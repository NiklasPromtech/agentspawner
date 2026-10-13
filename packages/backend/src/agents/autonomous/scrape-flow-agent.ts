/**
 * Scrape Flow Agent
 *
 * Specialist agent for creating scrape flows — read-only browser workflows
 * that navigate pages, query the DOM, and return structured data.
 *
 * Distinct from ActionFlowAgent: no dedup keys, no approval gates.
 * Focus: reliable selectors, empty-state handling, startup awareness.
 *
 * Moved/split from orchestrator/sub-agents.ts (Flow Builder section).
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { flows } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { runFlowDetailed, type FlowStep, type InputExpression, type StepCondition } from '../../orchestrator/flow-runner.js';
import { executeExtensionTool } from '../../websocket/server.js';
import type { SseEmitter } from '../../features/runs/runs.routes.js';

export interface FlowBuildResult {
  success: boolean;
  flow_id?: string;
  flow_name?: string;
  test_result?: string;
  attempts: number;
  notes: string;
}

const MAX_FLOW_BUILD_ATTEMPTS = 8;

const SCRAPE_FLOW_AGENT_SYSTEM_PROMPT = `You are the Scrape Flow Builder — a specialist in creating read-only browser automation flows that navigate pages and extract structured data.

You will receive a task description and a list of available tools with their UUIDs.
Output a valid JSON object — no markdown, no explanation outside it.

## Output format

{
  "name": "snake_case_name",
  "description": "One sentence.",
  "input_schema": { "type": "object", "properties": { "param": { "type": "string", "description": "..." } }, "required": ["param"] },
  "steps": [
    {
      "label": "Step label",
      "tool_id": "EXACT-UUID-from-tool-list",
      "inputs": { ... },
      "condition": { ... }
    }
  ]
}

## Input expression types

{ "type": "literal",    "value": <any> }
{ "type": "flow_input", "key": "param_name" }
{ "type": "step_ref",   "step_index": N, "path": "dot.path" }   ← 0-based index

## CRITICAL: exact tool return shapes (wrong path = broken flow)

open_tab       → { tabId: number }              ← path: "tabId"   ⚠️ NOT "result"
close_tab      → { result: null }               ← (no step_ref needed)
navigate_to    → { success: bool }              ← path: "success"
wait_for       → { found: bool, selector }      ← path: "found"
wait_for_any   → { found: "label_str", selector } ← path: "found"
click          → { success: bool } or { error } ← path: "success"
type_text      → { success: bool } or { error } ← path: "success"
press_key      → { success: bool }              ← path: "success"
get_text       → { text: string } or { error }  ← path: "text"
get_dom        → { html: string }               ← path: "html"
get_dom_filtered_all → { items: string[], count: N } ← path: "items"  ← querySelectorAll + applyDomFilter per element. Use for feeds/lists. Each item is filtered HTML capped at 10k. Requires selector + optional limit (default 20). Pipe into __transform__.
get_attribute  → { value: string } or { error } ← path: "value"
element_exists → { exists: bool, label: "true"/"false" } ← path: "label"
screenshot     → base64 data URL string

## URL template syntax

Use {{param_name}} inside literal URL strings:
"https://x.com/{{username}}"

## Tab lifecycle — MANDATORY for every flow using a browser

Step 0: open_tab — always { "active": false }
Step 1: wait_for_any — wait for page to fully load before ANY interaction
Second-to-last: screenshot — capture result before teardown
Last: close_tab — always reference tabId from step 0: { "type": "step_ref", "step_index": 0, "path": "tabId" }

Every tab opened MUST be closed. Browser must look identical before and after.

## Conditions

Evaluated after the step runs. Two modes:

GUARD MODE (no skipToStepIndexOnNoMatch):
  condition fires → bail out with failMessage (optionally run cleanup from skipToStepIndex first)

BRANCH MODE (skipToStepIndexOnNoMatch set):
  condition fires   → continue normally to next step (branch path executes)
  condition doesn't fire → jump to skipToStepIndexOnNoMatch (bypass branch steps)

{
  "check": "has_error" | "no_error" | "result_equals" | "result_not_equals" | "min_array_length" | "non_empty",
  "value": "string",                  // for result_equals/not_equals
  "minLength": 1,                     // for min_array_length
  "failMessage": "message for AI",
  "skipToStepIndex": N,               // guard: cleanup from step N then bail
  "skipToStepIndexOnNoMatch": N       // branch: jump to step N if condition doesn't fire
}

## Scrape flows — reliability rules

### Empty-state handling (the 10% failure case)
Scrape flows fail silently when the target element is missing. Always guard:
- After extraction steps: add condition { "check": "min_array_length", "minLength": 1, "failMessage": "No items found — page may be empty or selector changed", "skipToStepIndex": <close_tab_index> } where applicable
- After get_text: add condition { "check": "non_empty", "failMessage": "Text not found — element missing or selector outdated", "skipToStepIndex": <close_tab_index> }
- Never silently return an empty array as "success". If the result is genuinely empty (e.g. zero notifications), use failMessage "Empty — nothing to process" so the agent knows and doesn't retry unnecessarily.

### Child-element selectors
Browser DOM is fragile. Prefer these selector strategies in order:
1. data-testid attributes: [data-testid="commentBody"]  ← most stable
2. aria-label: [aria-label="Reply"]
3. semantic roles: article h1, nav a[href*="/comments"]
4. Avoid: class names (change with updates), nth-child (breaks on layout change), deeply nested paths

When selecting children within a result set, always anchor to the parent container first, then find the child within it.

### runOnStartup flows
Some scrape flows are tagged runOnStartup — they run automatically when the agent session starts (e.g. check_notifications, check_dms). Rules:
- Only use runOnStartup for monitoring flows that must fire on every session open (notifications, inbox checks, etc.)
- NOT for arbitrary scrapes — those run on demand
- Startup flows are also re-checked approximately hourly by the scheduler
- Keep startup flows fast (< 8 steps) — they run frequently

### X / Twitter data-testid selectors (stable across updates)

Notification panel:    [data-testid="primaryColumn"]
DM compose input:      [data-testid="dmComposerTextInput"]
Primary column:        [data-testid="primaryColumn"]
Tweet text:            [data-testid="tweetText"]
Follow button:         [data-testid="followButton"]
User cell:             [data-testid="UserCell"]

## Rules

- tool_id MUST be the exact UUID from the tool list. Never invent IDs.
- step_ref step_index is 0-based (step 0 = first step).
- Always use path "tabId" for open_tab result. NEVER "result".
- Keep flows focused (4–12 steps).
- Scrape flows do NOT use dedup keys or requiresApproval — those are for action flows only.
- Document what a successful run looks like in the flow description (e.g. "Returns array of { id, text, author } objects").
- READING FROM TABLES: use the __query_database__ sentinel step to read rows from a
  user-defined table. tool_id is the literal string "__query_database__" — not a UUID.
  Inputs: table_name (string), optional filter (object), limit (number), order_by, order_dir.
  Output: { rows: [...], count: N } — pipe into __transform__ for further processing.
- FORBIDDEN STEP TYPES: flows cannot write to agent tables (insert_row, create_table),
  call recall_memory, or access the AgentSpawner database directly. These are agent-level
  capabilities only. If a task description asks for this, refuse it and explain the limitation.
`.trim();

type RawInputExpr = {
  type: 'literal' | 'flow_input' | 'step_ref';
  value?: unknown;
  key?: string;
  step_index?: number;
  path?: string;
};

type RawStepCondition = {
  check: string;
  value?: string;
  minLength?: number;
  failMessage: string;
  suggestTool?: string;
  skipToStepIndex?: number;
  skipToStepIndexOnNoMatch?: number;
};

type RawStep = {
  label: string;
  tool_id: string;
  inputs: Record<string, RawInputExpr>;
  condition?: RawStepCondition;
};

function buildFlowStepsInternal(rawSteps: RawStep[]): FlowStep[] {
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
        inputMapping[field] = { type: 'step_ref', stepId: stepIds[refIndex]!, path: expr.path ?? '' };
      }
    }

    const step: FlowStep = { id: stepIds[i]!, toolId: raw.tool_id, label: raw.label, inputMapping };

    if (raw.condition) {
      step.condition = {
        check: raw.condition.check as StepCondition['check'],
        failMessage: raw.condition.failMessage,
        ...(raw.condition.value !== undefined && { value: raw.condition.value }),
        ...(raw.condition.minLength !== undefined && { minLength: raw.condition.minLength }),
        ...(raw.condition.suggestTool !== undefined && { suggestTool: raw.condition.suggestTool }),
        skipToStepId: raw.condition.skipToStepIndex != null
          ? (stepIds[raw.condition.skipToStepIndex] ?? null)
          : null,
        skipToStepIdOnNoMatch: raw.condition.skipToStepIndexOnNoMatch != null
          ? (stepIds[raw.condition.skipToStepIndexOnNoMatch] ?? null)
          : null,
      };
    }

    return step;
  });
}

/**
 * Run the Scrape Flow Agent.
 * Creates a read-only scrape flow from a description and tests it with sample input.
 */
export async function runScrapeFlowAgent(params: {
  agentId: string;
  agentName: string;
  taskDescription: string;
  availableTools: Array<{ id: string; name: string; description: string; inputSchema: string }>;
  testInput?: Record<string, unknown>;
  apiKey: string;
  agentModel: string;
  emit?: SseEmitter;
}): Promise<FlowBuildResult> {
  const { agentId, taskDescription, availableTools, testInput, apiKey, agentModel, emit } = params;
  const db = getDb();
  const anthropic = new Anthropic({ apiKey });

  emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `🔍 Scrape Flow Builder: "${taskDescription}"` }] });

  const toolList = availableTools
    .map((t) => `  - ID: ${t.id}\n    Name: ${t.name}\n    Description: ${t.description}`)
    .join('\n');

  const previousErrors: string[] = [];

  for (let attempt = 1; attempt <= MAX_FLOW_BUILD_ATTEMPTS; attempt++) {
    emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  🔧 Scrape Flow Builder attempt ${attempt}/${MAX_FLOW_BUILD_ATTEMPTS}...` }] });

    const errorHistory = previousErrors.length > 0
      ? `\n\nPREVIOUS ERRORS:\n${previousErrors.map((e, i) => `[${i + 1}] ${e}`).join('\n')}\n\nFix the specific issue above.`
      : '';

    const prompt = `Task: ${taskDescription}\n\nAvailable tools:\n${toolList}${errorHistory}`;

    try {
      const resp = await anthropic.messages.create({
        model: agentModel,
        max_tokens: 4096,
        system: SCRAPE_FLOW_AGENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const rawText = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('').trim();

      const jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const flowDef = JSON.parse(jsonStr) as {
        name: string; description: string; input_schema: object; steps: unknown[];
      };

      if (!flowDef.name || !Array.isArray(flowDef.steps) || flowDef.steps.length === 0) {
        previousErrors.push(`Attempt ${attempt}: Invalid flow structure — missing name or steps.`);
        continue;
      }

      let builtSteps: FlowStep[];
      try {
        builtSteps = buildFlowStepsInternal(flowDef.steps as RawStep[]);
      } catch (buildErr) {
        const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
        previousErrors.push(`Attempt ${attempt}: Step build error: ${msg}`);
        continue;
      }

      const newFlowId = uuidv4();
      const inputSchemaStr = JSON.stringify(flowDef.input_schema ?? { type: 'object', properties: {}, required: [] });

      await db.insert(flows).values({
        id: newFlowId, agentId,
        name: flowDef.name, description: flowDef.description,
        flowType: 'scrape',
        inputSchema: inputSchemaStr, steps: JSON.stringify(builtSteps),
      });

      emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  📝 Scrape flow "${flowDef.name}" saved (${builtSteps.length} steps). Testing...` }] });

      // Browser flows: structural validation only (no fake tabs)
      const openTabToolId = availableTools.find((t) => t.name === 'open_tab')?.id;
      const isBrowserFlow = openTabToolId != null && builtSteps.some((s) => s.toolId === openTabToolId);

      if (isBrowserFlow) {
        emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Scrape Flow Builder: "${flowDef.name}" created (browser flow — structural validation passed; live test skipped)` }] });
        return {
          success: true, flow_id: newFlowId, flow_name: flowDef.name,
          test_result: 'Browser flow — structural validation passed. Run with real input to confirm.',
          attempts: attempt,
          notes: `Created after ${attempt} attempt(s). Browser flows are not live-tested by the builder.`,
        };
      }

      // Non-browser flows: live test
      if (testInput) {
        const [savedFlow] = await db.select().from(flows).where(eq(flows.id, newFlowId));
        if (savedFlow) {
          let testResult: Awaited<ReturnType<typeof runFlowDetailed>> | null = null;
          let testErr: string | null = null;

          try {
            testResult = await runFlowDetailed(savedFlow, testInput, agentId);
          } catch (err) {
            testErr = err instanceof Error ? err.message : String(err);
          }

          // Close any leaked tabs
          const closeLeakedTabs = async (results: Record<string, unknown>) => {
            for (const val of Object.values(results)) {
              if (val && typeof val === 'object' && !Array.isArray(val)) {
                const tabId = (val as Record<string, unknown>).tabId;
                if (typeof tabId === 'number') {
                  try { await executeExtensionTool('close_tab', { tabId }, 5_000, ''); } catch { /* ignore */ }
                }
              }
            }
          };

          if (testErr || !testResult) {
            previousErrors.push(`Attempt ${attempt}: Flow execution threw: ${(testErr ?? 'unknown').slice(0, 300)}`);
            await db.delete(flows).where(eq(flows.id, newFlowId));
            emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ❌ Flow threw exception: ${(testErr ?? '').slice(0, 100)}` }] });
            continue;
          }

          await closeLeakedTabs(testResult.stepResults);

          if (!testResult.ok || testResult.error) {
            const stepSummary = builtSteps.map((s, idx) => {
              const result = testResult!.stepResults[s.id];
              const display = JSON.stringify(result ?? null).slice(0, 200);
              return `  Step ${idx} "${s.label}": ${display}`;
            });
            const errDetail = [
              `Attempt ${attempt}: Flow test failed.`,
              `Error: ${testResult.error ?? '(no error field)'}`,
              `Per-step results:`, ...stepSummary,
            ].join('\n');
            previousErrors.push(errDetail.slice(0, 800));
            await db.delete(flows).where(eq(flows.id, newFlowId));
            emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ❌ Flow test failed. Rebuilding...` }] });
            continue;
          }

          emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Scrape Flow Builder: "${flowDef.name}" passed after ${attempt} attempt(s)` }] });
          return {
            success: true, flow_id: newFlowId, flow_name: flowDef.name,
            test_result: testResult.result ?? 'ok', attempts: attempt,
            notes: `Created and tested after ${attempt} attempt(s).`,
          };
        }
      }

      // No test input — structural pass
      emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Scrape Flow Builder: "${flowDef.name}" created (no test input provided)` }] });
      return {
        success: true, flow_id: newFlowId, flow_name: flowDef.name,
        test_result: 'No test input provided — structure validated.',
        attempts: attempt,
        notes: `Flow created after ${attempt} attempt(s).`,
      };

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      previousErrors.push(`Attempt ${attempt}: ${errMsg.slice(0, 200)}`);
    }
  }

  return {
    success: false, attempts: MAX_FLOW_BUILD_ATTEMPTS,
    notes: [
      `Scrape Flow Builder exhausted all ${MAX_FLOW_BUILD_ATTEMPTS} attempts for: "${taskDescription}".`,
      `Errors:`,
      ...previousErrors.map((e, i) => `  [${i + 1}] ${e}`),
    ].join('\n'),
  };
}
