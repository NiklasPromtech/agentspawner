/**
 * agents.routes.ts
 * Thin Fastify route handler for the agents feature.
 * Delegates all work to agents.service.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listAgents,
  getAgent,
  createAgent,
  updateAgentById,
  removeAgent,
} from './agents.service.js';
import { findAgentById } from './agents.repository.js';
import { parseAndSyncProfileBlob } from '../../agents/ui/setup-agent.js';
import { decrypt } from '../../crypto/index.js';

const AgentBody = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().optional().default(''),
  model: z.string().optional().default('claude-sonnet-4-6'),
  apiKey: z.string().optional().default(''),
  telegramKey: z.string().optional().default(''),
  telegramChatId: z.string().optional().default(''),
  // Copy the encrypted API key from an existing agent (never exposes the raw key)
  copyKeyFromAgentId: z.string().optional(),
});

export function registerAgentRoutes(fastify: FastifyInstance): void {
  fastify.get('/agents', async () => {
    return listAgents();
  });

  fastify.get<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
    const agent = await getAgent(req.params.id);
    if (!agent) return reply.status(404).send({ error: 'Not found' });
    return agent;
  });

  fastify.post('/agents', async (req, reply) => {
    const body = AgentBody.parse(req.body);
    const agent = await createAgent(body);
    return reply.status(201).send(agent);
  });

  fastify.put<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
    const body = AgentBody.partial().parse(req.body);

    // Capture old systemPrompt before update — only fetch if systemPrompt is being changed
    const existing = body.systemPrompt !== undefined ? await getAgent(req.params.id) : null;

    const agent = await updateAgentById(req.params.id, body);
    if (!agent) return reply.status(404).send({ error: 'Not found' });

    // Fire-and-forget profileBlob re-sync whenever systemPrompt actually changed
    if (
      body.systemPrompt !== undefined &&
      body.systemPrompt !== existing?.systemPrompt &&
      body.systemPrompt.trim()
    ) {
      // We need the raw (encrypted) API key — the public agent strips it, so fetch the raw row
      findAgentById(req.params.id).then((raw) => {
        if (!raw) return;
        const apiKey = decrypt(raw.apiKeyEncrypted);
        if (!apiKey) return;
        parseAndSyncProfileBlob(req.params.id, body.systemPrompt as string, apiKey).catch(() => {});
      }).catch(() => {});
    }

    return agent;
  });

  // PATCH — partial update; currently supports profileBlob
  const AgentPatchBody = z.object({
    profileBlob: z.string().nullable().optional(),
  });

  fastify.patch<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
    const body = AgentPatchBody.parse(req.body);
    const agent = await updateAgentById(req.params.id, body);
    if (!agent) return reply.status(404).send({ error: 'Not found' });
    return agent;
  });

  fastify.delete<{ Params: { id: string } }>('/agents/:id', async (req, reply) => {
    const found = await removeAgent(req.params.id);
    if (!found) return reply.status(404).send({ error: 'Not found' });
    return { success: true };
  });
}
