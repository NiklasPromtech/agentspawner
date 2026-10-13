import { z } from 'zod';

// ── Input Expression ──────────────────────────────────────────────────────────

export const InputExpressionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('literal'), value: z.unknown() }),
  z.object({ type: z.literal('flow_input'), key: z.string() }),
  z.object({ type: z.literal('step_ref'), stepId: z.string(), path: z.string() }),
]);

export type InputExpression = z.infer<typeof InputExpressionSchema>;

// ── Step Condition ────────────────────────────────────────────────────────────

export const StepConditionSchema = z.object({
  check: z.enum([
    'min_array_length',
    'non_empty',
    'result_equals',
    'result_not_equals',
    'has_error',
    'no_error',
  ]),
  minLength: z.number().optional(),
  value: z.string().optional(),        // for result_equals / result_not_equals
  failMessage: z.string(),
  suggestTool: z.string().optional(),  // tool/flow name to append to fail message
  skipToStepId: z.string().nullable().optional(),          // condition FIRES → run cleanup from here then fail
  skipToStepIdOnNoMatch: z.string().nullable().optional(), // condition DOES NOT fire → jump to this step and continue
});

export type StepCondition = z.infer<typeof StepConditionSchema>;

// ── Evaluate Block ────────────────────────────────────────────────────────────

export const EvaluateBlockSchema = z.object({
  prompt: z.string(),
  screenshotStepId: z.string().optional(),
});

export type EvaluateBlock = z.infer<typeof EvaluateBlockSchema>;

// ── Transform Block ───────────────────────────────────────────────────────────

export const TransformBlockSchema = z.object({
  script: z.string(),
});

export type TransformBlock = z.infer<typeof TransformBlockSchema>;

// ── Flow Step ─────────────────────────────────────────────────────────────────

export const FlowStepSchema = z.object({
  id: z.string().uuid(),
  /** '__evaluate__' | '__transform__' | '__hydrate__' | '__generate__' | real tool UUID */
  toolId: z.string(),
  label: z.string().min(1),
  inputMapping: z.record(InputExpressionSchema),
  evaluate: EvaluateBlockSchema.optional(),
  condition: StepConditionSchema.nullable().optional(),
  transform: TransformBlockSchema.optional(), // only present on '__transform__' steps
  /** Per-step model override (OPERATION VANTAGE Task 2).
   *  Falls back to flow.reasoningModel, then the agent's model.
   *  e.g. 'claude-haiku-4-5-20251001' for scouting, 'claude-sonnet-4-6' for generation. */
  stepModel: z.string().optional(),
});

export type FlowStep = z.infer<typeof FlowStepSchema>;

// ── Flow Schema (array of steps) ──────────────────────────────────────────────

export const FlowSchema = z.array(FlowStepSchema);

export type FlowSteps = z.infer<typeof FlowSchema>;

// ── Action Brief (OPERATION VANTAGE — two-agent pipeline) ─────────────────────
//
// ActionBrief is the rich bundle that the Haiku scout produces at the end of a
// scouting flow.  It contains:
//   • The intended action (type + draft intent + any flow-specific fields)
//   • The full decision context (why, which sources, memory queries, DB refs)
//
// The __hydrate__ flow step re-executes every reference inside decision_context
// and promotes the brief to a HydratedContext, which is what the Sonnet __generate__
// step receives as its primary input.

export const ScrapeReferenceSchema = z.object({
  tool: z.string(),
  input: z.record(z.unknown()),
  relevance: z.string(),
});
export type ScrapeReference = z.infer<typeof ScrapeReferenceSchema>;

export const DbReferenceSchema = z.object({
  table_id: z.string(),
  description: z.string(),
});
export type DbReference = z.infer<typeof DbReferenceSchema>;

export const DecisionContextSchema = z.object({
  reason: z.string(),
  supporting_scrapes: z.array(ScrapeReferenceSchema),
  memory_queries: z.array(z.string()),
  database_context: z.array(DbReferenceSchema),
});
export type DecisionContext = z.infer<typeof DecisionContextSchema>;

// ActionBriefAction: type + optional rough draft + any flow-specific extra fields
// (e.g. post_url, subreddit, reply_to_id).  The .catchall keeps it extensible.
export const ActionBriefActionSchema = z.object({
  type: z.string(),
  draft: z.string().optional(),
}).catchall(z.unknown());
export type ActionBriefAction = z.infer<typeof ActionBriefActionSchema>;

export const ActionBriefSchema = z.object({
  action: ActionBriefActionSchema,
  decision_context: DecisionContextSchema,
});
export type ActionBrief = z.infer<typeof ActionBriefSchema>;

// ── Hydrated Context (post __hydrate__ step) ──────────────────────────────────
//
// Each reference in decision_context gains a `return` field containing the
// actual result of re-executing that reference.

export const HydratedScrapeReferenceSchema = ScrapeReferenceSchema.extend({
  return: z.unknown(),
});
export type HydratedScrapeReference = z.infer<typeof HydratedScrapeReferenceSchema>;

export const HydratedDbReferenceSchema = DbReferenceSchema.extend({
  return: z.array(z.unknown()),
});
export type HydratedDbReference = z.infer<typeof HydratedDbReferenceSchema>;

export const MemoryQueryResultSchema = z.object({
  query: z.string(),
  results: z.array(z.unknown()),
});
export type MemoryQueryResult = z.infer<typeof MemoryQueryResultSchema>;

export const HydratedDecisionContextSchema = z.object({
  reason: z.string(),
  supporting_scrapes: z.array(HydratedScrapeReferenceSchema),
  memory_queries: z.array(z.string()),
  memory_results: z.array(MemoryQueryResultSchema),
  database_context: z.array(HydratedDbReferenceSchema),
});
export type HydratedDecisionContext = z.infer<typeof HydratedDecisionContextSchema>;

export const HydratedContextSchema = z.object({
  action: ActionBriefActionSchema,
  decision_context: HydratedDecisionContextSchema,
});
export type HydratedContext = z.infer<typeof HydratedContextSchema>;
