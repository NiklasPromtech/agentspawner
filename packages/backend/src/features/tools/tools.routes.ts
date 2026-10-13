import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { tools } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { runTool } from '../../orchestrator/tool-runner.js';

const ToolBody = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.string().default('{"type":"object","properties":{},"required":[]}'),
  toolType: z.enum(['extension', 'web_search', 'web_fetch', 'local']).default('extension'),
  code: z.string().default(''),
});

export function registerToolRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/tools', async (req) => {
    return db.select().from(tools).where(eq(tools.agentId, req.params.agentId));
  });

  fastify.get<{ Params: { agentId: string; toolId: string } }>(
    '/agents/:agentId/tools/:toolId',
    async (req, reply) => {
      const [tool] = await db
        .select()
        .from(tools)
        .where(and(eq(tools.agentId, req.params.agentId), eq(tools.id, req.params.toolId)));
      if (!tool) return reply.status(404).send({ error: 'Not found' });
      return tool;
    },
  );

  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/tools', async (req, reply) => {
    const body = ToolBody.parse(req.body);
    const id = uuidv4();
    await db.insert(tools).values({ id, agentId: req.params.agentId, ...body });
    const [tool] = await db.select().from(tools).where(eq(tools.id, id));
    return reply.status(201).send(tool);
  });

  fastify.put<{ Params: { agentId: string; toolId: string } }>(
    '/agents/:agentId/tools/:toolId',
    async (req, reply) => {
      const [existing] = await db
        .select()
        .from(tools)
        .where(and(eq(tools.agentId, req.params.agentId), eq(tools.id, req.params.toolId)));
      if (!existing) return reply.status(404).send({ error: 'Not found' });

      const body = ToolBody.partial().parse(req.body);
      await db
        .update(tools)
        .set({ ...body, updatedAt: new Date().toISOString() })
        .where(eq(tools.id, req.params.toolId));
      const [tool] = await db.select().from(tools).where(eq(tools.id, req.params.toolId));
      return tool;
    },
  );

  // Test a tool directly — executes it with the provided input and returns the result
  fastify.post<{ Params: { agentId: string; toolId: string } }>(
    '/agents/:agentId/tools/:toolId/test',
    async (req, reply) => {
      const [tool] = await db
        .select()
        .from(tools)
        .where(and(eq(tools.agentId, req.params.agentId), eq(tools.id, req.params.toolId)));
      if (!tool) return reply.status(404).send({ error: 'Not found' });

      const input = (req.body as { input?: Record<string, unknown> })?.input ?? {};
      const started = Date.now();

      try {
        const result = await runTool(tool, input, req.params.agentId);
        return { ok: true, result, durationMs: Date.now() - started };
      } catch (err) {
        return reply.status(200).send({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - started,
        });
      }
    },
  );

  fastify.delete<{ Params: { agentId: string; toolId: string } }>(
    '/agents/:agentId/tools/:toolId',
    async (req, reply) => {
      const [existing] = await db
        .select()
        .from(tools)
        .where(and(eq(tools.agentId, req.params.agentId), eq(tools.id, req.params.toolId)));
      if (!existing) return reply.status(404).send({ error: 'Not found' });
      await db.delete(tools).where(eq(tools.id, req.params.toolId));
      return { success: true };
    },
  );
}
