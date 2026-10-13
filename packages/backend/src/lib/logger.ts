/**
 * Structured logger for the AgentSpawner backend.
 *
 * All modules should import `logger` from here (or call `.child()` to bind
 * context fields such as `agentId`, `runId`, or `flowId`).
 *
 * Output format: newline-delimited JSON (pino default), readable in
 * development via `pino-pretty` if desired:
 *   pnpm dev 2>&1 | pino-pretty
 */
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
});

/** Convenience factory — creates a child logger pre-bound with context fields. */
export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
