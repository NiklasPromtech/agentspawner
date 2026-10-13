import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { agents, tools, runs, messages, flows, memory, apiTools, agentSecrets, apiRequestLog, tables, rows, schedules, goals, flowRuns } from '../../db/schema.js';
import { eq, like, desc, and } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';
import { v4 as uuidv4 } from 'uuid';
import { runTool } from '../../orchestrator/tool-runner.js';
import { runFlow } from '../../orchestrator/flow-runner.js';
import { runApiToolThrottled } from '../../orchestrator/api-tool-runner-throttled.js';
import { executeInjectRows, type InjectRowsInput } from '../../features/tables/inject-rows.js';
import { storeToMemory } from '../../memory/librarian.js';
import type { SseEmitter } from '../../features/runs/runs.routes.js';
import { registerAbort, abortRun, unregisterAbort } from '../../orchestrator/abort-registry.js';
import { sendTelegramMessage } from '../../telegram/index.js';
import { logger } from '../../lib/logger.js';
import { getToneContext } from '../../lib/tone.js';

/**
 * Resolve a table identifier to its UUID.
 * Accepts either the actual UUID or the table name (case-insensitive).
 */
async function resolveTableId(db: ReturnType<typeof getDb>, agentId: string, tableIdOrName: string): Promise<string | null> {
  const [byId] = await db.select({ id: tables.id }).from(tables).where(and(eq(tables.id, tableIdOrName), eq(tables.agentId, agentId)));
  if (byId) return byId.id;
  const [byName] = await db.select({ id: tables.id }).from(tables).where(and(eq(tables.name, tableIdOrName), eq(tables.agentId, agentId)));
  return byName?.id ?? null;
}

export type OrchestratorEvent =
  | { type: 'message'; role: string; content: unknown; source?: string }
  | { type: 'tool_call'; toolName: string; input: unknown; correlationId: string; source?: string }
  | { type: 'tool_result'; correlationId: string; result: string; error?: string; source?: string }
  | { type: 'wake_up_context'; content: string }
  | { type: 'open_flow_generator'; prompt: string }
  | { type: 'done'; runId: string }
  | { type: 'error'; message: string };

// Keep local map for backward compatibility (stopRun still works)
const abortControllers = new Map<string, AbortController>();

const MEMORY_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'recall_memory',
    description: 'Search shared memory for everything known about a person, company, or topic. Call this before doing live web research on something you may have seen before.',
    input_schema: {
      type: 'object' as const,
      properties: {
        entity: { type: 'string', description: 'Handle, name, or keyword to search' },
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'store_memory',
    description: 'Explicitly save something important to shared memory with a specific category.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' },
        category: { type: 'string' },
        entities: { type: 'array', items: { type: 'string' } },
        hint: { type: 'string' },
      },
      required: ['content'],
    },
  },
];

const MEMORY_SYSTEM_ADDENDUM = `\n\nYou have the following management tools always available:
- recall_memory / store_memory — search and save to shared memory
- list_tables / query_table / insert_row / inject_rows — inspect and write to the agent's data tables
- list_api_requests — see stored API responses that can be used with inject_rows
- list_goals — see current objectives and tasks
- list_flows — see what automation flows exist
- list_tools — see what browser/code tools are available
- list_api_tools — see what custom API/script tools are available
- list_schedules — see what cron schedules are set up
- list_flow_runs — see recent flow execution history (name, success, duration, eval result)
- explain_flow_run — look up your own reasoning and context for past flow calls. Use when the user asks "why did you call X?" or "what were you thinking when you did Y?". Input: flow_name (optional, partial match), since (optional ISO timestamp), limit (optional, default 5).

CRITICAL RULES — follow these without exception:
1. NEVER ask the user what tables, tools, flows, or capabilities exist. Call list_tables, list_tools, list_api_tools, list_flows, or list_schedules yourself immediately and report what you find.
2. NEVER say "Want me to run list_tables?" or "Should I check?" — just run it.
3. When you need to store data, call list_tables first to find the right table, then insert_row for single rows or inject_rows for bulk inserts from API responses. Do not ask the user for the table name.
6. When you call an API tool and get back multiple items (e.g. articles, contacts), the response is automatically stored. Use list_api_requests to find it, then inject_rows to bulk-insert items into a table with a mapping script — much more efficient than calling insert_row per item.
4. Act first, report results. The user hired you to do things, not to ask for permission to look things up.
5. When the user asks WHY you did something or what you were thinking, call explain_flow_run immediately — do not try to reconstruct from memory.

APPROVAL PAUSES — when a flow has requiresApproval: true, it queues for human review in the Review Actions tab instead of executing immediately.
- This is NOT an error. The action was queued for approval as intended.
- Do NOT retry the flow. Do NOT call it again.
- Simply acknowledge the queue and move on to other goals/tasks.
- The human will approve or reject the action from the Review Actions tab.
- Example correct response: "The action has been queued for your review. I'll move on to the next task while you review it."`;

const MANAGEMENT_TOOL_NAMES = new Set([
  'recall_memory', 'store_memory',
  'list_tables', 'query_table', 'insert_row', 'inject_rows', 'list_api_requests',
  'list_goals',
  'list_flows',
  'list_tools',
  'list_api_tools',
  'list_schedules',
  'list_flow_runs',
  'explain_flow_run',
]);

async function handleRecallMemory(input: { entity: string; limit?: number }): Promise<string> {
  const db = getDb();
  const limit = Math.min(input.limit ?? 50, 200);
  const results = await db
    .select()
    .from(memory)
    .where(like(memory.entities, `%${input.entity}%`))
    .orderBy(desc(memory.createdAt))
    .limit(limit);
  if (results.length === 0) {
    return JSON.stringify({ found: 0, results: [], message: `No memories found for "${input.entity}"` });
  }
  // Group by category
  const grouped: Record<string, typeof results> = {};
  for (const r of results) {
    const cat = r.category ?? 'other';
    grouped[cat] = grouped[cat] ?? [];
    grouped[cat].push(r);
  }
  return JSON.stringify({ found: results.length, grouped });
}

async function handleStoreMemory(
  input: { content: string; category?: string; entities?: string[]; hint?: string },
  agentId: string,
  agentName: string,
): Promise<string> {
  const db = getDb();
  await db.insert(memory).values({
    id: uuidv4(),
    content: input.content,
    category: input.category ?? 'other',
    entities: JSON.stringify(input.entities ?? []),
    sourceAgentId: agentId,
    sourceAgentName: agentName,
    sourceTool: 'store_memory',
    metadata: JSON.stringify(input.hint ? { hint: input.hint } : {}),
  });
  return JSON.stringify({ success: true });
}

export function stopRun(runId: string): void {
  abortControllers.get(runId)?.abort();  // regular orchestrator
  abortRun(runId);                        // autonomous orchestrator (shared registry)
}

export async function runChatAgent(
  runId: string,
  agentId: string,
  userInput: string,
  emit?: SseEmitter,
  history?: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }>,
): Promise<void> {
  const db = getDb();
  const ac = new AbortController();
  abortControllers.set(runId, ac);
  registerAbort(runId, ac);

  try {
    // 1. Load agent
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const apiKey = decrypt(agent.apiKeyEncrypted);
    if (!apiKey) throw new Error('API key not configured for this agent');

    // 2. Load tools, flows, and API tools
    const agentTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
    const allAgentFlows = await db.select().from(flows).where(eq(flows.agentId, agentId));
    // Infeasible flows are kept for audit but must never appear as callable tools
    const agentFlows = allAgentFlows.filter((f) => !f.infeasible);
    const agentApiTools = await db.select().from(apiTools).where(eq(apiTools.agentId, agentId));
    const agentSecretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, agentId));
    const resolvedSecrets = Object.fromEntries(agentSecretRows.map((s) => [s.key, decrypt(s.value)]));
    const secretRateLimits = Object.fromEntries(agentSecretRows.map((s) => [s.key, s.requestsPerMinute]));

    // Build effective system prompt — inject suppression token instruction if present
    const suppressionToken = agent.suppressionToken;
    const basePrompt = suppressionToken
      ? `${agent.systemPrompt || ''}\n\n[SYSTEM INSTRUCTION] When any tool returns the exact string "${suppressionToken}", respond with exactly that string and nothing else. Do not add any other text.`.trim()
      : (agent.systemPrompt || '');

    // OPERATION VANTAGE Task 7 — inject tone layers so the chat agent writes in the right voice
    const { toneGuide, profileTone } = await getToneContext(agentId);
    const toneSections: string[] = [];
    if (profileTone.length > 0) {
      toneSections.push(
        'Base tone guidelines (from your persona):\n' +
        profileTone.map((t) => `- ${t}`).join('\n'),
      );
    }
    if (toneGuide.length > 0) {
      toneSections.push(
        'Tone corrections from human review — these override everything above. Follow them precisely:\n' +
        toneGuide.map((t) => `- ${t}`).join('\n'),
      );
    }
    const toneAddendum = toneSections.length > 0 ? '\n\n' + toneSections.join('\n\n') : '';

    const effectiveSystemPrompt = (basePrompt + toneAddendum + MEMORY_SYSTEM_ADDENDUM).trim() || undefined;

    // 3. Build Anthropic tool definitions (tools + flows + API tools + memory tools)
    const anthropicTools: Anthropic.Messages.Tool[] = [
      ...agentTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: JSON.parse(t.inputSchema) as Anthropic.Messages.Tool['input_schema'],
      })),
      ...agentApiTools
        .filter((t) => t.enabled)
        .flatMap((t) => {
          try {
            return [{
              name: t.name,
              description: `[API TOOL] ${t.description}`,
              input_schema: JSON.parse(t.inputSchema) as Anthropic.Messages.Tool['input_schema'],
            }];
          } catch {
            logger.warn({ toolName: t.name, agentId }, 'api-tools: skipping tool — invalid inputSchema JSON');
            return [];
          }
        }),
      ...agentFlows.map((f) => ({
        name: f.name,
        description: f.pinned
          ? `[APPROVED BY HUMAN — prefer this flow] ${f.description}`
          : f.description,
        input_schema: JSON.parse(f.inputSchema) as Anthropic.Messages.Tool['input_schema'],
      })),
      ...MEMORY_TOOLS,
      // Management / orientation tools
      { name: 'list_tools',      description: 'List all tools available to this agent.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
      { name: 'list_api_tools',  description: 'List all custom API tools (HTTP/script) available to this agent.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
      { name: 'list_flows',      description: 'List all automation flows for this agent.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
      { name: 'list_tables',     description: 'List all data tables for this agent — id, name, columns.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
      { name: 'query_table',     description: 'Read rows from a table by table_id.', input_schema: { type: 'object' as const, properties: { table_id: { type: 'string' }, limit: { type: 'number' } }, required: ['table_id'] } },
      { name: 'insert_row',      description: 'Insert a single row into a table.', input_schema: { type: 'object' as const, properties: { table_id: { type: 'string' }, data: { type: 'object', additionalProperties: true } }, required: ['table_id', 'data'] } },
      { name: 'list_api_requests', description: 'List recent stored API responses (from API tool calls). Returns request IDs that can be used with inject_rows.', input_schema: { type: 'object' as const, properties: { tool_name: { type: 'string', description: 'Filter by tool name (optional)' }, limit: { type: 'number', description: 'Max results (default 20)' } }, required: [] } },
      { name: 'inject_rows', description: 'Bulk-insert rows into a table from a stored API response. Write a JS mapping script that transforms each item. Much more efficient than calling insert_row per item. The script receives `item` (current array element) and `index` (position). Must return an object with column values.', input_schema: { type: 'object' as const, properties: { request_id: { type: 'string', description: 'ID from list_api_requests or __requestId from an API tool result' }, table_id: { type: 'string', description: 'Target table ID' }, path: { type: 'string', description: 'Dot-path to the array in the response (e.g. "articles" or "data.results"). Omit if the response itself is an array.' }, indices: { type: 'array', items: { type: 'number' }, description: 'Which array indices to process. Omit to process all items.' }, script: { type: 'string', description: 'JS mapping script. Receives `item` and `index`. Must return a row object.' } }, required: ['request_id', 'table_id', 'script'] } },
      { name: 'list_goals',      description: 'List current goals and tasks.', input_schema: { type: 'object' as const, properties: { status: { type: 'string' }, type: { type: 'string' } }, required: [] } },
      { name: 'list_schedules',  description: 'List all cron schedules for this agent.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
      { name: 'list_flow_runs',  description: 'List recent flow execution history — what flows ran, their inputs/outputs, duration, and whether an evaluate step passed or failed. Useful for diagnosing why a flow failed or checking what was done recently.', input_schema: { type: 'object' as const, properties: { flow_name: { type: 'string', description: 'Filter by flow name (partial match)' }, limit: { type: 'number', description: 'Max rows to return (default 20)' } }, required: [] } },
      { name: 'explain_flow_run', description: 'Look up your own stored reasoning for past flow calls. Use when the user asks "why did you call X?" or "what were you thinking when you did Y?". Returns the reasoning text, goal context, model used, and outcome for each matched run.', input_schema: { type: 'object' as const, properties: { flow_name: { type: 'string', description: 'Filter by flow name (partial match)' }, since: { type: 'string', description: 'ISO timestamp — only return runs after this time' }, limit: { type: 'number', description: 'Max runs to return (default 5)' } }, required: [] } },
    ];

    const anthropic = new Anthropic({ apiKey });

    // 4. Build initial message history — inject previous conversation so the
    //    agent has context of what was said before, then add the new user message.
    const conversationMessages: Anthropic.Messages.MessageParam[] = [
      ...(history ?? []) as Anthropic.Messages.MessageParam[],
      { role: 'user', content: userInput },
    ];

    // Persist user message (only the new one — history is already in DB)
    await db.insert(messages).values({
      id: uuidv4(),
      runId,
      role: 'user',
      content: JSON.stringify(userInput),
    });

    // Update run to running — also stamp the model that will handle this session (T3)
    await db.update(runs).set({ status: 'running', modelId: agent.model, updatedAt: new Date().toISOString() }).where(eq(runs.id, runId));

    // 5. Orchestration loop
    while (!ac.signal.aborted) {
      const response = await anthropic.messages.create({
        model: agent.model,
        max_tokens: 8096,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        system: effectiveSystemPrompt,
        messages: conversationMessages,
      });

      // Persist and emit assistant message
      const assistantContent = response.content;
      await db.insert(messages).values({
        id: uuidv4(),
        runId,
        role: 'assistant',
        content: JSON.stringify(assistantContent),
      });

      emit?.({ type: 'message', role: 'assistant', content: assistantContent });

      // Mirror text to Telegram if the agent has credentials configured
      if (agent.telegramKeyEncrypted && agent.telegramChatId) {
        const tgToken = decrypt(agent.telegramKeyEncrypted);
        if (tgToken) {
          const textBlocks = (assistantContent as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === 'text' && b.text?.trim())
            .map((b) => b.text!.trim())
            .join('\n');
          if (textBlocks) {
            const chunks = [];
            for (let i = 0; i < textBlocks.length; i += 4000) chunks.push(textBlocks.slice(i, i + 4000));
            for (const chunk of chunks) {
              sendTelegramMessage(chunk, tgToken, agent.telegramChatId).catch(() => {/* non-fatal */});
            }
          }
        }
      }

      conversationMessages.push({ role: 'assistant', content: assistantContent });

      if (response.stop_reason === 'end_turn') {
        break;
      }

      if (response.stop_reason === 'tool_use') {
        // T1 — extract reasoning: the text the agent wrote before its tool calls this turn
        const reasoningText = (assistantContent as Array<{ type?: string; text?: string }>)
          .filter((b) => b?.type === 'text' && b.text?.trim())
          .map((b) => b.text!.trim())
          .join('\n')
          .trim() || undefined;

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const block of assistantContent) {
          if (block.type !== 'tool_use') continue;
          if (ac.signal.aborted) break;

          const correlationId = block.id;
          const matchedFlow = agentFlows.find((f) => f.name === block.name);
          const toolDef = (!matchedFlow) ? agentTools.find((t) => t.name === block.name) : undefined;
          const apiToolDef = (!matchedFlow && !toolDef) ? agentApiTools.find((t) => t.name === block.name && t.enabled) : undefined;

          emit?.({
            type: 'tool_call',
            toolName: block.name,
            input: block.input,
            correlationId,
          });

          let resultStr: string;
          let errorStr: string | undefined;

          if (block.name === 'recall_memory') {
            try {
              resultStr = await handleRecallMemory(block.input as { entity: string; limit?: number });
            } catch (err) {
              errorStr = err instanceof Error ? err.message : String(err);
              resultStr = JSON.stringify({ error: errorStr });
            }
          } else if (block.name === 'store_memory') {
            try {
              resultStr = await handleStoreMemory(
                block.input as { content: string; category?: string; entities?: string[]; hint?: string },
                agentId,
                agent.name,
              );
            } catch (err) {
              errorStr = err instanceof Error ? err.message : String(err);
              resultStr = JSON.stringify({ error: errorStr });
            }
          } else if (block.name === 'list_tools') {
            const allTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
            resultStr = JSON.stringify(allTools.map((t) => ({ id: t.id, name: t.name, description: t.description, toolType: t.toolType })));
          } else if (block.name === 'list_api_tools') {
            const allApiTools = await db.select().from(apiTools).where(eq(apiTools.agentId, agentId));
            resultStr = JSON.stringify(allApiTools.map((t) => ({ id: t.id, name: t.name, description: t.description, type: t.type, enabled: t.enabled, inputSchema: (() => { try { return JSON.parse(t.inputSchema); } catch { return {}; } })() })));
          } else if (block.name === 'list_flows') {
            const allFlows = await db.select().from(flows).where(eq(flows.agentId, agentId));
            resultStr = JSON.stringify(allFlows.map((f) => ({ id: f.id, name: f.name, description: f.description })));
          } else if (block.name === 'list_tables') {
            const allTables = await db.select().from(tables).where(eq(tables.agentId, agentId));
            resultStr = JSON.stringify(allTables.map((t) => ({ id: t.id, name: t.name, columns: (() => { try { return JSON.parse(t.columns); } catch { return []; } })() })));
          } else if (block.name === 'query_table') {
            const inp = block.input as { table_id: string; limit?: number };
            const limit = Math.min(inp.limit ?? 20, 100);
            const resolvedQtId = await resolveTableId(db, agentId, inp.table_id);
            if (!resolvedQtId) { resultStr = JSON.stringify({ count: 0, rows: [], error: `Table "${inp.table_id}" not found. Call list_tables to see available tables.` }); }
            else {
              const tableRows = await db.select().from(rows).where(eq(rows.tableId, resolvedQtId)).orderBy(desc(rows.createdAt)).limit(limit);
              resultStr = JSON.stringify({ count: tableRows.length, rows: tableRows.map((r) => ({ id: r.id, data: (() => { try { return JSON.parse(r.data); } catch { return r.data; } })(), createdAt: r.createdAt })) });
            }
          } else if (block.name === 'insert_row') {
            const inp = block.input as { table_id: string; data: Record<string, unknown> };
            const resolvedIrId = await resolveTableId(db, agentId, inp.table_id);
            if (!resolvedIrId) { resultStr = JSON.stringify({ success: false, error: `Table "${inp.table_id}" not found. Call list_tables to see available tables.` }); }
            else {
              const newId = uuidv4();
              // T4 — attribute the write to the current run so rows can be traced back to their origin
              await db.insert(rows).values({ id: newId, tableId: resolvedIrId, data: JSON.stringify(inp.data ?? {}), runId });
              resultStr = JSON.stringify({ success: true, row_id: newId });
            }
          } else if (block.name === 'list_api_requests') {
            const inp = block.input as { tool_name?: string; limit?: number };
            const limit = Math.min(inp.limit ?? 20, 50);
            let query = db.select({
              id: apiRequestLog.id,
              toolName: apiRequestLog.toolName,
              input: apiRequestLog.input,
              durationMs: apiRequestLog.durationMs,
              createdAt: apiRequestLog.createdAt,
            }).from(apiRequestLog).where(eq(apiRequestLog.agentId, agentId))
              .orderBy(desc(apiRequestLog.createdAt)).limit(limit);
            const reqRows = await query;
            // Optionally filter by tool_name
            const filtered = inp.tool_name
              ? reqRows.filter((r) => r.toolName.toLowerCase().includes(inp.tool_name!.toLowerCase()))
              : reqRows;
            // Include a preview of the response (first 200 chars) so the agent can identify which request to use
            const withPreview = await Promise.all(filtered.map(async (r) => {
              const [full] = await db.select({ response: apiRequestLog.response }).from(apiRequestLog).where(eq(apiRequestLog.id, r.id));
              const preview = full?.response?.slice(0, 300) ?? '';
              return { ...r, responsePreview: preview };
            }));
            resultStr = JSON.stringify({ count: withPreview.length, requests: withPreview });
          } else if (block.name === 'inject_rows') {
            const inp = block.input as InjectRowsInput;
            const resolvedInjectId = await resolveTableId(db, agentId, inp.table_id);
            if (!resolvedInjectId) { resultStr = JSON.stringify({ ok: false, inserted: 0, failed: 0, errors: [{ index: -1, error: `Table "${inp.table_id}" not found. Call list_tables to see available tables.` }], rowIds: [] }); }
            else {
              const injectResult = await executeInjectRows(agentId, { ...inp, table_id: resolvedInjectId, runId });
              resultStr = JSON.stringify(injectResult);
            }
          } else if (block.name === 'list_goals') {
            const inp = block.input as { status?: string; type?: string };
            let allGoals = await db.select().from(goals).where(eq(goals.agentId, agentId)).orderBy(goals.priority, desc(goals.createdAt));
            if (inp.status) allGoals = allGoals.filter((g) => g.status === inp.status);
            else allGoals = allGoals.filter((g) => g.status !== 'completed' && g.status !== 'cancelled');
            if (inp.type) allGoals = allGoals.filter((g) => g.type === inp.type);
            resultStr = JSON.stringify({ total: allGoals.length, goals: allGoals.map((g) => ({ id: g.id, type: g.type, title: g.title, status: g.status, priority: g.priority, notes: g.notes })) });
          } else if (block.name === 'list_schedules') {
            const allSchedules = await db.select().from(schedules).where(eq(schedules.agentId, agentId));
            resultStr = JSON.stringify(allSchedules);
          } else if (block.name === 'list_flow_runs') {
            const inp = block.input as { flow_name?: string; limit?: number };
            const limit = Math.min(inp.limit ?? 20, 100);
            let recentRuns = await db.select().from(flowRuns).where(eq(flowRuns.agentId, agentId)).orderBy(desc(flowRuns.createdAt)).limit(limit);
            if (inp.flow_name) recentRuns = recentRuns.filter((r) => r.flowName.includes(inp.flow_name!));
            resultStr = JSON.stringify({
              total: recentRuns.length,
              runs: recentRuns.map((r) => ({
                id: r.id,
                flowName: r.flowName,
                success: r.success,
                durationMs: r.durationMs,
                evaluationPassed: r.evaluationPassed,
                evaluationReason: r.evaluationReason,
                error: r.error,
                createdAt: r.createdAt,
              })),
            });
          } else if (block.name === 'explain_flow_run') {
            // T6 — let the agent query its own stored reasoning for past flow calls
            const inp = block.input as { flow_name?: string; since?: string; limit?: number };
            const limit = Math.min(inp.limit ?? 5, 20);
            let recentRuns = await db.select().from(flowRuns).where(eq(flowRuns.agentId, agentId)).orderBy(desc(flowRuns.createdAt)).limit(50);
            if (inp.flow_name) recentRuns = recentRuns.filter((r) => r.flowName.includes(inp.flow_name!));
            if (inp.since) recentRuns = recentRuns.filter((r) => r.createdAt >= inp.since!);
            recentRuns = recentRuns.slice(0, limit);
            resultStr = JSON.stringify({
              total: recentRuns.length,
              runs: recentRuns.map((r) => ({
                id: r.id,
                flowName: r.flowName,
                reasoning: r.reasoning ?? null,
                goalId: r.goalId ?? null,
                modelId: r.modelId ?? null,
                success: r.success,
                evaluationPassed: r.evaluationPassed,
                evaluationReason: r.evaluationReason,
                error: r.error,
                durationMs: r.durationMs,
                createdAt: r.createdAt,
              })),
            });
          } else if (matchedFlow) {
            try {
              resultStr = await runFlow(
                matchedFlow,
                block.input as Record<string, unknown>,
                agentId,
                {
                  userMessage: userInput,
                  suppressionToken: suppressionToken ?? undefined,
                  apiKey,
                  emit: emit as ((event: { type: string; role?: string; content?: unknown }) => void) | undefined,
                  reasoning: reasoningText,  // T1 — why the agent decided to call this flow
                  modelId: agent.model,      // T3 — which model made this decision
                  runId,                     // T4 — link flow_run → run for attribution
                },
              );
            } catch (err) {
              errorStr = err instanceof Error ? err.message : String(err);
              resultStr = JSON.stringify({ error: errorStr });
            }
          } else if (apiToolDef) {
            try {
              const config = JSON.parse(apiToolDef.config) as Record<string, unknown>;
              const result = await runApiToolThrottled(apiToolDef.type, config, block.input as Record<string, unknown>, resolvedSecrets, agentId, secretRateLimits, apiToolDef.name);
              resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            } catch (err) {
              errorStr = err instanceof Error ? err.message : String(err);
              resultStr = JSON.stringify({ error: errorStr });
            }
          } else if (!toolDef) {
            errorStr = `Tool "${block.name}" not found`;
            resultStr = JSON.stringify({ error: errorStr });
          } else {
            try {
              resultStr = await runTool(
                toolDef,
                block.input as Record<string, unknown>,
                agentId,
              );
            } catch (err) {
              errorStr = err instanceof Error ? err.message : String(err);
              resultStr = JSON.stringify({ error: errorStr });
            }
          }

          emit?.({ type: 'tool_result', correlationId, result: resultStr, error: errorStr });

          // Fire-and-forget background memory storage (skip for memory tools themselves)
          if (!errorStr && !MANAGEMENT_TOOL_NAMES.has(block.name)) {
            storeToMemory({
              raw: resultStr,
              toolName: block.name,
              toolInput: block.input as Record<string, unknown>,
              agentId,
              agentName: agent.name,
              apiKey,
            }).catch((e) => logger.error({ err: e, agentId }, 'Memory: storeToMemory failed'));
          }

          // Persist tool result as a message
          const toolResultContent = [
            {
              type: 'tool_result' as const,
              tool_use_id: correlationId,
              content: resultStr,
            },
          ];
          await db.insert(messages).values({
            id: uuidv4(),
            runId,
            role: 'tool_result',
            content: JSON.stringify(toolResultContent),
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: correlationId,
            content: resultStr,
          });
        }

        if (toolResults.length > 0) {
          conversationMessages.push({ role: 'user', content: toolResults });
        }
        continue;
      }

      // Any other stop reason → break
      break;
    }

    const finalStatus = ac.signal.aborted ? 'stopped' : 'completed';
    await db.update(runs).set({ status: finalStatus, updatedAt: new Date().toISOString() }).where(eq(runs.id, runId));
    emit?.({ type: 'done', runId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await db.update(runs).set({ status: 'failed', error: errMsg, updatedAt: new Date().toISOString() }).where(eq(runs.id, runId));
    emit?.({ type: 'error', message: errMsg });
  } finally {
    abortControllers.delete(runId);
    unregisterAbort(runId);
  }
}
