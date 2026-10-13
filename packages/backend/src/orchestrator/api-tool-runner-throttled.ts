/**
 * Throttled API Tool Runner
 *
 * Wraps runApiTool with per-secret rate limiting and automatic request logging.
 * Inspects the tool's code/config to determine which secrets it references,
 * then acquires rate-limit slots before executing. Every response is stored in
 * api_request_log so agents can reference it later (e.g. inject_rows).
 *
 * Drop-in replacement for runApiTool at all call sites.
 */

import { runApiTool, type ApiToolConfig } from './api-tool-runner.js';
import { acquireSlot } from '../lib/secret-rate-limiter.js';
import { getDb } from '../db/index.js';
import { apiRequestLog } from '../db/schema.js';
import { v4 as uuidv4 } from 'uuid';

export interface SecretWithRateLimit {
  key: string;
  value: string;
  requestsPerMinute: number | null;
}

/**
 * Extract secret key names referenced in a tool's code or HTTP config.
 * Looks for patterns like `secrets.KEY_NAME` or `{{secrets.KEY_NAME}}`.
 */
function extractSecretRefs(type: string, config: ApiToolConfig): string[] {
  const refs = new Set<string>();

  if (type === 'script' && config.code) {
    // Match secrets.KEY_NAME in JS code
    const matches = config.code.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g);
    for (const m of matches) refs.add(m[1]);
  }

  if (type === 'http') {
    // Match {{secrets.KEY_NAME}} in URL, headers, body
    const sources = [config.url ?? '', config.body ?? '', ...Object.values(config.headers ?? {})];
    for (const source of sources) {
      const matches = source.matchAll(/\{\{secrets\.([A-Z][A-Z0-9_]*)\}\}/g);
      for (const m of matches) refs.add(m[1]);
    }
  }

  return [...refs];
}

/**
 * Run an API tool with rate limiting and response logging.
 *
 * @param type       - Tool type ('script' | 'http')
 * @param config     - Tool config (code or HTTP template)
 * @param input      - Tool input arguments
 * @param secrets    - Map of all decrypted secrets for the agent
 * @param agentId    - Agent ID (for rate limiter bucket key + request log)
 * @param rateLimits - Map of secretKey → requestsPerMinute (from DB)
 * @param toolName   - Name of the tool (for request log)
 * @returns The tool result + a requestId property for inject_rows references
 */
export async function runApiToolThrottled(
  type: string,
  config: ApiToolConfig,
  input: Record<string, unknown>,
  secrets: Record<string, string>,
  agentId: string,
  rateLimits: Record<string, number | null>,
  toolName?: string,
): Promise<unknown> {
  // Figure out which secrets this tool uses
  const secretRefs = extractSecretRefs(type, config);

  // Acquire slots for all referenced secrets that have rate limits
  const releases: Array<() => void> = [];
  for (const ref of secretRefs) {
    const rpm = rateLimits[ref];
    if (rpm && rpm > 0) {
      const release = await acquireSlot(agentId, ref, rpm);
      releases.push(release);
    }
  }

  const started = Date.now();
  let result: unknown;
  try {
    result = await runApiTool(type, config, input, secrets);
  } finally {
    for (const release of releases) release();
  }

  // Log the request + response for later reference by inject_rows
  const requestId = uuidv4();
  const durationMs = Date.now() - started;
  try {
    const db = getDb();
    await db.insert(apiRequestLog).values({
      id: requestId,
      agentId,
      toolName: toolName ?? 'unknown',
      input: JSON.stringify(input),
      response: JSON.stringify(result),
      durationMs,
    });
  } catch {
    // Don't fail the tool call if logging fails
  }

  // Attach requestId to the result so the agent can reference it
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    (result as Record<string, unknown>).__requestId = requestId;
  }

  return result;
}
