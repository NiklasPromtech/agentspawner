import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { agents, tools } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';
import { SseStream } from '../../lib/sse-stream.js';
import { runFlowGeneratorAgent, type GeneratorEvent } from '../../agents/ui/flow-generator-agent.js';

// ── Route request body schema ─────────────────────────────────────────────────

const SeedContextSchema = z.object({
  pageUrl:          z.string(),
  feedSelector:     z.string().optional(),
  postCardSelector: z.string().optional(),
  expandSelector:   z.string().optional(),
  notes:            z.string().optional(),
});

const GenerateBody = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.unknown(),
    }),
  ),
  /** When provided, prepends a type-specific focus note to the system prompt. */
  flowType: z.enum(['scrape', 'action']).optional(),
  /** Facts recorded in previous flow builds this session — injected into system prompt. */
  sessionFacts: z.array(z.string()).optional(),
  /** Pre-confirmed selectors from Quick Build form — skips the explorer entirely. */
  seedContext: SeedContextSchema.optional(),
});

// ── Route handler ─────────────────────────────────────────────────────────────

export function registerFlowGenerateRoute(fastify: FastifyInstance): void {
  const db = getDb();

  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/flows/generate',
    async (req, reply) => {
      req.raw.setTimeout(180_000);

      // Set up SSE — headers, open tracking, and write/end helpers are all
      // encapsulated in SseStream so the handler stays free of raw socket details.
      const sse = new SseStream(reply);

      const emit = (event: GeneratorEvent) => sse.send(event);

      // Parse body
      let body: z.infer<typeof GenerateBody>;
      try {
        body = GenerateBody.parse(req.body);
      } catch {
        emit({ type: 'error', message: 'Invalid request body' });
        emit({ type: 'done' });
        sse.end();
        return reply;
      }

      const agentId = req.params.agentId;
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      if (!agent) {
        emit({ type: 'error', message: 'Agent not found' });
        emit({ type: 'done' });
        sse.end();
        return reply;
      }

      const apiKey = decrypt(agent.apiKeyEncrypted);
      if (!apiKey) {
        emit({ type: 'error', message: 'Agent has no API key configured' });
        emit({ type: 'done' });
        sse.end();
        return reply;
      }

      const agentTools = await db.select().from(tools).where(eq(tools.agentId, agentId));

      try {
        // Run the agent loop
        await runFlowGeneratorAgent(
          {
            agentId,
            apiKey,
            agentTools,
            agentModel: agent.model ?? 'claude-sonnet-4-6',
            messages: body.messages.slice() as any[],
            flowType: body.flowType,
            sessionFacts: body.sessionFacts,
            seedContext: body.seedContext,
            isOpen: () => sse.isOpen,
          },
          emit,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isFatal =
          ('status' in (err as object) && (err as { status: number }).status === 402) ||
          errMsg.toLowerCase().includes('credit') ||
          errMsg.toLowerCase().includes('billing') ||
          errMsg.toLowerCase().includes('insufficient') ||
          errMsg.toLowerCase().includes('quota');
        if (isFatal) {
          emit({ type: 'fatal_error', message: errMsg });
        } else {
          emit({ type: 'error', message: errMsg });
        }
      } finally {
        // Ensure done is sent and stream is closed
        emit({ type: 'done' });
        sse.end();
      }

      return reply;
    },
  );
}
