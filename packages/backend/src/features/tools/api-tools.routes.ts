import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { agents, apiTools, agentSecrets } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { encrypt, decrypt } from '../../crypto/index.js';
import { runApiToolThrottled } from '../../orchestrator/api-tool-runner-throttled.js';

const ApiToolBody = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'Name must be snake_case'),
  description: z.string().min(1),
  inputSchema: z.string().default('{"type":"object","properties":{},"required":[]}'),
  type: z.enum(['script', 'http']).default('script'),
  config: z.string().default('{}'), // JSON string
  enabled: z.boolean().default(true),
});

const SecretBody = z.object({
  key: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/, 'Key must be UPPER_SNAKE_CASE'),
  value: z.string().min(1),
  requestsPerMinute: z.number().int().positive().nullable().optional(),
});

export function registerApiToolRoutes(fastify: FastifyInstance): void {
  const db = getDb();

  // ── API Tools CRUD ────────────────────────────────────────────────────────

  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/api-tools', async (req) => {
    return db.select().from(apiTools).where(eq(apiTools.agentId, req.params.agentId));
  });

  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/api-tools', async (req, reply) => {
    const body = ApiToolBody.parse(req.body);
    const id = uuidv4();
    await db.insert(apiTools).values({ id, agentId: req.params.agentId, ...body });
    const [tool] = await db.select().from(apiTools).where(eq(apiTools.id, id));
    return reply.status(201).send(tool);
  });

  fastify.put<{ Params: { agentId: string; toolId: string } }>(
    '/agents/:agentId/api-tools/:toolId',
    async (req, reply) => {
      const [existing] = await db
        .select()
        .from(apiTools)
        .where(and(eq(apiTools.agentId, req.params.agentId), eq(apiTools.id, req.params.toolId)));
      if (!existing) return reply.status(404).send({ error: 'Not found' });

      const body = ApiToolBody.partial().parse(req.body);
      await db
        .update(apiTools)
        .set({ ...body, updatedAt: new Date().toISOString() })
        .where(eq(apiTools.id, req.params.toolId));
      const [tool] = await db.select().from(apiTools).where(eq(apiTools.id, req.params.toolId));
      return tool;
    },
  );

  fastify.delete<{ Params: { agentId: string; toolId: string } }>(
    '/agents/:agentId/api-tools/:toolId',
    async (req, reply) => {
      const [existing] = await db
        .select()
        .from(apiTools)
        .where(and(eq(apiTools.agentId, req.params.agentId), eq(apiTools.id, req.params.toolId)));
      if (!existing) return reply.status(404).send({ error: 'Not found' });
      await db.delete(apiTools).where(eq(apiTools.id, req.params.toolId));
      return { success: true };
    },
  );

  // Test an API tool with given input values
  fastify.post<{ Params: { agentId: string; toolId: string } }>(
    '/agents/:agentId/api-tools/:toolId/test',
    async (req, reply) => {
      const [tool] = await db
        .select()
        .from(apiTools)
        .where(and(eq(apiTools.agentId, req.params.agentId), eq(apiTools.id, req.params.toolId)));
      if (!tool) return reply.status(404).send({ error: 'Not found' });

      // Load secrets + rate limits for this agent
      const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, req.params.agentId));
      const secrets = Object.fromEntries(secretRows.map((s) => [s.key, decrypt(s.value)]));
      const rateLimits = Object.fromEntries(secretRows.map((s) => [s.key, s.requestsPerMinute]));

      const input = (req.body as { input?: Record<string, unknown> })?.input ?? {};
      const config = JSON.parse(tool.config) as Record<string, unknown>;
      const started = Date.now();

      try {
        const result = await runApiToolThrottled(tool.type, config, input, secrets, req.params.agentId, rateLimits, tool.name);
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

  // ── Secrets CRUD ──────────────────────────────────────────────────────────

  // List secrets — values are masked
  fastify.get<{ Params: { agentId: string } }>('/agents/:agentId/secrets', async (req) => {
    const rows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, req.params.agentId));
    return rows.map((s) => ({ id: s.id, key: s.key, value: '••••••••', requestsPerMinute: s.requestsPerMinute, createdAt: s.createdAt }));
  });

  fastify.post<{ Params: { agentId: string } }>('/agents/:agentId/secrets', async (req, reply) => {
    const body = SecretBody.parse(req.body);
    // Upsert: if key already exists, replace value
    const [existing] = await db
      .select()
      .from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, req.params.agentId), eq(agentSecrets.key, body.key)));
    if (existing) {
      const updates: Record<string, unknown> = { value: encrypt(body.value) };
      if (body.requestsPerMinute !== undefined) updates.requestsPerMinute = body.requestsPerMinute;
      await db.update(agentSecrets).set(updates).where(eq(agentSecrets.id, existing.id));
      return { id: existing.id, key: body.key, value: '••••••••', requestsPerMinute: body.requestsPerMinute ?? existing.requestsPerMinute };
    }
    const id = uuidv4();
    await db.insert(agentSecrets).values({ id, agentId: req.params.agentId, key: body.key, value: encrypt(body.value), requestsPerMinute: body.requestsPerMinute ?? null });
    return reply.status(201).send({ id, key: body.key, value: '••••••••', requestsPerMinute: body.requestsPerMinute ?? null });
  });

  // Update rate limit on an existing secret
  fastify.patch<{ Params: { agentId: string; secretId: string } }>(
    '/agents/:agentId/secrets/:secretId',
    async (req, reply) => {
      const { requestsPerMinute } = req.body as { requestsPerMinute: number | null };
      const [existing] = await db.select().from(agentSecrets)
        .where(and(eq(agentSecrets.agentId, req.params.agentId), eq(agentSecrets.id, req.params.secretId)));
      if (!existing) return reply.status(404).send({ error: 'Not found' });
      await db.update(agentSecrets).set({ requestsPerMinute }).where(eq(agentSecrets.id, req.params.secretId));
      return { id: existing.id, key: existing.key, requestsPerMinute };
    },
  );

  fastify.delete<{ Params: { agentId: string; secretId: string } }>(
    '/agents/:agentId/secrets/:secretId',
    async (req, reply) => {
      await db.delete(agentSecrets).where(
        and(eq(agentSecrets.agentId, req.params.agentId), eq(agentSecrets.id, req.params.secretId)),
      );
      return { success: true };
    },
  );

  // ── AI Script Assist ──────────────────────────────────────────────────────
  // Takes a natural-language description + context, returns generated JS code.
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/api-tools/assist',
    async (req, reply) => {
      const { prompt, currentCode, toolName, toolDescription, inputSchema } =
        req.body as {
          prompt: string;
          currentCode?: string;
          toolName?: string;
          toolDescription?: string;
          inputSchema?: string;
        };

      const [agent] = await db.select().from(agents).where(eq(agents.id, req.params.agentId));
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });

      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) return reply.status(400).send({ error: 'Agent has no API key configured' });

      // Load secret key names (not values) so AI knows what's available
      const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, req.params.agentId));
      const secretKeys = secretRows.map((s) => s.key);

      const systemPrompt = `You are an expert JavaScript developer writing API tool scripts.

CONTEXT:
- Scripts run in a sandboxed Node.js VM (no require, no fs, no process)
- Available globals: fetch, JSON, Math, Date, Array, Object, String, Number, Boolean, Promise, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, console.log
- \`input\` object: the tool's arguments (from inputSchema)
- \`secrets\` object: API keys stored for this agent — keys available: ${secretKeys.length > 0 ? secretKeys.map((k) => `secrets.${k}`).join(', ') : '(none set yet — remind user to add secrets in the Secrets panel)'}
- Use \`return\` to return the result — can be any JSON-serialisable value
- Use \`await\` freely — the entire script runs as an async function

TOOL CONTEXT:
- Name: ${toolName ?? '(unnamed)'}
- Description: ${toolDescription ?? '(none)'}
- Current input schema: ${inputSchema ?? '{}'}

OUTPUT FORMAT:
You must respond with a JSON object with exactly two fields:
{
  "code": "<the complete JS script>",
  "inputSchema": <a valid JSON Schema object for the input fields the script uses>
}

The inputSchema must:
- Be a valid JSON Schema object (type: "object", with properties and required array)
- Include every input.XXX field the script uses as a property
- Give each field a sensible type (string/number/boolean) and description
- Mark fields required if the script would fail without them

RULES FOR THE CODE:
- The code must end with a \`return\` statement
- Keep it clean, readable, and production-quality
- Handle errors with try/catch where appropriate
- If an API key is needed but not in secrets, add a comment: // Add XXX_KEY to your Secrets panel`;

      const userMessage = currentCode
        ? `Current code:\n\`\`\`js\n${currentCode}\n\`\`\`\n\nRequest: ${prompt}`
        : `Request: ${prompt}`;

      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      // Parse the JSON response
      let code = '';
      let newInputSchema: string | undefined;
      try {
        // Strip markdown fences if present
        const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```\s*$/m, '').trim();
        const parsed = JSON.parse(cleaned) as { code?: string; inputSchema?: unknown };
        code = (parsed.code ?? '').trim();
        if (parsed.inputSchema) {
          newInputSchema = JSON.stringify(parsed.inputSchema);
        }
      } catch {
        // Fallback: treat whole response as raw code (old behaviour)
        code = text.replace(/^```(?:javascript|js)?\n?/m, '').replace(/\n?```\s*$/m, '').trim();
      }

      return { code, inputSchema: newInputSchema };
    },
  );
}
