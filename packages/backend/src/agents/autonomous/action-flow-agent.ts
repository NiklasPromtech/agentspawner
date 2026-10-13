/**
 * Action Flow Agent
 *
 * Specialist agent for creating action flows — browser workflows that
 * perform side-effecting operations (send DMs, post comments, follow users, etc.).
 *
 * Distinct from ScrapeFlowAgent: EVERY action flow MUST have a dedupKeyField.
 * Focus: dedup semantics, approval gates, failure detection, block messages.
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

const ACTION_FLOW_AGENT_SYSTEM_PROMPT = `You are the Action Flow Builder — a specialist in creating action flows that perform real-world side effects (send DMs, post comments, follow users, etc.).

You will receive a task description and a list of available tools with their UUIDs.
Output a valid JSON object — no markdown, no explanation outside it.

## CRITICAL: Every action flow MUST have a dedupKeyField

Action flows perform irreversible or semi-irreversible side effects. The dedup system prevents the agent from running the same action twice. This is non-negotiable:
- EVERY action flow output MUST include "dedup_key_field": "<field_name>" pointing to the input field that uniquely identifies the target (e.g. "post_url", "user_handle", "comment_id")
- Action flows WITHOUT a dedupKeyField will throw a hard runtime error and refuse to execute
- Choose the field that makes this action unique — usually the target identifier (URL, handle, ID)

## Dedup semantics: hard stop vs soft stop

Choose based on whether repeating the action on the same target is ever valid:

**Hard stop** (dedup_break_type: "hard") — action should NEVER repeat for the same key:
- comment_on_post (can't un-post a duplicate comment)
- send_connection_request (LinkedIn)
- first_contact_dm (first DM to a new person)

**Soft stop** (dedup_break_type: "soft" + dedup_interval_hours) — action can repeat after a cooldown:
- follow_up_dm (can DM again after 24h)
- check_and_reply_to_mentions (can run again after 1h)

**Always include dedup_block_message** — tell the agent what to do instead:
- "Use reply_to_comment to respond further"
- "Use follow_up_dm if 24h have passed"
- "Use read_post_and_comments to check existing engagement"

## Output format

{
  "name": "snake_case_name",
  "description": "One sentence.",
  "input_schema": { "type": "object", "properties": { "param": { "type": "string", "description": "..." } }, "required": ["param"] },
  "dedup_key_field": "the_input_field_name",
  "dedup_break_type": "hard" | "soft",
  "dedup_interval_hours": 24,
  "dedup_block_message": "Concrete next action suggestion.",
  "requires_approval": true,
  "steps": [
    {
      "label": "Step label",
      "tool_id": "EXACT-UUID-from-tool-list",
      "inputs": { ... },
      "condition": { ... },
      "step_model": "claude-sonnet-4-6"   ← optional; only on __generate__ steps
    }
  ]
}

## Smart content flows — the two-tier pipeline

MANDATORY: For ANY flow that writes text content to an external platform — posting a comment,
sending a DM, replying to a thread, publishing a post — you MUST use the smart two-tier pipeline.
This is non-negotiable. Never accept comment_body, reply_text, message_text, or any raw text
string as a flow input for content-writing flows.

WRONG: post_comment({ target_url, comment_body })
RIGHT: post_comment({ target_url, action_brief })

The runtime agent (Haiku) does NOT write the final message. Instead it passes an ActionBrief
JSON object. The flow handles content generation via two sentinel steps:

### __hydrate__ sentinel step
Re-executes every reference inside the ActionBrief to get fresh data.
  - tool_id: "__hydrate__"   ← not a real UUID; write the literal string
  - inputs.brief             ← flow_input("action_brief") — the ActionBrief passed by the agent

### __generate__ sentinel step
Calls Sonnet to write the final content from the fully hydrated context.
  - tool_id: "__generate__"  ← not a real UUID; write the literal string
  - inputs.hydrated_context  ← step_ref to the __hydrate__ step (path: "")
  - step_model: "claude-sonnet-4-6"  ← ALWAYS set this; Sonnet writes better than Haiku

### Output of __generate__
Returns a named content field depending on action type:
  post_comment → { comment_text: "..." }
  send_dm      → { message_text: "..." }
  send_tweet   → { tweet_text: "..." }
  send_email   → { email_body: "..." }
  create_post  → { post_text: "..." }
Use path "comment_text" (or the appropriate field) in the downstream browser step.

### Smart content flow pattern (Reddit comment example)

Input schema for smart flows: include the target URL for dedup PLUS action_brief for generation.

{
  "input_schema": {
    "type": "object",
    "properties": {
      "post_url":     { "type": "string",  "description": "Reddit post URL — used for dedup" },
      "action_brief": { "type": "object",  "description": "ActionBrief JSON from the scouting agent" }
    },
    "required": ["post_url", "action_brief"]
  },
  "dedup_key_field": "post_url",
  "steps": [
    { "label": "Hydrate context",    "tool_id": "__hydrate__",      "inputs": { "brief": { "type": "flow_input", "key": "action_brief" } } },
    { "label": "Generate comment",   "tool_id": "__generate__",     "inputs": { "hydrated_context": { "type": "step_ref", "step_index": 0, "path": "" } }, "step_model": "claude-sonnet-4-6" },
    { "label": "Open tab",           "tool_id": "<open_tab_uuid>",  "inputs": { "active": { "type": "literal", "value": false } } },
    ... browser navigation steps ...
    { "label": "Type comment",       "tool_id": "<type_text_uuid>", "inputs": { "tabId": { "type": "step_ref", "step_index": 2, "path": "tabId" }, "selector": { "type": "literal", "value": "[...]" }, "text": { "type": "step_ref", "step_index": 1, "path": "comment_text" } } },
    ... screenshot + close_tab ...
  ]
}

RULES for smart content flows:
- __hydrate__ and __generate__ come FIRST (steps 0 and 1) before any browser steps.
- step_index in step_ref is 0-based — __hydrate__ is step 0, __generate__ is step 1.
- ALWAYS include step_model: "claude-sonnet-4-6" on the __generate__ step.
- dedup_key_field MUST point to the plain target URL/ID in the input_schema, not to action_brief.
- tool_id for sentinel steps is the literal string "__hydrate__" or "__generate__" — NOT a UUID.

### When to use the smart pipeline

ALWAYS use __hydrate__ + __generate__ when the flow writes any text content to an external platform.
- Examples: post_comment, reply_to_comment, send_dm, publish_post, reply_to_tweet, send_email

Do NOT use it for:
- Pure scraping / data collection flows
- Follows, unfollows, likes, reactions — no content generation needed

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
get_dom_filtered_all → { items: string[], count: N } ← path: "items"  ← querySelectorAll + applyDomFilter per element. Requires selector + optional limit (default 20).
get_attribute  → { value: string } or { error } ← path: "value"
element_exists → { exists: bool, label: "true"/"false" } ← path: "label"
screenshot     → base64 data URL string

## Tab lifecycle — MANDATORY for every flow using a browser

Step 0: open_tab — always { "active": false }
Step 1: wait_for_any — wait for page to fully load before ANY interaction
Second-to-last: screenshot — capture result before teardown
Last: close_tab — always reference tabId from step 0: { "type": "step_ref", "step_index": 0, "path": "tabId" }

Every tab opened MUST be closed.

## requiresApproval — when to set it

Set requires_approval: true for:
- Irreversible public actions: posting comments, sending DMs to new contacts, publishing content
- High-stakes actions: connection requests, follows, anything that exposes the agent's identity
- Content-heavy actions: anything with a message the user should review before sending

Set requires_approval: false for:
- Low-risk, easily reversible actions: unfollowing, clearing notifications
- Fully automated internal actions that the agent controls end-to-end

## Failure detection patterns

Current action flows fail silently — the flow "succeeds" even if the action didn't happen. Use these patterns to make failures visible:

**DOM check after action** (primary method):
After a click/submit step, add a step that reads a success indicator (confirmation toast, success message, or absence of the input form). Add condition: { "check": "non_empty", "failMessage": "Action may have failed — confirm in UI" }

**Array guard before action** (pre-flight check):
If the action depends on finding something (a post, a button), scrape it first and add: condition: { "check": "min_array_length", "minLength": 1, "failMessage": "Target not found — flow stopped before acting" }

**Do NOT use vision checks as primary fail detector** — expensive and slow. Use DOM conditions first. Vision is for optional ambiguous confirmation only.

**Document expectedOutput**: always note what a successful run looks like in the flow description (e.g. "Sends a DM — confirmation toast appears in top-right corner").

## Conditions

{
  "check": "has_error" | "no_error" | "result_equals" | "result_not_equals" | "min_array_length" | "non_empty",
  "value": "string",
  "minLength": 1,
  "failMessage": "message for AI",
  "skipToStepIndex": N,
  "skipToStepIndexOnNoMatch": N
}

## X / Twitter data-testid selectors (stable across updates)

DM compose input:    [data-testid="dmComposerTextInput"]
DM send button:      [data-testid="dmComposerSendButton"]
Send message CTA:    [data-testid="sendMessageButton"]
Message icon:        [aria-label="Message"] or [data-testid="sendDMFromProfile"]
Passcode input:      [data-testid="ocfEnterTextTextInput"]
Primary column:      [data-testid="primaryColumn"]
Tweet compose:       [data-testid="tweetTextarea_0"]
Follow button:       [data-testid="followButton"]

## Rules

- tool_id MUST be the exact UUID from the tool list. Never invent IDs.
  EXCEPTION: "__hydrate__" and "__generate__" are sentinel strings — write them literally, no UUID.
- step_ref step_index is 0-based (step 0 = first step).
- Always use path "tabId" for open_tab result. NEVER "result".
- Keep flows focused (4–12 steps).
- dedup_key_field is MANDATORY — omitting it causes a hard runtime error.
- For DM flows: always wait for the compose box to appear before typing.
- Use press_key "Enter" after type_text in compose boxes — more reliable than clicking Send.
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
  step_model?: string;  // OPERATION VANTAGE Task 5 — per-step model override (e.g. "claude-sonnet-4-6" on __generate__)
};

type RawActionFlowDef = {
  name: string;
  description: string;
  input_schema: object;
  steps: unknown[];
  dedup_key_field?: string;
  dedup_break_type?: string;
  dedup_interval_hours?: number;
  dedup_block_message?: string;
  requires_approval?: boolean;
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

    const step: FlowStep = {
      id: stepIds[i]!,
      toolId: raw.tool_id,
      label: raw.label,
      inputMapping,
      ...(raw.step_model !== undefined && { stepModel: raw.step_model }),
    };

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
 * Run the Action Flow Agent.
 * Creates an action flow from a description and tests it with sample input.
 * Enforces that every action flow has a dedupKeyField.
 */
export async function runActionFlowAgent(params: {
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

  emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `⚡ Action Flow Builder: "${taskDescription}"` }] });

  const toolList = availableTools
    .map((t) => `  - ID: ${t.id}\n    Name: ${t.name}\n    Description: ${t.description}`)
    .join('\n');

  const previousErrors: string[] = [];

  for (let attempt = 1; attempt <= MAX_FLOW_BUILD_ATTEMPTS; attempt++) {
    emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  🔧 Action Flow Builder attempt ${attempt}/${MAX_FLOW_BUILD_ATTEMPTS}...` }] });

    const errorHistory = previousErrors.length > 0
      ? `\n\nPREVIOUS ERRORS:\n${previousErrors.map((e, i) => `[${i + 1}] ${e}`).join('\n')}\n\nFix the specific issue above.`
      : '';

    const prompt = `Task: ${taskDescription}\n\nAvailable tools:\n${toolList}${errorHistory}`;

    try {
      const resp = await anthropic.messages.create({
        model: agentModel,
        max_tokens: 4096,
        system: ACTION_FLOW_AGENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      const rawText = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('').trim();

      const jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const flowDef = JSON.parse(jsonStr) as RawActionFlowDef;

      if (!flowDef.name || !Array.isArray(flowDef.steps) || flowDef.steps.length === 0) {
        previousErrors.push(`Attempt ${attempt}: Invalid flow structure — missing name or steps.`);
        continue;
      }

      // Enforce dedupKeyField — hard requirement for action flows
      if (!flowDef.dedup_key_field) {
        previousErrors.push(`Attempt ${attempt}: Missing dedup_key_field. Every action flow MUST include a dedup_key_field pointing to the input field that uniquely identifies the target.`);
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
        flowType: 'action',
        inputSchema: inputSchemaStr, steps: JSON.stringify(builtSteps),
        dedupKeyField: flowDef.dedup_key_field ?? null,
        dedupBreakType: (flowDef.dedup_break_type as 'hard' | 'soft') ?? null,
        dedupIntervalHours: flowDef.dedup_interval_hours ?? null,
        dedupBlockMessage: flowDef.dedup_block_message ?? null,
        requiresApproval: flowDef.requires_approval ?? true,
      });

      emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  📝 Action flow "${flowDef.name}" saved (${builtSteps.length} steps, key: ${flowDef.dedup_key_field}). Testing...` }] });

      // Browser flows: structural validation only (no fake tabs)
      const openTabToolId = availableTools.find((t) => t.name === 'open_tab')?.id;
      const isBrowserFlow = openTabToolId != null && builtSteps.some((s) => s.toolId === openTabToolId);

      if (isBrowserFlow) {
        emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Action Flow Builder: "${flowDef.name}" created (browser flow — structural validation passed; live test skipped to avoid side effects)` }] });
        return {
          success: true, flow_id: newFlowId, flow_name: flowDef.name,
          test_result: 'Browser action flow — structural validation passed. Run with real input to confirm.',
          attempts: attempt,
          notes: `Created after ${attempt} attempt(s). Action browser flows are not live-tested to avoid unintended side effects.`,
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

          emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Action Flow Builder: "${flowDef.name}" passed after ${attempt} attempt(s)` }] });
          return {
            success: true, flow_id: newFlowId, flow_name: flowDef.name,
            test_result: testResult.result ?? 'ok', attempts: attempt,
            notes: `Created and tested after ${attempt} attempt(s).`,
          };
        }
      }

      // No test input — structural pass
      emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `  ✅ Action Flow Builder: "${flowDef.name}" created (no test input provided)` }] });
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
      `Action Flow Builder exhausted all ${MAX_FLOW_BUILD_ATTEMPTS} attempts for: "${taskDescription}".`,
      `Errors:`,
      ...previousErrors.map((e, i) => `  [${i + 1}] ${e}`),
    ].join('\n'),
  };
}
