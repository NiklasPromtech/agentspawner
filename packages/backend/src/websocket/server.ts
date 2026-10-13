import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { BackendToExtension, ExtensionToBackend, PendingToolCall } from './protocol.js';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { tools } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger.js';

// Single global registry (one extension connection at a time for now)
let activeSocket: WebSocket | null = null;
const pendingCalls = new Map<string, PendingToolCall>();

// Connection health tracking (OPERATION CONVERGENCE Task 6)
let lastSeenAt: Date | null = null;
let disconnectedAt: Date | null = null;
let connectedAt: Date | null = null;

export function getActiveSocket(): WebSocket | null {
  return activeSocket;
}

export function isExtensionConnected(): boolean {
  return activeSocket !== null && activeSocket.readyState === 1; // OPEN
}

export interface ExtensionStatus {
  connected: boolean;
  lastSeenAt: string | null;
  disconnectedAt: string | null;
  connectedAt: string | null;
  pendingCalls: number;
}

export function getExtensionStatus(): ExtensionStatus {
  return {
    connected: isExtensionConnected(),
    lastSeenAt: lastSeenAt?.toISOString() ?? null,
    disconnectedAt: disconnectedAt?.toISOString() ?? null,
    connectedAt: connectedAt?.toISOString() ?? null,
    pendingCalls: pendingCalls.size,
  };
}

export function sendToExtension(msg: BackendToExtension): void {
  if (!activeSocket || activeSocket.readyState !== 1) {
    throw new Error('No extension connected');
  }
  activeSocket.send(JSON.stringify(msg));
}

export interface ReviewTabData {
  sourceType: 'action' | 'review';
  actionId?: string;   // required when sourceType === 'action'
  reviewId?: string;   // required when sourceType === 'review'
  agentId: string;
  url: string;
  proposedContent: string;
  actionType: string;
  title: string;
  description: string;
  tabId?: number;      // if present, inject overlay into this existing tab instead of opening a new one
}

/**
 * Fire-and-forget: sends OPEN_REVIEW_TAB to the extension if one is connected.
 * Silently no-ops if no extension is connected — the action remains in the DB
 * and the ActionsTab fallback still works.
 */
export function sendReviewTab(data: ReviewTabData): void {
  if (!activeSocket || activeSocket.readyState !== 1) {
    return; // no extension connected — silent no-op
  }
  try {
    activeSocket.send(JSON.stringify({ type: 'OPEN_REVIEW_TAB', ...data } satisfies BackendToExtension));
  } catch (err) {
    logger.warn({ err }, 'sendReviewTab: failed to send OPEN_REVIEW_TAB (ignored)');
  }
}

/**
 * Execute a tool on the extension.
 *
 * OPERATION CONVERGENCE Task 6 — resilience improvements:
 * 1. Pre-flight check: if extension is not connected, fail immediately with a
 *    structured message the agent can act on (no 30s hang).
 * 2. Mid-execution disconnect detection: if the WebSocket drops while a call is
 *    pending, the `socket.on('close')` handler rejects all pending calls instantly
 *    (already existed). Additionally, a 5-second disconnect-check interval catches
 *    edge cases where the close event fires but the promise hasn't been rejected.
 */
export function executeExtensionTool(
  toolName: string,
  input: Record<string, unknown>,
  timeoutMs = 30_000,
  code = '',
): Promise<unknown> {
  // Pre-flight: fail fast if extension isn't connected
  if (!isExtensionConnected()) {
    return Promise.reject(
      new Error(
        'Extension not connected. Browser tools are unavailable. ' +
        'Use non-browser alternatives or wait for the extension to reconnect.',
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const correlationId = uuidv4();
    let settled = false;

    const settle = (fn: typeof resolve | typeof reject, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearInterval(disconnectCheckId);
      pendingCalls.delete(correlationId);
      (fn as (v: unknown) => void)(value);
    };

    const timeoutId = setTimeout(() => {
      settle(reject, new Error(`Extension tool "${toolName}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // Mid-execution disconnect detection: poll every 5s to catch edge cases
    const disconnectCheckId = setInterval(() => {
      if (!isExtensionConnected()) {
        settle(
          reject,
          new Error(
            `Extension disconnected while executing tool "${toolName}". ` +
            'Browser tools are unavailable. Use non-browser alternatives or wait for reconnection.',
          ),
        );
      }
    }, 5_000);

    pendingCalls.set(correlationId, {
      resolve: (val) => settle(resolve, val),
      reject: (err) => settle(reject, err),
      timeoutId,
    });

    try {
      sendToExtension({ type: 'EXECUTE_TOOL', correlationId, toolName, input, code });
    } catch (err) {
      settle(reject, err);
    }
  });
}

export function registerWebSocketRoute(fastify: FastifyInstance): void {
  fastify.get('/ws', { websocket: true }, (socket) => {
    logger.info('Extension connected');
    activeSocket = socket;
    connectedAt = new Date();
    lastSeenAt = new Date();
    disconnectedAt = null; // clear previous disconnect timestamp

    // Send PING every 20s
    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ type: 'PONG' } satisfies BackendToExtension));
      }
    }, 20_000);

    socket.on('message', (raw: Buffer) => {
      let msg: ExtensionToBackend;
      try {
        msg = JSON.parse(raw.toString()) as ExtensionToBackend;
      } catch {
        return;
      }

      // Track last activity for health monitoring
      lastSeenAt = new Date();

      switch (msg.type) {
        case 'HELLO':
          logger.info({ extensionId: msg.extensionId }, 'Extension HELLO');
          socket.send(
            JSON.stringify({ type: 'HELLO_ACK', serverId: 'agentspawner' } satisfies BackendToExtension),
          );
          break;

        case 'PING':
          socket.send(JSON.stringify({ type: 'PONG' } satisfies BackendToExtension));
          break;

        case 'TOOL_RESULT': {
          const pending = pendingCalls.get(msg.correlationId);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pendingCalls.delete(msg.correlationId);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve(msg.result);
            }
          }
          break;
        }
      }
    });

    socket.on('close', () => {
      logger.info('Extension disconnected');
      clearInterval(pingInterval);
      if (activeSocket === socket) {
        activeSocket = null;
        disconnectedAt = new Date();
      }

      // Reject all pending calls
      for (const [id, pending] of pendingCalls) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error('Extension disconnected'));
        pendingCalls.delete(id);
      }
    });

    socket.on('error', (err: Error) => {
      logger.error({ err }, 'WebSocket error');
    });
  });

  // Status endpoint — enriched with health data (OPERATION CONVERGENCE Task 6)
  fastify.get('/extension/status', async () => getExtensionStatus());

  // Tool code endpoint (called by extension background to fetch tool code)
  fastify.get<{ Querystring: { name: string } }>('/extension/tool-code', async (req, reply) => {
    const db = getDb();
    const { name } = req.query;
    const [tool] = await db.select().from(tools).where(eq(tools.name, name));
    if (!tool) return reply.status(404).send({ error: 'Tool not found' });
    return { code: tool.code };
  });
}
