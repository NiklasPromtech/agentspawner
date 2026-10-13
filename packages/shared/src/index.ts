// @agentspawner/shared — shared types and utilities

/** Placeholder type — verifies the shared package can be imported by both backend and frontend. */
export type SharedPackageVersion = { version: string };

// ── Flow schemas and types ────────────────────────────────────────────────────
export {
  InputExpressionSchema,
  StepConditionSchema,
  EvaluateBlockSchema,
  TransformBlockSchema,
  FlowStepSchema,
  FlowSchema,
  // OPERATION VANTAGE — brief schemas
  ScrapeReferenceSchema,
  DbReferenceSchema,
  DecisionContextSchema,
  ActionBriefActionSchema,
  ActionBriefSchema,
  HydratedScrapeReferenceSchema,
  HydratedDbReferenceSchema,
  MemoryQueryResultSchema,
  HydratedDecisionContextSchema,
  HydratedContextSchema,
} from './schemas/flow.schema.js';

export type {
  InputExpression,
  StepCondition,
  EvaluateBlock,
  TransformBlock,
  FlowStep,
  FlowSteps,
  // OPERATION VANTAGE — brief types
  ScrapeReference,
  DbReference,
  DecisionContext,
  ActionBriefAction,
  ActionBrief,
  HydratedScrapeReference,
  HydratedDbReference,
  MemoryQueryResult,
  HydratedDecisionContext,
  HydratedContext,
} from './schemas/flow.schema.js';
