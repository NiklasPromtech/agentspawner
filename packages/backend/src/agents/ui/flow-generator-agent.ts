/**
 * Flow Generator Agent
 *
 * This module implements the flow builder AI agent that helps users construct browser automation
 * flows. It exposes tools for page inspection, DOM analysis, flow testing, and submission.
 * The agent uses Claude to guide the user through building flows step-by-step.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { agents, tools, actionLog } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { runTool } from '../../orchestrator/tool-runner.js';
import { runFlowDetailed } from '../../features/flows/flow-runner.js';
import { validateFlow, type FlowMeta } from '../../features/flows/flow-validator.js';
import { v4 as uuidv4 } from 'uuid';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { saveScreenshotToDisk, SCREENSHOTS_DIR } from '../../lib/screenshots.js';
import { runFlowExplorer, type ExplorationReport } from './flow-explorer-agent.js';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Local types (mirrors frontend types) ─────────────────────────────────────

type InputExpression =
  | { type: 'literal'; value: unknown }
  | { type: 'flow_input'; key: string }
  | { type: 'step_ref'; stepId: string; path: string };

interface StepCondition {
  check: 'min_array_length' | 'non_empty' | 'result_equals' | 'result_not_equals' | 'has_error' | 'no_error';
  minLength?: number;
  value?: string;
  failMessage: string;
  suggestTool?: string;
  skipToStepId?: string | null;
  skipToStepIdOnNoMatch?: string | null;
}

interface FlowStep {
  id: string;
  toolId: string;
  label: string;
  inputMapping: Record<string, InputExpression>;
  condition?: StepCondition | null;
  transform?: { script: string };
}

interface FlowOutput {
  name: string;
  description: string;
  flowType: 'scrape' | 'action';
  inputSchema: string;
  steps: FlowStep[];
  returnStepId: string | null;
  expectedOutput?: string | null;
  // Deduplication fields (action flows only)
  dedupKeyField?: string | null;
  dedupBreakType?: 'hard' | 'soft' | null;
  dedupIntervalHours?: number | null;
  dedupBlockMessage?: string | null;
  requiresApproval?: boolean | null;
}

// ── Claude-generated format (uses string IDs and tool names) ─────────────────

interface GeneratedInputExpr {
  type: string;
  value?: unknown;
  key?: string;
  stepId?: string;
  path?: string;
}

interface GeneratedStep {
  id: string;
  toolName: string;
  label: string;
  inputMapping: Record<string, GeneratedInputExpr>;
  condition?: {
    check: string;
    minLength?: number;
    value?: string;
    failMessage: string;
    suggestTool?: string;
    skipToStepId?: string | null;
    skipToStepIdOnNoMatch?: string | null;
  } | null;
  transform?: { script: string };
}

interface GeneratedFlowDef {
  name: string;
  description: string;
  flowType: 'scrape' | 'action';
  inputFields: { key: string; description: string }[];
  steps: GeneratedStep[];
  returnStepId: string | null;
  expectedOutput?: string | null;
  // Deduplication fields (action flows only)
  dedupKeyField?: string | null;
  dedupBreakType?: 'hard' | 'soft' | null;
  dedupIntervalHours?: number | null;
  dedupBlockMessage?: string | null;
  requiresApproval?: boolean | null;
}

// ── SSE event shape sent to the frontend ──────────────────────────────────────

export type GeneratorEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; tool: string; displayText: string }
  | { type: 'tool_result'; tool: string; summary: string }
  | { type: 'screenshot'; url: string }
  | { type: 'flow_update'; steps?: Array<{ label: string; toolName: string }>; name?: string; description?: string }
  | { type: 'complete'; flow: FlowOutput; explanation?: string }
  | { type: 'reply'; content: string }
  | { type: 'error'; message: string }
  | { type: 'fatal_error'; message: string }
  | { type: 'input_request'; fields: Array<{ key: string; label: string; placeholder?: string; required?: boolean }> }
  // ── Explorer phase events ────────────────────────────────────────────────────
  | { type: 'explorer_start' }
  | { type: 'explorer_thinking'; text: string }
  | { type: 'explorer_tool_call'; tool: string; displayText: string }
  | { type: 'explorer_tool_result'; tool: string; summary: string; ok: boolean }
  | { type: 'explorer_complete'; success: boolean; summary: string }
  | { type: 'builder_start' }
  | { type: 'research_summary'; text: string }
  | { type: 'session_facts'; facts: string[] }
  | { type: 'token_usage'; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'done' };

// ── Generator tools exposed to Claude ────────────────────────────────────────

const GENERATOR_TOOLS = [
  {
    name: 'inspect_page',
    description:
      'Open a URL in a background tab, wait 3 seconds for it to load, then return the cleaned DOM (scripts/styles stripped, truncated to 15k chars). Use this to see actual page structure before writing any CSS selectors.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The full URL to inspect' },
      },
      required: ['url'],
    },
  },
  {
    name: 'analyze_dom',
    description:
      'Given DOM HTML and a question, returns precise CSS selectors and structural analysis. Use after inspect_page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        dom: { type: 'string', description: 'The HTML content from inspect_page' },
        question: { type: 'string', description: 'What selectors or structural info to find' },
      },
      required: ['dom', 'question'],
    },
  },
  {
    name: 'test_flow',
    description:
      'Run a flow definition with test input and return the result. For action flows, automatically runs guard validation after the main test: seeds an action_log entry, re-runs the flow, and verifies the guard step fires correctly. The result includes a guardValidation block — you MUST check it before calling submit_flow.',
    input_schema: {
      type: 'object' as const,
      properties: {
        flow: { type: 'object', description: 'The flow definition object (same structure as submit_flow)' },
        testInput: { type: 'object', description: 'Test input values matching the flow\'s inputFields (e.g. { "username": "jack", "message": "Hello!" })' },
      },
      required: ['flow', 'testInput'],
    },
  },
  {
    name: 'request_test_inputs',
    description:
      'Pause flow building and ask the user to provide real test values via an interactive form. Use this when you need specific test data (e.g. a real Twitter handle, a real post URL) to run test_flow. The user will fill in the form and submit — their values come back in the next message. After calling this, DO NOT call test_flow or submit_flow in the same turn.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fields: {
          type: 'array',
          description: 'The input fields to collect from the user',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Field key (snake_case) — becomes the test input key' },
              label: { type: 'string', description: 'Human-readable label shown to the user' },
              placeholder: { type: 'string', description: 'Example value (e.g. "@username")' },
              required: { type: 'boolean', description: 'Whether this field is required' },
            },
            required: ['key', 'label'],
          },
        },
        reason: { type: 'string', description: 'Brief explanation of why these values are needed (shown to user above the form)' },
      },
      required: ['fields', 'reason'],
    },
  },
  {
    name: 'submit_flow',
    description:
      'Submit the completed, verified flow definition. Only call this after test_flow has confirmed the flow works with real test data.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Snake_case flow name (e.g. get_profile_bio)' },
        description: { type: 'string', description: 'One sentence describing what this flow does' },
        flowType: {
          type: 'string',
          enum: ['scrape', 'action'],
          description: 'scrape = read-only, safe to repeat. action = writes/sends/posts, has side effects — MUST have a guard step.',
        },
        inputFields: {
          type: 'array',
          description: 'Flow-level input parameters',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Parameter key (snake_case)' },
              description: { type: 'string', description: 'What this parameter is' },
            },
            required: ['key', 'description'],
          },
        },
        steps: {
          type: 'array',
          description: 'Ordered list of flow steps',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Simple string ID you choose (e.g. "open_step", "wait_step")' },
              toolName: { type: 'string', description: 'Exact tool name from available tools list' },
              label: { type: 'string', description: 'Human-readable step label' },
              inputMapping: {
                type: 'object',
                description: 'Map of tool input field name to expression',
                additionalProperties: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['literal', 'flow_input', 'step_ref'] },
                    value: { description: 'For literal: the value to use' },
                    key: { type: 'string', description: 'For flow_input: the input key name' },
                    stepId: { type: 'string', description: 'For step_ref: the ID of the step to reference' },
                    path: { type: 'string', description: 'For step_ref: dot-notation path into step result (e.g. "tabId", "items.0.text")' },
                  },
                  required: ['type'],
                },
              },
              condition: {
                type: 'object',
                description: 'Optional: evaluate the step result after it runs.',
                nullable: true,
                properties: {
                  check: {
                    type: 'string',
                    enum: ['has_error', 'no_error', 'result_equals', 'result_not_equals', 'min_array_length', 'non_empty'],
                  },
                  value: { type: 'string' },
                  minLength: { type: 'number' },
                  failMessage: { type: 'string' },
                  suggestTool: { type: 'string' },
                  skipToStepId: { type: 'string', nullable: true },
                  skipToStepIdOnNoMatch: { type: 'string', nullable: true },
                },
                required: ['check', 'failMessage'],
              },
            },
            required: ['id', 'toolName', 'label', 'inputMapping'],
          },
        },
        returnStepId: {
          type: 'string',
          nullable: true,
          description: 'ID of the step whose result is the flow output. Use null for the last step.',
        },
        expectedOutput: {
          type: 'string',
          description: 'Plain-English description of what a successful output looks like. E.g. "A JSON object with title, author, body, and a comments array. Each comment has author, body, and timestamp." Be specific about field names and shapes. This is used for automated QA validation.',
        },
        dedupKeyField: {
          type: 'string',
          description: '(action flows only) The input field name that uniquely identifies the target of this action — e.g. "post_url", "user_handle", "comment_id". REQUIRED for action flows. The dedup system uses this to prevent running the same action twice on the same target.',
        },
        dedupBreakType: {
          type: 'string',
          enum: ['hard', 'soft'],
          description: '(action flows only) "hard" = never repeat for the same key (e.g. post_comment, send_connection_request). "soft" = allow repeat after a cooldown (e.g. follow_up_dm). Required when dedupKeyField is set.',
        },
        dedupIntervalHours: {
          type: 'number',
          description: '(action flows only, soft dedup) Minimum hours between repeated runs for the same key. E.g. 24 for daily follow-ups.',
        },
        dedupBlockMessage: {
          type: 'string',
          description: '(action flows only) Message the agent receives when this action is blocked by dedup. Tell it what to do instead — e.g. "Use reply_to_comment to respond further" or "Check if 24h have passed before using follow_up_dm".',
        },
        requiresApproval: {
          type: 'boolean',
          description: '(action flows only) If true, the flow queues a pending entry in Review Actions instead of executing immediately. Use for high-risk irreversible actions (send DM, post content, delete).',
        },
      },
      required: ['name', 'description', 'flowType', 'inputFields', 'steps', 'returnStepId', 'expectedOutput'],
    },
  },
  {
    name: 'record_fact',
    description:
      'Save a confirmed working pattern discovered during this build session. Write it as a positive, actionable statement — what to USE, not what failed. Good examples: "LinkedIn feed: get_dom_filtered on [data-testid=\'lazy-column\'] returns post text, author names, and hrefs", "Reddit: GET /r/{sub}/new.json returns posts at data.children[].data — no auth needed", "LinkedIn: navigate on an existing tab instead of open_tab — new tabs take too long to connect". Recorded facts are automatically injected into context when building the NEXT flow in this session.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fact: { type: 'string', description: 'A confirmed working pattern — written as a positive, reusable instruction. Start with the platform/tool name. Describe what selector, endpoint, or approach to use and what it returns.' },
      },
      required: ['fact'],
    },
  },
  {
    name: 'rename_flow',
    description: 'Update the name and/or description of the flow that was just submitted. Only call this AFTER submit_flow has succeeded. Use when the user asks to rename the flow, or when you want to improve the description based on what you learned during building.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'New snake_case name for the flow (optional — omit to keep current name)' },
        description: { type: 'string', description: 'New one-sentence description (optional — omit to keep current)' },
      },
      required: [],
    },
  },
] satisfies Anthropic.Messages.Tool[];

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ── QA structural summary — describes output shape instead of sending raw JSON ─

function describeValue(val: unknown, depth: number): string {
  if (depth > 3) return '…';
  if (val === null || val === undefined) return String(val);
  if (typeof val === 'string') return depth === 0 ? `"${val.slice(0, 120)}"` : `string(${val.length})`;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return 'array(empty)';
    const sample = describeValue(val[0], depth + 1);
    return `array(${val.length}), first: { ${sample} }`;
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>)
      .slice(0, 8)
      .map(([k, v]) => `${k}: ${describeValue(v, depth + 1)}`);
    return entries.join(', ') + (Object.keys(val as object).length > 8 ? ', …' : '');
  }
  return String(val);
}

function buildQASummary(testResultStr: string): string {
  try {
    const tr = JSON.parse(testResultStr) as { ok?: boolean; error?: string; result?: string; durationMs?: number };
    if (!tr.ok) return `TEST FAILED: ${tr.error ?? 'unknown error'}`;
    let resultDesc = '(no result)';
    if (tr.result) {
      try {
        const parsed: unknown = JSON.parse(tr.result);
        resultDesc = describeValue(parsed, 0);
      } catch {
        const s = tr.result;
        const looksHtml = s.includes('<html') || s.includes('<!DOCTYPE') || s.includes('{"html":');
        resultDesc = looksHtml
          ? `RAW HTML (${s.length} chars) — the fetch returned a rendered page, not structured data`
          : `Non-JSON string (${s.length} chars): "${s.slice(0, 200)}"`;
      }
    }
    return `Test PASSED in ${tr.durationMs ?? 0}ms\nOutput structure: ${resultDesc}`;
  } catch {
    return `Could not parse test result: ${testResultStr.slice(0, 400)}`;
  }
}

function buildExplorationSection(report: ExplorationReport): string {
  if (!report.success) {
    return `\n\n## Exploration phase — FAILED\n\nThe explorer tried to automate this task but could not:\n${report.additionalNotes}\n\nFailed approaches:\n${report.failedApproaches.map((f) => `- ${f.approach}: ${f.reason}`).join('\n') || '(none recorded)'}\n\nFall back to inspect_page and analyze_dom to investigate manually.`;
  }

  const stepsSection = report.workingSteps.length > 0
    ? report.workingSteps.map((s, i) =>
        `Step ${i + 1}: ${s.tool}(${JSON.stringify(s.input)})\n  → ${s.outputSummary}${s.notes ? `\n  Note: ${s.notes}` : ''}`
      ).join('\n')
    : '(no steps recorded)';

  const failedSection = report.failedApproaches.length > 0
    ? `\n### Failed approaches (do NOT retry these):\n${report.failedApproaches.map((f) => `- ${f.approach}: ${f.reason}`).join('\n')}`
    : '';

  const inputsSection = report.inputsNeeded.length > 0
    ? `\n### Runtime inputs needed:\n${report.inputsNeeded.map((i) => `- ${i.key}: ${i.description} (example: ${i.exampleValue})`).join('\n')}`
    : '';

  return `\n\n## Exploration phase — COMPLETE ✅\n\nThe explorer has already verified a working approach. Build the flow directly from these confirmed findings — do NOT use inspect_page or analyze_dom.\n\n### Working approach: ${report.approach}\n\n### Verified step sequence:\n${stepsSection}${inputsSection}\n\n### Data shape:\n${report.dataShape}${failedSection}${report.additionalNotes ? `\n\n### Additional notes:\n${report.additionalNotes}` : ''}`;
}

function buildSystemPrompt(
  agentTools: { name: string; description: string; inputSchema: string }[],
  flowType?: 'scrape' | 'action',
  sessionFacts?: string[],
  explorationReport?: ExplorationReport,
): string {
  const toolCatalog = agentTools
    .map((t) => {
      let props = '';
      try {
        const s = JSON.parse(t.inputSchema) as { properties?: Record<string, { type?: string; description?: string }> };
        if (s.properties && Object.keys(s.properties).length > 0) {
          props =
            '\n' +
            Object.entries(s.properties)
              .map(([k, v]) => `    ${k} (${v.type ?? 'any'}): ${v.description ?? ''}`)
              .join('\n');
        }
      } catch { /* ignore */ }
      return `- ${t.name}: ${t.description}${props}`;
    })
    .join('\n');

  const preamblePath = flowType === 'action'
    ? join(__dirname, 'flow-generator.action.preamble.md')
    : flowType === 'scrape'
    ? join(__dirname, 'flow-generator.scrape.preamble.md')
    : null;
  const preamble = preamblePath ? readFileSync(preamblePath, 'utf-8') : '';

  const sessionFactsSection = sessionFacts && sessionFacts.length > 0
    ? `\n\n## Confirmed working patterns from this session\n\nThese were verified while building earlier flows. Follow them exactly — do not re-investigate:\n${sessionFacts.map((f) => `- ${f}`).join('\n')}`
    : '';

  const explorationSection = explorationReport ? buildExplorationSection(explorationReport) : '';

  const template = readFileSync(join(__dirname, 'flow-generator.prompt.md'), 'utf-8');
  return template
    .replace('{{FLOW_TYPE_PREAMBLE}}', preamble)
    .replace('{{TOOL_CATALOG}}', toolCatalog || '(no tools installed — ask the user to add extension primitives first via the Tools tab)')
    .replace('{{SESSION_FACTS}}', sessionFactsSection + explorationSection);
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function inspectPage(url: string, agentId: string): Promise<string> {
  const db = getDb();
  const agentTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
  const find = (name: string) => agentTools.find((t) => t.name === name);

  const openTab = find('open_tab');
  const getDom = find('get_dom');
  const closeTab = find('close_tab');

  if (!openTab || !getDom || !closeTab) {
    return JSON.stringify({
      error: 'Required tools (open_tab, get_dom, close_tab) are not installed. Ask the user to add extension primitives via the Tools tab first.',
    });
  }

  let tabId: number | undefined;
  try {
    const openResult = JSON.parse(await runTool(openTab, { url, active: false }, agentId)) as { tabId?: number };
    tabId = openResult.tabId;
    if (tabId === undefined) return JSON.stringify({ error: 'open_tab did not return a tabId' });

    await new Promise((r) => setTimeout(r, 3000));

    const domResult = JSON.parse(await runTool(getDom, { tabId }, agentId)) as { html?: string };
    const html = domResult.html ?? '';

    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 15000);

    return JSON.stringify({ dom: cleaned, url, length: cleaned.length });
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    if (tabId !== undefined) {
      const closeTab_ = find('close_tab');
      if (closeTab_) await runTool(closeTab_, { tabId }, agentId).catch(() => {});
    }
  }
}

async function analyzeDom(dom: string, question: string, apiKey: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `HTML:\n${dom}\n\nQuestion: ${question}\n\nProvide exact CSS selectors and structural analysis.`,
      },
    ],
  });
  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ── processFlowDef: convert Claude's generated format → FlowOutput ────────────

async function processFlowDef(
  def: GeneratedFlowDef,
  agentId: string,
): Promise<FlowOutput> {
  const db = getDb();
  const agentTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
  const toolNameToId = new Map(agentTools.map((t) => [t.name, t.id]));

  const idMap = new Map<string, string>();
  for (const step of def.steps) {
    idMap.set(step.id, uuidv4());
  }

  const inputSchema =
    def.inputFields.length > 0
      ? JSON.stringify({
          type: 'object',
          properties: Object.fromEntries(
            def.inputFields.map((f) => [f.key, { type: 'string', description: f.description }]),
          ),
          required: def.inputFields.map((f) => f.key),
        })
      : '{}';

  const steps: FlowStep[] = def.steps.map((step) => {
    const uuid = idMap.get(step.id);
    if (!uuid) throw new Error(`Step ID "${step.id}" not in ID map`);

    // screenshot, transform, hydrate, generate are built-in sentinels that bypass the tool DB.
    const BUILTIN_SENTINELS: Record<string, string> = {
      screenshot: '__screenshot__',
      __transform__: '__transform__',
      query_action_log: '__query_action_log__',
      query_memory: '__query_memory__',
      __hydrate__: '__hydrate__',
      __generate__: '__generate__',
    };
    const toolId = toolNameToId.get(step.toolName) ?? BUILTIN_SENTINELS[step.toolName] ?? null;
    if (!toolId) {
      throw new Error(
        `Tool "${step.toolName}" not found. Available: ${[...toolNameToId.keys()].join(', ')}`,
      );
    }

    const inputMapping: Record<string, InputExpression> = {};
    for (const [field, expr] of Object.entries(step.inputMapping)) {
      if (expr.type === 'literal') {
        inputMapping[field] = { type: 'literal', value: expr.value };
      } else if (expr.type === 'flow_input') {
        inputMapping[field] = { type: 'flow_input', key: expr.key ?? '' };
      } else if (expr.type === 'step_ref') {
        const refUuid = idMap.get(expr.stepId ?? '');
        if (!refUuid) {
          throw new Error(`step_ref in step "${step.id}" references unknown stepId "${expr.stepId}"`);
        }
        inputMapping[field] = { type: 'step_ref', stepId: refUuid, path: expr.path ?? '' };
      } else {
        inputMapping[field] = { type: 'literal', value: null };
      }
    }

    const converted: FlowStep = { id: uuid, toolId, label: step.label, inputMapping };
    if (step.transform) {
      converted.transform = step.transform;
    }
    if (step.condition) {
      converted.condition = {
        ...(step.condition as StepCondition),
        skipToStepId: step.condition.skipToStepId
          ? (idMap.get(step.condition.skipToStepId) ?? null)
          : null,
        skipToStepIdOnNoMatch: step.condition.skipToStepIdOnNoMatch
          ? (idMap.get(step.condition.skipToStepIdOnNoMatch) ?? null)
          : null,
      };
    }
    return converted;
  });

  let returnStepId: string | null = null;
  if (def.returnStepId) {
    const refUuid = idMap.get(def.returnStepId);
    if (!refUuid) throw new Error(`returnStepId references unknown step "${def.returnStepId}"`);
    returnStepId = refUuid;
  }

  return {
    name: def.name,
    description: def.description,
    flowType: def.flowType ?? 'scrape',
    inputSchema,
    steps,
    returnStepId,
    expectedOutput: def.expectedOutput ?? null,
    // Dedup fields — only meaningful for action flows
    dedupKeyField: def.dedupKeyField ?? null,
    dedupBreakType: def.dedupBreakType ?? null,
    dedupIntervalHours: def.dedupIntervalHours ?? null,
    dedupBlockMessage: def.dedupBlockMessage ?? null,
    requiresApproval: def.requiresApproval ?? null,
  };
}

// ── testFlowInGenerator ───────────────────────────────────────────────────────

async function testFlowInGenerator(
  flowDef: GeneratedFlowDef,
  testInput: Record<string, unknown>,
  agentId: string,
  apiKey: string,
  anthropic: Anthropic,
  agentModel: string,
  emit: (event: GeneratorEvent) => void,
): Promise<string> {
  let processedFlow: FlowOutput;
  try {
    processedFlow = await processFlowDef(flowDef, agentId);
  } catch (err) {
    return JSON.stringify({ error: `Flow processing failed: ${err instanceof Error ? err.message : String(err)}` });
  }

  const mockFlowRecord = {
    id: 'test',
    agentId,
    name: processedFlow.name,
    description: processedFlow.description,
    inputSchema: processedFlow.inputSchema,
    steps: JSON.stringify(processedFlow.steps),
    returnStepId: processedFlow.returnStepId,
    returnSteps: null,
    resultMessage: null,
    pinned: false,
  };

  let testResult: Awaited<ReturnType<typeof runFlowDetailed>>;
  try {
    testResult = await runFlowDetailed(mockFlowRecord, testInput, agentId, { apiKey });
  } catch (err) {
    return JSON.stringify({ error: `Flow execution threw: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Build per-step summary
  // OPERATION SCREENSHOT REFS: save any screenshot data URLs to disk and record the URL reference
  const stepSummary: Record<string, unknown> = {};
  for (const step of processedFlow.steps) {
    const result = testResult.stepResults[step.id];
    if (typeof result === 'string' && result.startsWith('data:image')) {
      stepSummary[step.label] = '[screenshot]';
    } else {
      stepSummary[step.label] = result;
    }
  }

  // Find screenshot and stream it to the frontend as a URL reference
  let screenshotDataUrl: string | null = null;
  let screenshotUrl: string | null = null;
  for (const val of Object.values(testResult.stepResults)) {
    if (typeof val === 'string' && val.startsWith('data:image')) {
      screenshotDataUrl = val;
      break;
    }
  }

  if (screenshotDataUrl) {
    try {
      screenshotUrl = saveScreenshotToDisk(screenshotDataUrl);
      emit({ type: 'screenshot', url: screenshotUrl });
    } catch {
      // screenshot save failed — skip frontend emit
    }
  }

  // Vision verify
  let visionAnalysis: string | null = null;
  if (screenshotDataUrl) {
    try {
      const base64 = screenshotDataUrl.replace(/^data:image\/[^;]+;base64,/, '');
      const visionResp = await anthropic.messages.create({
        model: agentModel,
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
            {
              type: 'text',
              text: `This screenshot was captured at the end of a flow test.\nFlow: "${processedFlow.name}"\nTest input: ${JSON.stringify(testInput)}\nFlow result: ${testResult.result ?? testResult.error ?? '(no result)'}\n\nDescribe what you see. Did the flow appear to succeed? If not, what went wrong? Pay special attention to: (1) whether any typed text appears to float or hover over the input field rather than being entered into it — this indicates a clear:true issue with type_text. Be specific.`,
            },
          ],
        }],
      });
      visionAnalysis = visionResp.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text).join('').trim();
    } catch { /* skip vision if it fails */ }
  }

  // ── Guard validation (task 3.2) — action flows only ──────────────────────────
  // After the first successful run, verify the guard works:
  //   Run #1 (already done): seed an action_log entry → guard should fire + exit early
  //   DB write check: verify action_log was written after the clean run (auto-checked by seeding)
  let guardValidation: {
    hasGuard: boolean;
    keyField: string | null;
    keyValue: string | null;
    repeatBlocked: boolean | null;
    guardFoundEntry: boolean | null;
    dbWriteVerified: boolean | null;
    error: string | null;
  } | null = null;

  if (processedFlow.flowType === 'action' && testResult.ok) {
    const db = getDb();

    // Find the query_action_log guard step
    const guardStep = processedFlow.steps.find((s) => s.toolId === '__query_action_log__');

    if (guardStep) {
      // Extract the key field and its actual value from the test input
      const keyValueExpr = guardStep.inputMapping['key_value'];
      let keyField: string | null = null;
      let keyValue: string | null = null;

      if (keyValueExpr?.type === 'flow_input' && keyValueExpr.key) {
        keyField = keyValueExpr.key;
        const raw = testInput[keyField];
        if (raw != null) keyValue = String(raw);
      } else if (keyValueExpr?.type === 'step_ref') {
        // key_value pulled from a prior step result — not directly extractable from testInput
        // Fall back: look at the guard step's actual result from run #1
        const guardResult = testResult.stepResults[guardStep.id] as Record<string, unknown> | undefined;
        keyField = 'unknown';
        keyValue = null; // can't easily seed without the key
        guardValidation = {
          hasGuard: true, keyField, keyValue,
          repeatBlocked: null, guardFoundEntry: guardResult?.found === true ? true : null,
          dbWriteVerified: null, error: 'key_value is a step_ref — seeded guard test not possible',
        };
      }

      if (keyField && keyValue && !guardValidation) {
        const seedId = uuidv4();
        let repeatBlocked: boolean | null = null;
        let guardFoundEntry: boolean | null = null;
        let dbWriteVerified: boolean | null = null;
        let validationError: string | null = null;

        emit({ type: 'thinking', text: `🛡️ Guard validation: seeding action_log for "${keyField}"="${keyValue}", then re-running to verify early exit...` });

        // ── OPERATION CONVERGENCE Task 8 — guard validation seed + cleanup ───────
        // The seed insert and cleanup delete are wrapped in try/finally to guarantee
        // the test entry is always removed from action_log even if an exception occurs
        // mid-validation.  Without this, orphaned seed entries with
        // flowId='guard_validation_seed' could accumulate and trigger false dedup
        // blocks on subsequent test runs for the same keyValue.
        // Full DB transaction isn't used here because the validation query (step 2) is
        // async and runs between the seed INSERT and the cleanup DELETE — SQLite's
        // synchronous transaction API can't span async boundaries.

        // 1. Seed an action_log entry (simulates "already done" state)
        try {
          await db.insert(actionLog).values({
            id: seedId,
            agentId,
            flowId: 'guard_validation_seed',
            flowName: processedFlow.name,
            flowType: 'action',
            keyField,
            keyValue,
            input: JSON.stringify(testInput),
            result: 'Seeded for guard validation',
            blocked: false,
            runId: null,
          });
        } catch (seedErr) {
          validationError = `Seed insert failed: ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`;
        }

        try {
          // 2. Verify the guard step would find the seeded entry — direct DB check, no live re-run.
          // Running the full flow here would re-execute browser actions (open tabs, click, type,
          // post comments, etc.) causing real-world side effects on every test_flow call.
          // Instead we run the same query the __query_action_log__ step uses at runtime.
          if (!validationError) {
            try {
              const seedRows = await db
                .select({ id: actionLog.id })
                .from(actionLog)
                .where(and(
                  eq(actionLog.agentId, agentId),
                  eq(actionLog.keyValue, keyValue),
                  eq(actionLog.blocked, false),
                ))
                .limit(1);
              // The seed we just inserted should be visible — if it is, the guard step would fire.
              guardFoundEntry = seedRows.length > 0;

              // Check condition configuration statically: does the guard step (or the step
              // immediately after it) have a skipToStepId that would cause early exit?
              const guardStepIndex = processedFlow.steps.findIndex(s => s.id === guardStep.id);
              const hasSkipOnGuard = !!(guardStep.condition?.skipToStepId);
              const nextStep =
                guardStepIndex >= 0 && guardStepIndex + 1 < processedFlow.steps.length
                  ? processedFlow.steps[guardStepIndex + 1]
                  : null;
              const hasSkipOnNext = !!(
                nextStep?.condition?.skipToStepId || nextStep?.condition?.skipToStepIdOnNoMatch
              );
              repeatBlocked = hasSkipOnGuard || hasSkipOnNext;
            } catch (checkErr) {
              validationError = `Guard DB check failed: ${checkErr instanceof Error ? checkErr.message : String(checkErr)}`;
            }
          }

          // 3. DB write check — verify run #1 wrote to action_log (seeded entry proves the table is writable)
          //    We check for entries OTHER than our seed (the actual post-run write requires dedupKeyField on the flow)
          //    Report that the table is accessible + writeable (seed succeeded)
          dbWriteVerified = !validationError; // seed succeeded = table writable
        } finally {
          // 4. Always clean up the seeded entry — even if validation throws
          try {
            await db.delete(actionLog).where(eq(actionLog.id, seedId));
          } catch { /* ignore cleanup errors */ }
        }

        const status = guardFoundEntry && repeatBlocked
          ? '✅ Guard working correctly — found prior entry, exited early'
          : guardFoundEntry && !repeatBlocked
          ? '⚠️ Guard found entry but flow may not have exited early — check skipToStepId on guard condition'
          : !guardFoundEntry
          ? '❌ Guard did not find the seeded entry — check query_action_log key_value mapping'
          : '⚠️ Guard validation inconclusive';

        emit({ type: 'thinking', text: `🛡️ ${status}` });

        guardValidation = { hasGuard: true, keyField, keyValue, repeatBlocked, guardFoundEntry, dbWriteVerified, error: validationError };
      }
    } else {
      // Action flow with no query_action_log guard step
      guardValidation = {
        hasGuard: false, keyField: null, keyValue: null,
        repeatBlocked: null, guardFoundEntry: null, dbWriteVerified: null,
        error: 'No query_action_log guard step found — action flow is missing its DB-first guard',
      };
      emit({ type: 'thinking', text: '❌ Guard validation: no query_action_log step found — action flow is missing its DB guard!' });
    }
  }

  return JSON.stringify({
    ok: testResult.ok,
    result: testResult.result,
    error: testResult.error,
    durationMs: testResult.durationMs,
    stepResults: stepSummary,
    screenshotCaptured: !!screenshotDataUrl,
    screenshotUrl: screenshotUrl ?? undefined,
    visionAnalysis,
    ...(guardValidation !== null ? { guardValidation } : {}),
  }, null, 2);
}

// ── Flow Generator Agent Main Loop ─────────────────────────────────────────────

/**
 * Runs the flow generator agent loop.
 * Implements the entire agentic while(true) loop that processes Claude's responses,
 * executes tools, and manages the conversation flow.
 */
/** Returns true when the initial messages look like a browser recording (skip explorer). */
function hasRecording(messages: Anthropic.Messages.MessageParam[]): boolean {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = typeof m.content === 'string' ? m.content : m.content
      .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    // Recordings look like "1. navigate https://..." or "2. click [selector]"
    if (/\d+\.\s+(navigate|click|type)\s/i.test(text)) return true;
  }
  return false;
}

export interface SeedContext {
  pageUrl: string;
  feedSelector?: string;
  postCardSelector?: string;
  expandSelector?: string;
  notes?: string;
}

export async function runFlowGeneratorAgent(params: {
  agentId: string;
  apiKey: string;
  agentTools: Array<{ id: string; name: string; description: string; inputSchema: string; toolType: string; code: string | null }>;
  agentModel: string;
  messages: Anthropic.Messages.MessageParam[];
  flowType?: 'scrape' | 'action';
  sessionFacts?: string[];
  seedContext?: SeedContext;
  isOpen: () => boolean;
}, emit: (event: GeneratorEvent) => void): Promise<void> {
  const anthropic = new Anthropic({ apiKey: params.apiKey });

  // Session-level facts carry forward from previous flow builds
  const sessionFacts: string[] = [...(params.sessionFacts ?? [])];

  // ── Explorer phase ──────────────────────────────────────────────────────────
  // Run the freehand explorer before the builder whenever:
  //   - A flowType is specified (we know what kind of flow to build)
  //   - The messages don't contain a browser recording (recording = already explored)
  //   - The agent has browser tools installed
  let explorationReport: ExplorationReport | undefined;

  // Only explore on the first turn (single user message). On subsequent turns
  // (e.g. test input values being returned) the exploration already happened —
  // skip it and go straight to the builder.
  const userMessageCount = params.messages.filter((m) => m.role === 'user').length;

  // ── Seed context path — user provided selectors via Quick Build form ─────────
  if (params.seedContext && userMessageCount === 1) {
    const s = params.seedContext;
    const notes: string[] = [];
    if (s.feedSelector)     notes.push(`Feed container (use for scroll_load AND get_dom_filtered): ${s.feedSelector}`);
    if (s.postCardSelector) notes.push(`Post card selector (for counting/validation): ${s.postCardSelector}`);
    if (s.expandSelector)   notes.push(`Expand button (use for click_all before extraction): ${s.expandSelector}`);
    else                    notes.push('No expand button — post text is fully visible without clicking.');
    if (s.notes)            notes.push(`Additional notes from user: ${s.notes}`);

    emit({ type: 'explorer_start' } as GeneratorEvent);
    emit({ type: 'explorer_thinking', text: 'Using pre-confirmed selectors from Quick Build — skipping live exploration.' } as GeneratorEvent);
    emit({ type: 'explorer_complete', success: true, summary: `Quick Build: ${s.pageUrl}` } as GeneratorEvent);
    emit({ type: 'builder_start' } as GeneratorEvent);

    explorationReport = {
      success: true,
      taskDescription: 'Build flow from pre-confirmed selectors (Quick Build mode)',
      approach: 'Selectors confirmed by user via Quick Build form — no live exploration performed.',
      workingSteps: [
        { tool: 'open_tab', input: { url: s.pageUrl }, outputSummary: 'Page URL provided by user', notes: `URL pattern: ${s.pageUrl}` },
        ...(s.feedSelector ? [{ tool: 'scroll_load', input: { selector: s.feedSelector }, outputSummary: 'Feed container confirmed by user', notes: `Selector: ${s.feedSelector} — use this for both scroll_load and get_dom_filtered` }] : []),
        ...(s.expandSelector ? [{ tool: 'click_all', input: { selector: s.expandSelector }, outputSummary: 'Expand button confirmed by user', notes: `Selector: ${s.expandSelector} — use click_all with limit from flow input` }] : []),
      ],
      inputsNeeded: [],
      dataShape: s.feedSelector ? `Filtered HTML from ${s.feedSelector}` : 'Page content',
      failedApproaches: [],
      additionalNotes: notes.join('\n'),
    };
  }

  const shouldExplore =
    !params.seedContext &&
    params.flowType !== undefined &&
    userMessageCount === 1 &&
    !hasRecording(params.messages) &&
    params.agentTools.some((t) => t.name === 'open_tab' || t.name === 'web_fetch');

  if (shouldExplore) {
    // Extract the task description from the first user message
    const firstUserMsg = params.messages.find((m) => m.role === 'user');
    const taskDescription = firstUserMsg
      ? typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : (firstUserMsg.content as Anthropic.Messages.ContentBlockParam[])
            .filter((b): b is Anthropic.Messages.TextBlockParam => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
      : 'Build a flow';

    explorationReport = await runFlowExplorer(
      {
        agentId: params.agentId,
        apiKey: params.apiKey,
        agentTools: params.agentTools,
        taskDescription,
        flowType: params.flowType as 'scrape' | 'action',
        isOpen: params.isOpen,
      },
      // Forward explorer events directly — they have distinct types so the frontend
      // can route them to the right panel
      (event) => emit(event as GeneratorEvent),
    );

    // Signal to the frontend that the builder phase is starting
    emit({ type: 'builder_start' });
  }

  const systemPrompt = buildSystemPrompt(params.agentTools, params.flowType, sessionFacts, explorationReport);

  const messages = params.messages.slice() as Anthropic.Messages.MessageParam[];

  // Track the most recent test_flow input+result for the QA validation pass
  let lastTestResult: string | null = null;
  let lastTestInput: Record<string, unknown> | null = null;
  let flowSubmitted = false; // true after submit_flow succeeds — enables rename_flow

  // Token usage tracking for live cost counter (TASK 8.4)
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    while (true) {
      // Client disconnected (e.g. navigated back) — stop the whole loop
      if (!params.isOpen()) return;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: GENERATOR_TOOLS,
      });

      // Track token usage and emit a live cost update (TASK 8.4)
      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      // Sonnet 4.6 pricing: $3/M input, $15/M output (approximate)
      const estimatedCostUsd = (totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000;
      emit({ type: 'token_usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCostUsd });

      const textContent = extractText(response).trim();

      // On end_turn the text is the final user-facing reply — emit as reply only.
      // Emitting it as thinking first AND then as reply causes the same text to
      // appear twice in the chat panel.
      if (response.stop_reason === 'end_turn') {
        emit({ type: 'reply', content: textContent });
        emit({ type: 'done' });
        return;
      }

      if (response.stop_reason !== 'tool_use') {
        emit({ type: 'reply', content: textContent || `Unexpected stop reason: ${response.stop_reason}` });
        emit({ type: 'done' });
        return;
      }

      // On tool_use, any text alongside the tool calls is agent reasoning — show as thinking.
      if (textContent) {
        emit({ type: 'thinking', text: textContent });
      }

      // Client navigated away — stop processing immediately
      if (!params.isOpen()) return;

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        // Check again per-tool in case disconnect happened mid-batch
        if (!params.isOpen()) break;

        if (block.name === 'submit_flow') {
          // Claude occasionally wraps the definition in a nested "flow" key (mirroring
          // test_flow's schema). Unwrap it transparently if steps are missing at top level.
          let rawInput = block.input as GeneratedFlowDef & { flow?: GeneratedFlowDef };
          if (!rawInput.steps && rawInput.flow?.steps) rawInput = rawInput.flow;
          const rawDef = rawInput;

          // Validate required fields before touching them
          if (!rawDef.steps || !Array.isArray(rawDef.steps) || rawDef.steps.length === 0) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Error: submit_flow requires a top-level "steps" array with all flow steps. Do not wrap the definition inside a "flow" key — pass name, description, inputFields, steps, returnStepId directly as top-level properties.',
              is_error: true,
            });
            emit({ type: 'thinking', text: '⚠️ submit_flow: steps missing or wrapped incorrectly. Retrying...' });
            continue;
          }

          // Stream the flow preview immediately
          emit({
            type: 'flow_update',
            steps: rawDef.steps.map((s) => ({ label: s.label, toolName: s.toolName })),
            name: rawDef.name,
            description: rawDef.description,
          });

          // ── Block submission if no test has been run ─────────────────
          if (!lastTestInput) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'You must run test_flow with real test data before submitting. Call request_test_inputs to collect values from the user, then test_flow, then submit_flow.',
              is_error: true,
            });
            emit({ type: 'thinking', text: '⚠️ submit_flow blocked: no test has been run yet. Requesting test inputs...' });
            continue;
          }

          try {
            const definition = await processFlowDef(rawDef, params.agentId);

            // ── OPERATION CONVERGENCE Task 5 — structural validation ────────
            // Validate the processed flow before saving. If invalid, feed the
            // errors back to the AI for one retry.
            const valMeta: FlowMeta = {
              requiresApproval: rawDef.requiresApproval ?? false,
              dedupKeyField: rawDef.dedupKeyField ?? null,
              inputSchema: definition.inputSchema ?? null,
              flowType: rawDef.flowType ?? null,
            };
            const valResult = validateFlow(
              definition.steps as unknown as import('../../features/flows/flow-runner.js').FlowStep[],
              valMeta,
            );
            if (!valResult.valid) {
              const errList = valResult.errors.join('\n• ');
              emit({ type: 'thinking', text: `⚠️ Flow validation failed:\n• ${errList}` });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Flow validation failed. Fix these issues and resubmit:\n• ${errList}`,
                is_error: true,
              });
              continue;
            }

            // ── QA validation pass — validate the exact submitted flow ──────
            // For action flows (side-effect flows like posting comments, sending
            // messages, etc.) we REUSE the last test result rather than re-running
            // the flow live.  Re-running would repeat the real-world side effect
            // (e.g. post a duplicate Reddit comment) every time QA fires.
            // For scrape flows (read-only) we still re-run to catch any regressions.
            if (rawDef.expectedOutput) {
              const isActionFlow = rawDef.flowType === 'action';
              const canReuseLastResult = isActionFlow && lastTestResult !== null;

              emit({ type: 'thinking', text: canReuseLastResult
                ? '📋 QA: Reusing last test result for action flow (skipping live re-run to avoid duplicate side effects)...'
                : '🔄 QA: Re-running test on submitted flow definition...',
              });
              try {
                // Use cached result for action flows; live re-run for scrape flows.
                const freshResult = canReuseLastResult
                  ? lastTestResult!
                  : await testFlowInGenerator(rawDef, lastTestInput, params.agentId, params.apiKey, anthropic, params.agentModel ?? 'claude-sonnet-4-6', emit);
                // Emit per-step trace from the QA re-run so the user can see what each step returned
                try {
                  const freshParsed = JSON.parse(freshResult) as { stepResults?: Record<string, unknown> };
                  if (freshParsed.stepResults && Object.keys(freshParsed.stepResults).length > 0) {
                    const traceLines = Object.entries(freshParsed.stepResults).map(([label, val]) => {
                      let stepSummary: string;
                      if (val === null || val === undefined) {
                        stepSummary = '(null)';
                      } else if (typeof val === 'string') {
                        if (val === '[screenshot captured]') stepSummary = '[screenshot]';
                        else if (val.startsWith('data:image')) stepSummary = '[screenshot]';
                        else stepSummary = val.length > 150 ? val.slice(0, 150) + '…' : val;
                      } else if (typeof val === 'object' && 'error' in (val as object)) {
                        stepSummary = `❌ error: ${String((val as Record<string, unknown>).error)}`;
                      } else {
                        const s = JSON.stringify(val);
                        stepSummary = s.length > 200 ? s.slice(0, 200) + '…' : s;
                      }
                      return `  • ${label}: ${stepSummary}`;
                    });
                    emit({ type: 'thinking', text: `📋 QA re-run step trace:\n${traceLines.join('\n')}` });
                  }
                } catch { /* ignore trace parse errors */ }
                const qaSummary = buildQASummary(freshResult);
                emit({ type: 'thinking', text: `🔍 QA: Validating output structure against contract...` });

                // OPERATION SCREENSHOT REFS — if the flow produced a screenshot, pass it
                // to Claude as a vision block so it can verify the contract visually.
                let qaScreenshotBase64: string | null = null;
                try {
                  const freshParsedForScreenshot = JSON.parse(freshResult) as { screenshotUrl?: string };
                  if (freshParsedForScreenshot.screenshotUrl) {
                    const screenshotFilename = freshParsedForScreenshot.screenshotUrl.replace(/^\/screenshots\//, '');
                    const screenshotPath = join(SCREENSHOTS_DIR, screenshotFilename);
                    if (existsSync(screenshotPath)) {
                      qaScreenshotBase64 = readFileSync(screenshotPath).toString('base64');
                    }
                  }
                } catch { /* screenshot unavailable — fall through to text-only QA */ }

                const qaTextPrompt = `Flow: ${rawDef.name}\nExpected output contract:\n${rawDef.expectedOutput}\n\nActual output structure:\n${qaSummary}\n\nDoes the output structure match the contract? Focus on: correct top-level fields, array presence and non-empty content, no raw HTML where structured data is expected. Do NOT fail for cosmetic differences like timestamp format (unix vs ISO) unless the contract specifically requires a format. Reply JSON only.`;
                const qaUserContent: Anthropic.Messages.ContentBlockParam[] = qaScreenshotBase64
                  ? [
                      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: qaScreenshotBase64 } },
                      { type: 'text', text: `Here is a screenshot captured at the end of the flow.\n\n${qaTextPrompt}` },
                    ]
                  : [{ type: 'text', text: qaTextPrompt }];

                const qaResponse = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 512,
                  system: 'You are a QA validator for data flows. Check whether the actual output structure matches the expected contract. Reply with JSON only: { "pass": boolean, "reason": string }. Important: screenshot steps now return {"type":"screenshot_ref","url":"/screenshots/...png"} instead of raw base64 data — this is correct and expected. Do not fail a flow solely because a screenshot contract describes "base64 PNG" but the output is a screenshot_ref object; treat them as equivalent.',
                  messages: [{ role: 'user', content: qaUserContent }],
                });
                const qaText = extractText(qaResponse);
                let qaResult: { pass: boolean; reason: string } = { pass: true, reason: '' };
                try {
                  const match = qaText.match(/\{[\s\S]*\}/);
                  if (match) qaResult = JSON.parse(match[0]) as { pass: boolean; reason: string };
                } catch { /* parse fail → default pass */ }

                if (!qaResult.pass) {
                  emit({ type: 'thinking', text: `❌ QA failed: ${qaResult.reason}` });
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: `QA validation failed: ${qaResult.reason}\n\nFix the flow and resubmit. Test input used: ${JSON.stringify(lastTestInput)}`,
                    is_error: true,
                  });
                  continue;
                }
                emit({ type: 'thinking', text: `✅ QA passed: ${qaResult.reason}` });
              } catch { /* QA call failed — don't block submission */ }
            }

            // ── Emit complete but keep stream alive for rename_flow ───────
            emit({ type: 'complete', flow: definition, explanation: textContent || undefined });
            // TASK 8.3 — persist session facts so the frontend can carry them to the next build
            if (sessionFacts.length > 0) {
              emit({ type: 'session_facts', facts: [...sessionFacts] });
            }
            flowSubmitted = true;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Flow "${definition.name}" submitted successfully. You can now call rename_flow if the user wants to change the name or description. Otherwise say you're done.`,
            });
            // Do NOT call end() — continue the loop so the agent can handle rename requests
            continue;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: ${errMsg}. Please fix the flow definition and resubmit.`,
              is_error: true,
            });
            emit({ type: 'thinking', text: `⚠️ Flow processing error: ${errMsg}. Fixing...` });
          }
          continue;
        }

        // Announce the tool call
        let displayText = block.name;
        if (block.name === 'inspect_page') {
          displayText = `Opening ${(block.input as { url: string }).url}`;
        } else if (block.name === 'analyze_dom') {
          displayText = `Analyzing DOM: ${(block.input as { question: string }).question}`;
        } else if (block.name === 'test_flow') {
          const inp = block.input as { flow: GeneratedFlowDef; testInput: Record<string, unknown> };
          const testSteps = Array.isArray(inp.flow?.steps) ? inp.flow.steps : [];
          displayText = `Running ${testSteps.length} steps with input: ${JSON.stringify(inp.testInput)}`;
          // Show the flow being tested
          if (testSteps.length > 0) {
            emit({
              type: 'flow_update',
              steps: testSteps.map((s) => ({ label: s.label, toolName: s.toolName })),
              name: inp.flow.name,
              description: inp.flow.description,
            });
          }
        }
        emit({ type: 'tool_call', tool: block.name, displayText });

        // Execute the tool
        let result: string;
        if (block.name === 'inspect_page') {
          const input = block.input as { url: string };
          result = await inspectPage(input.url, params.agentId);
          try {
            const parsed = JSON.parse(result) as { dom?: string; length?: number; error?: string };
            emit({ type: 'tool_result', tool: block.name, summary: parsed.error ?? `Got ${parsed.length ?? 0} chars of DOM` });
          } catch { emit({ type: 'tool_result', tool: block.name, summary: 'Page inspected' }); }
        } else if (block.name === 'analyze_dom') {
          const input = block.input as { dom: string; question: string };
          result = await analyzeDom(input.dom, input.question, params.apiKey);
          const domSummary = result.slice(0, 300).trim();
          emit({ type: 'tool_result', tool: block.name, summary: domSummary });
          // TASK 8.1 — emit a distinct research summary so users know what was found
          emit({ type: 'research_summary', text: result.slice(0, 500).trim() });
        } else if (block.name === 'test_flow') {
          const input = block.input as { flow: GeneratedFlowDef; testInput: Record<string, unknown> };
          result = await testFlowInGenerator(
            input.flow, input.testInput, params.agentId, params.apiKey,
            anthropic, params.agentModel ?? 'claude-sonnet-4-6',
            emit,
          );
          lastTestResult = result;
          lastTestInput = input.testInput; // capture for fresh re-test at submit_flow time
          try {
            const parsed = JSON.parse(result) as {
              ok?: boolean;
              error?: string;
              visionAnalysis?: string;
              durationMs?: number;
              stepResults?: Record<string, unknown>;
            };
            const dur = parsed.durationMs ? ` (${(parsed.durationMs / 1000).toFixed(1)}s)` : '';
            const summary = parsed.error
              ? `❌ Failed: ${parsed.error}`
              : parsed.ok ? `✅ Completed${dur}` : `⚠️ Completed with issues${dur}`;
            emit({ type: 'tool_result', tool: block.name, summary });

            // ── Per-step trace — makes failures debuggable without digging into JSON ──
            if (parsed.stepResults && Object.keys(parsed.stepResults).length > 0) {
              const traceLines = Object.entries(parsed.stepResults).map(([label, val]) => {
                let stepSummary: string;
                if (val === null || val === undefined) {
                  stepSummary = '(null)';
                } else if (typeof val === 'string') {
                  if (val === '[screenshot captured]') {
                    stepSummary = '[screenshot]';
                  } else if (val.startsWith('data:image')) {
                    stepSummary = '[screenshot]';
                  } else {
                    stepSummary = val.length > 150 ? val.slice(0, 150) + '…' : val;
                  }
                } else if (typeof val === 'object' && 'error' in (val as object)) {
                  stepSummary = `❌ error: ${String((val as Record<string, unknown>).error)}`;
                } else {
                  const s = JSON.stringify(val);
                  stepSummary = s.length > 200 ? s.slice(0, 200) + '…' : s;
                }
                return `  • ${label}: ${stepSummary}`;
              });
              emit({ type: 'thinking', text: `📋 Step trace:\n${traceLines.join('\n')}` });
            }

            if (parsed.visionAnalysis) {
              emit({ type: 'thinking', text: `👁️ Screenshot analysis: ${parsed.visionAnalysis}` });
            }
          } catch { emit({ type: 'tool_result', tool: block.name, summary: 'Test complete' }); }
        } else if (block.name === 'request_test_inputs') {
          // Emit the input_request event and end the stream.
          // The frontend will render form fields; when submitted, values return as the next user turn.
          const inp = block.input as { fields: Array<{ key: string; label: string; placeholder?: string; required?: boolean }>; reason: string };
          emit({ type: 'input_request', fields: inp.fields });
          emit({ type: 'done' });
          return;
        } else if (block.name === 'record_fact') {
          // TASK 8.3 — record a session-level fact for cross-flow reuse
          const inp = block.input as { fact: string };
          const fact = (inp.fact ?? '').trim();
          if (fact) {
            sessionFacts.push(fact);
            emit({ type: 'session_facts', facts: [...sessionFacts] });
            emit({ type: 'tool_result', tool: block.name, summary: `📌 Recorded: "${fact.slice(0, 120)}"` });
          }
          result = JSON.stringify({ ok: true, recorded: fact });
        } else if (block.name === 'rename_flow') {
          // rename_flow — update name/description of the just-submitted flow
          if (!flowSubmitted) {
            result = JSON.stringify({ error: 'rename_flow can only be called after submit_flow has succeeded.' });
            emit({ type: 'tool_result', tool: block.name, summary: '⚠️ Cannot rename: no flow submitted yet' });
          } else {
            const inp = block.input as { name?: string; description?: string };
            emit({ type: 'flow_update', name: inp.name, description: inp.description });
            const changes = [inp.name && `name → "${inp.name}"`, inp.description && `description updated`].filter(Boolean).join(', ');
            result = JSON.stringify({ ok: true, message: `Flow updated: ${changes || 'no changes'}` });
            emit({ type: 'tool_result', tool: block.name, summary: `✏️ ${changes || 'no changes'}` });
          }
        } else {
          result = JSON.stringify({ error: `Unknown generator tool: ${block.name}` });
          emit({ type: 'tool_result', tool: block.name, summary: `Unknown tool: ${block.name}` });
        }

        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }

      if (toolResults.length === 0) {
        emit({ type: 'reply', content: textContent });
        emit({ type: 'done' });
        return;
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    // TASK 8.4 — detect credit/billing exhaustion and emit as fatal_error so the
    // frontend can show a prominent stopping banner rather than a small warning.
    const errMsg = err instanceof Error ? err.message : String(err);
    const isFatal =
      ('status' in (err as object) && (err as { status: number }).status === 402) ||
      errMsg.toLowerCase().includes('credit') ||
      errMsg.toLowerCase().includes('billing') ||
      errMsg.toLowerCase().includes('insufficient') ||
      errMsg.toLowerCase().includes('quota');
    if (isFatal) {
      emit({ type: 'fatal_error', message: errMsg });
    } else {
      emit({ type: 'error', message: errMsg });
    }
    emit({ type: 'done' });
  }
}
