import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { contacts } from '../../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const ContactBody = z.object({
  platform: z.string().min(1),
  handle: z.string().min(1),
  displayName: z.string().nullable().optional(),
  notes: z.string().optional(),
  status: z.enum(['prospect', 'contacted', 'replied', 'converted', 'do_not_contact']).optional(),
  lastAction: z.string().nullable().optional(),
  lastActionAt: z.string().nullable().optional(),
  lastActionInput: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export function registerContactsRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  // GET /agents/:agentId/contacts
  // Optional: ?platform=twitter&status=contacted&limit=100
  fastify.get<{
    Params: { agentId: string };
    Querystring: { platform?: string; status?: string; handle?: string; limit?: string };
  }>('/agents/:agentId/contacts', async (req) => {
    const { agentId } = req.params;
    const limit = Math.min(parseInt(req.query.limit ?? '100', 10) || 100, 500);

    let rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.agentId, agentId))
      .orderBy(desc(contacts.updatedAt))
      .limit(limit);

    if (req.query.platform) rows = rows.filter((r) => r.platform === req.query.platform);
    if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
    if (req.query.handle) rows = rows.filter((r) => r.handle.toLowerCase().includes(req.query.handle!.toLowerCase()));

    return rows;
  });

  // GET /agents/:agentId/contacts/:contactId
  fastify.get<{ Params: { agentId: string; contactId: string } }>(
    '/agents/:agentId/contacts/:contactId',
    async (req, reply) => {
      const [contact] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, req.params.contactId), eq(contacts.agentId, req.params.agentId)));
      if (!contact) return reply.status(404).send({ error: 'Not found' });
      return contact;
    },
  );

  // POST /agents/:agentId/contacts
  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/contacts', async (req, reply) => {
    const body = ContactBody.parse(req.body);
    const { agentId } = req.params;

    // Upsert by (agentId, platform, handle) — avoid duplicates
    const [existing] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.agentId, agentId), eq(contacts.platform, body.platform), eq(contacts.handle, body.handle)));

    if (existing) {
      // Update existing contact
      await db
        .update(contacts)
        .set({
          displayName: body.displayName ?? existing.displayName,
          notes: body.notes ?? existing.notes,
          status: body.status ?? existing.status,
          ...(body.lastAction !== undefined && { lastAction: body.lastAction }),
          ...(body.lastActionAt !== undefined && { lastActionAt: body.lastActionAt }),
          ...(body.lastActionInput !== undefined && { lastActionInput: JSON.stringify(body.lastActionInput) }),
          ...(body.metadata !== undefined && { metadata: JSON.stringify(body.metadata) }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(contacts.id, existing.id));
      const [updated] = await db.select().from(contacts).where(eq(contacts.id, existing.id));
      return reply.status(200).send(updated);
    }

    const id = uuidv4();
    await db.insert(contacts).values({
      id,
      agentId,
      platform: body.platform,
      handle: body.handle,
      displayName: body.displayName ?? null,
      notes: body.notes ?? '',
      status: body.status ?? 'prospect',
      lastAction: body.lastAction ?? null,
      lastActionAt: body.lastActionAt ?? null,
      lastActionInput: JSON.stringify(body.lastActionInput ?? {}),
      metadata: JSON.stringify(body.metadata ?? {}),
    });

    const [contact] = await db.select().from(contacts).where(eq(contacts.id, id));
    return reply.status(201).send(contact);
  });

  // PATCH /agents/:agentId/contacts/:contactId
  fastify.patch<{ Params: { agentId: string; contactId: string } }>(
    '/agents/:agentId/contacts/:contactId',
    async (req, reply) => {
      const body = ContactBody.partial().parse(req.body);
      const [existing] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, req.params.contactId), eq(contacts.agentId, req.params.agentId)));
      if (!existing) return reply.status(404).send({ error: 'Not found' });

      await db
        .update(contacts)
        .set({
          ...(body.displayName !== undefined && { displayName: body.displayName }),
          ...(body.notes !== undefined && { notes: body.notes }),
          ...(body.status !== undefined && { status: body.status }),
          ...(body.lastAction !== undefined && { lastAction: body.lastAction }),
          ...(body.lastActionAt !== undefined && { lastActionAt: body.lastActionAt }),
          ...(body.lastActionInput !== undefined && { lastActionInput: JSON.stringify(body.lastActionInput) }),
          ...(body.metadata !== undefined && { metadata: JSON.stringify(body.metadata) }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(contacts.id, req.params.contactId));

      const [updated] = await db.select().from(contacts).where(eq(contacts.id, req.params.contactId));
      return updated;
    },
  );

  // DELETE /agents/:agentId/contacts/:contactId
  fastify.delete<{ Params: { agentId: string; contactId: string } }>(
    '/agents/:agentId/contacts/:contactId',
    async (req) => {
      await db.delete(contacts).where(
        and(eq(contacts.id, req.params.contactId), eq(contacts.agentId, req.params.agentId)),
      );
      return { success: true };
    },
  );
}
