import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { memory } from '../../db/schema.js';
import { eq, like, desc } from 'drizzle-orm';

export function registerMemoryRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  // GET /memory/search?q=<string>&limit=50
  fastify.get<{ Querystring: { q?: string; limit?: string } }>('/memory/search', async (req) => {
    const q = req.query.q ?? '';
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10) || 50, 200);
    if (!q) {
      return db.select().from(memory).orderBy(desc(memory.createdAt)).limit(limit);
    }
    return db
      .select()
      .from(memory)
      .where(like(memory.entities, `%${q}%`))
      .orderBy(desc(memory.createdAt))
      .limit(limit);
  });

  // GET /memory/recent?limit=100
  fastify.get<{ Querystring: { limit?: string } }>('/memory/recent', async (req) => {
    const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, 500);
    return db.select().from(memory).orderBy(desc(memory.createdAt)).limit(limit);
  });

  // DELETE /memory/:id
  fastify.delete<{ Params: { id: string } }>('/memory/:id', async (req) => {
    await db.delete(memory).where(eq(memory.id, req.params.id));
    return { success: true };
  });

  // DELETE /memory/agent/:agentId — delete all entries for one agent
  fastify.delete<{ Params: { agentId: string } }>('/memory/agent/:agentId', async (req) => {
    const result = await db
      .delete(memory)
      .where(eq(memory.sourceAgentId, req.params.agentId));
    return { deleted: (result as unknown as { changes: number }).changes ?? 0 };
  });
}
