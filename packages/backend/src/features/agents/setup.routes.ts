/**
 * Setup Routes
 *
 * Thin HTTP adapters for the setup agents. Each handler:
 *   1. Parses and validates the request body
 *   2. Resolves the API key (from raw input or from an existing agent in the DB)
 *   3. Calls the appropriate agent function from agents/setup-agent.ts
 *   4. Serialises the result into a response
 *
 * All agent logic (system prompts, LLM calls, response parsing) lives in
 * agents/setup-agent.ts — not here.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { agents, tools } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';
import {
  runSetupAgent,
  parseAndSyncProfileBlob,
  runConverseAgent,
  runPlanFlowsAgent,
  runAmendAgent,
  runRetrospectiveAgent,
} from '../../agents/ui/setup-agent.js';

// ── Body schemas ──────────────────────────────────────────────────────────────

const ConverseBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  apiKey: z.string().optional(),
  agentId: z.string().optional(),
}).refine((d) => d.apiKey || d.agentId, {
  message: 'Either apiKey or agentId must be provided',
});

const PlanFlowsBriefFlow = z.object({
  name: z.string(),
  type: z.enum(['scrape', 'action']),
  description: z.string(),
  purpose: z.string(),
});

const PlanFlowsBody = z.object({
  systemPrompt: z.string().min(1),
  description: z.string().default(''),
  apiKey: z.string().optional(),
  agentId: z.string().optional(),
  brief_flows: z.array(PlanFlowsBriefFlow).optional(),
  feedback: z.string().optional(),
}).refine((d) => d.apiKey || d.agentId, {
  message: 'Either apiKey or agentId must be provided',
});

const FetchCompanyBody = z.object({
  url: z.string().transform((val) => {
    const trimmed = val.trim();
    if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
    return trimmed;
  }).pipe(z.string().url()),
});

const GenerateBody = z.object({
  roleTitle: z.string().min(1),
  companyContext: z.string(),
  jobDescription: z.string().min(1),
});

const AmendBody = z.object({
  currentPrompt: z.string(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
});

const RetrospectiveBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  failedFlowName: z.string(),
  failedFlowReason: z.string(),
  currentSystemPrompt: z.string(),
  currentGoals: z.array(z.object({
    title: z.string(),
    type: z.string(),
    description: z.string(),
  })).optional().default([]),
});

// ── Helper: resolve API key ───────────────────────────────────────────────────

async function resolveApiKey(
  rawKey: string | undefined,
  agentId: string | undefined,
): Promise<{ apiKey: string } | { error: string; status: number }> {
  if (rawKey) return { apiKey: rawKey };
  if (agentId) {
    const db = getDb();
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return { error: 'Agent not found', status: 404 };
    const key = decrypt(agent.apiKeyEncrypted);
    if (!key) return { error: 'That agent has no API key configured', status: 400 };
    return { apiKey: key };
  }
  return { error: 'No API key available', status: 400 };
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerSetupRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  // ── Conversational onboarding ────────────────────────────────────────────────
  fastify.post('/setup/converse', async (req, reply) => {
    req.raw.setTimeout(60_000);
    const body = ConverseBody.parse(req.body);

    const resolved = await resolveApiKey(body.apiKey, body.agentId);
    if ('error' in resolved) return reply.status(resolved.status).send({ error: resolved.error });

    const result = await runConverseAgent({ apiKey: resolved.apiKey, messages: body.messages });
    return reply.send(result);
  });

  // ── Fetch & summarise a company URL ─────────────────────────────────────────
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/setup/fetch-company',
    async (req, reply) => {
      const body = FetchCompanyBody.parse(req.body);
      const { agentId } = req.params;

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });

      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

      // Fetch the URL with a 10s timeout
      let pageText = '';
      try {
        const fetchPromise = fetch(body.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentSpawner/1.0)' },
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Fetch timeout')), 10_000),
        );
        const res = await Promise.race([fetchPromise, timeoutPromise]);
        const html = await res.text();
        pageText = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000);
      } catch (err) {
        return reply.send({ summary: `Could not fetch ${body.url}: ${err instanceof Error ? err.message : String(err)}` });
      }

      // Summarise with Haiku — this is a lightweight utility call, not a full agent
      try {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const anthropic = new Anthropic({ apiKey });
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: `Summarize this company/website in 2-3 sentences. Return JSON only: {"name": "...", "summary": "..."}\n\nPage content:\n${pageText}`,
          }],
        });
        const text = response.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { type: 'text'; text: string }).text)
          .join('');
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { name?: string; summary?: string };
          return reply.send({ summary: parsed.summary ?? text, name: parsed.name });
        }
        return reply.send({ summary: text });
      } catch (err) {
        return reply.send({ summary: `Fetched page but could not summarize: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  );

  // ── Amend — iterative chat-based system prompt editing ──────────────────────
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/setup/amend',
    async (req, reply) => {
      req.raw.setTimeout(30_000);
      const body = AmendBody.parse(req.body);
      const { agentId } = req.params;

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });
      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

      try {
        const result = await runAmendAgent({ apiKey, currentPrompt: body.currentPrompt, messages: body.messages });
        return reply.send(result);
      } catch (err) {
        return reply.status(500).send({ error: 'AI did not return valid JSON' });
      }
    },
  );

  // ── Generate — role+job → system prompt + recommendations ───────────────────
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/setup/generate',
    async (req, reply) => {
      req.raw.setTimeout(60_000);
      const body = GenerateBody.parse(req.body);
      const { agentId } = req.params;

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });
      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

      const agentTools = await db.select().from(tools).where(eq(tools.agentId, agentId));
      const installedToolNames = agentTools.map((t) => t.name).join(', ') || 'none';

      try {
        const result = await runSetupAgent({
          apiKey,
          agentModel: agent.model,
          roleTitle: body.roleTitle,
          companyContext: body.companyContext,
          jobDescription: body.jobDescription,
          installedToolNames,
        });

        await db.update(agents)
          .set({
            profileBlob: JSON.stringify(result.profileBlob),
            profileBlobUpdatedAt: new Date().toISOString(),
          })
          .where(eq(agents.id, agentId));

        return reply.send(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: msg });
      }
    },
  );

  // ── Parse existing prompt → profileBlob ─────────────────────────────────────
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/setup/parse-prompt',
    async (req, reply) => {
      req.raw.setTimeout(30_000);
      const { agentId } = req.params;

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });
      if (!agent.systemPrompt?.trim()) return reply.status(400).send({ error: 'Agent has no system prompt to parse' });

      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

      await parseAndSyncProfileBlob(agentId, agent.systemPrompt, apiKey);

      const [updated] = await db.select().from(agents).where(eq(agents.id, agentId));
      const profileBlob = updated?.profileBlob ? JSON.parse(updated.profileBlob) : null;
      return reply.send({ agent: updated, profileBlob });
    },
  );

  // ── Plan flows — propose atomic flow set ────────────────────────────────────
  fastify.post('/setup/plan-flows', async (req, reply) => {
    req.raw.setTimeout(30_000);
    const body = PlanFlowsBody.parse(req.body);

    const resolved = await resolveApiKey(body.apiKey, body.agentId);
    if ('error' in resolved) return reply.status(resolved.status).send({ error: resolved.error });

    try {
      const result = await runPlanFlowsAgent({
        apiKey: resolved.apiKey,
        systemPrompt: body.systemPrompt,
        description: body.description,
        briefFlows: body.brief_flows,
        feedback: body.feedback,
      });
      return reply.send(result);
    } catch (err) {
      return reply.status(500).send({ error: 'AI did not return valid JSON' });
    }
  });

  // ── Retrospective — adjust scope after a flow turns out to be infeasible ────
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/setup/retrospective',
    async (req, reply) => {
      req.raw.setTimeout(60_000);
      const body = RetrospectiveBody.parse(req.body);
      const { agentId } = req.params;

      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });
      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

      const result = await runRetrospectiveAgent({
        apiKey,
        failedFlowName: body.failedFlowName,
        failedFlowReason: body.failedFlowReason,
        currentSystemPrompt: body.currentSystemPrompt,
        currentGoals: body.currentGoals,
        messages: body.messages,
      });

      return reply.send(result);
    },
  );
}
