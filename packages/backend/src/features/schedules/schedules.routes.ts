import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { schedules } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { reloadSchedules } from '../../scheduler/index.js';

const ScheduleBody = z.object({
  cron: z.string().min(1),
  input: z.string().default(''),
  enabled: z.boolean().default(true),
  timezone: z.string().default('Europe/Stockholm'),
  flowId: z.string().nullable().optional(),
});

export function registerScheduleRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/schedules', async (req) => {
    return db.select().from(schedules).where(eq(schedules.agentId, req.params.agentId));
  });

  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/schedules',
    async (req, reply) => {
      const body = ScheduleBody.parse(req.body);
      const id = uuidv4();
      await db.insert(schedules).values({ id, agentId: req.params.agentId, ...body });
      await reloadSchedules();
      const [schedule] = await db.select().from(schedules).where(eq(schedules.id, id));
      return reply.status(201).send(schedule);
    },
  );

  fastify.put<{ Params: { agentId: string; scheduleId: string } }>(
    '/agents/:agentId/schedules/:scheduleId',
    async (req, reply) => {
      const [existing] = await db
        .select()
        .from(schedules)
        .where(eq(schedules.id, req.params.scheduleId));
      if (!existing) return reply.status(404).send({ error: 'Not found' });

      const body = ScheduleBody.partial().parse(req.body);
      await db
        .update(schedules)
        .set({ ...body, updatedAt: new Date().toISOString() })
        .where(eq(schedules.id, req.params.scheduleId));
      await reloadSchedules();
      const [schedule] = await db
        .select()
        .from(schedules)
        .where(eq(schedules.id, req.params.scheduleId));
      return schedule;
    },
  );

  fastify.delete<{ Params: { agentId: string; scheduleId: string } }>(
    '/agents/:agentId/schedules/:scheduleId',
    async (req) => {
      await db.delete(schedules).where(eq(schedules.id, req.params.scheduleId));
      await reloadSchedules();
      return { success: true };
    },
  );
}
