import type { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { runs, messages, flowRuns, goals, agents, rows } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';

/**
 * T5 — "Explain this run" endpoint
 *
 * GET /runs/:runId/explain
 *
 * Reads the full run context — messages, flow calls, goals, DB writes — and asks
 * Claude Haiku to narrate what happened in plain English:
 * "Here's what I was doing, what I found, what I decided, and why."
 *
 * Call this when you look at a run and think "I don't understand what happened here."
 * It costs a few Haiku tokens, so don't call it on every run automatically.
 */
export function registerExplainRoutes(fastify: FastifyInstance): void {

  // T7 helper — returns all flow_runs for a given runId (used by RunTraceTab in the frontend)
  fastify.get<{ Params: { runId: string } }>('/runs/:runId/flow-runs', async (req, reply) => {
    const db = getDb();
    const { runId } = req.params;
    const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
    if (!run) return reply.status(404).send({ error: 'Run not found' });
    const runFlows = await db.select().from(flowRuns)
      .where(eq(flowRuns.runId, runId))
      .orderBy(desc(flowRuns.createdAt));
    return runFlows;
  });

  // T5 — synthesize a plain-English narrative of what happened in a run
  fastify.get<{ Params: { runId: string } }>('/runs/:runId/explain', async (req, reply) => {
    const db = getDb();
    const { runId } = req.params;

    // 1. Load the run itself
    const [run] = await db.select().from(runs).where(eq(runs.id, runId));
    if (!run) return reply.status(404).send({ error: 'Run not found' });

    // 2. Load the agent so we can call Haiku using their API key
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    const apiKey = decrypt(agent.apiKeyEncrypted);
    if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

    // 3. Load all flow_runs for this run, newest first
    const runFlows = await db.select().from(flowRuns)
      .where(eq(flowRuns.runId, runId))
      .orderBy(desc(flowRuns.createdAt));

    // 4. Load unique goals referenced by these flow_runs
    const goalIds = [...new Set(runFlows.map((f) => f.goalId).filter(Boolean))] as string[];
    const linkedGoals = goalIds.length > 0
      ? await db.select().from(goals).where(eq(goals.agentId, run.agentId))
          .then((all) => all.filter((g) => goalIds.includes(g.id)))
      : [];

    // 5. Load a brief sample of messages (last 30 to keep tokens reasonable)
    const runMessages = await db.select().from(messages)
      .where(eq(messages.runId, runId))
      .orderBy(desc(messages.createdAt))
      .limit(30);
    runMessages.reverse(); // chronological order

    // 6. Load DB rows written by this run (attribution — T4)
    const writtenRows = await db.select().from(rows)
      .where(eq(rows.runId, runId))
      .limit(20);

    // ── Build context block ────────────────────────────────────────────────────
    const runSummaryBlock = [
      `RUN ID: ${run.id}`,
      `STATUS: ${run.status}`,
      `TRIGGER: ${run.trigger}`,
      `MODEL: ${run.modelId ?? 'unknown'}`,
      `STARTED: ${run.createdAt}`,
      run.costUsd ? `COST: $${run.costUsd.toFixed(4)}` : null,
    ].filter(Boolean).join('\n');

    const goalBlock = linkedGoals.length > 0
      ? `GOALS WORKED ON:\n${linkedGoals.map((g) => `  [${g.id}] ${g.type} | ${g.status} | ${g.title}`).join('\n')}`
      : 'GOALS WORKED ON: none linked';

    const flowBlock = runFlows.length > 0
      ? `FLOWS CALLED (${runFlows.length} total):\n` + runFlows.slice(0, 15).map((f) => [
          `  • ${f.flowName} — ${f.success ? 'success' : 'failed'} (${f.durationMs ?? '?'}ms)`,
          f.reasoning ? `    Reasoning: ${f.reasoning.slice(0, 200)}` : null,
          f.error ? `    Error: ${f.error}` : null,
          f.evaluationPassed != null ? `    Eval: ${f.evaluationPassed ? 'passed' : 'failed'}${f.evaluationReason ? ` — ${f.evaluationReason}` : ''}` : null,
        ].filter(Boolean).join('\n')).join('\n')
      : 'FLOWS CALLED: none';

    const writesBlock = writtenRows.length > 0
      ? `DB ROWS WRITTEN: ${writtenRows.length} rows across tables`
      : 'DB ROWS WRITTEN: none';

    // Condense message content for the prompt (extract text from JSON-encoded content)
    const messageSnippets = runMessages
      .map((m) => {
        let content: unknown;
        try { content = JSON.parse(m.content); } catch { content = m.content; }
        const textParts = Array.isArray(content)
          ? (content as Array<{ type?: string; text?: string }>)
              .filter((b) => b?.type === 'text' && b.text)
              .map((b) => b.text!.slice(0, 300))
              .join(' ')
          : String(content).slice(0, 300);
        return textParts ? `[${m.role}] ${textParts}` : null;
      })
      .filter(Boolean)
      .join('\n');

    const contextBlock = [
      '=== RUN SUMMARY ===',
      runSummaryBlock,
      '',
      '=== GOALS ===',
      goalBlock,
      '',
      '=== FLOWS ===',
      flowBlock,
      '',
      '=== DATABASE WRITES ===',
      writesBlock,
      '',
      '=== CONVERSATION EXCERPT ===',
      messageSnippets || '(no messages)',
    ].join('\n');

    // ── Call Haiku to synthesize a narrative ──────────────────────────────────
    const anthropic = new Anthropic({ apiKey });

    const synthesis = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: [
        'You are an AI agent explaining your own past run to the human who owns you.',
        'Write a clear, honest, first-person narrative in 2–5 paragraphs.',
        'Cover: what you were trying to do, what you actually did, what worked or failed, and why.',
        'Be concrete — mention specific flow names, goal titles, outcomes.',
        'If reasoning is available, quote it briefly to show your thinking.',
        'Do NOT use bullet points. Write in prose.',
      ].join(' '),
      messages: [{
        role: 'user',
        content: `Here is the context for run ${runId}:\n\n${contextBlock}\n\nPlease explain what happened in this run.`,
      }],
    });

    const narrativeBlock = synthesis.content.find((b) => b.type === 'text');
    const narrative = narrativeBlock?.type === 'text' ? narrativeBlock.text : '(no narrative generated)';

    return {
      runId,
      narrative,
      flowsCalled: runFlows.map((f) => f.flowName),
      goalWorkedOn: linkedGoals.length > 0 ? linkedGoals[0].title : null,
      modelUsed: run.modelId ?? null,
      flowRunCount: runFlows.length,
      dbRowsWritten: writtenRows.length,
    };
  });
}
