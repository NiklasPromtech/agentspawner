import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { messages } from '../../db/schema.js';
import { eq } from 'drizzle-orm';

export function registerMessageRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  fastify.get<{ Params: { runId: string } }>('/runs/:runId/messages', async (req, reply) => {
    return db.select().from(messages).where(eq(messages.runId, req.params.runId));
  });
}
