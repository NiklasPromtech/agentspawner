import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { runs } from '../db/schema.js';
import { inArray, count } from 'drizzle-orm';
import { isExtensionConnected } from '../websocket/server.js';

export function registerHealthRoute(fastify: FastifyInstance): void {
  fastify.get('/health', async (_req, reply) => {
    let dbStatus: 'ok' | 'error' = 'ok';
    let runningRuns = 0;

    try {
      const db = getDb();
      const [row] = await db
        .select({ count: count() })
        .from(runs)
        .where(inArray(runs.status, ['running', 'pending']));
      runningRuns = row?.count ?? 0;
    } catch {
      dbStatus = 'error';
    }

    const extensionConnected = isExtensionConnected();
    const status = dbStatus === 'ok' ? 'ok' : 'degraded';

    return reply.status(status === 'ok' ? 200 : 503).send({
      status,
      db: dbStatus,
      extension: extensionConnected,
      runningRuns,
    });
  });
}
