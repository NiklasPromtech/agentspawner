import type { FastifyInstance } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { performanceLog, runs, memory, actionLog, flowRuns, flows, goals, agents } from '../../db/schema.js';
import { eq, desc, and, gte, count, sql } from 'drizzle-orm';
import { getExtensionStatus } from '../../websocket/server.js';
import { v4 as uuidv4 } from 'uuid';
import { decrypt } from '../../crypto/index.js';

const AUDIT_SYSTEM_PROMPT = `You are an experienced QA manager reviewing an AI agent's recent performance.
Analyze the data provided and write a concise audit report (200-350 words).

Your report must cover:
1. ACTION LOG — what actions were taken, success rate, any concerning patterns
2. FLOW PERFORMANCE — which flows are working, which are failing consistently
3. GUARD EFFECTIVENESS — are deduplication guards working? Any excessive blocking?
4. RECOMMENDATIONS — 1-3 concrete, actionable improvements

Tone: direct and technical. No fluff. Flag real issues clearly. If everything looks healthy, say so briefly.
Format: plain prose paragraphs. End with a numbered RECOMMENDATIONS section.`;

export function registerAnalyticsRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  // ── Performance Log ──────────────────────────────────────────────────────────

  // List performance log entries for an agent
  fastify.get<{ Params: { agentId: string }; Querystring: { category?: string; limit?: string; days?: string } }>(
    '/agents/:agentId/performance',
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '200'), 500);
      const days = parseInt(req.query.days ?? '30');
      const since = new Date(Date.now() - days * 86_400_000).toISOString();

      const base = db.select().from(performanceLog)
        .where(and(eq(performanceLog.agentId, req.params.agentId), gte(performanceLog.createdAt, since)));

      const entries = await base.orderBy(desc(performanceLog.createdAt)).limit(limit);
      return entries;
    },
  );

  // Create a performance log entry (also exposed so humans can log outcomes manually)
  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/performance', async (req, reply) => {
    const body = req.body as {
      category?: string;
      action: string;
      outcome?: string;
      value?: number;
      notes?: string;
      metadata?: Record<string, unknown>;
      runId?: string;
    };

    const id = uuidv4();
    await db.insert(performanceLog).values({
      id,
      agentId: req.params.agentId,
      category: body.category ?? 'other',
      action: body.action,
      outcome: body.outcome ?? 'unknown',
      value: body.value ?? 0,
      notes: body.notes ?? '',
      metadata: JSON.stringify(body.metadata ?? {}),
      runId: body.runId ?? null,
    });

    const [entry] = await db.select().from(performanceLog).where(eq(performanceLog.id, id));
    return reply.status(201).send(entry);
  });

  // ── Analytics summary ────────────────────────────────────────────────────────

  // Aggregated stats for the analytics dashboard
  fastify.get<{ Params: { agentId: string }; Querystring: { days?: string } }>(
    '/agents/:agentId/analytics',
    async (req) => {
      const days = parseInt(req.query.days ?? '30');
      const since = new Date(Date.now() - days * 86_400_000).toISOString();

      // Run stats
      const recentRuns = await db.select().from(runs)
        .where(and(eq(runs.agentId, req.params.agentId), gte(runs.createdAt, since)))
        .orderBy(desc(runs.createdAt))
        .limit(500);

      const runStats = {
        total: recentRuns.length,
        completed: recentRuns.filter((r) => r.status === 'completed').length,
        failed: recentRuns.filter((r) => r.status === 'failed').length,
        stopped: recentRuns.filter((r) => r.status === 'stopped').length,
        totalCostUsd: recentRuns.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
        totalInputTokens: recentRuns.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
        totalOutputTokens: recentRuns.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
        // Group by day for sparkline data
        byDay: Object.entries(
          recentRuns.reduce<Record<string, { runs: number; cost: number }>>((acc, r) => {
            const day = r.createdAt.slice(0, 10);
            if (!acc[day]) acc[day] = { runs: 0, cost: 0 };
            acc[day].runs++;
            acc[day].cost += r.costUsd ?? 0;
            return acc;
          }, {}),
        )
          .map(([date, v]) => ({ date, ...v }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      };

      // Performance log stats
      const perfEntries = await db.select().from(performanceLog)
        .where(and(eq(performanceLog.agentId, req.params.agentId), gte(performanceLog.createdAt, since)))
        .limit(1000);

      const perfByCategory = Object.entries(
        perfEntries.reduce<Record<string, { total: number; success: number; failure: number }>>((acc, e) => {
          if (!acc[e.category]) acc[e.category] = { total: 0, success: 0, failure: 0 };
          acc[e.category].total++;
          if (e.outcome === 'success') acc[e.category].success++;
          if (e.outcome === 'failure') acc[e.category].failure++;
          return acc;
        }, {}),
      ).map(([category, v]) => ({
        category,
        ...v,
        successRate: v.total > 0 ? Math.round((v.success / v.total) * 100) : null,
      }));

      // Session journal — last 10 entries
      const journals = await db.select().from(memory)
        .where(and(eq(memory.sourceAgentId, req.params.agentId), eq(memory.category, 'session_journal')))
        .orderBy(desc(memory.createdAt))
        .limit(10);

      return {
        period: { days, since },
        runs: runStats,
        performance: { entries: perfEntries.length, byCategory: perfByCategory },
        sessionJournal: journals.map((j) => ({
          id: j.id,
          content: j.content,
          createdAt: j.createdAt,
          metadata: (() => { try { return JSON.parse(j.metadata); } catch { return {}; } })(),
        })),
      };
    },
  );

  // ── Audit endpoint (task 5.2) ─────────────────────────────────────────────
  // POST /agents/:agentId/audit
  // Runs expensive Sonnet audit over action log + flow performance, writes report to memory.
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/audit',
    async (req, reply) => {
      req.raw.setTimeout(60_000);

      const { agentId } = req.params;

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });

      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

      // ── Gather audit data ──────────────────────────────────────────────────

      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const since7d  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      // Action log — last 24h
      const recentActions = await db
        .select()
        .from(actionLog)
        .where(and(eq(actionLog.agentId, agentId), gte(actionLog.createdAt, since24h)))
        .orderBy(desc(actionLog.createdAt))
        .limit(200);

      // Flow runs — last 7 days (to detect persistent failures)
      const recentFlowRuns = await db
        .select()
        .from(flowRuns)
        .where(and(eq(flowRuns.agentId, agentId), gte(flowRuns.createdAt, since7d)))
        .orderBy(desc(flowRuns.createdAt))
        .limit(300);

      // Current flows
      const agentFlows = await db.select().from(flows).where(eq(flows.agentId, agentId));

      // Current goals
      const agentGoals = await db.select().from(goals).where(eq(goals.agentId, agentId));

      // Last audit report (for context)
      const [lastAudit] = await db
        .select()
        .from(memory)
        .where(and(eq(memory.sourceAgentId, agentId), eq(memory.category, 'audit_report')))
        .orderBy(desc(memory.createdAt))
        .limit(1);

      // ── Build briefing ────────────────────────────────────────────────────

      // Summarise action log
      const actionsByFlow: Record<string, { total: number; blocked: number; success: number }> = {};
      for (const a of recentActions) {
        if (!actionsByFlow[a.flowName]) actionsByFlow[a.flowName] = { total: 0, blocked: 0, success: 0 };
        actionsByFlow[a.flowName].total++;
        if (a.blocked) actionsByFlow[a.flowName].blocked++;
        else actionsByFlow[a.flowName].success++;
      }

      const actionSummary = Object.entries(actionsByFlow)
        .map(([flow, stats]) => `  ${flow}: ${stats.total} executions — ${stats.success} succeeded, ${stats.blocked} blocked by guard`)
        .join('\n') || '  No actions in last 24h';

      // Summarise flow run success/failure
      const flowRunsByName: Record<string, { total: number; failed: number; errors: string[] }> = {};
      for (const r of recentFlowRuns) {
        if (!flowRunsByName[r.flowName]) flowRunsByName[r.flowName] = { total: 0, failed: 0, errors: [] };
        flowRunsByName[r.flowName].total++;
        if (!r.success) {
          flowRunsByName[r.flowName].failed++;
          if (r.error && flowRunsByName[r.flowName].errors.length < 2) {
            flowRunsByName[r.flowName].errors.push(r.error.slice(0, 120));
          }
        }
      }

      const flowRunSummary = Object.entries(flowRunsByName)
        .map(([name, stats]) => {
          const failRate = Math.round((stats.failed / stats.total) * 100);
          const errNote = stats.errors.length > 0 ? ` — errors: ${stats.errors.join('; ')}` : '';
          return `  ${name}: ${stats.total} runs, ${failRate}% failure rate${errNote}`;
        })
        .join('\n') || '  No flow runs in last 7 days';

      const goalsSummary = agentGoals.length > 0
        ? agentGoals.map((g) => `  [${g.status}] ${g.title} — ${g.description ?? ''}`).join('\n')
        : '  No goals configured';

      const flowList = agentFlows.map((f) => `  ${f.name} (${f.flowType ?? 'unknown'})`).join('\n') || '  No flows';

      const briefing = `AUDIT REQUEST for agent "${agent.name}"

CURRENT GOALS:
${goalsSummary}

INSTALLED FLOWS (${agentFlows.length} total):
${flowList}

ACTION LOG — LAST 24 HOURS:
${actionSummary}

FLOW RUN PERFORMANCE — LAST 7 DAYS:
${flowRunSummary}

${lastAudit ? `LAST AUDIT (${lastAudit.createdAt.slice(0, 16)}):\n${lastAudit.content.slice(0, 400)}` : 'No previous audit on record.'}`;

      // ── Call Sonnet ───────────────────────────────────────────────────────

      const anthropic = new Anthropic({ apiKey });
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: AUDIT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: briefing }],
      });

      const reportText = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      // ── Write report to memory ────────────────────────────────────────────

      const reportId = uuidv4();
      await db.insert(memory).values({
        id: reportId,
        content: `[Audit Report — ${new Date().toISOString().slice(0, 16)}]\n\n${reportText}`,
        category: 'audit_report',
        entities: JSON.stringify([agentId]),
        sourceAgentId: agentId,
        sourceAgentName: agent.name,
        sourceTool: 'audit',
        metadata: JSON.stringify({
          agentId,
          actionsLast24h: recentActions.length,
          flowRunsLast7d: recentFlowRuns.length,
          timestamp: new Date().toISOString(),
        }),
      });

      return reply.send({ report: reportText, memoryId: reportId, timestamp: new Date().toISOString() });
    },
  );

  // ── Agent Activity Dashboard ─────────────────────────────────────────────────
  // OPERATION CONVERGENCE Task 10 — single aggregated endpoint for live agent state.
  // Frontend polls this every 10s when running, every 60s when idle.

  fastify.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/dashboard',
    async (req, reply) => {
      const { agentId } = req.params;

      // Agent row — for status + lastActiveAt written by manager-agent.ts
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });

      // Latest autonomous run
      const [latestRun] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.agentId, agentId), eq(runs.trigger, 'autonomous')))
        .orderBy(desc(runs.createdAt))
        .limit(1);

      // Latest status memory entry (written by update_status tool in manager-agent)
      const [latestStatus] = await db
        .select()
        .from(memory)
        .where(and(eq(memory.sourceAgentId, agentId), eq(memory.category, 'agent_status')))
        .orderBy(desc(memory.createdAt))
        .limit(1);

      // Pending approvals count — actions waiting for human review
      const [{ pendingCount }] = await db
        .select({ pendingCount: count() })
        .from(actionLog)
        .where(and(eq(actionLog.agentId, agentId), eq(actionLog.status, 'pending_review')));

      // Recent 5 action log entries (newest first)
      const recentActions = await db
        .select()
        .from(actionLog)
        .where(eq(actionLog.agentId, agentId))
        .orderBy(desc(actionLog.createdAt))
        .limit(5);

      // Today's token usage — sum across all runs since midnight UTC
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const todayRuns = await db
        .select({
          totalInput: sql<number>`sum(${runs.inputTokens})`,
          totalOutput: sql<number>`sum(${runs.outputTokens})`,
          totalCost: sql<number>`sum(${runs.costUsd})`,
        })
        .from(runs)
        .where(and(eq(runs.agentId, agentId), gte(runs.createdAt, todayStart.toISOString())));

      const todayTokens = {
        inputTokens: todayRuns[0]?.totalInput ?? 0,
        outputTokens: todayRuns[0]?.totalOutput ?? 0,
        costUsd: todayRuns[0]?.totalCost ?? 0,
      };

      // Extension connection state (from WebSocket server singleton)
      const extStatus = getExtensionStatus();

      return {
        // Agent-level live status
        status: agent.status,          // 'idle' | 'running' | 'error'
        lastActiveAt: agent.lastActiveAt ?? null,
        // Current run info
        latestRun: latestRun ?? null,
        currentTask: latestStatus?.content ?? null,
        statusUpdatedAt: latestStatus?.createdAt ?? null,
        // Approval queue
        pendingApprovalsCount: pendingCount,
        // Recent action history
        recentActions,
        // Today's cost
        todayTokens,
        // Extension
        extensionConnected: extStatus.connected,
        extensionLastSeenAt: extStatus.lastSeenAt ?? null,
      };
    },
  );
}
