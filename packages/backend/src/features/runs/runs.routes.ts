import type { FastifyInstance } from 'fastify';
import { SseStream } from '../../lib/sse-stream.js';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { runs, messages, memory } from '../../db/schema.js';
import { eq, desc, and, ne } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { runOrchestrator, stopRun, type OrchestratorEvent } from '../../orchestrator/index.js';
import { runAutonomousOrchestrator } from '../../orchestrator/autonomous.js';
import { pushNudge } from '../../orchestrator/nudge-registry.js';
import { logger } from '../../lib/logger.js';

export type SseEmitter = (event: OrchestratorEvent) => void;

// SSE subscriber registry: runId → set of SseStream instances
const sseSubscribers = new Map<string, Set<SseStream>>();

export function emitSseEvent(runId: string, event: OrchestratorEvent): void {
  const subs = sseSubscribers.get(runId);
  if (!subs) return;
  for (const stream of subs) {
    if (!stream.isOpen) {
      subs.delete(stream);
      continue;
    }
    stream.send(event);
    if (event.type === 'done' || event.type === 'error') {
      stream.end();
      subs.delete(stream);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Load recent conversation history for an agent across all manual (chat) runs.
 * Returns the last `maxTurns` user/assistant pairs as Anthropic MessageParam objects.
 * Only includes text content — skips tool_use/tool_result so the history is clean.
 */
async function loadChatHistory(
  agentId: string,
  maxTurns = 20,
): Promise<Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>> {
  const db = getDb();

  const recentRuns = await db
    .select()
    .from(runs)
    .where(and(eq(runs.agentId, agentId), eq(runs.trigger, 'manual')))
    .orderBy(desc(runs.createdAt))
    .limit(10); // look at last 10 runs, extract best user/assistant pair from each

  if (recentRuns.length === 0) return [];

  const history: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [];

  for (const run of recentRuns.reverse()) { // oldest first
    const runMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.runId, run.id))
      .orderBy(messages.createdAt);

    // Take the first user message and last meaningful assistant text response
    const userMsg = runMessages.find((m) => m.role === 'user');
    const assistantMsgs = runMessages.filter((m) => m.role === 'assistant');
    if (!userMsg || assistantMsgs.length === 0) continue;

    const userContent = (() => { try { return JSON.parse(userMsg.content); } catch { return userMsg.content; } })();
    if (typeof userContent !== 'string') continue; // skip non-text user messages

    // Find last assistant message that has text blocks
    let assistantText: unknown[] | null = null;
    for (let i = assistantMsgs.length - 1; i >= 0; i--) {
      const ac = (() => { try { return JSON.parse(assistantMsgs[i]!.content); } catch { return null; } })();
      const textBlocks = Array.isArray(ac) ? ac.filter((b: unknown) => (b as { type?: string }).type === 'text') : [];
      if (textBlocks.length > 0) { assistantText = textBlocks; break; }
    }
    if (!assistantText) continue;

    history.push({ role: 'user', content: userContent });
    history.push({ role: 'assistant', content: assistantText });
  }

  // Keep only the last maxTurns pairs
  return history.slice(-(maxTurns * 2));
}

export function registerRunRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/runs', async (req) => {
    return db
      .select()
      .from(runs)
      .where(eq(runs.agentId, req.params.agentId))
      .orderBy(desc(runs.createdAt))
      .limit(50);
  });

  fastify.get<{ Params: { runId: string } }>('/runs/:runId', async (req, reply) => {
    const [run] = await db.select().from(runs).where(eq(runs.id, req.params.runId));
    if (!run) return reply.status(404).send({ error: 'Not found' });
    return run;
  });

  fastify.get<{ Params: { runId: string } }>('/runs/:runId/messages', async (req, reply) => {
    const [run] = await db.select().from(runs).where(eq(runs.id, req.params.runId));
    if (!run) return reply.status(404).send({ error: 'Not found' });
    return db.select().from(messages).where(eq(messages.runId, req.params.runId));
  });

  // SSE endpoint for real-time run events
  fastify.get<{ Params: { runId: string } }>('/runs/:runId/events', async (req, reply) => {
    const { runId } = req.params;

    const stream = new SseStream(reply);

    if (!sseSubscribers.has(runId)) {
      sseSubscribers.set(runId, new Set());
    }
    sseSubscribers.get(runId)!.add(stream);

    // Check if run is already done
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (run && (run.status === 'completed' || run.status === 'failed' || run.status === 'stopped')) {
      stream.send({ type: 'done', runId });
      stream.end();
      sseSubscribers.get(runId)?.delete(stream);
      return reply;
    }

    // Stale streams are pruned lazily in emitSseEvent (via isOpen check).
    // No explicit close listener is needed in the route handler.

    return reply;
  });

  // ── Conversation history (all chat messages for this agent across all runs) ──
  // Returns messages in chronological order so the frontend can display a
  // continuous thread rather than per-run fragments.
  fastify.get<{ Params: { agentId: string }; Querystring: { limit?: string } }>(
    '/agents/:agentId/conversation',
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '200', 10), 500);

      // Get recent manual runs
      const manualRuns = await db
        .select()
        .from(runs)
        .where(and(eq(runs.agentId, req.params.agentId), eq(runs.trigger, 'manual')))
        .orderBy(desc(runs.createdAt))
        .limit(30);

      if (manualRuns.length === 0) return [];

      // Gather all messages from those runs (oldest run first, messages oldest first)
      const allMessages: Array<typeof messages.$inferSelect & { runId: string }> = [];
      for (const run of manualRuns.reverse()) {
        const msgs = await db
          .select()
          .from(messages)
          .where(eq(messages.runId, run.id))
          .orderBy(messages.createdAt);
        allMessages.push(...msgs);
      }

      return allMessages.slice(-limit);
    },
  );

  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/runs', async (req, reply) => {
    const { input = '', trigger = 'manual' } = (req.body as { input?: string; trigger?: string }) ?? {};

    const runId = uuidv4();
    await db.insert(runs).values({
      id: runId,
      agentId: req.params.agentId,
      status: 'pending',
      trigger,
      input,
    });

    const emitter: SseEmitter = (event) => emitSseEvent(runId, event);

    // For manual chat runs, load recent conversation history so the agent
    // remembers what was said in previous messages.
    const history = trigger === 'manual'
      ? await loadChatHistory(req.params.agentId)
      : [];

    // Run orchestrator async (don't await)
    runOrchestrator(runId, req.params.agentId, input, emitter, history).catch((err) => {
      logger.error({ err, runId, agentId: req.params.agentId }, 'Orchestrator: unhandled error');
    });

    return reply.status(201).send({ runId });
  });

  fastify.post<{ Params: { runId: string } }>('/runs/:runId/stop', async (req, reply) => {
    const [run] = await db.select().from(runs).where(eq(runs.id, req.params.runId));
    if (!run) return reply.status(404).send({ error: 'Not found' });
    // Signal the in-memory orchestrator (no-op if server was restarted and run is orphaned)
    stopRun(req.params.runId);
    // Always update the DB — ensures orphaned runs (stuck from a server restart) also get stopped
    if (run.status === 'running' || run.status === 'pending') {
      await db.update(runs)
        .set({ status: 'stopped', updatedAt: new Date().toISOString() })
        .where(eq(runs.id, req.params.runId));
    }
    return { success: true };
  });

  // Status endpoint — returns what the autonomous agent is currently working on
  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/autonomous-status', async (req) => {
    // Latest autonomous run
    const [latestRun] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.agentId, req.params.agentId), eq(runs.trigger, 'autonomous')))
      .orderBy(desc(runs.createdAt))
      .limit(1);

    // Latest status memory entry
    const [latestStatus] = await db
      .select()
      .from(memory)
      .where(and(eq(memory.sourceAgentId, req.params.agentId), eq(memory.category, 'agent_status')))
      .orderBy(desc(memory.createdAt))
      .limit(1);

    return {
      latestRun: latestRun ?? null,
      currentTask: latestStatus ? latestStatus.content : null,
      plan: latestStatus ? (() => { try { return (JSON.parse(latestStatus.metadata) as { plan?: string }).plan ?? null; } catch { return null; } })() : null,
      statusUpdatedAt: latestStatus?.createdAt ?? null,
    };
  });

  // Wake-up endpoint — fires the autonomous (Haiku) orchestrator
  // Body: { budgetUsdPerHour?: number, recentMessages?: Array<{role: string, content: string}> }
  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/wake-up', async (req, reply) => {
    const { budgetUsdPerHour = 0, recentMessages } = (req.body as {
      budgetUsdPerHour?: number;
      recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    }) ?? {};

    const runId = uuidv4();
    await db.insert(runs).values({
      id: runId,
      agentId: req.params.agentId,
      status: 'pending',
      trigger: 'autonomous',
      input: `__wake_up__${budgetUsdPerHour > 0 ? `:$${budgetUsdPerHour}/hr` : ''}`,
    });

    const emitter: SseEmitter = (event) => emitSseEvent(runId, event);

    runAutonomousOrchestrator(runId, req.params.agentId, emitter, budgetUsdPerHour, recentMessages).catch((err) => {
      logger.error({ err, runId, agentId: req.params.agentId }, 'Autonomous orchestrator: unhandled error');
    });

    return reply.status(201).send({ runId });
  });

  // ── Nudge endpoint — inject a user message into a running autonomous session ──
  // The autonomous orchestrator drains nudges at the top of each iteration.
  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/nudge', async (req, reply) => {
    const { message } = (req.body as { message?: string }) ?? {};
    if (!message?.trim()) return reply.status(400).send({ error: 'message is required' });
    pushNudge(req.params.agentId, message.trim());
    return { queued: true };
  });
}
