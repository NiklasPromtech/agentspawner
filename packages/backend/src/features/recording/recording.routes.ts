import type { FastifyInstance } from 'fastify';
import { sendToExtension, isExtensionConnected } from '../../websocket/server.js';

export interface RecordEvent {
  type: 'navigate' | 'click' | 'type';
  url?: string;
  selector?: string;
  text?: string;
  value?: string;
}

interface RecordingSession {
  events: RecordEvent[];
  done: boolean;
}

let session: RecordingSession | null = null;

export function registerRecordingRoutes(fastify: FastifyInstance): void {
  fastify.post<{ Body: { url?: string } }>('/recording/start', async (req, reply) => {
    if (!isExtensionConnected()) {
      return reply.status(503).send({ error: 'Extension not connected' });
    }
    const url = req.body?.url;
    if (!url) return reply.status(400).send({ error: 'url is required' });
    session = { events: [], done: false };
    sendToExtension({ type: 'START_RECORDING', url });
    return reply.send({ ok: true });
  });

  fastify.post<{ Body: RecordEvent }>('/recording/event', async (req, reply) => {
    if (!session || session.done) return reply.status(400).send({ error: 'No active session' });
    const event = req.body;
    if (!event?.type) return reply.status(400).send({ error: 'Invalid event' });
    session.events.push(event);
    return reply.send({ ok: true, count: session.events.length });
  });

  fastify.post('/recording/stop', async (_req, reply) => {
    if (!session) return reply.status(400).send({ error: 'No session' });
    session.done = true;
    return reply.send({ ok: true });
  });

  fastify.get('/recording/events', async (_req, reply) => {
    if (!session) return reply.send({ events: [], done: false });
    return reply.send({ events: session.events, done: session.done });
  });

  fastify.delete('/recording', async (_req, reply) => {
    session = null;
    return reply.send({ ok: true });
  });
}
