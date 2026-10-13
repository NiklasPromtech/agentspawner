import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { toneEdits, agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { refreshToneGuide } from '../../lib/tone.js';

/**
 * TONE GUIDE ROUTES
 *
 * The legacy `pendingHumanReviews` table and its read/resolve routes have been
 * removed (OPERATION CONVERGENCE Task 4.5). New approval happens via the
 * `actionLog` table + the Review Actions tab.
 *
 * What remains here: tone guide display, editing, and auto-refresh — these are
 * still functional and backed by the `toneEdits` table (which is live).
 */
export function registerReviewRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  // POST /agents/:agentId/reviews/tone/refresh — manually trigger tone guide refresh
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/reviews/tone/refresh',
    async (req, reply) => {
      const { agentId } = req.params;
      const edits = await db.select().from(toneEdits).where(eq(toneEdits.agentId, agentId));
      if (edits.length < 3) return reply.status(400).send({ error: 'Need at least 3 edits to generate a tone guide' });
      await refreshToneGuide(agentId, edits.map(e => ({ draft: e.agentDraft, final: e.humanFinal })));
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      // Surface success or failure: if toneRefreshError was set during the refresh, pass it back
      if (agent?.toneRefreshError) {
        return reply.status(500).send({
          error: agent.toneRefreshError,
          errorAt: agent.toneRefreshErrorAt,
        });
      }
      return {
        toneGuide: agent?.toneGuide ? JSON.parse(agent.toneGuide) as string[] : [],
        toneGuideUpdatedAt: agent?.toneGuideUpdatedAt ?? null,
        editCount: edits.length,
        lastError: null,
        lastErrorAt: null,
      };
    }
  );

  // GET /agents/:agentId/reviews/tone — get current tone guide + edit count + refresh status
  fastify.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/reviews/tone',
    async (req, reply) => {
      const { agentId } = req.params;
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });
      const editRows = await db.select().from(toneEdits).where(eq(toneEdits.agentId, agentId));
      return {
        toneGuide: agent.toneGuide ? JSON.parse(agent.toneGuide) as string[] : [],
        toneGuideUpdatedAt: agent.toneGuideUpdatedAt ?? null,
        editCount: editRows.length,
        lastError: agent.toneRefreshError ?? null,
        lastErrorAt: agent.toneRefreshErrorAt ?? null,
      };
    }
  );

  // PATCH /agents/:agentId/reviews/tone — manually update tone guide bullets
  fastify.patch<{ Params: { agentId: string } }>(
    '/agents/:agentId/reviews/tone',
    async (req, reply) => {
      const body = z.object({ toneGuide: z.array(z.string()) }).parse(req.body);
      const { agentId } = req.params;
      await db.update(agents)
        .set({ toneGuide: JSON.stringify(body.toneGuide), toneGuideUpdatedAt: new Date().toISOString() })
        .where(eq(agents.id, agentId));
      return { toneGuide: body.toneGuide };
    }
  );

}
