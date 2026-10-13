import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { agents } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../../crypto/index.js';
import { SseStream } from '../../lib/sse-stream.js';
import { runApiToolDiscoveryAgent, type DiscoveryEvent } from '../../agents/ui/api-tool-discovery-agent.js';

const DiscoverBody = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.unknown(),
    }),
  ),
});

export function registerApiToolDiscoveryRoute(fastify: FastifyInstance): void {
  const db = getDb();

  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/api-tools/discover',
    async (req, reply) => {
      req.raw.setTimeout(300_000); // 5 min — discovery sessions can be long

      const sse = new SseStream(reply);
      const emit = (event: DiscoveryEvent) => sse.send(event);

      // Parse body
      let body: z.infer<typeof DiscoverBody>;
      try {
        body = DiscoverBody.parse(req.body);
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

      try {
        await runApiToolDiscoveryAgent(
          {
            agentId,
            apiKey,
            agentName: agent.name,
            agentSystemPrompt: agent.systemPrompt,
            agentProfileBlob: (agent as Record<string, unknown>).profileBlob as string | null,
            messages: body.messages.slice() as any[],
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
        emit({ type: 'done' });
        sse.end();
      }

      return reply;
    },
  );
}
