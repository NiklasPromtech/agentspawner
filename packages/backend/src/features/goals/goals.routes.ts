import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { goals } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export function registerGoalsRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  // List all goals for an agent
  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/goals', async (req) => {
    return db
      .select()
      .from(goals)
      .where(eq(goals.agentId, req.params.agentId))
      .orderBy(desc(goals.priority), desc(goals.createdAt));
  });

  // Create a goal
  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/goals', async (req, reply) => {
    const body = req.body as {
      type?: string;
      parentId?: string;
      title: string;
      description?: string;
      priority?: number;
      dueDate?: string;
    };

    const id = uuidv4();
    await db.insert(goals).values({
      id,
      agentId: req.params.agentId,
      parentId: body.parentId ?? null,
      type: body.type ?? 'task',
      title: body.title,
      description: body.description ?? '',
      status: 'pending',
      priority: body.priority ?? 3,
      dueDate: body.dueDate ?? null,
    });

    const [goal] = await db.select().from(goals).where(eq(goals.id, id));
    return reply.status(201).send(goal);
  });

  // Update a goal
  fastify.patch<{ Params: { agentId: string; goalId: string } }>(
    '/agents/:agentId/goals/:goalId',
    async (req, reply) => {
      const body = req.body as Partial<{
        title: string;
        description: string;
        status: string;
        priority: number;
        dueDate: string | null;
        notes: string;
        parentId: string | null;
      }>;

      const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      if (body.title !== undefined) patch.title = body.title;
      if (body.description !== undefined) patch.description = body.description;
      if (body.status !== undefined) {
        patch.status = body.status;
        if (body.status === 'completed') patch.completedAt = new Date().toISOString();
      }
      if (body.priority !== undefined) patch.priority = body.priority;
      if (body.dueDate !== undefined) patch.dueDate = body.dueDate;
      if (body.notes !== undefined) patch.notes = body.notes;
      if (body.parentId !== undefined) patch.parentId = body.parentId;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      await db.update(goals).set(patch as any).where(
        and(eq(goals.id, req.params.goalId), eq(goals.agentId, req.params.agentId)),
      );

      const [updated] = await db.select().from(goals).where(eq(goals.id, req.params.goalId));
      if (!updated) return reply.status(404).send({ error: 'Not found' });
      return updated;
    },
  );

  // Delete a goal (and its children will cascade if they reference this goal via parent_id)
  fastify.delete<{ Params: { agentId: string; goalId: string } }>(
    '/agents/:agentId/goals/:goalId',
    async (req) => {
      await db.delete(goals).where(
        and(eq(goals.id, req.params.goalId), eq(goals.agentId, req.params.agentId)),
      );
      return { success: true };
    },
  );
}
