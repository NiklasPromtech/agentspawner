import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { actionLog, flows, agents, toneEdits, tables, schedules } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { runFlowDetailed } from '../../features/flows/flow-runner.js';
import type { FlowRecord } from '../../features/flows/flow-runner.js';
import { decrypt } from '../../crypto/index.js';
import { refreshToneGuide } from '../../lib/tone.js';
import Anthropic from '@anthropic-ai/sdk';
import { reloadSchedules } from '../../scheduler/index.js';

const ActionLogEntry = z.object({
  flowId: z.string(),
  flowName: z.string(),
  flowType: z.string(),
  keyField: z.string(),
  keyValue: z.string(),
  input: z.record(z.unknown()).default({}),
  result: z.string().nullable().optional(),
  blocked: z.boolean().default(false),
  runId: z.string().nullable().optional(),
});

export function registerActionLogRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  // GET /agents/:agentId/action-log
  // Optional query: ?flow_name=send_dm&key_value=@niklas&limit=50&blocked=true
  fastify.get<{
    Params: { agentId: string };
    Querystring: { flow_name?: string; key_value?: string; key_field?: string; limit?: string; blocked?: string; flowType?: string; status?: string };
  }>('/agents/:agentId/action-log', async (req) => {
    const { agentId } = req.params;
    const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, 500);

    let rows = await db
      .select()
      .from(actionLog)
      .where(eq(actionLog.agentId, agentId))
      .orderBy(desc(actionLog.createdAt))
      .limit(limit);

    // In-memory filters (simpler than building dynamic where clauses for optional fields)
    if (req.query.flow_name) rows = rows.filter((r) => r.flowName === req.query.flow_name);
    if (req.query.key_value) rows = rows.filter((r) => r.keyValue === req.query.key_value);
    if (req.query.key_field) rows = rows.filter((r) => r.keyField === req.query.key_field);
    if (req.query.blocked !== undefined) {
      const wantBlocked = req.query.blocked === 'true';
      rows = rows.filter((r) => Boolean(r.blocked) === wantBlocked);
    }
    if (req.query.flowType) rows = rows.filter((r) => r.flowType === req.query.flowType);
    if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);

    return rows;
  });

  // POST /agents/:agentId/action-log  — write a new entry (called by flow runner or agent tools)
  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/action-log', async (req, reply) => {
    const body = ActionLogEntry.parse(req.body);
    const { agentId } = req.params;

    const id = uuidv4();
    await db.insert(actionLog).values({
      id,
      agentId,
      flowId: body.flowId,
      flowName: body.flowName,
      flowType: body.flowType,
      keyField: body.keyField,
      keyValue: body.keyValue,
      input: JSON.stringify(body.input),
      result: body.result ?? null,
      blocked: body.blocked,
      runId: body.runId ?? null,
    });

    const [entry] = await db.select().from(actionLog).where(eq(actionLog.id, id)).limit(1);
    return reply.status(201).send(entry);
  });

  // DELETE /agents/:agentId/action-log/:entryId
  fastify.delete<{ Params: { agentId: string; entryId: string } }>(
    '/agents/:agentId/action-log/:entryId',
    async (req) => {
      await db.delete(actionLog).where(
        and(eq(actionLog.id, req.params.entryId), eq(actionLog.agentId, req.params.agentId)),
      );
      return { success: true };
    },
  );

  // ── OPERATION KEYSTONE: Task 5 ────────────────────────────────────────────
  // Review Actions endpoints: play / reject / rerun

  /**
   * POST /agents/:agentId/action-log/:entryId/play
   * Execute a pending_review action log entry, optionally with amended content.
   */
  fastify.post<{
    Params: { agentId: string; entryId: string };
    Body: { amendedContent?: string };
  }>('/agents/:agentId/action-log/:entryId/play', async (req, reply) => {
    const { agentId, entryId } = req.params;
    const { amendedContent } = (req.body as { amendedContent?: string }) ?? {};

    // ── OPERATION CONVERGENCE Task 8 — atomic status check + claim ────────────
    // Wrapping the status check and the transition to 'executing' in a single
    // synchronous transaction prevents two concurrent play requests from both
    // seeing 'pending_review', both passing the guard, and both running the flow
    // — which would execute the same action twice (e.g. post the same comment twice).
    // Only one request can win the transaction; the second will see 'executing'
    // and return a 400 immediately.
    type ClaimResult =
      | { claimed: true; entry: typeof actionLog.$inferSelect }
      | { claimed: false; reason: 'not_found' | 'wrong_status'; currentStatus?: string };

    const claimResult: ClaimResult = db.transaction((tx) => {
      const rows = tx
        .select()
        .from(actionLog)
        .where(and(eq(actionLog.id, entryId), eq(actionLog.agentId, agentId)))
        .limit(1)
        .all();

      const e = rows[0];
      if (!e) return { claimed: false as const, reason: 'not_found' as const };
      if (e.status !== 'pending_review') {
        return { claimed: false as const, reason: 'wrong_status' as const, currentStatus: e.status };
      }

      // Atomically claim this entry for execution
      tx.update(actionLog)
        .set({ status: 'executing' })
        .where(eq(actionLog.id, entryId))
        .run();

      return { claimed: true as const, entry: { ...e, status: 'executing' } };
    });

    // 1. Fetch the entry — must be pending_review
    if (!claimResult.claimed) {
      if (claimResult.reason === 'not_found') {
        return reply.status(404).send({ error: 'Action log entry not found' });
      }
      return reply.status(400).send({ error: `Entry is not pending_review (current status: ${claimResult.currentStatus})` });
    }

    const entry = claimResult.entry;

    // ── SESSION 6 (OPERATION CLARITY): infrastructure action execution ────────
    // Infrastructure actions (create_table, create_schedule) are not backed by a
    // real flow — execute them directly and return early.
    if (entry.flowType === 'infrastructure') {
      let infraInput: Record<string, unknown>;
      try {
        infraInput = JSON.parse(entry.input) as Record<string, unknown>;
      } catch {
        await db.update(actionLog).set({ status: 'failed', result: 'Could not parse stored input JSON' }).where(eq(actionLog.id, entryId));
        return reply.status(400).send({ error: 'Could not parse stored input JSON' });
      }

      let infraResult = '';
      let infraStatus = 'approved';
      try {
        if (entry.flowName === 'create_table') {
          type ColDef = { name: string; type: string };
          const newTableId = uuidv4();
          await db.insert(tables).values({
            id: newTableId,
            agentId,
            name: infraInput.name as string,
            columns: JSON.stringify((infraInput.columns as ColDef[]) ?? []),
          });
          infraResult = JSON.stringify({ success: true, table_id: newTableId, name: infraInput.name });
        } else if (entry.flowName === 'create_schedule') {
          const newScheduleId = uuidv4();
          await db.insert(schedules).values({
            id: newScheduleId,
            agentId,
            cron: infraInput.cron as string,
            input: (infraInput.input as string) ?? '',
            timezone: (infraInput.timezone as string) ?? 'Europe/Stockholm',
            enabled: true,
          });
          await reloadSchedules();
          infraResult = JSON.stringify({ success: true, schedule_id: newScheduleId });
        } else {
          infraResult = JSON.stringify({ error: `Unknown infrastructure action: ${entry.flowName}` });
          infraStatus = 'failed';
        }
      } catch (err) {
        infraResult = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        infraStatus = 'failed';
      }

      await db.update(actionLog).set({ status: infraStatus!, result: infraResult }).where(eq(actionLog.id, entryId));
      const [updated] = await db.select().from(actionLog).where(eq(actionLog.id, entryId)).limit(1);
      return reply.status(200).send(updated);
    }

    // 2. Load the flow
    const [flowRow] = await db
      .select()
      .from(flows)
      .where(eq(flows.id, entry.flowId))
      .limit(1);

    if (!flowRow) return reply.status(404).send({ error: `Flow '${entry.flowId}' not found` });

    // 3. Parse the stored input
    let flowInput: Record<string, unknown>;
    try {
      flowInput = JSON.parse(entry.input) as Record<string, unknown>;
    } catch {
      return reply.status(400).send({ error: 'Could not parse stored input JSON' });
    }

    // 4. If amendedContent is provided, replace the content field in the input.
    //    Try common content field names, then fall back to any *_text / content-keyword field.
    const CONTENT_FIELDS = ['content', 'message', 'text', 'comment_text', 'body', 'tweet_text', 'post_text', 'comment', 'reply'];
    const CONTENT_KEYWORDS = ['text', 'content', 'message', 'body', 'comment', 'reply', 'post'];
    let originalContent: string | undefined;
    if (amendedContent !== undefined && amendedContent !== null) {
      const targetField =
        CONTENT_FIELDS.find((f) => f in flowInput) ??
        Object.keys(flowInput).find((k) => CONTENT_KEYWORDS.some((kw) => k.toLowerCase().includes(kw)) && typeof flowInput[k] === 'string') ??
        'content';
      // Capture original before overwriting — used for tone learning below
      originalContent = typeof flowInput[targetField] === 'string' ? flowInput[targetField] as string : undefined;
      flowInput = { ...flowInput, [targetField]: amendedContent };
    }

    // 5. Run the flow, bypassing dedup and reusing the existing actionLog entry.
    //    The flow runner will update result (and status='failed' on error) via
    //    postRun() / the error handler in run().
    const flowRecord = flowRow as unknown as FlowRecord;
    const runResult = await runFlowDetailed(flowRecord, flowInput, agentId, {
      skipDedup: true,
      existingActionLogId: entryId,
    });

    // 6. Update the entry with the final status and optional finalContent.
    const finalStatus = !runResult.ok
      ? 'failed'
      : amendedContent !== undefined && amendedContent !== null
      ? 'approved_with_edits'
      : 'approved';

    await db
      .update(actionLog)
      .set({
        status: finalStatus,
        ...(amendedContent !== undefined && amendedContent !== null
          ? { finalContent: amendedContent }
          : {}),
      })
      .where(eq(actionLog.id, entryId));

    // 7. If the play succeeded with edited content that actually changed, record a tone edit
    //    so the agent can learn from the human's adjustment — same as the human review system.
    if (runResult.ok && amendedContent && originalContent && amendedContent !== originalContent) {
      await db.insert(toneEdits).values({
        id: uuidv4(),
        agentId,
        reviewId: entryId, // action log entry ID stands in for review ID
        flowName: entry.flowName,
        context: '', // no tab URL in this flow — could be enriched with post_url later
        agentDraft: originalContent,
        humanFinal: amendedContent,
      });

      // Trigger tone guide refresh on the same schedule as human reviews (every 5 edits, min 3)
      const allEdits = await db.select().from(toneEdits).where(eq(toneEdits.agentId, agentId));
      if (allEdits.length >= 3 && allEdits.length % 5 === 0) {
        void refreshToneGuide(agentId, allEdits.map((e) => ({ draft: e.agentDraft, final: e.humanFinal })));
      }
    }

    // 8. Return the updated entry
    const [updated] = await db.select().from(actionLog).where(eq(actionLog.id, entryId)).limit(1);
    return reply.status(200).send(updated);
  });

  /**
   * POST /agents/:agentId/action-log/:entryId/reject
   * Reject a pending_review entry with a required reason.
   */
  fastify.post<{
    Params: { agentId: string; entryId: string };
    Body: { reason: string };
  }>('/agents/:agentId/action-log/:entryId/reject', async (req, reply) => {
    const { agentId, entryId } = req.params;
    const { reason } = (req.body as { reason: string }) ?? {};

    if (!reason?.trim()) {
      return reply.status(400).send({ error: 'A rejection reason is required' });
    }

    const [entry] = await db
      .select()
      .from(actionLog)
      .where(and(eq(actionLog.id, entryId), eq(actionLog.agentId, agentId)))
      .limit(1);

    if (!entry) return reply.status(404).send({ error: 'Action log entry not found' });
    if (entry.status !== 'pending_review') {
      return reply.status(400).send({ error: `Entry is not pending_review (current status: ${entry.status})` });
    }

    await db
      .update(actionLog)
      .set({ status: 'rejected', blockedReason: reason.trim() })
      .where(eq(actionLog.id, entryId));

    const [updated] = await db.select().from(actionLog).where(eq(actionLog.id, entryId)).limit(1);
    return reply.status(200).send(updated);
  });

  /**
   * POST /agents/:agentId/action-log/:entryId/rerun
   * Re-run a completed/failed entry.
   * - requiresApproval flows: status → pending_review (back in the review queue)
   * - non-approval flows: execute immediately with the stored input
   * Always increments reRunCount.
   */
  fastify.post<{ Params: { agentId: string; entryId: string } }>(
    '/agents/:agentId/action-log/:entryId/rerun',
    async (req, reply) => {
      const { agentId, entryId } = req.params;

      const [entry] = await db
        .select()
        .from(actionLog)
        .where(and(eq(actionLog.id, entryId), eq(actionLog.agentId, agentId)))
        .limit(1);

      if (!entry) return reply.status(404).send({ error: 'Action log entry not found' });

      const [flowRow] = await db
        .select()
        .from(flows)
        .where(eq(flows.id, entry.flowId))
        .limit(1);

      if (!flowRow) return reply.status(404).send({ error: `Flow '${entry.flowId}' not found` });

      const flowRecord = flowRow as unknown as FlowRecord;
      const newReRunCount = (entry.reRunCount ?? 0) + 1;

      if (flowRecord.requiresApproval) {
        // Put it back in the review queue
        await db
          .update(actionLog)
          .set({ status: 'pending_review', reRunCount: newReRunCount, result: null })
          .where(eq(actionLog.id, entryId));
      } else {
        // Execute immediately with the stored input, bypassing dedup
        let flowInput: Record<string, unknown>;
        try {
          flowInput = JSON.parse(entry.input) as Record<string, unknown>;
        } catch {
          return reply.status(400).send({ error: 'Could not parse stored input JSON' });
        }

        // Increment reRunCount before running so it's recorded even if execution fails
        await db
          .update(actionLog)
          .set({ reRunCount: newReRunCount, status: 'executed', result: null })
          .where(eq(actionLog.id, entryId));

        await runFlowDetailed(flowRecord, flowInput, agentId, {
          skipDedup: true,
          existingActionLogId: entryId,
        });
        // postRun() updates result; run() updates status to 'failed' on error
      }

      const [updated] = await db.select().from(actionLog).where(eq(actionLog.id, entryId)).limit(1);
      return reply.status(200).send(updated);
    },
  );

  /**
   * GET /action-log/:entryId
   * Fetch a single action log entry by ID (no agentId required — used by the Flows Debugger
   * extension to pre-populate the flow input from a queued action).
   */
  fastify.get<{ Params: { entryId: string } }>(
    '/action-log/:entryId',
    async (req, reply) => {
      const { entryId } = req.params;
      const [entry] = await db
        .select()
        .from(actionLog)
        .where(eq(actionLog.id, entryId))
        .limit(1);
      if (!entry) return reply.status(404).send({ error: 'Action log entry not found' });
      return reply.status(200).send(entry);
    },
  );

  /**
   * POST /agents/:agentId/action-log/:entryId/revise
   * Use Claude to revise the content field of a pending action based on a human instruction.
   * Returns { revisedContent: string } — the caller decides whether to immediately play it
   * ("Play with thought") or pre-fill the amend editor ("Edit with thought").
   */
  fastify.post<{
    Params: { agentId: string; entryId: string };
    Body: { thought: string };
  }>('/agents/:agentId/action-log/:entryId/revise', async (req, reply) => {
    const { agentId, entryId } = req.params;
    const { thought } = (req.body as { thought?: string }) ?? {};

    if (!thought?.trim()) {
      return reply.status(400).send({ error: 'A thought/instruction is required' });
    }

    // 1. Fetch entry
    const [entry] = await db
      .select()
      .from(actionLog)
      .where(and(eq(actionLog.id, entryId), eq(actionLog.agentId, agentId)))
      .limit(1);
    if (!entry) return reply.status(404).send({ error: 'Action log entry not found' });

    // 2. Extract the content field from the stored input
    let flowInput: Record<string, unknown>;
    try {
      flowInput = JSON.parse(entry.input) as Record<string, unknown>;
    } catch {
      return reply.status(400).send({ error: 'Could not parse stored input JSON' });
    }

    const CONTENT_FIELDS = ['content', 'message', 'text', 'comment_text', 'body', 'tweet_text', 'post_text', 'comment', 'reply'];
    // Exact match first, then any field whose name ends in _text or contains a content keyword,
    // then fall back to whichever string field is longest.
    const CONTENT_KEYWORDS = ['text', 'content', 'message', 'body', 'comment', 'reply', 'post'];
    const contentField =
      CONTENT_FIELDS.find((f) => f in flowInput) ??
      Object.keys(flowInput).find((k) => CONTENT_KEYWORDS.some((kw) => k.toLowerCase().includes(kw)) && typeof flowInput[k] === 'string') ??
      Object.entries(flowInput)
        .filter(([, v]) => typeof v === 'string')
        .sort(([, a], [, b]) => (b as string).length - (a as string).length)[0]?.[0];

    if (!contentField) {
      return reply.status(400).send({ error: 'No content field found in action input' });
    }
    const originalContent = String(flowInput[contentField] ?? '');

    // 3. Get agent API key
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    const apiKey = decrypt(agent.apiKeyEncrypted);
    if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

    // 4. Call Claude to revise the content
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are helping a human reviewer adjust AI-generated content before it gets posted online.

Original content:
"""
${originalContent}
"""

Human's instruction:
"""
${thought.trim()}
"""

Rewrite the content to incorporate the human's instruction. Preserve the same intent and general structure but apply their requested changes. Return ONLY the rewritten content — no explanation, no quotes, no preamble.`,
      }],
    });

    const revisedContent = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();

    return reply.status(200).send({ revisedContent });
  });
}
