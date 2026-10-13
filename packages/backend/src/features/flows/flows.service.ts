/**
 * flows.service.ts
 * Business logic for the flows feature.
 * Orchestrates repository calls, validation, and flow execution.
 */
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { FlowStepSchema, FlowSchema } from '@agentspawner/shared';
import type { FlowStep } from '@agentspawner/shared';
import { decrypt } from '../../crypto/index.js';
import { childLogger } from '../../lib/logger.js';
import { runFlowDetailed } from './flow-runner.js';
// OPERATION CONVERGENCE Task 5 — flow validation at save time
import { validateFlow, type FlowMeta } from './flow-validator.js';
import {
  findFlows,
  findFlowById,
  findFlowByName,
  insertFlow,
  updateFlowById,
  deleteFlowById,
  findFlowRuns,
  findToolByName,
  findAgentById,
  type FlowRow,
} from './flows.repository.js';

const log = childLogger({ feature: 'flows' });

// ── Zod schema for create/update body ────────────────────────────────────────

export const FlowBody = z.object({
  name: z.string().min(1).regex(/^[a-z_][a-z0-9_]*$/, 'Name must be snake_case'),
  description: z.string().min(1),
  inputSchema: z.string().default('{}'),
  steps: z.array(FlowStepSchema).default([]),
  returnStepId: z.string().nullable().optional(),
  returnSteps: z.string().nullable().optional(),
  reasoningModel: z.string().nullable().optional(),
  reasoningPrompt: z.string().nullable().optional(),
  resultMessage: z.string().nullable().optional(),
  flowType: z.enum(['scrape', 'action']).nullable().optional(),
  dedupKeyField: z.string().nullable().optional(),
  dedupBreakType: z.enum(['hard', 'soft']).nullable().optional(),
  dedupIntervalHours: z.number().int().positive().nullable().optional(),
  dedupBlockMessage: z.string().nullable().optional(),
  readsFrom: z.string().nullable().optional(),
  writesTo: z.string().nullable().optional(),
  updatesFields: z.array(z.string()).nullable().optional(),
  requiresApproval: z.boolean().nullable().optional().transform((v) => v ?? false),
  infeasible: z.boolean().nullable().optional(),
  infeasibleReason: z.string().nullable().optional(),
  requiresHumanReview: z.boolean().nullable().optional().transform((v) => v ?? false),
  expectedOutput: z.string().nullable().optional(),
});

export type FlowBodyInput = z.infer<typeof FlowBody>;
export type FlowBodyPartial = Partial<FlowBodyInput>;

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validates the steps array structure (via FlowSchema from shared) and then
 * verifies that every step_ref.stepId references a step that exists within
 * the same flow.  Returns a 400-ready error object on failure, or null if valid.
 */
export function validateStepsAndCrossRefs(
  steps: unknown[],
): { error: string; details?: { path: string; message: string }[] } | null {
  const parsed = FlowSchema.safeParse(steps);
  if (!parsed.success) {
    return {
      error: 'Invalid steps: schema validation failed',
      details: parsed.error.issues.map((i) => ({
        path: `steps.${i.path.join('.')}`,
        message: i.message,
      })),
    };
  }

  const stepIds = new Set<string>(parsed.data.map((s: FlowStep) => s.id));
  for (let idx = 0; idx < parsed.data.length; idx++) {
    const step = parsed.data[idx];
    for (const [field, expr] of Object.entries(step.inputMapping)) {
      if (expr.type === 'step_ref' && !stepIds.has(expr.stepId)) {
        return {
          error: `Step "${step.label}" (${step.id}): inputMapping field "${field}" references unknown step ID "${expr.stepId}"`,
          details: [
            {
              path: `steps[${idx}].inputMapping.${field}.stepId`,
              message: `Referenced step ID "${expr.stepId}" does not exist in this flow`,
            },
          ],
        };
      }
    }
  }

  return null;
}

// ── Service methods ───────────────────────────────────────────────────────────

export async function listFlows(agentId: string): Promise<FlowRow[]> {
  return findFlows(agentId);
}

export async function getFlow(agentId: string, flowId: string): Promise<FlowRow | null> {
  return (await findFlowById(agentId, flowId)) ?? null;
}

export interface CreateFlowError {
  status: 400 | 409;
  body: { error: string; details?: { path: string; message: string }[] };
}

export async function createFlow(
  agentId: string,
  body: FlowBodyInput,
): Promise<{ flow: FlowRow } | { error: CreateFlowError }> {
  // Validate steps (schema + cross-refs)
  if (body.steps.length > 0) {
    const stepsError = validateStepsAndCrossRefs(body.steps);
    if (stepsError) return { error: { status: 400, body: stepsError } };
  }

  // OPERATION CONVERGENCE Task 5 — flow-level validation (always strict on save)
  if (body.steps.length > 0) {
    const meta: FlowMeta = {
      requiresApproval: body.requiresApproval ?? false,
      dedupKeyField: body.dedupKeyField ?? null,
      inputSchema: body.inputSchema ?? null,
      flowType: body.flowType ?? null,
    };
    const flowValidation = validateFlow(body.steps as unknown as import('./flow-runner.js').FlowStep[], meta);
    if (!flowValidation.valid) {
      return {
        error: {
          status: 400,
          body: {
            error: 'Flow validation failed',
            details: flowValidation.errors.map((msg) => ({ path: 'flow', message: msg })),
          },
        },
      };
    }
  }

  // Name collision checks
  const existingTool = await findToolByName(agentId, body.name);
  if (existingTool) {
    return { error: { status: 409, body: { error: `A tool named "${body.name}" already exists` } } };
  }

  const existingFlow = await findFlowByName(agentId, body.name);
  if (existingFlow) {
    return { error: { status: 409, body: { error: `A flow named "${body.name}" already exists` } } };
  }

  const flow = await insertFlow({
    id: uuidv4(),
    agentId,
    name: body.name,
    description: body.description,
    inputSchema: body.inputSchema,
    steps: JSON.stringify(body.steps),
    returnStepId: body.returnStepId ?? null,
    returnSteps: body.returnSteps ?? null,
    reasoningModel: body.reasoningModel ?? null,
    reasoningPrompt: body.reasoningPrompt ?? null,
    resultMessage: body.resultMessage ?? null,
    flowType: body.flowType ?? null,
    dedupKeyField: body.dedupKeyField ?? null,
    dedupBreakType: body.dedupBreakType ?? null,
    dedupIntervalHours: body.dedupIntervalHours ?? null,
    dedupBlockMessage: body.dedupBlockMessage ?? null,
    readsFrom: body.readsFrom ?? null,
    writesTo: body.writesTo ?? null,
    updatesFields: body.updatesFields ? JSON.stringify(body.updatesFields) : null,
    requiresApproval: body.requiresApproval ?? false,
    infeasible: body.infeasible ?? false,
    infeasibleReason: body.infeasibleReason ?? null,
    requiresHumanReview: body.requiresHumanReview ?? false,
    expectedOutput: body.expectedOutput ?? null,
  });

  log.info({ agentId, flowId: flow.id }, 'Flow created');
  return { flow };
}

export async function updateFlow(
  agentId: string,
  flowId: string,
  body: FlowBodyPartial,
): Promise<{ flow: FlowRow } | { error: CreateFlowError }> {
  const existing = await findFlowById(agentId, flowId);
  if (!existing) {
    return { error: { status: 400, body: { error: 'Not found' } } };
  }

  // Validate steps if being updated
  if (body.steps !== undefined && body.steps.length > 0) {
    const stepsError = validateStepsAndCrossRefs(body.steps);
    if (stepsError) return { error: { status: 400, body: stepsError } };
  }

  // OPERATION CONVERGENCE Task 5 — flow-level validation (always strict on save)
  if (body.steps !== undefined && body.steps.length > 0) {
    const meta: FlowMeta = {
      requiresApproval: body.requiresApproval ?? (existing as Record<string, unknown>).requiresApproval as boolean ?? false,
      dedupKeyField: body.dedupKeyField ?? (existing as Record<string, unknown>).dedupKeyField as string ?? null,
      inputSchema: body.inputSchema ?? (existing as Record<string, unknown>).inputSchema as string ?? null,
      flowType: body.flowType ?? (existing as Record<string, unknown>).flowType as string ?? null,
    };
    const flowValidation = validateFlow(body.steps as unknown as import('./flow-runner.js').FlowStep[], meta);
    if (!flowValidation.valid) {
      return {
        error: {
          status: 400,
          body: {
            error: 'Flow validation failed',
            details: flowValidation.errors.map((msg) => ({ path: 'flow', message: msg })),
          },
        },
      };
    }
  }

  // Name collision checks if name is changing
  if (body.name && body.name !== existing.name) {
    const existingTool = await findToolByName(agentId, body.name);
    if (existingTool) {
      return { error: { status: 409, body: { error: `A tool named "${body.name}" already exists` } } };
    }

    const existingFlow = await findFlowByName(agentId, body.name, flowId);
    if (existingFlow) {
      return { error: { status: 409, body: { error: `A flow named "${body.name}" already exists` } } };
    }
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;
  if (body.inputSchema !== undefined) patch.inputSchema = body.inputSchema;
  if (body.steps !== undefined) patch.steps = JSON.stringify(body.steps);
  if ('returnStepId' in body) patch.returnStepId = body.returnStepId ?? null;
  if ('returnSteps' in body) patch.returnSteps = body.returnSteps ?? null;
  if ('reasoningModel' in body) patch.reasoningModel = body.reasoningModel ?? null;
  if ('reasoningPrompt' in body) patch.reasoningPrompt = body.reasoningPrompt ?? null;
  if ('resultMessage' in body) patch.resultMessage = body.resultMessage ?? null;
  if ('flowType' in body) patch.flowType = body.flowType ?? null;
  if ('dedupKeyField' in body) patch.dedupKeyField = body.dedupKeyField ?? null;
  if ('dedupBreakType' in body) patch.dedupBreakType = body.dedupBreakType ?? null;
  if ('dedupIntervalHours' in body) patch.dedupIntervalHours = body.dedupIntervalHours ?? null;
  if ('dedupBlockMessage' in body) patch.dedupBlockMessage = body.dedupBlockMessage ?? null;
  if ('readsFrom' in body) patch.readsFrom = body.readsFrom ?? null;
  if ('writesTo' in body) patch.writesTo = body.writesTo ?? null;
  if ('updatesFields' in body) patch.updatesFields = body.updatesFields ? JSON.stringify(body.updatesFields) : null;
  if ('requiresApproval' in body) patch.requiresApproval = body.requiresApproval ?? false;
  if ('infeasible' in body) patch.infeasible = body.infeasible ?? false;
  if ('infeasibleReason' in body) patch.infeasibleReason = body.infeasibleReason ?? null;
  if ('requiresHumanReview' in body) patch.requiresHumanReview = body.requiresHumanReview ?? false;
  if ('expectedOutput' in body) patch.expectedOutput = body.expectedOutput ?? null;
  patch.updatedAt = new Date().toISOString();

  const flow = await updateFlowById(flowId, patch as Parameters<typeof updateFlowById>[1]);
  log.info({ agentId, flowId }, 'Flow updated');
  return { flow };
}

export async function pinFlow(agentId: string, flowId: string, pinned: boolean): Promise<FlowRow | null> {
  const existing = await findFlowById(agentId, flowId);
  if (!existing) return null;
  return updateFlowById(flowId, { pinned, updatedAt: new Date().toISOString() });
}

export async function copyFlow(agentId: string, flowId: string): Promise<FlowRow | null> {
  const source = await findFlowById(agentId, flowId);
  if (!source) return null;

  // Find a name that doesn't collide — "Copy of X", then "Copy of X (2)", etc.
  let candidateName = `Copy of ${source.name}`;
  let suffix = 2;
  while (await findFlowByName(agentId, candidateName)) {
    candidateName = `Copy of ${source.name} (${suffix++})`;
  }

  const copy = await insertFlow({
    id: uuidv4(),
    agentId,
    name: candidateName,
    description: source.description,
    inputSchema: source.inputSchema,
    steps: source.steps,
    returnStepId: source.returnStepId,
    returnSteps: source.returnSteps,
    reasoningModel: source.reasoningModel,
    reasoningPrompt: source.reasoningPrompt,
    resultMessage: source.resultMessage,
    flowType: source.flowType,
    dedupKeyField: source.dedupKeyField,
    dedupBreakType: source.dedupBreakType,
    dedupIntervalHours: source.dedupIntervalHours,
    dedupBlockMessage: source.dedupBlockMessage,
    readsFrom: source.readsFrom,
    writesTo: source.writesTo,
    updatesFields: source.updatesFields,
    requiresApproval: source.requiresApproval,
    infeasible: false,
    infeasibleReason: null,
    requiresHumanReview: source.requiresHumanReview,
    expectedOutput: source.expectedOutput,
  });

  log.info({ agentId, sourceFlowId: flowId, copyFlowId: copy.id }, 'Flow copied');
  return copy;
}

export async function deleteFlow(agentId: string, flowId: string): Promise<boolean> {
  const existing = await findFlowById(agentId, flowId);
  if (!existing) return false;
  await deleteFlowById(flowId);
  log.info({ agentId, flowId }, 'Flow deleted');
  return true;
}

export async function markFlowInfeasible(
  agentId: string,
  flowId: string,
  infeasible: boolean,
  infeasibleReason: string | null | undefined,
): Promise<FlowRow | null> {
  const existing = await findFlowById(agentId, flowId);
  if (!existing) return null;
  return updateFlowById(flowId, {
    infeasible,
    infeasibleReason: infeasibleReason ?? null,
    updatedAt: new Date().toISOString(),
  });
}

export async function listFlowRuns(agentId: string, flowId: string | undefined, limit: number, flowType?: string) {
  const runs = await findFlowRuns(agentId, limit, flowType);
  if (flowId) return runs.filter((r) => r.flowId === flowId);
  return runs;
}

export const InlineTestBody = z.object({
  steps: z.array(FlowStepSchema),
  inputSchema: z.string().default('{}'),
  returnStepId: z.string().nullable().optional(),
  returnSteps: z.string().nullable().optional(),
  resultMessage: z.string().nullable().optional(),
  input: z.record(z.unknown()).default({}),
});

export async function testInlineFlow(
  agentId: string,
  body: z.infer<typeof InlineTestBody>,
) {
  const agent = await findAgentById(agentId);
  const apiKey = agent ? decrypt(agent.apiKeyEncrypted) ?? undefined : undefined;

  const inlineFlow = {
    id: 'inline',
    agentId,
    name: '__inline_test__',
    description: '',
    inputSchema: body.inputSchema,
    steps: JSON.stringify(body.steps),
    returnStepId: body.returnStepId ?? null,
    returnSteps: body.returnSteps ?? null,
    resultMessage: body.resultMessage ?? null,
  };

  return runFlowDetailed(inlineFlow, body.input, agentId, { apiKey });
}

export async function testSavedFlow(
  agentId: string,
  flowId: string,
  input: Record<string, unknown>,
) {
  const flow = await findFlowById(agentId, flowId);
  if (!flow) return null;

  const agent = await findAgentById(agentId);
  const apiKey = agent ? decrypt(agent.apiKeyEncrypted) ?? undefined : undefined;

  return runFlowDetailed(flow, input, agentId, { apiKey });
}
