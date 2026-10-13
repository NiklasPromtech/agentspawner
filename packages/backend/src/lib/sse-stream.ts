import type { FastifyReply } from 'fastify';

/**
 * SseStream wraps a Fastify reply to provide a clean Server-Sent Events interface.
 *
 * Responsibilities:
 * - Sets the required SSE response headers and flushes them immediately.
 * - Tracks whether the client connection is still open via the `isOpen` getter.
 * - `send(event)` serialises the event as an SSE data frame and writes it.
 * - `end()` closes the underlying socket.
 *
 * Route handlers no longer need to manage the `reply.raw` socket directly, hold a
 * `clientDisconnected` flag, or wire up `reply.raw.on('close', ...)`.
 */
export class SseStream {
  private _isOpen = true;

  constructor(private readonly reply: FastifyReply) {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.flushHeaders();

    reply.raw.on('close', () => {
      this._isOpen = false;
    });
  }

  /** True while the client connection is open. */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /** Write a single SSE data frame. Silently no-ops if the connection is closed. */
  send(event: unknown): void {
    if (!this._isOpen) return;
    try {
      this.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this._isOpen = false;
    }
  }

  /** Close the SSE stream. Safe to call multiple times. */
  end(): void {
    this._isOpen = false;
    try {
      this.reply.raw.end();
    } catch {
      // already closed — ignore
    }
  }
}
