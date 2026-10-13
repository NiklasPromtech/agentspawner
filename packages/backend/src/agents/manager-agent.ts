/**
 * Autonomous Orchestrator — Continuous Operation Edition
 *
 * Uses claude-haiku (cheap) for the continuous reasoning loop so it can run all
 * day without a big bill. When it needs to generate tool code it delegates to
 * the agent's configured model (one-off, higher quality).
 *
 * The agent runs CONTINUOUSLY until the user stops it or there is truly nothing
 * left to do. Instead of "ending sessions", it does periodic supervisor check-ins
 * which trigger a manager review, then the agent continues with the directive.
 *
 * The agent can:
 *   Memory    — recall, store, browse, clean up
 *   Flows     — list, create, update, delete, TEST
 *   Tools     — list, AI-generate-and-save, update, delete, TEST
 *   Tables    — list, create, query, insert, delete
 *   Schedules — list, create, delete
 *   Status    — announce what it's working on right now
 *   Check-in  — supervisor_checkin: save progress, get manager directive, CONTINUE
 *   Stop      — stop_working: only when truly nothing left to do
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { getDb } from '../db/index.js';
import {
  agents,
  tools,
  runs,
  messages,
  flows,
  schedules,
  memory,
  tables,
  rows,
  goals,
  performanceLog,
  apiTools,
  agentSecrets,
  flowRuns,
  actionLog,
  contacts,
  apiRequestLog,
} from '../db/schema.js';
import { eq, desc, like, and } from 'drizzle-orm';
import { decrypt } from '../crypto/index.js';
import { v4 as uuidv4 } from 'uuid';
import { runTool } from '../orchestrator/tool-runner.js';
import { runFlow, runFlowDetailed, type FlowStep, type InputExpression } from '../orchestrator/flow-runner.js';
import { storeToMemory } from '../memory/librarian.js';
import { reloadSchedules } from '../scheduler/index.js';
import type { SseEmitter } from '../features/runs/runs.routes.js';
import { registerAbort, unregisterAbort } from '../orchestrator/abort-registry.js';
import { runScrapeFlowAgent } from './autonomous/scrape-flow-agent.js';
import { runActionFlowAgent } from './autonomous/action-flow-agent.js';
import { runApiToolThrottled } from '../orchestrator/api-tool-runner-throttled.js';
import { executeInjectRows } from '../features/tables/inject-rows.js';
import { drainNudges } from '../orchestrator/nudge-registry.js';
import { getWebSearchToolDef } from '../orchestrator/tool-types/web-search.js';
import { logger } from '../lib/logger.js';
// sendReviewTab import removed — pendingActions queue_action no longer opens review tabs
// (OPERATION CONVERGENCE Task 4.5)

// ── Constants ─────────────────────────────────────────────────────────────────

const AUTONOMOUS_MODEL = 'claude-haiku-4-5-20251001';
// High iteration cap — the agent runs all day. Real stops come from:
// (a) user pressing Stop (AbortController), (b) stop_working tool, (c) budget throttle.
const MAX_ITERATIONS = 1000;

// Max characters for a single tool result in the conversation history.
// Prevents base64 images, huge HTML pages, etc. from blowing up the context.
const MAX_TOOL_RESULT_CHARS = 8_000;

/**
 * Resolve a table identifier to its UUID.
 * Accepts either the actual UUID or the table name (case-insensitive).
 * Returns null if no matching table is found for this agent.
 */
async function resolveTableId(db: ReturnType<typeof getDb>, agentId: string, tableIdOrName: string): Promise<string | null> {
  // Try direct UUID match first
  const [byId] = await db.select({ id: tables.id }).from(tables).where(and(eq(tables.id, tableIdOrName), eq(tables.agentId, agentId)));
  if (byId) return byId.id;
  // Fall back to name match
  const [byName] = await db.select({ id: tables.id }).from(tables).where(and(eq(tables.name, tableIdOrName), eq(tables.agentId, agentId)));
  return byName?.id ?? null;
}

// When input tokens exceed this threshold after a response, compact the history.
const COMPACT_AT_INPUT_TOKENS = 140_000;

// Haiku pricing (per token) — used for cost tracking and budget throttling
const HAIKU_INPUT_COST  = 0.80 / 1_000_000;  // $0.80 / M input tokens
const HAIKU_OUTPUT_COST = 4.00 / 1_000_000;  // $4.00 / M output tokens

function computeIterationCost(inputTokens: number, outputTokens: number): number {
  return inputTokens * HAIKU_INPUT_COST + outputTokens * HAIKU_OUTPUT_COST;
}

// extractActionUrl + extractProposedContent REMOVED (OPERATION CONVERGENCE Task 4.5)
// These helpers were only used by the dead queue_action tool.

async function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Truncate a tool result string so it never balloons the context window. */
function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  const kept = result.slice(0, MAX_TOOL_RESULT_CHARS);
  return kept + `\n\n[... truncated ${result.length - MAX_TOOL_RESULT_CHARS} chars to stay within context limits ...]`;
}

/**
 * Compact the conversation history when it's getting too long.
 * Summarises everything so far with a single cheap Haiku call, then replaces
 * the history with one "user" message containing the compact summary plus the
 * original wake-up prompt so the agent retains its mission.
 */
async function compactConversation(
  conversationMessages: Anthropic.Messages.MessageParam[],
  systemPrompt: string,
  apiKey: string,
  wakeUpPrompt: string,
  emit?: SseEmitter,
): Promise<Anthropic.Messages.MessageParam[]> {
  emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '🔄 Compacting conversation history to free up context space...' }], source: 'manager' });

  const anthropic = new Anthropic({ apiKey });

  // Build a readable transcript for the summariser
  const transcript = conversationMessages.map((m) => {
    const roleLabel = m.role === 'user' ? 'USER/TOOL_RESULTS' : 'ASSISTANT';
    const contentStr = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content).slice(0, 3000);
    return `[${roleLabel}]: ${contentStr}`;
  }).join('\n\n').slice(0, 60_000); // don't send more than ~60k chars to summariser

  let summary = '';
  try {
    const resp = await anthropic.messages.create({
      model: AUTONOMOUS_MODEL,
      max_tokens: 2048,
      system: 'You are a summarisation assistant. Summarise the autonomous agent session transcript below into a concise but complete status update. Include: what tasks were completed, what was created (tools/flows/tables/schedules), key findings stored in memory, and any remaining work the agent noted. Be thorough but concise — this summary replaces the full history.',
      messages: [{ role: 'user', content: `SYSTEM PROMPT:\n${systemPrompt.slice(0, 2000)}\n\nTRANSCRIPT:\n${transcript}` }],
    });
    summary = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');
  } catch {
    summary = '[Compaction failed — continuing with partial history]';
  }

  emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `✅ Conversation compacted. Summary:\n${summary}` }], source: 'manager' });

  // Return a fresh history: original wake-up + compact summary
  return [
    { role: 'user', content: wakeUpPrompt },
    { role: 'assistant', content: [{ type: 'text', text: `[COMPACTED SESSION HISTORY]\n\n${summary}\n\nContinuing autonomous work...` }] },
  ];
}

// ── Meta-prompt ───────────────────────────────────────────────────────────────

const AUTONOMOUS_META_PROMPT = readFileSync(join(__dirname, 'autonomous/meta.prompt.md'), 'utf-8').trim();

// ── Tool-generation system prompt (mirrors generate-tool.ts) ─────────────────

const GENERATE_TOOL_SYSTEM_PROMPT = readFileSync(join(__dirname, 'generate-tool.prompt.md'), 'utf-8').trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

async function generateToolWithAI(
  description: string,
  toolType: string,
  apiKey: string,
  agentModel: string,
): Promise<{ name: string; description: string; inputSchema: string; code: string; toolType: string }> {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: agentModel, // Use agent's configured model for quality code generation
    max_tokens: 2048,
    system: GENERATE_TOOL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Tool type: ${toolType}\n\nDescription: ${description}` }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  const nameMatch = text.match(/^NAME:\s*(.+)$/m);
  const descMatch = text.match(/^DESCRIPTION:\s*(.+)$/m);
  const schemaMatch = text.match(/^SCHEMA:\s*\n([\s\S]*?)(?=\nCODE:|\n```|$)/m);
  const codeMatch = text.match(/```javascript\s*([\s\S]*?)```/);

  if (!nameMatch || !descMatch) {
    throw new Error('AI did not return a valid tool definition. Raw: ' + text.slice(0, 300));
  }

  let inputSchema = '{"type":"object","properties":{},"required":[]}';
  if (schemaMatch?.[1]) {
    try {
      inputSchema = JSON.stringify(JSON.parse(schemaMatch[1].trim()));
    } catch { /* keep default */ }
  }

  return {
    name: nameMatch[1]!.trim(),
    description: descMatch[1]!.trim(),
    inputSchema,
    code: codeMatch ? codeMatch[1]!.trim() : '',
    toolType,
  };
}

// Translate the agent-friendly step format into the internal FlowStep format.
// Agent provides step_index (0-based) for referencing previous steps by position.
function buildFlowSteps(
  rawSteps: Array<{
    label: string;
    tool_id: string;
    inputs: Record<string, {
      type: 'literal' | 'flow_input' | 'step_ref';
      value?: unknown;
      key?: string;
      step_index?: number;
      path?: string;
    }>;
  }>,
): FlowStep[] {
  // Pre-assign UUIDs for all steps so we can build step_ref references
  const stepIds = rawSteps.map(() => uuidv4());

  return rawSteps.map((raw, i) => {
    const inputMapping: Record<string, InputExpression> = {};

    for (const [field, expr] of Object.entries(raw.inputs)) {
      if (expr.type === 'literal') {
        inputMapping[field] = { type: 'literal', value: expr.value };
      } else if (expr.type === 'flow_input') {
        inputMapping[field] = { type: 'flow_input', key: expr.key ?? field };
      } else if (expr.type === 'step_ref') {
        const refIndex = expr.step_index ?? (i - 1);
        if (refIndex < 0 || refIndex >= rawSteps.length) {
          throw new Error(`step_ref in step ${i} has invalid step_index ${refIndex}`);
        }
        inputMapping[field] = { type: 'step_ref', stepId: stepIds[refIndex]!, path: expr.path ?? '' };
      }
    }

    return {
      id: stepIds[i]!,
      toolId: raw.tool_id,
      label: raw.label,
      inputMapping,
    };
  });
}

// ── Management tool definitions ───────────────────────────────────────────────

const MANAGEMENT_TOOLS: Anthropic.Messages.Tool[] = [
  // ── Runs ──────────────────────────────────────────────────────────────────
  {
    name: 'list_recent_runs',
    description: 'List recent runs for this agent — status, trigger, input, errors. Use this first to understand what has been done.',
    input_schema: {
      type: 'object' as const,
      properties: { limit: { type: 'number', description: 'Max runs (default 20)' } },
      required: [],
    },
  },

  // ── Memory ────────────────────────────────────────────────────────────────
  {
    name: 'recall_memory',
    description: 'Search shared memory for known information. Always call before live research on any entity you may have seen before.',
    input_schema: {
      type: 'object' as const,
      properties: {
        entity: { type: 'string', description: 'Handle, name, or keyword to search' },
        limit: { type: 'number', description: 'Max entries (default 50)' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'list_memory_by_category',
    description: 'Browse memory entries by category: profile, post, interaction, research, market_data, web_content, data, agent_status, other.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Category to filter by' },
        limit: { type: 'number', description: 'Max entries (default 30)' },
      },
      required: ['category'],
    },
  },
  {
    name: 'store_memory',
    description: 'Save an insight, learning, or important fact to shared memory for future sessions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string' },
        category: { type: 'string', description: 'profile | post | interaction | research | market_data | web_content | data | other' },
        entities: { type: 'array', items: { type: 'string' } },
        hint: { type: 'string' },
      },
      required: ['content'],
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a specific memory entry by ID (use list_memory_by_category to find IDs).',
    input_schema: {
      type: 'object' as const,
      properties: { memory_id: { type: 'string' } },
      required: ['memory_id'],
    },
  },

  // ── Tools ─────────────────────────────────────────────────────────────────
  {
    name: 'list_tools',
    description: 'List all tools available to this agent. Returns id, name, description, toolType. Use tool IDs when creating flows.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'list_api_tools',
    description: 'List all custom API tools (HTTP/script tools) available to this agent. These tools call external APIs or run scripts. Call this if you are unsure whether a specific API tool exists or to discover available API integrations.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'generate_tool',
    description: 'Use AI to generate a new tool and save it. Describe what you want and the tool type (extension, local, web_fetch, web_search). The agent\'s main model (not Haiku) writes the code for quality. Returns the saved tool ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'What the tool should do' },
        tool_type: {
          type: 'string',
          enum: ['extension', 'local', 'web_fetch', 'web_search'],
          description: 'extension=browser automation, local=server-side JS with DB access, web_fetch=HTTP fetch, web_search=Anthropic search',
        },
      },
      required: ['description', 'tool_type'],
    },
  },
  {
    name: 'update_tool',
    description: 'Update a tool\'s description or code. Use test_tool first to verify the change works.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tool_id: { type: 'string' },
        description: { type: 'string' },
        code: { type: 'string' },
      },
      required: ['tool_id'],
    },
  },
  {
    name: 'delete_tool',
    description: 'Delete a tool by ID. Make sure no flows are using it first.',
    input_schema: {
      type: 'object' as const,
      properties: { tool_id: { type: 'string' } },
      required: ['tool_id'],
    },
  },
  {
    name: 'test_tool',
    description: 'Run a tool with given input and return the result. Works for both regular tools (use UUID from list_tools) and API tools (use UUID or name from list_api_tools). Always test before putting into production.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tool_id: { type: 'string', description: 'Tool UUID from list_tools, or UUID/name from list_api_tools' },
        input: { type: 'object', description: 'Input parameters matching the tool schema', additionalProperties: true },
      },
      required: ['tool_id', 'input'],
    },
  },

  // ── Flows ─────────────────────────────────────────────────────────────────
  {
    name: 'list_flows',
    description: 'List all flows for this agent — id, name, description.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_flow',
    description: `Create a new flow that chains tools together. Steps reference tools by UUID (get from list_tools).
Each step input uses one of:
  {"type":"literal","value":42}
  {"type":"flow_input","key":"my_param"}
  {"type":"step_ref","step_index":0,"path":"results"}
where step_index is 0-based. The flow's input_schema defines what callers must provide.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'snake_case flow name' },
        description: { type: 'string' },
        input_schema: {
          type: 'object',
          description: 'JSON Schema object defining the flow\'s inputs',
          additionalProperties: true,
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              tool_id: { type: 'string', description: 'UUID from list_tools' },
              inputs: { type: 'object', additionalProperties: true },
            },
            required: ['label', 'tool_id', 'inputs'],
          },
        },
      },
      required: ['name', 'description', 'input_schema', 'steps'],
    },
  },
  {
    name: 'update_flow',
    description: 'Update a flow\'s name, description, input_schema, or steps.',
    input_schema: {
      type: 'object' as const,
      properties: {
        flow_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        input_schema: { type: 'object', additionalProperties: true },
        steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['flow_id'],
    },
  },
  {
    name: 'delete_flow',
    description: 'Delete a flow by ID.',
    input_schema: {
      type: 'object' as const,
      properties: { flow_id: { type: 'string' } },
      required: ['flow_id'],
    },
  },
  {
    name: 'test_flow',
    description: 'Run a flow with given input and return the full result including each step\'s output. Use this to verify a flow works before scheduling it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        flow_id: { type: 'string' },
        input: { type: 'object', description: 'Input matching the flow\'s input_schema', additionalProperties: true },
      },
      required: ['flow_id', 'input'],
    },
  },

  // ── Tables ────────────────────────────────────────────────────────────────
  {
    name: 'list_tables',
    description: 'List all data tables for this agent — id, name, columns.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_table',
    description: 'Create a new data table to store structured data.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Table name (e.g. leads, profiles)' },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', description: 'text, number, boolean, json' },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['name', 'columns'],
    },
  },
  {
    name: 'query_table',
    description: 'Read rows from a table. Use this to check what data has been collected or verify inserts worked.',
    input_schema: {
      type: 'object' as const,
      properties: {
        table_id: { type: 'string' },
        limit: { type: 'number', description: 'Max rows to return (default 20)' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'insert_row',
    description: 'Insert a test row into a table to verify the table schema works.',
    input_schema: {
      type: 'object' as const,
      properties: {
        table_id: { type: 'string' },
        data: { type: 'object', description: 'Row data as key-value pairs', additionalProperties: true },
      },
      required: ['table_id', 'data'],
    },
  },
  {
    name: 'list_api_requests',
    description: 'List recent stored API responses (from API tool calls). Returns request IDs that can be used with inject_rows for bulk data inserts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tool_name: { type: 'string', description: 'Filter by tool name (optional)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'inject_rows',
    description: 'Bulk-insert rows into a table from a stored API response. Write a JS mapping script that transforms each item into a table row. MUCH more efficient than calling insert_row per item — use this when you have an API response with multiple items to store. The script receives `item` (current array element) and `index` (position). Must return an object with column values.',
    input_schema: {
      type: 'object' as const,
      properties: {
        request_id: { type: 'string', description: 'ID from list_api_requests or __requestId from an API tool result' },
        table_id: { type: 'string', description: 'Target table ID' },
        path: { type: 'string', description: 'Dot-path to the array in the response (e.g. "articles" or "data.results"). Omit if the response itself is an array.' },
        indices: { type: 'array', items: { type: 'number' }, description: 'Which array indices to process. Omit to process all items.' },
        script: { type: 'string', description: 'JS mapping script. Receives `item` and `index`. Must return a row object.' },
      },
      required: ['request_id', 'table_id', 'script'],
    },
  },
  {
    name: 'delete_table',
    description: 'Delete a table and all its rows.',
    input_schema: {
      type: 'object' as const,
      properties: { table_id: { type: 'string' } },
      required: ['table_id'],
    },
  },

  // ── Flow Runs ──────────────────────────────────────────────────────────────
  {
    name: 'list_flow_runs',
    description: 'List recent flow execution history — what flows ran, their inputs/outputs, duration, and whether an evaluate step passed or failed. Use this to check if a flow worked, diagnose failures, or understand what was done in previous sessions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        flow_name: { type: 'string', description: 'Filter by flow name (partial match)' },
        limit: { type: 'number', description: 'Max rows to return (default 20, max 100)' },
      },
      required: [],
    },
  },

  // ── Schedules ─────────────────────────────────────────────────────────────
  {
    name: 'list_schedules',
    description: 'List all cron schedules for this agent — id, cron, input, enabled, lastRunAt.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_schedule',
    description: 'Create a cron schedule. Set input to "__wake_up__" to schedule an autonomous session. Use 5-field cron syntax.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cron: { type: 'string', description: '5-field cron e.g. "0 9 * * *" for 9 AM daily' },
        input: { type: 'string', description: 'Prompt for the run. Use "__wake_up__" for autonomous sessions.' },
        timezone: { type: 'string', description: 'Timezone (default: Europe/Stockholm)' },
      },
      required: ['cron', 'input'],
    },
  },
  {
    name: 'delete_schedule',
    description: 'Delete a schedule by ID.',
    input_schema: {
      type: 'object' as const,
      properties: { schedule_id: { type: 'string' } },
      required: ['schedule_id'],
    },
  },

  // ── Goals ─────────────────────────────────────────────────────────────────
  {
    name: 'list_goals',
    description: 'List all goals — mission, objectives, and tasks — with status, priority, and progress notes. Call this right after orient to understand what you should be working on.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter: pending | in_progress | completed | blocked | cancelled. Omit for all active.' },
        type: { type: 'string', description: 'Filter: mission | objective | task. Omit for all.' },
      },
      required: [],
    },
  },
  {
    name: 'create_goal',
    description: 'Create a new goal. Use type="mission" for top-level purpose, "objective" for measurable outcomes, "task" for concrete actionable steps.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string' },
        type: { type: 'string', enum: ['mission', 'objective', 'task'], description: 'mission | objective | task (default: task)' },
        description: { type: 'string', description: 'Details about this goal' },
        parent_id: { type: 'string', description: 'Parent goal ID — e.g. set an objective under a mission, or a task under an objective' },
        priority: { type: 'number', description: '1=critical, 2=high, 3=normal (default), 4=low' },
        due_date: { type: 'string', description: 'ISO date e.g. 2026-03-20' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_goal',
    description: 'Update a goal\'s status, notes, or fields. Mark in_progress when starting work, completed when done, blocked with notes explaining what\'s blocking you.',
    input_schema: {
      type: 'object' as const,
      properties: {
        goal_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
        notes: { type: 'string', description: 'Progress notes — what was done, what was found, what is next' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number', description: '1=critical, 2=high, 3=normal, 4=low' },
        due_date: { type: 'string' },
      },
      required: ['goal_id'],
    },
  },
  {
    name: 'delete_goal',
    description: 'Delete a goal by ID. Use when a goal is no longer relevant (prefer updating status to "cancelled" instead).',
    input_schema: {
      type: 'object' as const,
      properties: { goal_id: { type: 'string' } },
      required: ['goal_id'],
    },
  },

  // ── Tool Health ───────────────────────────────────────────────────────────
  {
    name: 'check_tool_health',
    description: 'Audit all tools — validates configuration (schema JSON, code present for code-based tools) and reports any issues. Stores results to memory as category "tool_health". Run this at the start of a session to catch broken tools.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },

  {
    name: 'request_capability',
    description: 'Formally request a new capability from the manager. The manager will check if an existing flow already covers this need before building anything new. Use this when you need a browser automation capability that does not appear in your available flows. The manager will review, decide whether to reuse or build, and return what to do.',
    input_schema: {
      type: 'object' as const,
      properties: {
        capability_description: { type: 'string', description: 'What you need in plain terms. Include: what website/platform, what action or data, what inputs you\'ll provide, what output you expect. Example: "I need to reply to a DM thread on X/Twitter. Input: thread_url and reply_text. Should navigate to thread, find the reply box, type reply_text, click Send, return { success, error }."' },
        why_needed: { type: 'string', description: 'What goal or task requires this capability. Helps manager prioritise.' },
        already_tried: { type: 'string', description: 'Optional: what existing flows you already checked and why they don\'t work for this need.' },
      },
      required: ['capability_description', 'why_needed'],
    },
  },
  {
    name: 'request_flow',
    description: 'Commission the Flow Builder to create a browser automation capability you need. Describe what you want in plain terms — the specialist AI will design the steps, build the flow from available browser primitives, test it, and return a proposal for your review. After it returns, check the steps_summary and input_schema, then either call the flow directly as a tool or use revise_flow if changes are needed. This is the ONLY way to perform browser interactions — you have no direct access to click, type, execute_code, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        task_description: { type: 'string', description: 'What capability you need in plain terms. Be specific about inputs and expected output. Example: "Given a LinkedIn post URL and comment text, navigate to the post, click the comment field, type the text, and submit it. Return success/failure."' },
        context: { type: 'string', description: 'Optional: what you already know about the page — URL structure, relevant selectors, what you tried before, any site-specific quirks' },
        test_input: { type: 'object', description: 'Optional example input to immediately validate the flow after building', additionalProperties: true },
      },
      required: ['task_description'],
    },
  },
  {
    name: 'revise_flow',
    description: 'Ask the Flow Builder to amend a flow that needs changes. The old version is deleted and rebuilt with your feedback. Use after request_flow returns a draft that is wrong, incomplete, or failing. Be specific about what needs to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        flow_id: { type: 'string', description: 'ID of the flow to revise (from the request_flow result)' },
        feedback: { type: 'string', description: 'Specific changes needed. Example: "It needs to wait for the comment box to appear before typing", or "The output should include the URL of the submitted comment"' },
        test_input: { type: 'object', description: 'Optional: new test input to validate the revised flow', additionalProperties: true },
      },
      required: ['flow_id', 'feedback'],
    },
  },

  // ── Human Approval Queue tools REMOVED (OPERATION CONVERGENCE Task 4.5)
  // queue_action, list_pending_actions, complete_action — superseded by actionLog.

  // ── Performance Log ───────────────────────────────────────────────────────
  {
    name: 'log_outcome',
    description: 'Record the outcome of an action for long-term performance tracking. Call this after any significant action (lead contacted, tool created, flow ran, etc.). This data powers the analytics dashboard and helps future sessions improve strategy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'outreach | lead | content | tool | flow | research | other' },
        action: { type: 'string', description: 'What was done, e.g. "Sent partnership pitch to @handle"' },
        outcome: { type: 'string', enum: ['success', 'failure', 'pending', 'unknown'], description: 'Result of the action' },
        value: { type: 'number', description: 'Optional numeric value (e.g. cost in USD, score 0-100, lead count)' },
        notes: { type: 'string', description: 'Details, observations, what to do differently next time' },
      },
      required: ['category', 'action', 'outcome'],
    },
  },
  {
    name: 'analyze_performance',
    description: 'Analyze the performance log to find patterns, success rates, and improvement opportunities. Returns aggregated stats by category, recent successes/failures, and trend data. Use this during REFLECT to guide strategy.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Filter to a specific category (outreach, lead, etc.). Omit for all.' },
        days: { type: 'number', description: 'How many days of history to analyse (default 30)' },
        limit: { type: 'number', description: 'Max entries to return (default 100)' },
      },
      required: [],
    },
  },

  // ── Status & Session ──────────────────────────────────────────────────────
  {
    name: 'update_status',
    description: 'Announce what you are currently working on. Call this at the start of each major task so a human can check in on your progress.',
    input_schema: {
      type: 'object' as const,
      properties: {
        current_task: { type: 'string', description: 'One sentence describing the current task' },
        plan: { type: 'string', description: 'Optional: short bullet list of what you plan to do this session' },
      },
      required: ['current_task'],
    },
  },
  {
    name: 'supervisor_checkin',
    description: 'Request a supervisor review of your progress. Saves your work as a journal entry, triggers the manager AI to analyse what you\'ve done and create fix tasks, then returns a directive for what to do next. The run CONTINUES after this — do not stop working. Call this after completing a meaningful batch of work (every ~20-30 significant actions), not after every single step.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Summary of what you accomplished since the last check-in: tasks completed, actions taken, outcomes, blockers encountered' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'stop_working',
    description: 'Stop the run entirely. ONLY call this for CRITICAL FAILURES: the API key is invalid, billing is broken, or the system is in an unrecoverable error state. NEVER stop because goals are "completed" — there is always more work to do: expand data coverage, improve existing flows, build missing tools, optimize performance, explore new sources, clean up data quality, or do maintenance. If you think you are "done", call supervisor_checkin instead and find the next productive thing to work on.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Final summary of what was accomplished this run' },
        reason: { type: 'string', description: 'Why you are stopping: critical_failure | api_key_invalid | billing_error | unrecoverable_error' },
      },
      required: ['summary', 'reason'],
    },
  },
];

const MANAGEMENT_TOOL_NAMES = new Set(MANAGEMENT_TOOLS.map((t) => t.name));

// ── Cheap-agent restrictions (task 4.2) ───────────────────────────────────────
// The autonomous loop runs on a cheap model (Haiku). These tools are stripped
// from its tool list — the cheap agent must use request_flow / request_capability instead.
// This is enforced at two layers: (1) the tools are not offered, (2) runtime handler returns
// an error if somehow invoked.
const CHEAP_AGENT_BLOCKED_TOOLS = new Set([
  'create_flow',    // must use request_flow (goes through the Flow Builder AI)
  'update_flow',    // must use revise_flow
  'delete_flow',    // destructive — manager only
  // System prompt modification would go here if a tool ever exists for it
]);

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runManagerAgent(
  runId: string,
  agentId: string,
  emit?: SseEmitter,
  budgetUsdPerHour: number = 0,  // 0 = unlimited
  recentChatMessages?: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<void> {
  const db = getDb();

  // Register abort controller so the /runs/:runId/stop endpoint can cancel this run
  const ac = new AbortController();
  registerAbort(runId, ac);

  try {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const apiKey = decrypt(agent.apiKeyEncrypted);
    if (!apiKey) throw new Error('API key not configured for this agent');

    const agentTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
    const agentFlows = await db.select().from(flows).where(eq(flows.agentId, agentId));
    const agentApiTools = await db.select().from(apiTools).where(eq(apiTools.agentId, agentId));
    const agentSecretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, agentId));
    const resolvedSecrets = Object.fromEntries(agentSecretRows.map((s) => [s.key, decrypt(s.value)]));
    const secretRateLimits = Object.fromEntries(agentSecretRows.map((s) => [s.key, s.requestsPerMinute]));

    const effectiveSystemPrompt = [agent.systemPrompt || '', AUTONOMOUS_META_PROMPT]
      .filter(Boolean)
      .join('\n\n')
      .trim();

    // Browser action tools the autonomous agent must NOT call directly.
    // These are delegated to flows via request_flow — the agent stays strategic,
    // the Flow Builder handles all DOM interaction details.
    const AUTONOMOUS_ACTION_TOOLS = new Set([
      'click', 'double_click', 'right_click',
      'type_text', 'focus', 'press_key', 'hover',
      'select_option', 'set_checkbox',
      'execute_code',
      'go_back', 'go_forward', 'reload_page',
      'wait_ms', 'wait_for_gone',
    ]);

    // All Anthropic tool definitions: native tools + read-only browser tools + flows + management tools
    // web_search is always available as a native Anthropic tool (no DB entry needed)
    // Anthropic requires input_schema to always have `type: "object"`.
    // Flows/tools saved with a bare `{}` schema would fail validation — normalise here.
    const parseInputSchema = (raw: string): Anthropic.Messages.Tool['input_schema'] => {
      let schema: Record<string, unknown>;
      try { schema = JSON.parse(raw) as Record<string, unknown>; }
      catch { schema = {}; }
      if (!schema.type) schema.type = 'object';
      return schema as Anthropic.Messages.Tool['input_schema'];
    };

    const anthropicTools: Anthropic.Messages.Tool[] = [
      getWebSearchToolDef(),
      ...agentTools
        .filter((t) => t.toolType !== 'web_search') // don't double-add if somehow in DB
        .filter((t) => !AUTONOMOUS_ACTION_TOOLS.has(t.name)) // delegate actions to Flow Builder
        .map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: parseInputSchema(t.inputSchema),
        })),
      // API tools (custom HTTP / script tools)
      ...agentApiTools
        .filter((t) => t.enabled)
        .flatMap((t) => {
          try {
            return [{
              name: t.name,
              description: `[API TOOL] ${t.description}`,
              input_schema: parseInputSchema(t.inputSchema),
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
        input_schema: parseInputSchema(f.inputSchema),
      })),
      // Strip cheap-agent-blocked tools (task 4.2) — they are not offered to the autonomous loop.
      // The cheap agent uses request_flow / revise_flow for all flow management.
      ...MANAGEMENT_TOOLS.filter((t) => !CHEAP_AGENT_BLOCKED_TOOLS.has(t.name)),
    ];

    const anthropic = new Anthropic({ apiKey });

    // ── Auto-load context so the agent wakes up knowing what happened ────────
    // ── Session briefing: action log + contacts (task 4.4) ───────────────────
    // Load the last 30 action log entries so the agent knows what it's already done
    const recentActionLog = await db
      .select()
      .from(actionLog)
      .where(eq(actionLog.agentId, agentId))
      .orderBy(desc(actionLog.createdAt))
      .limit(30);

    // Load contacts by status for outreach awareness
    const contactSummary = await db
      .select()
      .from(contacts)
      .where(eq(contacts.agentId, agentId))
      .orderBy(desc(contacts.updatedAt))
      .limit(100);

    // Load the last 3 session journals from memory
    const recentJournals = await db
      .select()
      .from(memory)
      .where(and(eq(memory.sourceAgentId, agentId), eq(memory.category, 'session_journal')))
      .orderBy(desc(memory.createdAt))
      .limit(3);

    // Load the last 5 chat messages the user sent (manual runs only)
    // These capture any user instructions/preferences from the chat tab
    const recentChatRuns = await db
      .select()
      .from(runs)
      .where(and(eq(runs.agentId, agentId), eq(runs.trigger, 'manual')))
      .orderBy(desc(runs.createdAt))
      .limit(10);

    const recentUserInstructions: string[] = [];
    for (const chatRun of recentChatRuns) {
      const [firstMsg] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.runId, chatRun.id), eq(messages.role, 'user')))
        .limit(1);
      if (firstMsg) {
        const content = (() => { try { return JSON.parse(firstMsg.content); } catch { return null; } })();
        if (typeof content === 'string' && content.length > 5) {
          const ts = new Date(chatRun.createdAt).toLocaleString();
          recentUserInstructions.push(`[${ts}] ${content}`);
        }
      }
      if (recentUserInstructions.length >= 5) break;
    }

    // Format the live chat thread if the user was chatting before pressing Wake Up
    const chatBriefing = recentChatMessages && recentChatMessages.length > 0
      ? `CONVERSATION WITH USER (just before this session started — read this first and act on it):\n${
          recentChatMessages
            .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
            .join('\n')
        }`
      : '';

    // ── Format action log briefing ────────────────────────────────────────────
    let actionLogBriefing = '';
    if (recentActionLog.length > 0) {
      // Group by blocked vs executed
      const executed = recentActionLog.filter((e) => !e.blocked);
      const blocked  = recentActionLog.filter((e) => e.blocked);

      const lines: string[] = [];
      if (executed.length > 0) {
        lines.push(`Completed actions (${executed.length}):`)
        for (const e of executed.slice(0, 20)) {
          lines.push(`  • [${e.createdAt.slice(0, 16)}] ${e.flowName}(${e.keyField}=${e.keyValue})`);
        }
      }
      if (blocked.length > 0) {
        lines.push(`Blocked by dedup (${blocked.length} times — already done):`);
        // Deduplicate to unique flow+key pairs
        const seen = new Set<string>();
        for (const e of blocked) {
          const key = `${e.flowName}:${e.keyValue}`;
          if (!seen.has(key)) { seen.add(key); lines.push(`  • ${e.flowName}(${e.keyField}=${e.keyValue})`); }
        }
      }
      actionLogBriefing = `ACTION LOG — WHAT YOU HAVE ALREADY DONE (do NOT repeat these):\n${lines.join('\n')}`;
    }

    // ── Format contacts briefing ──────────────────────────────────────────────
    let contactsBriefing = '';
    if (contactSummary.length > 0) {
      const byStatus: Record<string, number> = {};
      for (const c of contactSummary) { byStatus[c.status] = (byStatus[c.status] ?? 0) + 1; }
      const statusLine = Object.entries(byStatus)
        .map(([s, n]) => `${n} ${s}`)
        .join(', ');

      const pending = contactSummary.filter((c) => c.status === 'prospect').slice(0, 10);
      const replied = contactSummary.filter((c) => c.status === 'replied').slice(0, 5);

      const lines = [`Total contacts: ${contactSummary.length} (${statusLine})`];
      if (replied.length > 0) {
        lines.push(`\nReplied — follow up with these first:`);
        for (const c of replied) lines.push(`  • ${c.handle} (${c.platform}) — last: ${c.lastAction ?? 'none'}`);
      }
      if (pending.length > 0) {
        lines.push(`\nTop prospects to contact next:`);
        for (const c of pending) lines.push(`  • ${c.handle} (${c.platform})${c.notes ? ` — ${c.notes.slice(0, 80)}` : ''}`);
      }
      contactsBriefing = `CONTACTS BRIEFING:\n${lines.join('\n')}`;
    }

    // Build the context block that gets injected at the top of the wake-up prompt
    const contextBlock = [
      recentJournals.length > 0
        ? `PREVIOUS SESSION JOURNALS (read carefully — continue from where you left off):\n${
            recentJournals
              .reverse() // oldest first
              .map((j) => `• [${j.createdAt.slice(0, 16)}] ${j.content.slice(0, 600)}`)
              .join('\n')
          }`
        : 'PREVIOUS SESSION JOURNALS: none yet — this appears to be your first run.',
      actionLogBriefing,
      contactsBriefing,
      recentUserInstructions.length > 0
        ? `RECENT USER INSTRUCTIONS (from the chat tab — treat these as directives):\n${
            recentUserInstructions.reverse().map((m) => `• ${m}`).join('\n')
          }`
        : '',
      chatBriefing,
    ].filter(Boolean).join('\n\n');

    const wakeUpPrompt = `Continuous autonomous run started at ${new Date().toISOString()}. You will run until the user stops you — this is not a 10-minute session, it is an all-day work shift.

━━━ CONTEXT FROM PREVIOUS SESSIONS ━━━
${contextBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Work cycle:
0. USER FIRST — If there is a CONVERSATION WITH USER above, that is your immediate briefing — handle any requests or act on any insights from it BEFORE anything else. If there are RECENT USER INSTRUCTIONS, treat those as directives too. The user's direct requests always override goal work. Use list_tables, list_api_tools, insert_row, inject_rows etc. to fulfill them without asking clarifying questions.
1. ORIENT: update_status + list_recent_runs + list_tools + list_api_tools + list_flows + list_schedules + check_tool_health
2. GOALS: list_goals — pick the highest-priority pending task and work on it
3. WORK — ONE CALL AT A TIME:
   ⚠️ MANDATORY: Make ONE data-retrieval call → IMMEDIATELY persist the results → then make the next call.
   This applies to BOTH API tools AND scrape flows — both return a __requestId in their result.
   NEVER stack multiple calls before storing. Your context window is NOT a database.
   The pattern for every data-retrieval call is:
     a) Call the tool/flow ONCE (e.g. one API search, one scrape flow for one page)
     b) The response is auto-stored — note the __requestId in the result
     c) Evaluate what came back: group items by category/tag/relevance
     d) Call inject_rows for EACH group separately with the right indices and tags
        Example: 10 politics articles → inject_rows with indices [0,2,5,7] and topic_tags="politics"
                 3 tech articles → inject_rows with indices [1,3,8] and topic_tags="tech"
     e) Log the outcome
     f) ONLY NOW make the next call
   This is non-negotiable. The database is the source of truth, not your memory.
   Small, well-tagged injections > one giant bulk dump.
4. LOG: log_outcome after each significant action
5. REPEAT: after every ~20-30 significant actions, call supervisor_checkin with a progress summary. The manager will review and give you direction. Then continue working.
6. NEVER STOP on your own. You do NOT decide when to stop working — the user will stop you when they want. If all goals are completed, find new productive work: expand data coverage, improve flow quality, build missing tools, optimize existing flows, explore new data sources, clean up data quality, review and fix failed runs, or do general maintenance. Call supervisor_checkin to report progress and get new direction. Only call stop_working for critical unrecoverable failures (invalid API key, billing broken, system error).

CRITICAL: When the user sends you a message mid-session (nudge), stop what you are doing, complete their request fully, then resume goal work. Never ignore or defer a direct user request.
IMPORTANT: You already have context above — do NOT spend time calling list_memory_by_category for session_journal, you already have it. Start working immediately.
This run will last hours. Pace yourself with the budget, keep making progress, and check in with the supervisor regularly. You are an employee — you work until your shift ends, not until you feel like you are done.`;

    const conversationMessages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: wakeUpPrompt },
    ];

    await db.insert(messages).values({ id: uuidv4(), runId, role: 'user', content: JSON.stringify(wakeUpPrompt) });
    // Emit the full wake-up context as a special event so the frontend can render it as a collapsible panel
    emit?.({ type: 'wake_up_context', content: wakeUpPrompt });
    await db.update(runs).set({ status: 'running', updatedAt: new Date().toISOString() }).where(eq(runs.id, runId));
    // OPERATION CONVERGENCE Task 10 — mark agent as running for the dashboard
    await db.update(agents).set({ status: 'running', lastActiveAt: new Date().toISOString() }).where(eq(agents.id, agentId));

    let iterations = 0;
    let sessionEnded = false;

    // Cost / throttle tracking
    let totalInputTokens = 0;
    let lastInputTokens = 0;  // from previous iteration — used for top-of-loop compaction check
    let totalOutputTokens = 0;
    let totalCostUsd = 0;
    const sessionStartMs = Date.now();

    // ── Stuck / loop detection ────────────────────────────────────────────────
    // We track these to auto-trigger a forced supervisor check-in when the agent
    // is going in circles instead of making progress.
    //
    // toolErrorCounts   — consecutive errors for each tool name (reset on success)
    // iterationsSinceCheckin — how many iterations since the last check-in (voluntary
    //                          or forced); triggers a forced review if too high
    const toolErrorCounts = new Map<string, number>();
    let iterationsSinceCheckin = 0;
    const ERROR_REPEAT_THRESHOLD = 2; // same tool errors this many times in a row = stuck
    const MAX_ITERS_BETWEEN_CHECKINS = 50; // force a check-in if agent goes this long
    let consecutiveEndTurns = 0; // how many times in a row the model returned end_turn without tools
    const MAX_CONSECUTIVE_END_TURNS = 3; // after this many, force a supervisor check-in

    /** Inject a forced supervisor check-in into the conversation. */
    async function forceSupervisorCheckin(reason: string): Promise<void> {
      const forcedSummary =
        `FORCED CHECK-IN after ${iterationsSinceCheckin} iterations without a check-in.\n` +
        `Reason: ${reason}`;

      emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `⚡ Forcing supervisor check-in: ${reason}` }] });

      const directive = await runManagerReview(
        agentId, agent.name, forcedSummary, apiKey, agent.model, runId, emit,
      );

      const interventionMsg =
        `⚡ SUPERVISOR INTERVENTION\n\n` +
        `Reason: ${reason}\n\n` +
        `You are stuck. Stop whatever you are currently doing and follow the manager's directive:\n\n` +
        `${directive}\n\n` +
        `Rules for getting unstuck:\n` +
        `- If a flow or tool keeps failing: use build_flow to create a new flow that handles the edge case.\n` +
        `- If you keep calling the same flow/tool with the same input: try a completely different approach or channel.\n` +
        `- If all automated options have failed: update the goal as blocked and move on to the next goal.\n` +
        `- Do NOT repeat the same failing action again.`;

      // Persist the intervention to DB and push to conversation
      await db.insert(messages).values({ id: uuidv4(), runId, role: 'user', content: JSON.stringify(interventionMsg) });
      conversationMessages.push({ role: 'user', content: interventionMsg });
      emit?.({ type: 'message', role: 'user', content: [{ type: 'text', text: interventionMsg }] });

      // Reset stuck-detection state
      toolErrorCounts.clear();
      iterationsSinceCheckin = 0;
    }

    // ── Reasoning loop ────────────────────────────────────────────────────────
    while (iterations < MAX_ITERATIONS && !sessionEnded && !ac.signal.aborted) {
      iterations++;
      iterationsSinceCheckin++;

      // ── Inject any pending user nudges ────────────────────────────────────
      // Users can send messages mid-run via POST /agents/:id/nudge.
      // We prepend them as user messages so the agent can immediately react.
      const nudges = drainNudges(agentId);
      if (nudges.length > 0) {
        for (const nudge of nudges) {
          const nudgeText = `[DIRECT USER MESSAGE — STOP current task and handle this NOW before resuming any other work. Use your tools (list_tables, insert_row, list_api_tools, etc.) to fulfill it. Do NOT ask clarifying questions — look things up yourself and act.]\n\nUser said: ${nudge}`;
          conversationMessages.push({ role: 'user', content: nudgeText });
          emit?.({ type: 'message', role: 'user', content: nudge });
        }
      }

      // ── Context compaction ────────────────────────────────────────────────
      // Done here (top of loop, before API call) so we never compact while
      // there are dangling tool_use blocks awaiting their tool_results.
      // The previous iteration already pushed all tool_results before looping.
      if (conversationMessages.length > 0 && lastInputTokens >= COMPACT_AT_INPUT_TOKENS) {
        conversationMessages.splice(
          0,
          conversationMessages.length,
          ...(await compactConversation(conversationMessages, effectiveSystemPrompt, apiKey, wakeUpPrompt, emit)),
        );
      }

      const response = await anthropic.messages.create({
        model: AUTONOMOUS_MODEL,
        max_tokens: 4096,
        tools: anthropicTools,
        system: effectiveSystemPrompt,
        messages: conversationMessages,
      });

      const assistantContent = response.content;

      // ── Token accounting ────────────────────────────────────────────────────
      totalInputTokens  += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      totalCostUsd += computeIterationCost(response.usage.input_tokens, response.usage.output_tokens);

      // Persist cost to DB so the status endpoint can return live cost
      const iterNow = new Date().toISOString();
      await db.update(runs).set({
        inputTokens:  totalInputTokens,
        outputTokens: totalOutputTokens,
        costUsd:      totalCostUsd,
        updatedAt:    iterNow,
      }).where(eq(runs.id, runId));
      // OPERATION CONVERGENCE Task 10 — keep lastActiveAt fresh for the dashboard
      await db.update(agents).set({ lastActiveAt: iterNow }).where(eq(agents.id, agentId));

      await db.insert(messages).values({ id: uuidv4(), runId, role: 'assistant', content: JSON.stringify(assistantContent) });
      emit?.({ type: 'message', role: 'assistant', content: assistantContent, source: 'manager' });
      conversationMessages.push({ role: 'assistant', content: assistantContent });

      // Track token count so the top-of-loop compaction knows when to fire
      lastInputTokens = response.usage.input_tokens;

      // ── Budget throttle ─────────────────────────────────────────────────────
      // If we've spent faster than the budget allows, sleep until we're back on pace.
      if (budgetUsdPerHour > 0) {
        const elapsedMs = Date.now() - sessionStartMs;
        const budgetPaceUsd = (elapsedMs / 3_600_000) * budgetUsdPerHour;
        if (totalCostUsd > budgetPaceUsd) {
          const overspendUsd = totalCostUsd - budgetPaceUsd;
          const throttleMs = Math.min((overspendUsd / budgetUsdPerHour) * 3_600_000, 120_000);
          if (throttleMs > 500) {
            emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `[throttle] pacing to $${budgetUsdPerHour}/hr budget — waiting ${(throttleMs / 1000).toFixed(0)}s` }] });
            await sleepMs(throttleMs);
          }
        }
      }

      if (response.stop_reason === 'end_turn') {
        // Agent said something without calling tools. This does NOT mean the
        // session is over — only stop_working or user-abort ends the session.
        // Nudge the model back into action, escalating to a supervisor check-in
        // if it keeps idling.
        consecutiveEndTurns++;

        if (consecutiveEndTurns >= MAX_CONSECUTIVE_END_TURNS || iterationsSinceCheckin >= MAX_ITERS_BETWEEN_CHECKINS) {
          await forceSupervisorCheckin(
            consecutiveEndTurns >= MAX_CONSECUTIVE_END_TURNS
              ? `Model returned ${consecutiveEndTurns} consecutive end_turn responses without calling any tools`
              : `${iterationsSinceCheckin} iterations without a supervisor check-in (end_turn with no tools)`,
          );
          consecutiveEndTurns = 0;
          continue;
        }

        // Gentle nudge — remind the agent it's in autonomous mode
        const nudgeMsg =
          `You responded with text but did not call any tools. You are in AUTONOMOUS MODE ` +
          `— your session runs until you call stop_working or the user stops you. ` +
          `Check list_goals and continue working on your next task. ` +
          `If there is truly nothing left to do, call stop_working.`;
        conversationMessages.push({ role: 'user', content: nudgeMsg });
        emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `[nudge] Agent responded without tool calls — reminding it to keep working (${consecutiveEndTurns}/${MAX_CONSECUTIVE_END_TURNS})` }] });
        continue;
      }
      if (response.stop_reason !== 'tool_use') break;

      // Model is calling tools — reset the idle counter
      consecutiveEndTurns = 0;

      // T1 — extract reasoning text (what the agent wrote before its tool calls this turn)
      const autonomousReasoning = (assistantContent as Array<{ type?: string; text?: string }>)
        .filter((b) => b?.type === 'text' && b.text?.trim())
        .map((b) => b.text!.trim())
        .join('\n')
        .trim() || undefined;

      // T2 — extract goal ID from reasoning text: the autonomous agent writes goal IDs as
      // UUIDs in square brackets, e.g. "[abc123-...] | task | ..." from list_goals output
      const goalIdMatch = autonomousReasoning?.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
      const autonomousGoalId = goalIdMatch?.[1] ?? undefined;

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue;
        if (ac.signal.aborted) break;  // honour stop signal mid-iteration

        const correlationId = block.id;
        emit?.({ type: 'tool_call', toolName: block.name, input: block.input, correlationId, source: 'manager' });

        let resultStr: string;
        let errorStr: string | undefined;

        // ── Cheap-agent enforcement (task 4.2) ────────────────────────────────
        // These tools are not in the offered tool list, but guard anyway in case
        // the model hallucinates a call to them.
        if (CHEAP_AGENT_BLOCKED_TOOLS.has(block.name)) {
          resultStr = JSON.stringify({
            error: `The autonomous agent cannot call '${block.name}' directly. Use request_flow to commission new flows, or revise_flow to update existing ones. The Flow Builder AI handles all direct flow creation.`,
            suggestion: block.name === 'create_flow' || block.name === 'update_flow' ? 'Call request_flow with a plain-English description of the capability you need.' : 'Contact the manager via supervisor_checkin to discuss flow deletion.',
          });
          logger.warn({ toolName: block.name, agentId }, 'Cheap-agent restriction: blocked tool call');
        } else

        try {
          resultStr = await handleManagementTool(
            block.name,
            block.input as Record<string, unknown>,
            {
              agentId, agent, agentTools, agentFlows, agentApiTools, resolvedSecrets, secretRateLimits, apiKey, wakeUpPrompt, runId, emit,
              reasoning: autonomousReasoning,   // T1
              goalId: autonomousGoalId,          // T2
              modelId: AUTONOMOUS_MODEL,         // T3
            },
          );
          // Successful call: reset the error count for this tool
          toolErrorCounts.delete(block.name);
        } catch (err) {
          errorStr = err instanceof Error ? err.message : String(err);
          resultStr = JSON.stringify({ error: errorStr });
          // Increment consecutive error count for this tool
          toolErrorCounts.set(block.name, (toolErrorCounts.get(block.name) ?? 0) + 1);
        }

        // If it's stop_working, break out of the outer loop after this turn
        if (block.name === 'stop_working' && !errorStr) sessionEnded = true;

        // If it's a voluntary supervisor_checkin, reset stuck counters
        if (block.name === 'supervisor_checkin' && !errorStr) {
          toolErrorCounts.clear();
          iterationsSinceCheckin = 0;
        }

        // Re-sync cached tools/flows after any mutation
        if (!errorStr && ['generate_tool', 'update_tool', 'delete_tool'].includes(block.name)) {
          agentTools.splice(0, agentTools.length, ...(await db.select().from(tools).where(eq(tools.agentId, agentId))));
        }
        if (!errorStr && ['create_flow', 'update_flow', 'delete_flow'].includes(block.name)) {
          agentFlows.splice(0, agentFlows.length, ...(await db.select().from(flows).where(eq(flows.agentId, agentId))));
        }
        // Re-sync api tools if they were mutated (currently only via UI, but future-proof)
        if (!errorStr && block.name.startsWith('api_tool')) {
          agentApiTools.splice(0, agentApiTools.length, ...(await db.select().from(apiTools).where(eq(apiTools.agentId, agentId))));
        }

        emit?.({ type: 'tool_result', correlationId, result: resultStr, error: errorStr, source: 'manager' });

        // Truncate before persisting / feeding back into the conversation context
        const resultForContext = truncateToolResult(resultStr);

        await db.insert(messages).values({
          id: uuidv4(), runId, role: 'tool_result',
          content: JSON.stringify([{ type: 'tool_result', tool_use_id: correlationId, content: resultForContext }]),
        });

        toolResults.push({ type: 'tool_result', tool_use_id: correlationId, content: resultForContext });
      }

      if (toolResults.length > 0) {
        conversationMessages.push({ role: 'user', content: toolResults });
      }

      // ── Post-iteration stuck detection ────────────────────────────────────────
      // Checked AFTER tool results are collected so the agent always gets the
      // results first, then receives the intervention on the next turn.
      if (!sessionEnded && !ac.signal.aborted) {
        let stuckReason: string | null = null;

        // 1. Same tool consecutive errors
        for (const [toolName, count] of toolErrorCounts) {
          if (count >= ERROR_REPEAT_THRESHOLD) {
            stuckReason = `Tool "${toolName}" has failed ${count} consecutive times without a fix attempt`;
            break;
          }
        }

        // 2. Max iterations between check-ins
        if (!stuckReason && iterationsSinceCheckin >= MAX_ITERS_BETWEEN_CHECKINS) {
          stuckReason = `${iterationsSinceCheckin} iterations without a supervisor check-in`;
        }

        if (stuckReason) {
          await forceSupervisorCheckin(stuckReason);
        }
      }
    }

    const finalStatus = ac.signal.aborted ? 'stopped' : 'completed';
    const doneNow = new Date().toISOString();
    await db.update(runs).set({ status: finalStatus, updatedAt: doneNow }).where(eq(runs.id, runId));
    // OPERATION CONVERGENCE Task 10 — mark agent idle when run finishes
    await db.update(agents).set({ status: 'idle', lastActiveAt: doneNow }).where(eq(agents.id, agentId));
    emit?.({ type: 'done', runId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errNow = new Date().toISOString();
    await db.update(runs).set({ status: 'failed', error: errMsg, updatedAt: errNow }).where(eq(runs.id, runId));
    // OPERATION CONVERGENCE Task 10 — mark agent error on crash
    await db.update(agents).set({ status: 'error', lastActiveAt: errNow }).where(eq(agents.id, agentId));
    emit?.({ type: 'error', message: errMsg });
  } finally {
    unregisterAbort(runId);
  }
}

// ── Manager Review ─────────────────────────────────────────────────────────────
//
// Runs automatically on every supervisor_checkin call (awaited, returns directive)
// and after stop_working (fire-and-forget). Uses a smarter model (the agent's
// configured model, not Haiku) to read the journal, spot blockers, inject fix tasks
// as high-priority goals, and return a next-step directive.
// This is the supervisor layer: it learns across check-ins and keeps the agent
// from getting stuck on the same problem twice.

const MANAGER_SYSTEM_PROMPT = readFileSync(join(__dirname, 'manager.prompt.md'), 'utf-8').trim();


async function runManagerReview(
  agentId: string,
  agentName: string,
  sessionSummary: string,
  apiKey: string,
  agentModel: string,
  runId: string,
  emit?: SseEmitter,
): Promise<string> {
  const db = getDb();

  try {
    emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: '🧠 Manager reviewing session...' }], source: 'manager' });

    // Gather context for the manager
    const [blockedGoals, recentFailures, prevInsights, existingFlows, existingTools, existingApiTools] = await Promise.all([
      db.select().from(goals)
        .where(and(eq(goals.agentId, agentId)))
        .orderBy(goals.priority)
        .limit(20),
      db.select().from(performanceLog)
        .where(and(eq(performanceLog.agentId, agentId), eq(performanceLog.outcome, 'failure')))
        .orderBy(desc(performanceLog.createdAt))
        .limit(10),
      db.select().from(memory)
        .where(and(eq(memory.sourceAgentId, agentId), eq(memory.category, 'manager_insight')))
        .orderBy(desc(memory.createdAt))
        .limit(5),
      db.select().from(flows).where(eq(flows.agentId, agentId)),
      db.select().from(tools).where(eq(tools.agentId, agentId)),
      db.select().from(apiTools).where(eq(apiTools.agentId, agentId)),
    ]);

    const activeGoals = blockedGoals.filter((g) => g.status !== 'completed' && g.status !== 'cancelled');

    // Cap the session summary so the manager's output stays within its token budget
    const cappedSummary = sessionSummary.length > 6000 ? sessionSummary.slice(-6000) : sessionSummary;

    const contextBlock = [
      `SESSION JOURNAL:\n${cappedSummary}`,
      existingFlows.length > 0
        ? `EXISTING FLOWS (already built — do NOT suggest building these again):\n${existingFlows.map((f) => `- ${f.name}: ${f.description}`).join('\n')}`
        : 'EXISTING FLOWS: none',
      existingTools.length > 0
        ? `EXISTING TOOLS:\n${existingTools.map((t) => `- ${t.name} (${t.toolType}): ${t.description}`).join('\n')}`
        : 'EXISTING TOOLS: none',
      existingApiTools.filter((t) => t.enabled).length > 0
        ? `EXISTING API TOOLS:\n${existingApiTools.filter((t) => t.enabled).map((t) => `- ${t.name}: ${t.description}`).join('\n')}`
        : 'EXISTING API TOOLS: none',
      activeGoals.length > 0
        ? `CURRENT GOALS (active):\n${activeGoals.map((g) => `[${g.id}] ${g.type} | ${g.status} | p${g.priority} | ${g.title}${g.notes ? ` | notes: ${g.notes.slice(0, 200)}` : ''}`).join('\n')}`
        : 'CURRENT GOALS: none',
      recentFailures.length > 0
        ? `RECENT FAILURES:\n${recentFailures.map((f) => `- ${f.action}: ${f.notes}`).join('\n')}`
        : 'RECENT FAILURES: none',
      prevInsights.length > 0
        ? `PREVIOUS MANAGER INSIGHTS:\n${prevInsights.map((i) => `- ${i.content.slice(0, 300)}`).join('\n')}`
        : 'PREVIOUS MANAGER INSIGHTS: none',
    ].join('\n\n');

    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: agentModel,
      max_tokens: 2048,
      system: MANAGER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contextBlock }],
    });

    const rawText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('').trim();

    // Parse JSON — strip markdown fences if present
    let jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    // Safety net: if the output was truncated mid-JSON, close any open structure so parse can succeed
    if (!jsonStr.endsWith('}')) {
      // Drop to last clean top-level key boundary we can find
      const lastBrace = jsonStr.lastIndexOf('",');
      if (lastBrace > 0) jsonStr = jsonStr.slice(0, lastBrace + 1) + '}';
      else jsonStr += '}';
    }
    const review = JSON.parse(jsonStr) as {
      assessment: string;
      priority_tasks: { title: string; description: string; priority: number }[];
      goal_updates: { goal_id: string; notes: string }[];
      insight: string;
      next_session_directive: string;
    };

    // ── 1. Create strategic priority tasks ──────────────────────────────────
    const createdTasks: string[] = [];
    for (const task of (review.priority_tasks ?? []).slice(0, 3)) {
      const newId = uuidv4();
      await db.insert(goals).values({
        id: newId, agentId, type: 'task',
        title: `[Manager] ${task.title}`,
        description: task.description ?? '',
        status: 'pending',
        priority: Math.min(Math.max(task.priority ?? 1, 1), 4),
        notes: `Created by manager after check-in ${runId.slice(0, 8)}`,
      });
      createdTasks.push(task.title);
    }

    // ── 3. Apply goal updates ────────────────────────────────────────────────
    for (const update of (review.goal_updates ?? [])) {
      if (!update.goal_id) continue;
      await db.update(goals)
        .set({ notes: update.notes, updatedAt: new Date().toISOString() })
        .where(and(eq(goals.id, update.goal_id), eq(goals.agentId, agentId)));
    }

    // ── 4. Store manager insight ─────────────────────────────────────────────
    if (review.insight) {
      await db.insert(memory).values({
        id: uuidv4(),
        content: `[Manager — ${new Date().toISOString().slice(0, 10)}]\n${review.assessment}\n\n${review.insight}\n\nDirective: ${review.next_session_directive}`,
        category: 'manager_insight',
        entities: JSON.stringify([agentId]),
        sourceAgentId: agentId, sourceAgentName: agentName, sourceTool: 'manager_review',
        metadata: JSON.stringify({ runId, assessment: review.assessment, tasksCreated: createdTasks, timestamp: new Date().toISOString() }),
      });
    }

    const summaryLines = [
      `📋 **Manager review complete**`,
      `Assessment: ${review.assessment}`,
      createdTasks.length > 0 ? `Tasks queued: ${createdTasks.map((t) => `\n  • ${t}`).join('')}` : '',
      `Next directive: ${review.next_session_directive}`,
    ].filter(Boolean).join('\n');

    emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: summaryLines }] });

    return review.next_session_directive ?? 'Continue with your highest priority pending goals.';

  } catch (err) {
    // Manager failures are non-fatal — log and continue
    const msg = err instanceof Error ? err.message : String(err);
    emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `⚠️ Manager review failed: ${msg}` }] });
    try {
      await db.insert(memory).values({
        id: uuidv4(),
        content: `Manager review failed for check-in ${runId}: ${msg}`,
        category: 'manager_insight',
        entities: JSON.stringify([agentId]),
        sourceAgentId: agentId,
        sourceAgentName: agentName,
        sourceTool: 'manager_review',
        metadata: JSON.stringify({ runId, error: msg }),
      });
    } catch { /* ignore */ }
    return 'Continue with your highest priority pending goals.';
  }
}

// ── Tool handler (separated for readability) ──────────────────────────────────

type AgentContext = {
  agentId: string;
  agent: { id: string; name: string; model: string; systemPrompt: string };
  agentTools: Array<{ id: string; name: string; description: string; inputSchema: string; toolType: string; code: string }>;
  agentFlows: Array<{ id: string; agentId: string; name: string; description: string; inputSchema: string; steps: string; returnStepId?: string | null; returnSteps?: string | null; reasoningModel?: string | null; reasoningPrompt?: string | null; pinned?: boolean | null }>;
  agentApiTools: Array<{ id: string; name: string; description: string; inputSchema: string; type: string; config: string; enabled: boolean }>;
  resolvedSecrets: Record<string, string>;
  secretRateLimits: Record<string, number | null>;
  apiKey: string;
  wakeUpPrompt: string;
  runId: string;
  emit?: SseEmitter;
  // T1–T3 transparency fields
  reasoning?: string;   // T1 — the agent's reasoning text before this tool call
  goalId?: string;      // T2 — the goal the agent was working toward
  modelId?: string;     // T3 — model that made this decision
};

async function handleManagementTool(
  toolName: string,
  inp: Record<string, unknown>,
  ctx: AgentContext,
): Promise<string> {
  const db = getDb();
  const { agentId, agent, agentTools, agentFlows, agentApiTools, resolvedSecrets, secretRateLimits, apiKey, wakeUpPrompt, emit: ctxEmit } = ctx;

  // ── Agent's own tools/flows (not management) ──────────────────────────────
  if (!MANAGEMENT_TOOL_NAMES.has(toolName)) {
    const matchedFlow = agentFlows.find((f) => f.name === toolName);
    const toolDef = matchedFlow ? undefined : agentTools.find((t) => t.name === toolName);
    const apiToolDef = (!matchedFlow && !toolDef) ? agentApiTools.find((t) => t.name === toolName && t.enabled) : undefined;

    if (matchedFlow) {
      const result = await runFlow(matchedFlow, inp, agentId, {
        userMessage: wakeUpPrompt,
        apiKey,
        reasoning: ctx.reasoning,   // T1
        goalId: ctx.goalId,          // T2
        modelId: ctx.modelId,        // T3
        runId: ctx.runId,            // T4
      });
      storeToMemory({ raw: result, toolName, toolInput: inp, agentId, agentName: agent.name, apiKey }).catch(() => {});
      return result;
    } else if (apiToolDef) {
      const config = JSON.parse(apiToolDef.config) as Record<string, unknown>;
      const result = await runApiToolThrottled(apiToolDef.type, config, inp, resolvedSecrets, agentId, secretRateLimits, apiToolDef.name);
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      storeToMemory({ raw: resultStr, toolName, toolInput: inp, agentId, agentName: agent.name, apiKey }).catch(() => {});
      return resultStr;
    } else if (toolDef) {
      const result = await runTool(toolDef, inp, agentId);
      storeToMemory({ raw: result, toolName, toolInput: inp, agentId, agentName: agent.name, apiKey }).catch(() => {});
      return result;
    } else {
      throw new Error(`Tool "${toolName}" not found`);
    }
  }

  // ── Management tools ──────────────────────────────────────────────────────

  switch (toolName) {

    // Runs
    case 'list_recent_runs': {
      const limit = Math.min((inp.limit as number) ?? 20, 50);
      const recent = await db.select().from(runs).where(eq(runs.agentId, agentId)).orderBy(desc(runs.createdAt)).limit(limit);
      return JSON.stringify(recent.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, input: r.input.slice(0, 100), error: r.error, createdAt: r.createdAt })));
    }

    // Memory
    case 'recall_memory': {
      const limit = Math.min((inp.limit as number) ?? 50, 200);
      const results = await db.select().from(memory).where(like(memory.entities, `%${inp.entity as string}%`)).orderBy(desc(memory.createdAt)).limit(limit);
      return JSON.stringify({ found: results.length, results });
    }

    case 'list_memory_by_category': {
      const limit = Math.min((inp.limit as number) ?? 30, 100);
      const results = await db.select().from(memory).where(eq(memory.category, inp.category as string)).orderBy(desc(memory.createdAt)).limit(limit);
      return JSON.stringify({ found: results.length, results });
    }

    case 'store_memory': {
      await db.insert(memory).values({
        id: uuidv4(),
        content: inp.content as string,
        category: (inp.category as string) ?? 'other',
        entities: JSON.stringify((inp.entities as string[]) ?? []),
        sourceAgentId: agentId,
        sourceAgentName: agent.name,
        sourceTool: 'autonomous_reflection',
        metadata: JSON.stringify(inp.hint ? { hint: inp.hint } : {}),
      });
      return JSON.stringify({ success: true });
    }

    case 'delete_memory': {
      await db.delete(memory).where(eq(memory.id, inp.memory_id as string));
      return JSON.stringify({ success: true });
    }

    // Tools
    case 'list_tools': {
      const allTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
      return JSON.stringify(allTools.map((t) => ({ id: t.id, name: t.name, description: t.description, toolType: t.toolType })));
    }

    case 'list_api_tools': {
      const allApiTools = await db.select().from(apiTools).where(eq(apiTools.agentId, agentId));
      return JSON.stringify(allApiTools.map((t) => ({
        name: t.name,
        description: t.description,
        type: t.type,
        enabled: t.enabled,
        inputSchema: JSON.parse(t.inputSchema),
      })));
    }

    case 'generate_tool': {
      const generated = await generateToolWithAI(
        inp.description as string,
        inp.tool_type as string,
        apiKey,
        agent.model,
      );
      const newId = uuidv4();
      await db.insert(tools).values({
        id: newId,
        agentId,
        name: generated.name,
        description: generated.description,
        inputSchema: generated.inputSchema,
        toolType: generated.toolType,
        code: generated.code,
      });
      return JSON.stringify({ success: true, tool_id: newId, name: generated.name, description: generated.description, toolType: generated.toolType });
    }

    case 'update_tool': {
      const updates: Record<string, string> = {};
      if (inp.description) updates['description'] = inp.description as string;
      if (inp.code) updates['code'] = inp.code as string;
      if (Object.keys(updates).length === 0) throw new Error('No fields to update provided');
      await db.update(tools).set({ ...updates, updatedAt: new Date().toISOString() }).where(and(eq(tools.id, inp.tool_id as string), eq(tools.agentId, agentId)));
      return JSON.stringify({ success: true });
    }

    case 'delete_tool': {
      await db.delete(tools).where(and(eq(tools.id, inp.tool_id as string), eq(tools.agentId, agentId)));
      return JSON.stringify({ success: true });
    }

    case 'test_tool': {
      const toolId = inp.tool_id as string;
      // Check regular tools first (by UUID), then API tools (by UUID or name)
      const toolDef = agentTools.find((t) => t.id === toolId);
      const apiToolDef = !toolDef
        ? agentApiTools.find((t) => t.id === toolId || t.name === toolId)
        : undefined;
      if (!toolDef && !apiToolDef) throw new Error(`Tool "${toolId}" not found. Use list_tools for browser/code tools or list_api_tools for API tools.`);
      const start = Date.now();
      if (apiToolDef) {
        const config = JSON.parse(apiToolDef.config) as Record<string, unknown>;
        const result = await runApiToolThrottled(apiToolDef.type, config, (inp.input as Record<string, unknown>) ?? {}, resolvedSecrets, agentId, secretRateLimits, apiToolDef.name);
        return JSON.stringify({ ok: true, result, durationMs: Date.now() - start });
      }
      const result = await runTool(toolDef!, (inp.input as Record<string, unknown>) ?? {}, agentId);
      return JSON.stringify({ ok: true, result, durationMs: Date.now() - start });
    }

    // Flows
    case 'list_flows': {
      const allFlows = await db.select().from(flows).where(eq(flows.agentId, agentId));
      return JSON.stringify(allFlows.map((f) => ({ id: f.id, name: f.name, description: f.description })));
    }

    case 'create_flow': {
      type RawStep = {
        label: string;
        tool_id: string;
        inputs: Record<string, {
          type: 'literal' | 'flow_input' | 'step_ref';
          value?: unknown;
          key?: string;
          step_index?: number;
          path?: string;
        }>;
      };
      const rawSteps = (inp.steps as RawStep[]) ?? [];
      const builtSteps = buildFlowSteps(rawSteps);
      const newId = uuidv4();
      const inputSchemaStr = typeof inp.input_schema === 'string'
        ? inp.input_schema
        : JSON.stringify(inp.input_schema ?? { type: 'object', properties: {}, required: [] });
      await db.insert(flows).values({
        id: newId,
        agentId,
        name: inp.name as string,
        description: inp.description as string,
        inputSchema: inputSchemaStr,
        steps: JSON.stringify(builtSteps),
      });
      return JSON.stringify({ success: true, flow_id: newId, name: inp.name, steps_created: builtSteps.length });
    }

    case 'update_flow': {
      // Build steps separately so TS can type-check the set() call properly
      type RawStep = {
        label: string; tool_id: string;
        inputs: Record<string, { type: 'literal' | 'flow_input' | 'step_ref'; value?: unknown; key?: string; step_index?: number; path?: string }>;
      };
      const newStepsStr = inp.steps
        ? JSON.stringify(buildFlowSteps(inp.steps as RawStep[]))
        : undefined;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch: Record<string, any> = { updatedAt: new Date().toISOString() };
      if (inp.name) patch.name = inp.name;
      if (inp.description) patch.description = inp.description;
      if (inp.input_schema) patch.inputSchema = typeof inp.input_schema === 'string' ? inp.input_schema : JSON.stringify(inp.input_schema);
      if (newStepsStr) patch.steps = newStepsStr;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await db.update(flows).set(patch).where(and(eq(flows.id, inp.flow_id as string), eq(flows.agentId, agentId)));
      return JSON.stringify({ success: true });
    }

    case 'delete_flow': {
      await db.delete(flows).where(and(eq(flows.id, inp.flow_id as string), eq(flows.agentId, agentId)));
      return JSON.stringify({ success: true });
    }

    case 'test_flow': {
      const flowDef = agentFlows.find((f) => f.id === (inp.flow_id as string));
      if (!flowDef) throw new Error(`Flow ${inp.flow_id as string} not found`);
      const result = await runFlowDetailed(flowDef, (inp.input as Record<string, unknown>) ?? {}, agentId, { apiKey });
      return JSON.stringify(result);
    }

    // Tables
    case 'list_tables': {
      const allTables = await db.select().from(tables).where(eq(tables.agentId, agentId));
      return JSON.stringify(allTables.map((t) => ({ id: t.id, name: t.name, columns: JSON.parse(t.columns) })));
    }

    case 'create_table': {
      // ── SESSION 6 (OPERATION CLARITY): infrastructure approval gate ─────────
      // New tables are persistent infrastructure — queue for user approval before creating.
      const infraId = uuidv4();
      await db.insert(actionLog).values({
        id: infraId,
        agentId,
        flowId: '__infrastructure__',
        flowName: 'create_table',
        flowType: 'infrastructure',
        keyField: 'name',
        keyValue: inp.name as string,
        input: JSON.stringify(inp),
        result: null,
        blocked: false,
        runId: ctx.runId ?? null,
        status: 'pending_review',
      });
      return JSON.stringify({
        status: 'pending_review',
        action_log_id: infraId,
        message: `Table creation for "${inp.name as string}" has been queued for user approval in the Review Actions tab. Do NOT attempt to use this table until approved. Continue with other goals.`,
      });
    }

    case 'query_table': {
      const limit = Math.min((inp.limit as number) ?? 20, 100);
      const resolvedTableId = await resolveTableId(db, agentId, inp.table_id as string);
      if (!resolvedTableId) return JSON.stringify({ count: 0, rows: [], error: `Table "${inp.table_id}" not found. Call list_tables to see available tables.` });
      const tableRows = await db.select().from(rows).where(eq(rows.tableId, resolvedTableId)).orderBy(desc(rows.createdAt)).limit(limit);
      return JSON.stringify({ count: tableRows.length, rows: tableRows.map((r) => ({ id: r.id, data: JSON.parse(r.data), createdAt: r.createdAt })) });
    }

    case 'insert_row': {
      const resolvedInsertTableId = await resolveTableId(db, agentId, inp.table_id as string);
      if (!resolvedInsertTableId) return JSON.stringify({ success: false, error: `Table "${inp.table_id}" not found. Call list_tables to see available tables.` });
      const newId = uuidv4();
      await db.insert(rows).values({ id: newId, tableId: resolvedInsertTableId, data: JSON.stringify(inp.data ?? {}), runId: ctx.runId });
      return JSON.stringify({ success: true, row_id: newId });
    }

    case 'list_api_requests': {
      const limit = Math.min((inp.limit as number) ?? 20, 50);
      const reqRows = await db.select({
        id: apiRequestLog.id,
        toolName: apiRequestLog.toolName,
        input: apiRequestLog.input,
        durationMs: apiRequestLog.durationMs,
        createdAt: apiRequestLog.createdAt,
      }).from(apiRequestLog).where(eq(apiRequestLog.agentId, agentId))
        .orderBy(desc(apiRequestLog.createdAt)).limit(limit);
      const filtered = inp.tool_name
        ? reqRows.filter((r) => r.toolName.toLowerCase().includes((inp.tool_name as string).toLowerCase()))
        : reqRows;
      // Include response preview
      const withPreview = await Promise.all(filtered.map(async (r) => {
        const [full] = await db.select({ response: apiRequestLog.response }).from(apiRequestLog).where(eq(apiRequestLog.id, r.id));
        return { ...r, responsePreview: full?.response?.slice(0, 300) ?? '' };
      }));
      return JSON.stringify({ count: withPreview.length, requests: withPreview });
    }

    case 'inject_rows': {
      const resolvedInjectTableId = await resolveTableId(db, agentId, inp.table_id as string);
      if (!resolvedInjectTableId) return JSON.stringify({ ok: false, inserted: 0, failed: 0, errors: [{ index: -1, error: `Table "${inp.table_id}" not found. Call list_tables to see available tables.` }], rowIds: [] });
      const injectResult = await executeInjectRows(agentId, {
        request_id: inp.request_id as string,
        table_id: resolvedInjectTableId,
        path: inp.path as string | undefined,
        indices: inp.indices as number[] | undefined,
        script: inp.script as string,
        runId: ctx.runId,
      });
      return JSON.stringify(injectResult);
    }

    case 'delete_table': {
      await db.delete(tables).where(and(eq(tables.id, inp.table_id as string), eq(tables.agentId, agentId)));
      return JSON.stringify({ success: true });
    }

    // Flow Runs
    case 'list_flow_runs': {
      const limit = Math.min((inp.limit as number) ?? 20, 100);
      let recentRuns = await db.select().from(flowRuns).where(eq(flowRuns.agentId, agentId)).orderBy(desc(flowRuns.createdAt)).limit(limit);
      if (inp.flow_name) recentRuns = recentRuns.filter((r) => r.flowName.includes(inp.flow_name as string));
      return JSON.stringify({
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
    }

    // Schedules
    case 'list_schedules': {
      const allSchedules = await db.select().from(schedules).where(eq(schedules.agentId, agentId));
      return JSON.stringify(allSchedules);
    }

    case 'create_schedule': {
      // ── SESSION 6 (OPERATION CLARITY): infrastructure approval gate ─────────
      // New schedules are persistent infrastructure — queue for user approval before creating.
      const schedInfraId = uuidv4();
      await db.insert(actionLog).values({
        id: schedInfraId,
        agentId,
        flowId: '__infrastructure__',
        flowName: 'create_schedule',
        flowType: 'infrastructure',
        keyField: 'cron',
        keyValue: inp.cron as string,
        input: JSON.stringify(inp),
        result: null,
        blocked: false,
        runId: ctx.runId ?? null,
        status: 'pending_review',
      });
      return JSON.stringify({
        status: 'pending_review',
        action_log_id: schedInfraId,
        message: `Schedule creation (cron: "${inp.cron as string}") has been queued for user approval in the Review Actions tab. Do NOT attempt to use this schedule until approved. Continue with other goals.`,
      });
    }

    case 'delete_schedule': {
      await db.delete(schedules).where(eq(schedules.id, inp.schedule_id as string));
      await reloadSchedules();
      return JSON.stringify({ success: true });
    }

    // Goals
    case 'list_goals': {
      const conditions = [eq(goals.agentId, agentId)];
      const allGoals = await db.select().from(goals)
        .where(conditions.length === 1 ? conditions[0] : and(...conditions))
        .orderBy(goals.priority, desc(goals.createdAt));
      // Apply optional filters in memory since we can't easily build dynamic AND chains
      let filtered = allGoals;
      if (inp.status) filtered = filtered.filter((g) => g.status === inp.status);
      else filtered = filtered.filter((g) => g.status !== 'completed' && g.status !== 'cancelled');
      if (inp.type) filtered = filtered.filter((g) => g.type === inp.type);
      return JSON.stringify({
        total: filtered.length,
        goals: filtered.map((g) => ({
          id: g.id,
          type: g.type,
          title: g.title,
          description: g.description,
          status: g.status,
          priority: g.priority,
          parentId: g.parentId,
          notes: g.notes,
          dueDate: g.dueDate,
          createdAt: g.createdAt,
          updatedAt: g.updatedAt,
        })),
      });
    }

    case 'create_goal': {
      const newId = uuidv4();
      await db.insert(goals).values({
        id: newId,
        agentId,
        parentId: (inp.parent_id as string) ?? null,
        type: (inp.type as string) ?? 'task',
        title: inp.title as string,
        description: (inp.description as string) ?? '',
        status: 'pending',
        priority: (inp.priority as number) ?? 3,
        dueDate: (inp.due_date as string) ?? null,
      });
      return JSON.stringify({ success: true, goal_id: newId, title: inp.title, type: inp.type ?? 'task' });
    }

    case 'update_goal': {
      const goalPatch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (inp.status !== undefined) {
        goalPatch.status = inp.status;
        if (inp.status === 'completed') goalPatch.completedAt = new Date().toISOString();
      }
      if (inp.notes !== undefined) goalPatch.notes = inp.notes;
      if (inp.title !== undefined) goalPatch.title = inp.title;
      if (inp.description !== undefined) goalPatch.description = inp.description;
      if (inp.priority !== undefined) goalPatch.priority = inp.priority;
      if (inp.due_date !== undefined) goalPatch.dueDate = inp.due_date;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.update(goals).set(goalPatch as any).where(
        and(eq(goals.id, inp.goal_id as string), eq(goals.agentId, agentId)),
      );
      return JSON.stringify({ success: true });
    }

    case 'delete_goal': {
      await db.delete(goals).where(
        and(eq(goals.id, inp.goal_id as string), eq(goals.agentId, agentId)),
      );
      return JSON.stringify({ success: true });
    }

    // Tool Health
    case 'check_tool_health': {
      const allTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
      const results: Array<{ id: string; name: string; type: string; status: string; issue?: string }> = [];

      for (const t of allTools) {
        let status = 'ok';
        let issue: string | undefined;

        // Validate schema
        try {
          JSON.parse(t.inputSchema);
        } catch {
          status = 'error';
          issue = 'Input schema is not valid JSON';
        }

        // Check code-based tools have code
        if (status === 'ok' && (t.toolType === 'extension' || t.toolType === 'local')) {
          if (!t.code || t.code.trim().length === 0) {
            status = 'warning';
            issue = 'No code defined for this tool';
          }
        }

        results.push({ id: t.id, name: t.name, type: t.toolType, status, ...(issue ? { issue } : {}) });
      }

      const errorCount = results.filter((r) => r.status === 'error').length;
      const warnCount = results.filter((r) => r.status === 'warning').length;
      const okCount = results.filter((r) => r.status === 'ok').length;
      const summary = `Tool health: ${okCount} ok, ${warnCount} warnings, ${errorCount} errors out of ${allTools.length} tools.`;

      // Store results in memory
      await db.insert(memory).values({
        id: uuidv4(),
        content: `${summary}\n\nDetails:\n${results.map((r) => `- ${r.name} (${r.type}): ${r.status}${r.issue ? ` — ${r.issue}` : ''}`).join('\n')}`,
        category: 'tool_health',
        entities: JSON.stringify([agentId]),
        sourceAgentId: agentId,
        sourceAgentName: agent.name,
        sourceTool: 'check_tool_health',
        metadata: JSON.stringify({ timestamp: new Date().toISOString(), results }),
      });

      return JSON.stringify({ summary, results });
    }

    case 'request_capability': {
      // Manager-gated capability escalation (task 4.3):
      // 1. Manager (Sonnet) reviews existing flows first
      // 2. If covered → return "use existing: <flow_name>"
      // 3. If genuinely new → commission request_flow (opens Flow Generator in UI)
      const capDesc = inp.capability_description as string;
      const whyNeeded = inp.why_needed as string;
      const alreadyTried = (inp.already_tried as string | undefined) ?? '';

      // Load existing flows for manager to review
      const existingFlowsForManager = agentFlows.map((f) => `- ${f.name}: ${f.description}`).join('\n') || '(no flows yet)';

      const managerPrompt = `You are the manager for an autonomous agent. The agent is requesting a new capability.

AGENT REQUEST:
${capDesc}

WHY NEEDED:
${whyNeeded}

${alreadyTried ? `ALREADY TRIED:\n${alreadyTried}\n\n` : ''}EXISTING FLOWS:
${existingFlowsForManager}

Decide one of:
1. "REUSE" — an existing flow already covers this need. Tell the agent exactly which flow to call and with what inputs.
2. "BUILD" — this is genuinely new. Provide a clean task description for the Flow Builder (mechanical browser steps only, no content generation).

Respond with JSON: { "decision": "REUSE" | "BUILD", "reasoning": "...", "reuse_flow": "flow_name (if REUSE)", "build_description": "flow builder task (if BUILD)" }`;

      let managerDecision: { decision: 'REUSE' | 'BUILD'; reasoning: string; reuse_flow?: string; build_description?: string } = {
        decision: 'BUILD',
        reasoning: 'Manager review unavailable — proceeding to build',
        build_description: capDesc,
      };

      try {
        const anthropicManager = new Anthropic({ apiKey });
        const managerResp = await anthropicManager.messages.create({
          model: agent.model ?? 'claude-sonnet-4-6',
          max_tokens: 512,
          messages: [{ role: 'user', content: managerPrompt }],
        });
        const managerText = managerResp.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const jsonMatch = managerText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          managerDecision = JSON.parse(jsonMatch[0]) as typeof managerDecision;
        }
      } catch (err) {
        logger.warn({ err, agentId }, 'request_capability: manager review failed');
      }

      if (managerDecision.decision === 'REUSE' && managerDecision.reuse_flow) {
        return JSON.stringify({
          decision: 'reuse',
          message: `Manager decision: use existing flow "${managerDecision.reuse_flow}" — no new build needed.`,
          reasoning: managerDecision.reasoning,
          existing_flow: managerDecision.reuse_flow,
        });
      }

      // BUILD: open the flow generator
      const buildTask = managerDecision.build_description ?? capDesc;
      const taskWithContext = `${buildTask}\n\nCONTEXT (from capability request):\n${whyNeeded}`;
      ctxEmit?.({ type: 'open_flow_generator', prompt: taskWithContext });

      return JSON.stringify({
        decision: 'build',
        message: 'Manager approved: this is a new capability. The flow generator has been opened in the UI.',
        reasoning: managerDecision.reasoning,
        status: 'flow_generator_opened',
      });
    }

    case 'request_flow': {
      // Merge optional context into the task description so the Flow Generator has full picture
      const context = inp.context as string | undefined;
      const taskWithContext = context
        ? `${inp.task_description as string}\n\nCONTEXT FROM AGENT:\n${context}`
        : inp.task_description as string;

      // Hand off to the full flow generator UI instead of the internal builder.
      // The frontend will navigate to the flow generator with autoApply=true and
      // return to this chat when the flow is built and applied.
      ctxEmit?.({ type: 'open_flow_generator', prompt: taskWithContext });

      return JSON.stringify({
        status: 'flow_generator_opened',
        message: 'The flow generator has been opened in the UI. The user will be redirected back to this chat once the flow is built and applied. Your current run is ending — resume when the user returns.',
      });
    }

    case 'revise_flow': {
      const flowId = inp.flow_id as string;
      const feedback = inp.feedback as string;

      // Fetch the existing flow to get its original description for context
      const [existingFlow] = await db.select().from(flows).where(eq(flows.id, flowId));
      if (!existingFlow) return JSON.stringify({ error: `Flow "${flowId}" not found — it may have already been deleted` });

      // Delete the old version so the builder starts fresh
      await db.delete(flows).where(eq(flows.id, flowId));
      agentFlows.splice(0, agentFlows.length, ...(await db.select().from(flows).where(eq(flows.agentId, agentId))));

      // Rebuild with the original task + feedback as context
      const allTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
      const revisedTask = `${existingFlow.description}\n\nREVISION FEEDBACK (please incorporate):\n${feedback}`;

      // Select the correct agent based on the flow's type
      const flowType = existingFlow.flowType ?? 'scrape';
      const agentParams = {
        agentId,
        agentName: agent.name,
        taskDescription: revisedTask,
        availableTools: allTools.map((t) => ({ id: t.id, name: t.name, description: t.description, inputSchema: t.inputSchema })),
        testInput: (inp.test_input as Record<string, unknown>) ?? undefined,
        apiKey,
        agentModel: agent.model,
        emit: ctxEmit,
      };
      const buildResult = flowType === 'action'
        ? await runActionFlowAgent(agentParams)
        : await runScrapeFlowAgent(agentParams);

      agentFlows.splice(0, agentFlows.length, ...(await db.select().from(flows).where(eq(flows.agentId, agentId))));

      if (!buildResult.success || !buildResult.flow_id) {
        return JSON.stringify({ success: false, attempts: buildResult.attempts, notes: buildResult.notes });
      }

      const [revisedFlow] = await db.select().from(flows).where(eq(flows.id, buildResult.flow_id));
      const stepsPreview = revisedFlow ? (() => {
        try {
          const steps = JSON.parse(revisedFlow.steps) as Array<{ label?: string }>;
          return steps.map((s, i) => `  ${i + 1}. ${s.label ?? '(unlabeled)'}`).join('\n');
        } catch { return '  (steps unavailable)'; }
      })() : '  (unavailable)';

      return JSON.stringify({
        success: true,
        flow_id: buildResult.flow_id,
        flow_name: buildResult.flow_name,
        input_schema: revisedFlow ? JSON.parse(revisedFlow.inputSchema) : {},
        steps_summary: stepsPreview,
        test_result: buildResult.test_result ?? null,
        attempts: buildResult.attempts,
        next_step: `Revised. If this looks right, call: ${buildResult.flow_name}({...}). Still not right? Call revise_flow again with more specific feedback.`,
      });
    }

    // queue_action, list_pending_actions, complete_action case handlers
    // REMOVED (OPERATION CONVERGENCE Task 4.5) — pendingActions table dropped.

    // Performance Log
    case 'log_outcome': {
      const newId = uuidv4();
      await db.insert(performanceLog).values({
        id: newId,
        agentId,
        category: (inp.category as string) ?? 'other',
        action: inp.action as string,
        outcome: (inp.outcome as string) ?? 'unknown',
        value: (inp.value as number) ?? 0,
        notes: (inp.notes as string) ?? '',
        metadata: JSON.stringify({}),
        runId: ctx.runId,
      });
      return JSON.stringify({ success: true, log_id: newId });
    }

    case 'analyze_performance': {
      const limit = Math.min((inp.limit as number) ?? 100, 500);
      const days = (inp.days as number) ?? 30;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();

      let entries;
      if (inp.category) {
        entries = await db.select().from(performanceLog)
          .where(and(eq(performanceLog.agentId, agentId), eq(performanceLog.category, inp.category as string)))
          .orderBy(desc(performanceLog.createdAt)).limit(limit);
      } else {
        entries = await db.select().from(performanceLog)
          .where(eq(performanceLog.agentId, agentId))
          .orderBy(desc(performanceLog.createdAt)).limit(limit);
      }

      entries = entries.filter((e) => e.createdAt >= since);

      // Aggregate by category + outcome
      const byCategory = Object.entries(
        entries.reduce<Record<string, { total: number; success: number; failure: number; pending: number }>>((acc, e) => {
          if (!acc[e.category]) acc[e.category] = { total: 0, success: 0, failure: 0, pending: 0 };
          acc[e.category].total++;
          if (e.outcome === 'success') acc[e.category].success++;
          if (e.outcome === 'failure') acc[e.category].failure++;
          if (e.outcome === 'pending') acc[e.category].pending++;
          return acc;
        }, {}),
      ).map(([cat, v]) => ({
        category: cat, ...v,
        successRate: v.total > 0 ? `${Math.round((v.success / v.total) * 100)}%` : 'n/a',
      }));

      const recentFailures = entries.filter((e) => e.outcome === 'failure').slice(0, 10)
        .map((e) => ({ action: e.action, notes: e.notes, createdAt: e.createdAt }));

      return JSON.stringify({
        period: `Last ${days} days`,
        totalEntries: entries.length,
        byCategory,
        recentFailures,
        insight: entries.length === 0 ? 'No performance data yet. Start logging outcomes with log_outcome after each significant action.' : null,
      });
    }

    // Status
    case 'update_status': {
      // Store current task in memory with special category so frontend can query it
      await db.insert(memory).values({
        id: uuidv4(),
        content: inp.current_task as string,
        category: 'agent_status',
        entities: JSON.stringify([agentId]),
        sourceAgentId: agentId,
        sourceAgentName: agent.name,
        sourceTool: 'autonomous_status',
        metadata: JSON.stringify({ plan: inp.plan ?? null, runId: ctx.runId, timestamp: new Date().toISOString() }),
      });
      return JSON.stringify({ success: true });
    }

    case 'supervisor_checkin': {
      // Save progress as a journal entry
      await db.insert(memory).values({
        id: uuidv4(),
        content: inp.summary as string,
        category: 'session_journal',
        entities: JSON.stringify([agentId]),
        sourceAgentId: agentId,
        sourceAgentName: agent.name,
        sourceTool: 'supervisor_checkin',
        metadata: JSON.stringify({ runId: ctx.runId, timestamp: new Date().toISOString() }),
      });

      // Run manager review synchronously — await so we can return the directive.
      // The agent reads the directive and CONTINUES WORKING.
      const directive = await runManagerReview(
        agentId,
        agent.name,
        inp.summary as string,
        apiKey,
        agent.model,
        ctx.runId,
        ctxEmit,
      );

      return JSON.stringify({
        success: true,
        checkin_complete: true,
        manager_directive: directive,
        message: 'Check-in complete. Manager has reviewed your progress. Continue working with the directive above — the run is NOT stopping.',
      });
    }

    case 'stop_working': {
      // Save a final journal entry then stop
      await db.insert(memory).values({
        id: uuidv4(),
        content: `[STOP] ${inp.summary as string}`,
        category: 'session_journal',
        entities: JSON.stringify([agentId]),
        sourceAgentId: agentId,
        sourceAgentName: agent.name,
        sourceTool: 'stop_working',
        metadata: JSON.stringify({ runId: ctx.runId, reason: inp.reason, timestamp: new Date().toISOString() }),
      });

      // Fire manager review async (non-blocking) so it still analyses and creates tasks
      runManagerReview(
        agentId,
        agent.name,
        inp.summary as string,
        apiKey,
        agent.model,
        ctx.runId,
        ctxEmit,
      ).catch(() => { /* non-fatal */ });

      return JSON.stringify({ success: true, stopping: true, reason: inp.reason, summary: inp.summary });
    }

    default:
      throw new Error(`Unknown management tool: ${toolName}`);
  }
}
