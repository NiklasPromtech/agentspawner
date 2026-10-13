/**
 * flows.routes.ts
 * Thin Fastify route handler for the flows feature.
 * Delegates all work to flows.service.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FlowBody,
  InlineTestBody,
  copyFlow,
  createFlow,
  deleteFlow,
  getFlow,
  listFlowRuns,
  listFlows,
  markFlowInfeasible,
  pinFlow,
  testInlineFlow,
  testSavedFlow,
  updateFlow,
} from './flows.service.js';
import { findFlowByIdOnly, findAgentById, findToolByName } from './flows.repository.js';
import { runSingleStep, type InputExpression, type FlowStep } from './flow-runner.js';
import { decrypt } from '../../crypto/index.js';

export function registerFlowRoutes(fastify: FastifyInstance): void {
  // GET /agents/:agentId/flows
  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/flows', async (req) => {
    return listFlows(req.params.agentId);
  });

  // GET /agents/:agentId/flows/:flowId
  fastify.get<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId',
    async (req, reply) => {
      const flow = await getFlow(req.params.agentId, req.params.flowId);
      if (!flow) return reply.status(404).send({ error: 'Not found' });
      return flow;
    },
  );

  // POST /agents/:agentId/flows
  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/flows', async (req, reply) => {
    const parsed = FlowBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation error',
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    const result = await createFlow(req.params.agentId, parsed.data);
    if ('error' in result) return reply.status(result.error.status).send(result.error.body);
    return reply.status(201).send(result.flow);
  });

  // PUT /agents/:agentId/flows/:flowId
  fastify.put<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId',
    async (req, reply) => {
      const existing = await getFlow(req.params.agentId, req.params.flowId);
      if (!existing) return reply.status(404).send({ error: 'Not found' });

      const parsedBody = FlowBody.partial().safeParse(req.body);
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'Validation error',
          details: parsedBody.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }

      const result = await updateFlow(req.params.agentId, req.params.flowId, parsedBody.data);
      if ('error' in result) return reply.status(result.error.status).send(result.error.body);
      return result.flow;
    },
  );

  // PATCH /agents/:agentId/flows/:flowId  (steps-only partial update — used by the Flow Debugger extension)
  fastify.patch<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId',
    async (req, reply) => {
      const existing = await getFlow(req.params.agentId, req.params.flowId);
      if (!existing) return reply.status(404).send({ error: 'Not found' });

      // Pre-process steps: resolve toolName → toolId for inserted steps that don't have a toolId yet.
      // This mirrors the same sentinel/DB lookup logic used in the run-step handler.
      const PATCH_BUILTIN_SENTINELS: Record<string, string> = {
        screenshot: '__screenshot__',
        __transform__: '__transform__',
        query_action_log: '__query_action_log__',
        query_memory: '__query_memory__',
        query_database: '__query_database__',
      };
      const rawBody = req.body as Record<string, unknown>;
      if (Array.isArray(rawBody.steps)) {
        rawBody.steps = await Promise.all(
          (rawBody.steps as Array<Record<string, unknown>>).map(async (step) => {
            if (step.toolId || !step.toolName) return step;
            const toolId =
              PATCH_BUILTIN_SENTINELS[step.toolName as string] ??
              (await findToolByName(req.params.agentId, step.toolName as string))?.id ??
              undefined;
            return toolId ? { ...step, toolId } : step;
          }),
        );
      }

      const parsedBody = FlowBody.partial().safeParse(rawBody);
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: 'Validation error',
          details: parsedBody.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }

      const result = await updateFlow(req.params.agentId, req.params.flowId, parsedBody.data);
      if ('error' in result) return reply.status(result.error.status).send(result.error.body);
      return result.flow;
    },
  );

  // PATCH /agents/:agentId/flows/:flowId/pin
  fastify.patch<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId/pin',
    async (req, reply) => {
      const body = req.body as { pinned: boolean };
      const updated = await pinFlow(req.params.agentId, req.params.flowId, body.pinned);
      if (!updated) return reply.status(404).send({ error: 'Not found' });
      return updated;
    },
  );

  // POST /agents/:agentId/flows/:flowId/copy
  fastify.post<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId/copy',
    async (req, reply) => {
      const copy = await copyFlow(req.params.agentId, req.params.flowId);
      if (!copy) return reply.status(404).send({ error: 'Not found' });
      return copy;
    },
  );

  // DELETE /agents/:agentId/flows/:flowId
  fastify.delete<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId',
    async (req, reply) => {
      const deleted = await deleteFlow(req.params.agentId, req.params.flowId);
      if (!deleted) return reply.status(404).send({ error: 'Not found' });
      return { success: true };
    },
  );

  // POST /agents/:agentId/flows/test  (inline — no saved flow required)
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/flows/test',
    async (req) => {
      const body = InlineTestBody.parse(req.body);
      return testInlineFlow(req.params.agentId, body);
    },
  );

  // POST /agents/:agentId/flows/:flowId/test
  fastify.post<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId/test',
    async (req, reply) => {
      const body = z.object({ input: z.record(z.unknown()).default({}) }).parse(req.body);
      const result = await testSavedFlow(req.params.agentId, req.params.flowId, body.input);
      if (!result) return reply.status(404).send({ error: 'Not found' });
      return result;
    },
  );

  // GET /agents/:agentId/flow-runs
  fastify.get<{ Params: { agentId: string }; Querystring: { flow_id?: string; limit?: string; flowType?: string } }>(
    '/agents/:agentId/flow-runs',
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200);
      return listFlowRuns(req.params.agentId, req.query.flow_id, limit, req.query.flowType);
    },
  );

  // POST /agents/:agentId/flows/:flowId/run
  // Execute a saved flow with the given input. Writes a flowRuns entry.
  fastify.post<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId/run',
    async (req, reply) => {
      const body = z.object({ input: z.record(z.unknown()).default({}) }).parse(req.body);
      const result = await testSavedFlow(req.params.agentId, req.params.flowId, body.input);
      if (!result) return reply.status(404).send({ error: 'Not found' });
      return result;
    },
  );

  // PATCH /agents/:agentId/flows/:flowId/infeasible
  fastify.patch<{ Params: { agentId: string; flowId: string } }>(
    '/agents/:agentId/flows/:flowId/infeasible',
    async (req, reply) => {
      const body = z.object({
        infeasible: z.boolean(),
        infeasibleReason: z.string().nullable().optional(),
      }).parse(req.body);

      const updated = await markFlowInfeasible(
        req.params.agentId,
        req.params.flowId,
        body.infeasible,
        body.infeasibleReason,
      );
      if (!updated) return reply.status(404).send({ error: 'Flow not found' });
      return updated;
    },
  );

  // ── Extension / Flow Step Debugger routes ─────────────────────────────────
  // These routes use only the flowId (no agentId in path) so the Chrome
  // extension can call them without knowing which agent owns the flow.

  // GET /flows/:flowId
  // Load a flow definition by ID — used by the extension's "Load Flow" button.
  // Returns steps and inputSchema as parsed JSON (not raw strings) so the
  // extension can do Array.isArray(flow.steps) and JSON.parse(flow.inputSchema)
  // without an extra parse step.
  fastify.get<{ Params: { flowId: string } }>('/flows/:flowId', async (req, reply) => {
    const flow = await findFlowByIdOnly(req.params.flowId);
    if (!flow) return reply.status(404).send({ error: 'Flow not found' });
    return {
      ...flow,
      steps: JSON.parse(flow.steps ?? '[]'),
      inputSchema: flow.inputSchema,  // keep as string — extension calls JSON.parse on it
    };
  });

  // POST /flows/:flowId/run-step
  // Execute exactly one step of a flow for the step-by-step debugger.
  // Does NOT write a flow_runs row — this is a debug/test tool only.
  fastify.post<{ Params: { flowId: string } }>(
    '/flows/:flowId/run-step',
    async (req, reply) => {
      const body = z.object({
        stepId: z.string().min(1),
        flowInput: z.record(z.unknown()).default({}),
        priorStepResults: z.record(z.unknown()).default({}),
        // Optional override sent by the step debugger when re-running an edited step
        inputMappingOverride: z.record(z.unknown()).optional(),
        // Optional full step definition for newly inserted steps not yet saved to DB
        stepDef: z.object({
          id: z.string(),
          label: z.string().optional(),
          toolName: z.string().optional(),
          toolId: z.string().optional(),
          inputMapping: z.record(z.unknown()).optional(),
        }).optional(),
      }).parse(req.body);

      const flow = await findFlowByIdOnly(req.params.flowId);
      if (!flow) return reply.status(404).send({ error: 'Flow not found' });

      // Resolve the API key so __evaluate__ steps work
      const agent = await findAgentById(flow.agentId);
      const apiKey = agent?.apiKeyEncrypted ? decrypt(agent.apiKeyEncrypted) ?? undefined : undefined;

      // If a full stepDef is provided (new step not yet saved to DB), resolve its toolId
      let resolvedStepDef: FlowStep | undefined;
      if (body.stepDef) {
        const BUILTIN_SENTINELS: Record<string, string> = {
          screenshot: '__screenshot__',
          __transform__: '__transform__',
          query_action_log: '__query_action_log__',
          query_memory: '__query_memory__',
          query_database: '__query_database__',
        };
        let toolId = body.stepDef.toolId;
        if (!toolId && body.stepDef.toolName) {
          toolId = BUILTIN_SENTINELS[body.stepDef.toolName]
            ?? (await findToolByName(flow.agentId, body.stepDef.toolName))?.id
            ?? undefined;
        }
        resolvedStepDef = {
          ...body.stepDef,
          toolId,
          inputMapping: body.stepDef.inputMapping as Record<string, InputExpression> | undefined,
        } as FlowStep;
      }

      const result = await runSingleStep(
        flow,
        body.stepId,
        body.flowInput,
        body.priorStepResults,
        apiKey,
        body.inputMappingOverride as Record<string, InputExpression> | undefined,
        resolvedStepDef,
      );
      return result;
    },
  );
}
