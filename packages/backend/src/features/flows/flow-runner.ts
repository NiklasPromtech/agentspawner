import Anthropic from '@anthropic-ai/sdk';
import * as vm from 'vm';
import { getDb } from '../../db/index.js';
import { tools, flows, agents, flowRuns, memory, actionLog, tables as userTables, rows as userRows, apiRequestLog } from '../../db/schema.js';
import { eq, and, like, desc, asc } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';
import { v4 as uuidv4 } from 'uuid';
import { runTool } from '../../orchestrator/tool-runner.js';
import { executeExtensionTool } from '../../websocket/server.js';
import { logger } from '../../lib/logger.js';
// OPERATION SCREENSHOT REFS — screenshot persistence helpers
import { saveScreenshotToDisk } from '../../lib/screenshots.js';
// OPERATION VANTAGE — brief types used by __hydrate__ (Task 3) and __generate__ (Task 4)
import type {
  ActionBrief,
  HydratedContext,
  HydratedScrapeReference,
  HydratedDbReference,
  MemoryQueryResult,
} from '@agentspawner/shared';
import { HydratedContextSchema } from '@agentspawner/shared';
// OPERATION VANTAGE Task 3 — hydration step runtime helpers
import { hydrateActionBrief, parseActionBrief } from './hydration.js';
// OPERATION VANTAGE Task 4 — tone injection helper
import { getToneContext } from '../../lib/tone.js';
// OPERATION CONVERGENCE Task 5 — flow validation at load time
import { validateFlow, getValidationMode, type FlowMeta } from './flow-validator.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type InputExpression =
  | { type: 'literal'; value: unknown }
  | { type: 'flow_input'; key: string }
  | { type: 'step_ref'; stepId: string; path: string };

export interface StepCondition {
  check: 'min_array_length' | 'non_empty' | 'result_equals' | 'result_not_equals' | 'has_error' | 'no_error';
  minLength?: number;
  value?: string;
  failMessage: string;
  suggestTool?: string;
  skipToStepId?: string | null;          // condition FIRES → run cleanup from here then fail
  skipToStepIdOnNoMatch?: string | null; // condition DOES NOT fire → jump to this step and continue
}

export interface EvaluateStep {
  id: string;
  toolId: '__evaluate__';           // sentinel — not a real tool
  label: string;
  inputMapping: Record<string, InputExpression>;
  evaluate: {
    prompt: string;                 // e.g. "Did this comment get posted successfully?"
    screenshotStepId?: string;      // use screenshot from a previous step instead of taking a new one
  };
  condition?: StepCondition | null;
}

export interface FlowStep {
  id: string;
  toolId: string;
  label: string;
  inputMapping: Record<string, InputExpression>;
  evaluate?: {                      // optional evaluate block on any step
    prompt: string;
    screenshotStepId?: string;
  };
  condition?: StepCondition | null;
  transform?: {                     // only used when toolId === '__transform__'
    script: string;                 // JS function body receiving `input` object, must return a value
  };
  /** Per-step model override (OPERATION VANTAGE Task 2).
   *  Falls back to flow.reasoningModel, then the agent's model.
   *  e.g. 'claude-haiku-4-5-20251001' for scouting steps, 'claude-sonnet-4-6' for __generate__. */
  stepModel?: string;
}

export interface FlowRecord {
  id: string;
  agentId: string;
  name: string;
  description: string;
  inputSchema: string;
  steps: string; // JSON
  returnStepId?: string | null;
  returnSteps?: string | null; // JSON: {key:string,stepId:string}[]
  reasoningModel?: string | null;
  reasoningPrompt?: string | null;
  resultMessage?: string | null; // optional message prepended to result; supports {{result}} placeholder
  flowType?: string | null;
  stepDelayMs?: number | null; // ms to wait between steps; null = default (1000ms); 0 = no delay
  // Deduplication (task 1.3 / 1.6)
  dedupKeyField?: string | null;      // input field that makes an execution unique, e.g. 'user_id'
  dedupBreakType?: string | null;     // 'hard' | 'soft' | null
  dedupIntervalHours?: number | null; // for soft: min hours between repeats
  dedupBlockMessage?: string | null;  // message returned to agent when blocked
  // Human approval queue (task 5.3)
  requiresApproval?: boolean | null;  // if true, queue a pending_action instead of executing
  // Inline tab review (F3.2 / F3.6)
  requiresHumanReview?: boolean | null; // legacy alias for requiresApproval; pending_human_reviews table has been dropped
  // Infeasibility (F2.1)
  infeasible?: boolean | null;
  infeasibleReason?: string | null;
  // QA contract
  expectedOutput?: string | null;
}

export interface FlowRunResult {
  ok: boolean;
  result?: string;
  stepResults: Record<string, unknown>;
  stepTimings?: Record<string, number>;
  durationMs: number;
  error?: string;
}

// Context passed from the orchestrator so the reasoning model can formulate the final answer
export interface FlowContext {
  userMessage?: string;
  suppressionToken?: string;
  runId?: string;           // autonomous/chat run that triggered this flow (for flow_runs log)
  apiKey?: string;          // needed for evaluate steps
  emit?: (event: { type: string; role?: string; content?: unknown }) => void;
  // T1 — the agent's reasoning text before it decided to call this flow
  reasoning?: string;
  // T2 — which goal triggered this flow
  goalId?: string;
  // T3 — which model made the decision to call this flow
  modelId?: string;
  // ── OPERATION KEYSTONE: Task 5 ──────────────────────────────────────────────
  // Set by the play/rerun endpoints to bypass the dedup guard and reuse an existing
  // actionLog entry rather than inserting a new one.
  skipDedup?: boolean;
  existingActionLogId?: string;
}

// ── Module-level pure helpers ─────────────────────────────────────────────────

function tryParseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

function getByDotPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function evaluateConditionFailed(condition: StepCondition, result: unknown): boolean {
  switch (condition.check) {
    case 'min_array_length': {
      const r = result as Record<string, unknown>;
      const arr = Array.isArray(result) ? result
        : (result && typeof result === 'object' && Array.isArray(r.items)) ? r.items as unknown[]
        : (result && typeof result === 'object' && Array.isArray(r.elements)) ? r.elements as unknown[]
        : (result && typeof result === 'object' && Array.isArray(r.data)) ? r.data as unknown[]
        : [];
      return arr.length < (condition.minLength ?? 1);
    }
    case 'non_empty': {
      if (result == null) return true;
      if (Array.isArray(result)) return result.length === 0;
      if (typeof result === 'string') return result.trim() === '';
      if (typeof result === 'object') return Object.keys(result as object).length === 0;
      return false;
    }
    case 'result_equals': {
      // Check label first (element_exists), then found (wait_for_any), then value, then raw
      const r = result as Record<string, unknown>;
      const labelValue = result && typeof result === 'object'
        ? String(r.label ?? r.found ?? r.value ?? JSON.stringify(result))
        : typeof result === 'string' ? result : JSON.stringify(result);
      return labelValue === condition.value;
    }
    case 'result_not_equals': {
      const r = result as Record<string, unknown>;
      const labelValue = result && typeof result === 'object'
        ? String(r.label ?? r.found ?? r.value ?? JSON.stringify(result))
        : typeof result === 'string' ? result : JSON.stringify(result);
      return labelValue !== condition.value;
    }
    case 'has_error': {
      // Fires when the result is an object with an "error" field (e.g. element not found, timeout)
      return !!(result && typeof result === 'object' && 'error' in result);
    }
    case 'no_error': {
      // Fires when the result does NOT have an "error" field (success path)
      return !(result && typeof result === 'object' && 'error' in result);
    }
    default:
      return false;
  }
}

function resolveInputMapping(
  mapping: Record<string, InputExpression>,
  flowInput: Record<string, unknown>,
  stepResults: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(mapping)) {
    switch (expr.type) {
      case 'literal':
        // If the value is a string containing {{key}} placeholders, substitute from flowInput
        resolved[field] = typeof expr.value === 'string' && expr.value.includes('{{')
          ? expr.value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
              const v = flowInput[k];
              return v != null ? String(v) : '';
            })
          : expr.value;
        break;
      case 'flow_input':
        resolved[field] = flowInput[expr.key];
        break;
      case 'step_ref': {
        if (!(expr.stepId in stepResults)) {
          throw new Error(
            `step_ref for field "${field}" references step "${expr.stepId}" which has not run yet (forward reference)`,
          );
        }
        const stepResult = stepResults[expr.stepId];
        const value = getByDotPath(stepResult, expr.path);
        if (value === undefined) {
          const resultType = Array.isArray(stepResult) ? 'array' : typeof stepResult;
          const resultPreview = (() => {
            try { return JSON.stringify(stepResult).slice(0, 100); } catch { return String(stepResult).slice(0, 100); }
          })();
          throw new Error(
            `step_ref for field "${field}": path "${expr.path}" resolved to undefined on step "${expr.stepId}". ` +
            `Step result type: ${resultType}. Step result (first 100 chars): ${resultPreview}`,
          );
        }
        resolved[field] = value;
        break;
      }
    }
  }
  return resolved;
}

// ── Reasoning model call ──────────────────────────────────────────────────────

async function callReasoningModel(
  flow: FlowRecord,
  flowResult: string,
  agentId: string,
  context: FlowContext,
): Promise<string> {
  const db = getDb();
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) throw new Error('Agent not found');

  const apiKey = decrypt(agent.apiKeyEncrypted);
  if (!apiKey) throw new Error('API key not configured');

  const anthropic = new Anthropic({ apiKey });

  const systemPrompt = flow.reasoningPrompt?.trim()
    || agent.systemPrompt
    || 'You are a helpful assistant. Present the provided data to the user clearly and concisely.';

  const userContent = context.userMessage
    ? `${context.userMessage}\n\nFlow data:\n${flowResult}`
    : `Flow data:\n${flowResult}`;

  const response = await anthropic.messages.create({
    model: flow.reasoningModel!,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  // Emit as an assistant message so it appears in the chat
  context.emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text }] });

  // Return the suppression token so the orchestrator sends it back to Sonnet
  return context.suppressionToken ?? '__flow_done__';
}

// ── Evaluate step ─────────────────────────────────────────────────────────────

async function runEvaluateStep(
  prompt: string,
  screenshotData: string | null,  // base64 PNG or null if unavailable
  apiKey: string,
  /** Model to use for evaluation. Falls back to haiku if not specified. */
  model?: string,
): Promise<{ passed: boolean; reason: string }> {
  if (!screenshotData) {
    return { passed: false, reason: 'No screenshot available — add a take_screenshot tool to this agent or reference a prior screenshot step.' };
  }

  const client = new Anthropic({ apiKey });

  const userContent: Anthropic.Messages.ContentBlockParam[] = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotData } },
    { type: 'text', text: `${prompt}\n\nRespond with JSON only: {"passed": true|false, "reason": "one sentence explanation"}` },
  ];

  const response = await client.messages.create({
    model: model ?? 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { passed: false, reason: 'Evaluation parse failed' };
  try {
    return JSON.parse(match[0]) as { passed: boolean; reason: string };
  } catch {
    return { passed: false, reason: 'Evaluation parse failed' };
  }
}

// ── FlowRunnerService class ───────────────────────────────────────────────────

type FinalizeResult = FlowRunResult & {
  evaluationPassed?: boolean | null;
  evaluationReason?: string | null;
};

interface ResumeOptions {
  /** Index in the steps array to start from (steps before this are skipped). */
  startFromIndex: number;
  /** Step results from the paused run to pre-populate before resuming. */
  preloadedStepResults: Record<string, unknown>;
}

class FlowRunnerService {
  private readonly flow: FlowRecord;
  private readonly flowInput: Record<string, unknown>;
  private readonly agentId: string;
  private readonly context: FlowContext | undefined;
  private readonly stepResults: Record<string, unknown> = {};
  private stepTimings: Record<string, number> = {};
  private readonly start: number;
  private readonly flowRunId: string;
  private readonly isInternalTestRun: boolean;
  private readonly stepDelayMs: number;
  private readonly db: ReturnType<typeof getDb>;
  private readonly log: ReturnType<typeof logger.child>;
  private steps: FlowStep[] = [];
  private evalPassed: boolean | null = null;
  private evalReason: string | null = null;
  /** ID of the actionLog entry written at queue-time in checkDedup(); used for result write-back. */
  private actionLogEntryId: string | null = null;

  private readonly resumeOptions: ResumeOptions | undefined;

  constructor(
    flow: FlowRecord,
    flowInput: Record<string, unknown>,
    agentId: string,
    context: FlowContext | undefined,
    resumeOptions?: ResumeOptions,
  ) {
    this.flow = flow;
    this.flowInput = flowInput;
    this.agentId = agentId;
    this.context = context;
    this.resumeOptions = resumeOptions;
    this.start = Date.now();
    this.flowRunId = uuidv4();
    this.isInternalTestRun = flow.name === '__inline_test__' || flow.id === '__inline_test__';
    this.stepDelayMs = flow.stepDelayMs != null ? flow.stepDelayMs : 0;
    this.db = getDb();
    this.log = logger.child({ flowId: flow.id, agentId });
    // Pre-populate step results when resuming from a paused review
    if (resumeOptions?.preloadedStepResults) {
      Object.assign(this.stepResults, resumeOptions.preloadedStepResults);
    }
  }

  // ── Public entry point ────────────────────────────────────────────────────

  async run(): Promise<FlowRunResult> {
    // Parse steps JSON
    try {
      this.steps = JSON.parse(this.flow.steps) as FlowStep[];
    } catch {
      return { ok: false, stepResults: this.stepResults, durationMs: Date.now() - this.start, error: 'Invalid steps JSON' };
    }

    // ── Flow validation (OPERATION CONVERGENCE Task 5) ─────────────────────
    // Validate the parsed steps + flow-level metadata. Pre-existing flows
    // (created before the validation cutoff) get 'warn' mode — errors are
    // logged but don't block execution. New flows get 'strict' mode.
    const validationMeta: FlowMeta = {
      requiresApproval: this.flow.requiresApproval ?? false,
      dedupKeyField: this.flow.dedupKeyField ?? null,
      inputSchema: this.flow.inputSchema ?? null,
      flowType: this.flow.flowType ?? null,
    };
    const validation = validateFlow(this.steps, validationMeta);
    if (!validation.valid) {
      const mode = getValidationMode('createdAt' in this.flow ? (this.flow as unknown as { createdAt?: string }).createdAt : undefined);
      const errMsg = `Flow validation ${mode === 'strict' ? 'failed' : 'warnings'}: ${validation.errors.join('; ')}`;
      if (mode === 'strict') {
        this.log.error(errMsg);
        return {
          ok: false,
          stepResults: this.stepResults,
          durationMs: Date.now() - this.start,
          error: errMsg,
        };
      } else {
        // Warn mode — log but continue execution
        this.log.warn(errMsg);
      }
    }

    // ── Infeasible guard ────────────────────────────────────────────────────
    if (this.flow.infeasible) {
      const reason = this.flow.infeasibleReason ? ` Reason: ${this.flow.infeasibleReason}` : '';
      return {
        ok: true,
        stepResults: this.stepResults,
        durationMs: Date.now() - this.start,
        result: `Flow "${this.flow.name}" has been marked as infeasible and cannot be executed.${reason} Please use an alternative approach or revisit the agent's scope.`,
      };
    }

    // ── Deduplication / approval / review pre-checks ────────────────────────
    // Skip on resume — the flow already passed these checks on its first run.
    if (!this.resumeOptions) {
      const dedupResult = await this.checkDedup();
      if (dedupResult) return dedupResult;
    }

    // ── Execute all steps ───────────────────────────────────────────────────
    const stepsResult = await this.executeSteps(this.resumeOptions?.startFromIndex ?? 0);
    if (stepsResult) {
      // If the flow errored, update the actionLog entry status to 'failed'
      if (!stepsResult.ok && this.actionLogEntryId && !this.isInternalTestRun) {
        try {
          await this.db.update(actionLog)
            .set({ status: 'failed', result: stepsResult.error ?? 'Execution failed' })
            .where(eq(actionLog.id, this.actionLogEntryId));
        } catch { /* logging failure must not block */ }
      }
      return stepsResult;
    }

    // ── Assemble final result string ────────────────────────────────────────
    let finalResult = this.assembleResult();

    // ── Reasoning model delegation (early return — bypasses action log / resultMessage) ──
    if (this.flow.reasoningModel && this.context?.emit) {
      try {
        const suppressionToken = await callReasoningModel(this.flow, finalResult, this.agentId, this.context);
        return await this.finalize({
          ok: true,
          result: suppressionToken,
          stepResults: this.stepResults,
          durationMs: Date.now() - this.start,
        });
      } catch (err) {
        // Reasoning model failed — fall through to normal result path
        this.log.error({ err }, 'FlowRunner: reasoning model error');
      }
    }

    // ── Post-run side-effects (action log write-back + result message decoration) ──
    finalResult = await this.postRun(finalResult);

    return await this.finalize({ ok: true, result: finalResult, stepResults: this.stepResults, durationMs: Date.now() - this.start });
  }

  // ── Private: finalize ─────────────────────────────────────────────────────
  // Persists the flow run record to the DB and returns the result unchanged.

  private async finalize(result: FinalizeResult): Promise<FlowRunResult> {
    const withTimings: FinalizeResult = { ...result, stepTimings: this.stepTimings };
    if (this.isInternalTestRun) return withTimings; // don't pollute flow_runs with builder test noise
    try {
      await this.db.insert(flowRuns).values({
        id: this.flowRunId,
        flowId: this.flow.id,
        flowName: this.flow.name,
        agentId: this.agentId,
        runId: this.context?.runId ?? null,
        input: JSON.stringify(this.flowInput),
        output: result.result ?? null,
        evaluationPassed: result.evaluationPassed ?? this.evalPassed ?? null,
        evaluationReason: result.evaluationReason ?? this.evalReason ?? null,
        durationMs: result.durationMs,
        success: result.ok,
        error: result.error ?? null,
        reasoning: this.context?.reasoning ?? null,   // T1
        goalId: this.context?.goalId ?? null,          // T2
        modelId: this.context?.modelId ?? null,        // T3
        stepResults: JSON.stringify(result.stepResults), // KEYSTONE T2: always written on completion
      });
    } catch (logErr) {
      this.log.error({ err: logErr }, 'DB: failed to log flow run');
    }

    // ── Scrape flow auto-logging ──────────────────────────────────────────
    // When a scrape flow completes successfully, store its final output in
    // api_request_log so the agent can reference it via inject_rows — same
    // pattern as API tool auto-logging in api-tool-runner-throttled.ts.
    if (this.flow.flowType === 'scrape' && result.ok && result.result) {
      try {
        const requestId = uuidv4();
        await this.db.insert(apiRequestLog).values({
          id: requestId,
          agentId: this.agentId,
          toolName: `flow:${this.flow.name}`,
          input: JSON.stringify(this.flowInput),
          response: result.result, // already a JSON string from assembleResult
          durationMs: result.durationMs,
        });
        // Attach __requestId to the result string so the agent can use inject_rows
        try {
          const parsed = JSON.parse(result.result);
          if (parsed && typeof parsed === 'object') {
            parsed.__requestId = requestId;
            withTimings.result = JSON.stringify(parsed);
          }
        } catch {
          // Result isn't valid JSON — wrap it so __requestId can still be attached
          withTimings.result = JSON.stringify({ data: result.result, __requestId: requestId });
        }
      } catch (logErr) {
        this.log.error({ err: logErr }, 'DB: failed to auto-log scrape flow result');
      }
    }

    return withTimings;
  }

  // ── Private: resolveInputExpression ──────────────────────────────────────
  // Thin wrapper around the module-level resolveInputMapping that captures
  // this.flowInput and this.stepResults so callers only pass the mapping.

  private resolveInputExpression(
    mapping: Record<string, InputExpression>,
  ): Record<string, unknown> {
    return resolveInputMapping(mapping, this.flowInput, this.stepResults);
  }

  // ── Private: checkDedup ───────────────────────────────────────────────────
  // Key-first dedup guard: enforces that every action flow has a dedupKeyField,
  // checks for prior executions, writes the actionLog entry immediately, and
  // optionally queues for human review. Returns a FlowRunResult to
  // short-circuit execution, or null to continue.

  private async checkDedup(): Promise<FlowRunResult | null> {
    const { flow, flowInput, agentId, isInternalTestRun, stepResults, start } = this;

    // Only applies to action flows
    if (flow.flowType !== 'action') return null;

    // ── Skip guard for play/rerun endpoints ───────────────────────────────────
    // When the request comes from the Review Actions UI (play or rerun), we trust
    // the human decision and bypass the guard entirely.  If an existingActionLogId
    // is supplied, point the runner at that entry so postRun() updates it in-place
    // instead of inserting a new row.
    if (this.context?.skipDedup) {
      if (this.context.existingActionLogId) {
        this.actionLogEntryId = this.context.existingActionLogId;
      }
      return null; // continue to step execution
    }

    // Hard error: every action flow must declare a dedupKeyField
    if (!flow.dedupKeyField) {
      throw new Error(`Action flow '${flow.name}' has no dedupKeyField. All action flows must have a key.`);
    }

    const keyValue = String(flowInput[flow.dedupKeyField] ?? '');

    if (!isInternalTestRun && keyValue) {
      // ── OPERATION CONVERGENCE Task 8 — atomic dedup check + actionLog insert ─
      // Wrapping SELECT + INSERT in a single synchronous transaction prevents the
      // TOCTOU race where two concurrent flow runs both query "no prior entry",
      // both pass the dedup guard, and both insert a non-blocked entry — causing
      // double-execution of the same action (e.g. two DMs sent to the same user).
      // SQLite serialises writes within a transaction, so only one winner can
      // insert the non-blocked entry; the second will see the first's entry and
      // be blocked.
      type TxResult =
        | { kind: 'blocked'; blockMsg: string }
        | { kind: 'queued'; entryId: string }
        | { kind: 'error' };

      let txResult: TxResult = { kind: 'error' };
      try {
        txResult = this.db.transaction((tx) => {
          // SELECT for prior non-blocked entry (synchronous — .all() not await)
          const rows = tx
            .select({
              status: actionLog.status,
              blockedReason: actionLog.blockedReason,
              createdAt: actionLog.createdAt,
            })
            .from(actionLog)
            .where(
              and(
                eq(actionLog.agentId, agentId),
                eq(actionLog.flowId, flow.id),
                eq(actionLog.keyValue, keyValue),
                eq(actionLog.blocked, false),
              ),
            )
            .orderBy(desc(actionLog.createdAt))
            .limit(1)
            .all();

          const prior = rows[0] ?? null;

          // ── Build block message from prior entry status ──────────────────
          let blockMsg: string | null = null;

          if (prior) {
            const entryDate = new Date(prior.createdAt);
            const dateStr = entryDate.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
            const timeStr = entryDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

            if (prior.status === 'pending_review') {
              const minutesAgo = Math.round((Date.now() - entryDate.getTime()) / 60000);
              const agoStr = minutesAgo < 1 ? 'just now' : minutesAgo < 60 ? `${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago` : `${Math.round(minutesAgo / 60)} hour${Math.round(minutesAgo / 60) === 1 ? '' : 's'} ago`;
              blockMsg = `⏳ Already in review: ${flow.name} for ${keyValue} was already queued at ${timeStr} (${agoStr}) and is still awaiting human approval. Do not re-queue.`;
            } else if (prior.status === 'rejected') {
              const reason = prior.blockedReason ?? 'no reason given';
              blockMsg = `❌ Rejected: The user previously rejected ${flow.name} for ${keyValue} with reason: '${reason}'. Do not retry without new context.`;
            } else if (prior.status === 'failed') {
              blockMsg = `⚠ Previously failed: You already attempted ${flow.name} for ${keyValue} on ${dateStr} but the execution failed. Check Review Actions for details. Do not retry automatically — the flow likely needs fixing.`;
            } else if (
              (prior.status === 'executed' || prior.status === 'approved' || prior.status === 'approved_with_edits') &&
              flow.dedupBreakType === 'hard'
            ) {
              const suggestion = flow.dedupBlockMessage ? ` ${flow.dedupBlockMessage}` : '';
              blockMsg = `⛔ Hard stop: You already ran ${flow.name} for ${keyValue} on ${dateStr} at ${timeStr}.${suggestion}`;
            } else if (
              (prior.status === 'executed' || prior.status === 'approved' || prior.status === 'approved_with_edits') &&
              flow.dedupBreakType === 'soft' &&
              flow.dedupIntervalHours
            ) {
              const intervalMs = flow.dedupIntervalHours * 60 * 60 * 1000;
              const ageMs = Date.now() - entryDate.getTime();
              if (ageMs < intervalMs) {
                const hoursAgo = (ageMs / 3600000).toFixed(1);
                const nextAllowed = new Date(entryDate.getTime() + intervalMs).toLocaleString('en-US', {
                  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                });
                blockMsg = `⏳ Soft stop: You ran ${flow.name} for ${keyValue} ${hoursAgo}h ago. Minimum interval is ${flow.dedupIntervalHours}h. Next allowed: ${nextAllowed}.`;
              }
              // else: outside the cooldown window — allow this run
            }
          }

          if (blockMsg) {
            // Insert a blocked entry to record that the guard fired (synchronous .run())
            tx.insert(actionLog).values({
              id: uuidv4(),
              agentId,
              flowId: flow.id,
              flowName: flow.name,
              flowType: flow.flowType ?? 'action',
              keyField: flow.dedupKeyField!,
              keyValue,
              input: JSON.stringify(flowInput),
              result: blockMsg,
              blocked: true,
              status: 'blocked',
              runId: this.context?.runId ?? null,
            }).run();
            return { kind: 'blocked' as const, blockMsg };
          }

          // Not blocked — insert the non-blocked entry to claim this execution slot.
          // Status is optimistic: 'pending_review' if approval required, 'executed' otherwise.
          // On execution failure, run() updates the status to 'failed'.
          const entryId = uuidv4();
          const initialStatus = flow.requiresApproval ? 'pending_review' : 'executed';
          tx.insert(actionLog).values({
            id: entryId,
            agentId,
            flowId: flow.id,
            flowName: flow.name,
            flowType: flow.flowType ?? 'action',
            keyField: flow.dedupKeyField!,
            keyValue,
            input: JSON.stringify(flowInput),
            result: null,
            blocked: false,
            status: initialStatus,
            runId: this.context?.runId ?? null,
          }).run();
          return { kind: 'queued' as const, entryId };
        });
      } catch {
        // Transaction failed — logging failures must not block execution
        txResult = { kind: 'error' };
      }

      if (txResult.kind === 'blocked') {
        return await this.finalize({ ok: true, result: txResult.blockMsg, stepResults, durationMs: Date.now() - start });
      }

      if (txResult.kind === 'queued') {
        this.actionLogEntryId = txResult.entryId;
      }
      // For kind === 'error': proceed without actionLogEntryId (same as previous swallow-errors behavior)
    }

    // ── Human approval queue: return queue message without executing ────────
    if (flow.requiresApproval && !isInternalTestRun) {
      const queueMsg = `⏸ Queued for review: ${flow.name} for ${keyValue} has been sent to Review Actions. ID: ${this.actionLogEntryId ?? 'unknown'}`;
      return await this.finalize({ ok: true, result: queueMsg, stepResults, durationMs: Date.now() - start });
    }

    return null;
  }

  // ── Private: executeSteps ─────────────────────────────────────────────────
  // Runs each step in the flow in order, handling all sentinel step types,
  // conditions, and early exits. Returns a FlowRunResult on early exit, or
  // null when all steps complete normally (caller then assembles the result).

  private async executeSteps(startFromIndex = 0): Promise<FlowRunResult | null> {
    const { flow, flowInput, agentId, start, steps, stepDelayMs } = this;

    // Proxy intercepts every stepResults[step.id] = … assignment and records
    // how long that step took, without touching any of the assignment sites.
    let currentStepStart = 0;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const stepResults = new Proxy(this.stepResults, {
      set(target, prop: string, value: unknown) {
        if (currentStepStart > 0) self.stepTimings[prop] = Date.now() - currentStepStart;
        target[prop] = value;
        return true;
      },
    });

    for (let i = startFromIndex; i < steps.length; i++) {
      const step = steps[i]!;

      // Inter-step delay (skip for first step)
      if (i > 0 && stepDelayMs > 0) {
        await new Promise((r) => setTimeout(r, stepDelayMs));
      }

      currentStepStart = Date.now();

      // ── Evaluate step ──────────────────────────────────────────────────────
      if (step.toolId === '__evaluate__') {
        if (!step.evaluate) {
          stepResults[step.id] = { passed: null, reason: 'Evaluate step has no prompt configured — skipped' };
          continue;
        }
        const apiKey = this.context?.apiKey ?? null;
        if (!apiKey) {
          stepResults[step.id] = { passed: null, reason: 'No API key available for evaluation' };
        } else {
          try {
            let screenshotData: string | null = null;
            if (step.evaluate.screenshotStepId && stepResults[step.evaluate.screenshotStepId]) {
              const prior = stepResults[step.evaluate.screenshotStepId];
              const dataUrl = typeof prior === 'string' ? prior
                : (prior as Record<string, unknown>)?.screenshot as string
                ?? (prior as Record<string, unknown>)?.data as string
                ?? null;
              if (dataUrl) {
                screenshotData = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
              }
            } else {
              let tabId: number | null = null;
              for (const result of Object.values(stepResults)) {
                if (result && typeof result === 'object' && !Array.isArray(result)) {
                  const id = (result as Record<string, unknown>).tabId;
                  if (typeof id === 'number') { tabId = id; }
                }
              }

              if (tabId === null) {
                try {
                  const tabsRaw = await executeExtensionTool('list_tabs', {});
                  const tabs = tryParseJson(typeof tabsRaw === 'string' ? tabsRaw : JSON.stringify(tabsRaw)) as Array<{ tabId: number; active: boolean }> | null;
                  const found = Array.isArray(tabs) ? (tabs.find((t) => t.active) ?? tabs[0]) : null;
                  if (found?.tabId) tabId = found.tabId;
                } catch { /* extension not connected — tabId stays null */ }
              }

              if (tabId !== null) {
                try {
                  const raw = await executeExtensionTool('screenshot', { tabId });
                  const dataUrl = typeof raw === 'string' ? raw : null;
                  if (dataUrl) {
                    screenshotData = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
                  }
                } catch { /* screenshot failed — screenshotData stays null */ }
              }
            }

            const resolvedPrompt = step.evaluate.prompt.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
              const v = flowInput[k];
              return v != null ? String(v) : '';
            });
            const stepEvalModel = step.stepModel ?? flow.reasoningModel ?? undefined;
            const evalResult = await runEvaluateStep(resolvedPrompt, screenshotData, apiKey, stepEvalModel);
            stepResults[step.id] = evalResult;
            this.evalPassed = evalResult.passed;
            this.evalReason = evalResult.reason;

            this.context?.emit?.({ type: 'message', role: 'assistant', content: [{ type: 'text', text: `🔍 Evaluation: ${evalResult.passed ? '✅ Passed' : '❌ Failed'} — ${evalResult.reason}` }] });

            if (!evalResult.passed) {
              return await this.finalize({
                ok: false,
                result: JSON.stringify({ error: 'Evaluation failed', reason: evalResult.reason }),
                stepResults,
                durationMs: Date.now() - start,
                error: `Evaluation failed: ${evalResult.reason}`,
                evaluationPassed: false,
                evaluationReason: evalResult.reason,
              });
            }
          } catch (err) {
            stepResults[step.id] = { passed: null, reason: `Evaluation error: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
        continue;
      }

      // ── Screenshot sentinel step ───────────────────────────────────────────
      if (step.toolId === '__screenshot__') {
        let tabId: number | null = null;
        try {
          const resolved = this.resolveInputExpression(step.inputMapping);
          if (typeof resolved.tabId === 'number') tabId = resolved.tabId;
        } catch { /* ignore */ }
        if (tabId === null) {
          for (const result of Object.values(stepResults)) {
            if (result && typeof result === 'object' && !Array.isArray(result)) {
              const id = (result as Record<string, unknown>).tabId;
              if (typeof id === 'number') { tabId = id; break; }
            }
          }
        }
        if (tabId !== null) {
          try {
            const raw = await executeExtensionTool('screenshot', { tabId });
            stepResults[step.id] = raw;
          } catch (err) {
            stepResults[step.id] = { error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        } else {
          stepResults[step.id] = { error: 'Screenshot: no tabId found in prior steps' };
        }
        continue;
      }

      // ── Transform sentinel step ────────────────────────────────────────────
      if (step.toolId === '__transform__') {
        if (!step.transform?.script) {
          stepResults[step.id] = { error: '__transform__ step has no script defined' };
          continue;
        }
        try {
          const resolved = this.resolveInputExpression(step.inputMapping);
          const sandbox = vm.createContext({ input: resolved, result: undefined });
          const wrappedScript = `"use strict";\nresult = (function(input) {\n${step.transform.script}\n})(input);`;
          new vm.Script(wrappedScript).runInContext(sandbox, { timeout: 2000 });
          stepResults[step.id] = sandbox.result as unknown;
        } catch (err) {
          stepResults[step.id] = { error: `Transform error: ${err instanceof Error ? err.message : String(err)}` };
        }
        continue;
      }

      // ── query_action_log sentinel step ─────────────────────────────────────
      if (step.toolId === '__query_action_log__') {
        try {
          const resolved = this.resolveInputExpression(step.inputMapping);
          const keyValue = typeof resolved.key_value === 'string' ? resolved.key_value : String(resolved.key_value ?? '');
          const flowNameFilter = typeof resolved.flow_name === 'string' ? resolved.flow_name : null;
          const blockedOnly = resolved.blocked_only === true;

          const q = this.db.select({
            keyValue: actionLog.keyValue,
            blocked: actionLog.blocked,
            createdAt: actionLog.createdAt,
            result: actionLog.result,
          }).from(actionLog)
            .where(
              and(
                eq(actionLog.agentId, agentId),
                eq(actionLog.keyValue, keyValue),
                ...(flowNameFilter ? [eq(actionLog.flowName, flowNameFilter)] : []),
                ...(blockedOnly ? [eq(actionLog.blocked, true)] : [eq(actionLog.blocked, false)]),
              )
            )
            .orderBy(desc(actionLog.createdAt))
            .limit(5);
          const rows = await q;
          stepResults[step.id] = {
            found: rows.length > 0,
            count: rows.length,
            entries: rows.map((r) => ({ keyValue: r.keyValue, blocked: r.blocked, createdAt: r.createdAt, result: r.result })),
          };
        } catch (err) {
          stepResults[step.id] = { found: false, count: 0, entries: [], error: `query_action_log failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        continue;
      }

      // ── query_memory sentinel step ─────────────────────────────────────────
      if (step.toolId === '__query_memory__') {
        try {
          const resolved = this.resolveInputExpression(step.inputMapping);
          const q = typeof resolved.query === 'string' ? resolved.query : '';
          const limit = typeof resolved.limit === 'number' ? Math.min(resolved.limit, 50) : 10;
          const rows = q
            ? await this.db.select().from(memory)
                .where(like(memory.entities, `%${q}%`))
                .orderBy(desc(memory.createdAt))
                .limit(limit)
            : await this.db.select().from(memory)
                .orderBy(desc(memory.createdAt))
                .limit(limit);
          stepResults[step.id] = {
            entries: rows.map((r) => ({ content: r.content, category: r.category, entities: r.entities, createdAt: r.createdAt })),
            count: rows.length,
          };
        } catch (err) {
          stepResults[step.id] = { error: `query_memory failed: ${err instanceof Error ? err.message : String(err)}`, entries: [], count: 0 };
        }
        continue;
      }

      // ── query_database sentinel step (SESSION 5) ──────────────────────────
      if (step.toolId === '__query_database__') {
        try {
          const resolved = this.resolveInputExpression(step.inputMapping);
          const tableName  = typeof resolved.table_name === 'string' ? resolved.table_name : null;
          const tableId    = typeof resolved.table_id   === 'string' ? resolved.table_id   : null;
          const limit      = typeof resolved.limit      === 'number' ? Math.min(resolved.limit, 200) : 50;
          const orderBy    = typeof resolved.order_by   === 'string' ? resolved.order_by   : null;
          const orderDir   = resolved.order_dir === 'asc' ? 'asc' : 'desc';
          const filter     = resolved.filter && typeof resolved.filter === 'object' && !Array.isArray(resolved.filter)
            ? resolved.filter as Record<string, unknown>
            : null;

          if (!tableName && !tableId) {
            stepResults[step.id] = { error: '__query_database__: table_name or table_id is required', rows: [], count: 0 };
            continue;
          }

          // Look up the table scoped to this agent
          const tableMatch = tableName
            ? await this.db.select().from(userTables)
                .where(and(eq(userTables.agentId, agentId), eq(userTables.name, tableName)))
                .limit(1)
                .then(r => r[0] ?? null)
            : await this.db.select().from(userTables)
                .where(and(eq(userTables.agentId, agentId), eq(userTables.id, tableId!)))
                .limit(1)
                .then(r => r[0] ?? null);

          if (!tableMatch) {
            stepResults[step.id] = { error: `__query_database__: table "${tableName ?? tableId}" not found`, rows: [], count: 0 };
            continue;
          }

          // Fetch rows — fetch extra if we need to filter/sort in memory
          const fetchLimit = (filter || orderBy) ? 1000 : limit;
          const rawRows = await this.db.select().from(userRows)
            .where(eq(userRows.tableId, tableMatch.id))
            .orderBy(orderDir === 'asc' ? asc(userRows.createdAt) : desc(userRows.createdAt))
            .limit(fetchLimit);

          // Parse row data JSON
          let parsed: Record<string, unknown>[] = rawRows.map(r => {
            try {
              const data = JSON.parse(r.data) as Record<string, unknown>;
              return { ...data, __id: r.id, __createdAt: r.createdAt };
            } catch {
              return { __id: r.id, __createdAt: r.createdAt, __parseError: 'invalid JSON in row data' };
            }
          });

          // In-memory exact-match filter
          if (filter) {
            parsed = parsed.filter(row =>
              Object.entries(filter).every(([key, value]) => row[key] === value)
            );
          }

          // In-memory sort on a specific data field (overrides the DB createdAt ordering)
          if (orderBy) {
            parsed.sort((a, b) => {
              const av = a[orderBy], bv = b[orderBy];
              if (av === bv) return 0;
              if (av === undefined || av === null) return 1;
              if (bv === undefined || bv === null) return -1;
              const cmp = av < bv ? -1 : 1;
              return orderDir === 'asc' ? cmp : -cmp;
            });
          }

          // Apply limit
          parsed = parsed.slice(0, limit);

          stepResults[step.id] = { rows: parsed, count: parsed.length };
        } catch (err) {
          stepResults[step.id] = { error: `__query_database__ failed: ${err instanceof Error ? err.message : String(err)}`, rows: [], count: 0 };
        }
        continue;
      }

      // ── Hydrate step (OPERATION VANTAGE Task 3) ────────────────────────────
      if (step.toolId === '__hydrate__') {
        try {
          const resolved = this.resolveInputExpression(step.inputMapping);
          const brief = parseActionBrief(resolved.brief);
          if (!brief) {
            stepResults[step.id] = { error: '__hydrate__: inputMapping.brief is not a valid ActionBrief' };
          } else {
            const hydrated = await hydrateActionBrief(brief, agentId);
            stepResults[step.id] = hydrated;
            this.context?.emit?.({
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'text',
                text: `💧 Hydration complete — ${brief.decision_context.supporting_scrapes.length} scrape(s), ${brief.decision_context.memory_queries.length} memory quer${brief.decision_context.memory_queries.length === 1 ? 'y' : 'ies'}, ${brief.decision_context.database_context.length} DB ref(s)`,
              }],
            });
          }
        } catch (err) {
          stepResults[step.id] = { error: `__hydrate__ failed: ${err instanceof Error ? err.message : String(err)}` };
        }
        continue;
      }

      // ── Generate step (OPERATION VANTAGE Task 4) ──────────────────────────
      // Calls Sonnet (or step.stepModel) with the full HydratedContext + tone
      // to produce the final action content.
      if (step.toolId === '__generate__') {
        const apiKey = this.context?.apiKey ?? null;
        if (!apiKey) {
          stepResults[step.id] = { error: '__generate__: no API key available' };
          continue;
        }

        try {
          const resolved = this.resolveInputExpression(step.inputMapping);

          // Validate the hydrated context coming from the prior __hydrate__ step
          const parseResult = HydratedContextSchema.safeParse(resolved.hydrated_context);
          if (!parseResult.success) {
            stepResults[step.id] = {
              error: '__generate__: inputMapping.hydrated_context is not a valid HydratedContext',
              issues: parseResult.error.issues,
            };
            continue;
          }
          const hydratedContext = parseResult.data;

          // Load agent for system prompt + model fallback
          const [agentRow] = await this.db
            .select()
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1);
          if (!agentRow) {
            stepResults[step.id] = { error: '__generate__: agent not found' };
            continue;
          }

          // Pull both tone layers
          const { toneGuide, profileTone } = await getToneContext(agentId);

          // Build system prompt — agent persona + tone injected as structured data
          let systemPrompt = agentRow.systemPrompt?.trim() || 'You are a helpful assistant.';
          const toneSections: string[] = [];

          if (profileTone.length > 0) {
            toneSections.push(
              '## Base Tone Guidelines\n' + profileTone.map((t) => `- ${t}`).join('\n'),
            );
          }
          if (toneGuide.length > 0) {
            toneSections.push(
              '## Tone Corrections (OVERRIDE — applied by your human reviewer)\n' +
              'These tone corrections were made by your human reviewer — follow them precisely:\n' +
              toneGuide.map((t) => `- ${t}`).join('\n'),
            );
          }
          if (toneSections.length > 0) {
            systemPrompt = systemPrompt + '\n\n' + toneSections.join('\n\n');
          }

          // Assemble user message from hydrated context sections
          const ctx = hydratedContext.decision_context;
          const action = hydratedContext.action;
          const sections: string[] = [];

          sections.push(`## Why this action\n${ctx.reason}`);

          if (action.draft) {
            sections.push(
              `## Draft intent (rough shape — do NOT copy verbatim, use as directional guide only)\n${action.draft}`,
            );
          }

          if (ctx.supporting_scrapes.length > 0) {
            const scrapeSections = ctx.supporting_scrapes.map((s, idx) => {
              const returnStr =
                s.return != null
                  ? typeof s.return === 'string'
                    ? s.return
                    : JSON.stringify(s.return, null, 2)
                  : '(no data returned)';
              return (
                `### Source ${idx + 1}: ${s.tool}\n` +
                `Relevance: ${s.relevance}\n` +
                `Data:\n${returnStr.slice(0, 3000)}`
              );
            });
            sections.push(`## Supporting evidence\n${scrapeSections.join('\n\n')}`);
          }

          const nonEmptyMemory = ctx.memory_results.filter((m) => m.results.length > 0);
          if (nonEmptyMemory.length > 0) {
            const memSections = nonEmptyMemory.map((m) => {
              const bullets = m.results
                .slice(0, 5)
                .map((r) => {
                  const obj = r as Record<string, unknown>;
                  return `- ${String(obj.content ?? JSON.stringify(r))}`;
                })
                .join('\n');
              return `### Memory: "${m.query}"\n${bullets}`;
            });
            sections.push(`## Memory context\n${memSections.join('\n\n')}`);
          }

          if (ctx.database_context.length > 0) {
            const dbSections = ctx.database_context.map((d) => {
              const dataStr =
                d.return.length > 0
                  ? JSON.stringify(d.return.slice(0, 10), null, 2)
                  : '(no rows found)';
              return `### DB: ${d.description}\n${dataStr.slice(0, 2000)}`;
            });
            sections.push(`## Database context\n${dbSections.join('\n\n')}`);
          }

          // Extra action fields (e.g. post_url, subreddit, reply_to_id)
          const extraFields = Object.entries(action)
            .filter(([k]) => k !== 'type' && k !== 'draft')
            .map(([k, v]) => `${k}: ${String(v)}`)
            .join('\n');
          if (extraFields) {
            sections.push(`## Action parameters\nAction type: ${action.type}\n${extraFields}`);
          } else {
            sections.push(`## Action type\n${action.type}`);
          }

          const actionLabel = action.type.replace(/_/g, ' ');
          sections.push(
            `## Your task\nUsing all the context above, write the final ${actionLabel} in your authentic voice. ` +
            `Apply the tone guidelines precisely. Return ONLY the final content — no preamble, no explanation, no quotes around it.`,
          );

          const userMessage = sections.join('\n\n');

          // Model priority: step.stepModel → flow.reasoningModel → agent.model → sonnet fallback
          const model =
            step.stepModel ??
            this.flow.reasoningModel ??
            agentRow.model ??
            'claude-sonnet-4-6';

          const anthropic = new Anthropic({ apiKey });
          const response = await anthropic.messages.create({
            model,
            max_tokens: 2048,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
          });

          const generatedContent = response.content
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim();

          // Build output — map generated_content to the action-type-specific field name
          // so downstream action steps can pick it up without extra transform steps.
          const ACTION_FIELD_MAP: Record<string, string> = {
            post_comment: 'comment_text',
            send_dm: 'message_text',
            send_tweet: 'tweet_text',
            send_email: 'email_body',
            create_post: 'post_text',
            publish_post: 'post_text',
          };
          const contentField = ACTION_FIELD_MAP[action.type] ?? 'content';

          const output: Record<string, unknown> = {
            generated_content: generatedContent,
            [contentField]: generatedContent,
          };

          // Pass through extra action fields (post_url, subreddit, etc.) so
          // downstream steps can reference them via step_ref without needing
          // to re-reference the original brief.
          for (const [k, v] of Object.entries(action)) {
            if (k !== 'type' && k !== 'draft' && !(k in output)) {
              output[k] = v;
            }
          }

          stepResults[step.id] = output;

          this.context?.emit?.({
            type: 'message',
            role: 'assistant',
            content: [{
              type: 'text',
              text: `✍️ Generated ${actionLabel} using ${model} (${generatedContent.length} chars)`,
            }],
          });
        } catch (err) {
          stepResults[step.id] = {
            error: `__generate__ failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        continue;
      }

      // ── Regular tool step ──────────────────────────────────────────────────

      // Security: lookup tool scoped to agentId
      const [tool] = await this.db
        .select()
        .from(tools)
        .where(and(eq(tools.id, step.toolId), eq(tools.agentId, agentId)));

      if (!tool) {
        return await this.finalize({
          ok: false,
          stepResults,
          durationMs: Date.now() - start,
          error: `Step "${step.label}": tool "${step.toolId}" not found`,
        });
      }

      let resolvedInput: Record<string, unknown>;
      try {
        resolvedInput = this.resolveInputExpression(step.inputMapping);
      } catch (err) {
        return await this.finalize({
          ok: false,
          stepResults,
          durationMs: Date.now() - start,
          error: `Step "${step.label}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      try {
        // A step is mid-pipeline when its output won't be the final answer
        // returned to the agent — i.e. there are more steps after it, or the
        // flow has a designated return step that isn't this one.  In that case
        // we allow a much larger web_fetch response so downstream
        // filter/transform steps receive the full payload.
        const isReturnStep = flow.returnStepId
          ? step.id === flow.returnStepId
          : i === steps.length - 1;
        const isMidPipeline = !isReturnStep;
        const raw = await runTool(tool, resolvedInput, agentId, { isMidPipeline });
        stepResults[step.id] = tryParseJson(raw);
      } catch (err) {
        return await this.finalize({
          ok: false,
          stepResults,
          durationMs: Date.now() - start,
          error: `Step "${step.label}": ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Condition check
      if (step.condition) {
        const conditionFired = evaluateConditionFailed(step.condition, stepResults[step.id]);

        if (conditionFired) {
          if (step.condition.skipToStepIdOnNoMatch) {
            // BRANCH MODE: condition firing means "this path is active — continue to next step normally"
            // Nothing to do here — fall through to next iteration
          } else {
            // GUARD MODE: condition firing means something went wrong — bail out
            const failMessage = step.condition.suggestTool
              ? `${step.condition.failMessage} Use the "${step.condition.suggestTool}" tool.`
              : step.condition.failMessage;

            if (step.condition.skipToStepId) {
              const cleanupIdx = steps.findIndex((s) => s.id === step.condition!.skipToStepId);
              if (cleanupIdx !== -1) {
                for (const cleanupStep of steps.slice(cleanupIdx)) {
                  try {
                    const [cleanupTool] = await this.db.select().from(tools)
                      .where(and(eq(tools.id, cleanupStep.toolId), eq(tools.agentId, agentId)));
                    if (!cleanupTool) continue;
                    const cleanupInput = resolveInputMapping(cleanupStep.inputMapping, flowInput, stepResults);
                    const raw = await runTool(cleanupTool, cleanupInput, agentId);
                    stepResults[cleanupStep.id] = tryParseJson(raw);
                  } catch {
                    // Cleanup errors are swallowed — don't mask the original condition failure
                  }
                }
              }
            }

            return await this.finalize({
              ok: true,
              result: failMessage,
              stepResults,
              durationMs: Date.now() - start,
            });
          }
        } else if (step.condition.skipToStepIdOnNoMatch) {
          // BRANCH MODE: condition did NOT fire — jump forward past the branch steps
          const jumpIdx = steps.findIndex((s) => s.id === step.condition!.skipToStepIdOnNoMatch);
          if (jumpIdx !== -1) {
            i = jumpIdx - 1; // -1 because the loop will increment before next iteration
          }
        }
      }
    }

    return null; // all steps completed — continue to assembleResult
  }

  // ── Private: assembleResult ───────────────────────────────────────────────
  // Builds the final result string from stepResults according to the flow's
  // return configuration (returnSteps, returnStepId, or last step).

  private assembleResult(): string {
    const { flow, steps, stepResults } = this;

    let finalResult: string;
    if (flow.returnSteps) {
      let returnStepsConfig: { key: string; stepId: string }[] = [];
      try { returnStepsConfig = JSON.parse(flow.returnSteps) as { key: string; stepId: string }[]; } catch { /* ignore */ }
      if (returnStepsConfig.length > 0) {
        const merged: Record<string, unknown> = {};
        for (const { key, stepId } of returnStepsConfig) merged[key] = stepResults[stepId] ?? null;
        finalResult = JSON.stringify(merged);
      } else {
        const returnStep = steps[steps.length - 1];
        finalResult = returnStep ? JSON.stringify(stepResults[returnStep.id]) : '{}';
      }
    } else {
      const returnStep = flow.returnStepId
        ? steps.find((s) => s.id === flow.returnStepId) ?? steps[steps.length - 1]
        : steps[steps.length - 1];
      finalResult = returnStep ? JSON.stringify(stepResults[returnStep.id]) : '{}';
    }

    // OPERATION SCREENSHOT REFS — replace inline base64 data URLs with disk-persisted URL references.
    // Each unique data URL is saved once; the JSON string value (including surrounding quotes)
    // is swapped for a screenshot_ref object so the result stays lightweight but the image
    // is still accessible via GET /screenshots/{uuid}.png.
    finalResult = finalResult.replace(/"data:image\/[^"]+"/g, (match) => {
      try {
        // match includes surrounding quotes — strip them to get the raw data URL
        const dataUrl = match.slice(1, -1);
        const url = saveScreenshotToDisk(dataUrl);
        return JSON.stringify({ type: 'screenshot_ref', url });
      } catch {
        return '"[screenshot captured]"';
      }
    });

    // Warn the agent if the final result is null/undefined
    if (finalResult === 'null' || finalResult === 'undefined') {
      finalResult = JSON.stringify({
        result: null,
        warning: 'Flow returned null — the action may not have completed. Do not assume success. Check the page state or add an evaluate step to verify.',
      });
    }

    return finalResult;
  }

  // ── Private: postRun ──────────────────────────────────────────────────────
  // Updates the actionLog entry written at queue-time with the actual result,
  // and applies result message decoration.
  // Called only on the normal (non-reasoning-model) completion path.
  // Returns the (possibly decorated) final result string.

  private async postRun(finalResult: string): Promise<string> {
    const { flow, isInternalTestRun } = this;

    // Action log result write-back: update the entry written in checkDedup()
    if (!isInternalTestRun && flow.flowType === 'action' && this.actionLogEntryId) {
      try {
        await this.db.update(actionLog)
          .set({ result: finalResult })
          .where(eq(actionLog.id, this.actionLogEntryId));
      } catch { /* logging failure must not block execution */ }
    }

    // Apply result message — wraps raw data with instructions for the AI
    if (flow.resultMessage?.trim()) {
      finalResult = flow.resultMessage.includes('{{result}}')
        ? flow.resultMessage.replace('{{result}}', finalResult)
        : `${flow.resultMessage}\n\n${finalResult}`;
    }

    return finalResult;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
// These module-level functions are the stable external interface. All callers
// import and use these; nothing needs to know about FlowRunnerService directly.

export async function runFlow(
  flow: FlowRecord,
  flowInput: Record<string, unknown>,
  agentId: string,
  context?: FlowContext,
): Promise<string> {
  const result = await runFlowDetailed(flow, flowInput, agentId, context);
  if (!result.ok) throw new Error(result.error ?? 'Flow failed');
  return result.result ?? '';
}

export async function runFlowDetailed(
  flow: FlowRecord,
  flowInput: Record<string, unknown>,
  agentId: string,
  context?: FlowContext,
): Promise<FlowRunResult> {
  const runner = new FlowRunnerService(flow, flowInput, agentId, context);
  return runner.run();
}

// Re-export so orchestrator/scheduler can query the table
export { flows };

// ── Single-step debug runner ──────────────────────────────────────────────────
// Used by the Flow Step Debugger (extension Flows tab).  Executes exactly one
// step from a saved flow without writing a flow_runs row.

export interface SingleStepResult {
  stepId: string;
  result: unknown;
  ok: boolean;
  error?: string;
}

export async function runSingleStep(
  flow: FlowRecord,
  stepId: string,
  flowInput: Record<string, unknown>,
  priorStepResults: Record<string, unknown>,
  apiKey?: string,
  inputMappingOverride?: Record<string, InputExpression>,
  stepDef?: FlowStep,
): Promise<SingleStepResult> {
  let foundStep: FlowStep;

  if (stepDef) {
    // Caller provided the full step definition (e.g. a newly inserted step not yet in DB)
    foundStep = stepDef;
  } else {
    // Look up the step from the saved flow definition
    let steps: FlowStep[];
    try {
      steps = JSON.parse(flow.steps) as FlowStep[];
    } catch {
      return { stepId, result: null, ok: false, error: 'Invalid steps JSON in flow definition' };
    }
    const found = steps.find((s) => s.id === stepId);
    if (!found) {
      return { stepId, result: null, ok: false, error: `Step "${stepId}" not found in flow` };
    }
    foundStep = found;
  }

  // Apply inputMapping override when the debugger re-runs a step with edits
  const step: FlowStep = inputMappingOverride
    ? { ...foundStep, inputMapping: inputMappingOverride }
    : foundStep;

  // Resolve input expressions using the existing module-level helper
  let resolved: Record<string, unknown>;
  try {
    resolved = resolveInputMapping(step.inputMapping, flowInput, priorStepResults);
  } catch (err) {
    return { stepId, result: null, ok: false, error: `Input resolution failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const db = getDb();
  const agentId = flow.agentId;

  try {
    // ── __transform__ ─────────────────────────────────────────────────────────
    if (step.toolId === '__transform__') {
      if (!step.transform?.script) {
        return { stepId, result: { error: '__transform__ step has no script defined' }, ok: true };
      }
      try {
        const sandbox = vm.createContext({ input: resolved, result: undefined });
        const wrappedScript = `"use strict";\nresult = (function(input) {\n${step.transform.script}\n})(input);`;
        new vm.Script(wrappedScript).runInContext(sandbox, { timeout: 2000 });
        return { stepId, result: sandbox.result as unknown, ok: true };
      } catch (err) {
        return { stepId, result: { error: `Transform error: ${err instanceof Error ? err.message : String(err)}` }, ok: true };
      }
    }

    // ── __query_action_log__ ──────────────────────────────────────────────────
    if (step.toolId === '__query_action_log__') {
      try {
        const keyValue = typeof resolved.key_value === 'string' ? resolved.key_value : String(resolved.key_value ?? '');
        const flowNameFilter = typeof resolved.flow_name === 'string' ? resolved.flow_name : null;
        const blockedOnly = resolved.blocked_only === true;

        const rows = await db.select({
          keyValue: actionLog.keyValue,
          blocked: actionLog.blocked,
          createdAt: actionLog.createdAt,
          result: actionLog.result,
        }).from(actionLog)
          .where(
            and(
              eq(actionLog.agentId, agentId),
              eq(actionLog.keyValue, keyValue),
              ...(flowNameFilter ? [eq(actionLog.flowName, flowNameFilter)] : []),
              ...(blockedOnly ? [eq(actionLog.blocked, true)] : [eq(actionLog.blocked, false)]),
            )
          )
          .orderBy(desc(actionLog.createdAt))
          .limit(5);
        return {
          stepId,
          result: {
            found: rows.length > 0,
            count: rows.length,
            entries: rows.map((r) => ({ keyValue: r.keyValue, blocked: r.blocked, createdAt: r.createdAt, result: r.result })),
          },
          ok: true,
        };
      } catch (err) {
        return { stepId, result: { found: false, count: 0, entries: [], error: `query_action_log failed: ${err instanceof Error ? err.message : String(err)}` }, ok: true };
      }
    }

    // ── __query_memory__ ──────────────────────────────────────────────────────
    if (step.toolId === '__query_memory__') {
      try {
        const q = typeof resolved.query === 'string' ? resolved.query : '';
        const limit = typeof resolved.limit === 'number' ? Math.min(resolved.limit, 50) : 10;
        const rows = q
          ? await db.select().from(memory).where(like(memory.entities, `%${q}%`)).orderBy(desc(memory.createdAt)).limit(limit)
          : await db.select().from(memory).orderBy(desc(memory.createdAt)).limit(limit);
        return {
          stepId,
          result: {
            entries: rows.map((r) => ({ content: r.content, category: r.category, entities: r.entities, createdAt: r.createdAt })),
            count: rows.length,
          },
          ok: true,
        };
      } catch (err) {
        return { stepId, result: { error: `query_memory failed: ${err instanceof Error ? err.message : String(err)}`, entries: [], count: 0 }, ok: true };
      }
    }

    // ── __hydrate__ (OPERATION VANTAGE Task 3) ────────────────────────────────
    if (step.toolId === '__hydrate__') {
      try {
        const brief = parseActionBrief(resolved.brief);
        if (!brief) {
          return { stepId, result: { error: '__hydrate__: resolved.brief is not a valid ActionBrief' }, ok: true };
        }
        const hydrated = await hydrateActionBrief(brief, agentId);
        return { stepId, result: hydrated, ok: true };
      } catch (err) {
        return { stepId, result: { error: `__hydrate__ failed: ${err instanceof Error ? err.message : String(err)}` }, ok: true };
      }
    }

    // ── __evaluate__ ──────────────────────────────────────────────────────────
    if (step.toolId === '__evaluate__') {
      if (!step.evaluate) {
        return { stepId, result: { passed: null, reason: 'Evaluate step has no prompt configured — skipped' }, ok: true };
      }
      if (!apiKey) {
        return { stepId, result: { passed: null, reason: 'No API key available for evaluation' }, ok: true };
      }
      try {
        let screenshotData: string | null = null;
        if (step.evaluate.screenshotStepId && priorStepResults[step.evaluate.screenshotStepId]) {
          const prior = priorStepResults[step.evaluate.screenshotStepId];
          const dataUrl = typeof prior === 'string' ? prior
            : (prior as Record<string, unknown>)?.screenshot as string
            ?? (prior as Record<string, unknown>)?.data as string
            ?? null;
          if (dataUrl) {
            screenshotData = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
          }
        }
        const resolvedPrompt = step.evaluate.prompt.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
          const v = flowInput[k];
          return v != null ? String(v) : '';
        });
        const stepEvalModel = step.stepModel ?? flow.reasoningModel ?? undefined;
        const evalResult = await runEvaluateStep(resolvedPrompt, screenshotData, apiKey, stepEvalModel);
        return { stepId, result: evalResult, ok: true };
      } catch (err) {
        return { stepId, result: { passed: null, reason: `Evaluation error: ${err instanceof Error ? err.message : String(err)}` }, ok: true };
      }
    }

    // ── __screenshot__ ────────────────────────────────────────────────────────
    if (step.toolId === '__screenshot__') {
      let tabId: number | null = null;
      if (typeof resolved.tabId === 'number') tabId = resolved.tabId;
      if (tabId === null) {
        for (const r of Object.values(priorStepResults)) {
          if (r && typeof r === 'object' && !Array.isArray(r)) {
            const id = (r as Record<string, unknown>).tabId;
            if (typeof id === 'number') { tabId = id; break; }
          }
        }
      }
      if (tabId !== null) {
        try {
          const raw = await executeExtensionTool('screenshot', { tabId });
          return { stepId, result: raw, ok: true };
        } catch (err) {
          return { stepId, result: { error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` }, ok: true };
        }
      }
      return { stepId, result: { error: 'Screenshot: no tabId found in prior steps' }, ok: true };
    }

    // ── Regular tool step ─────────────────────────────────────────────────────
    const [tool] = await db.select().from(tools).where(and(eq(tools.id, step.toolId), eq(tools.agentId, agentId)));
    if (!tool) {
      return { stepId, result: null, ok: false, error: `Step "${step.label}": tool "${step.toolId}" not found` };
    }

    const raw = await runTool(tool, resolved, agentId);
    return { stepId, result: tryParseJson(raw), ok: true };
  } catch (err) {
    return { stepId, result: null, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
