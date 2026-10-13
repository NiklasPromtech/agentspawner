/**
 * API Tool Discovery Agent
 *
 * Conversational agent that helps users discover what tools can be built from an API key,
 * then builds them one-at-a-time with a test-approve cycle.
 *
 * Pattern mirrors flow-generator-agent.ts: Claude with tool_use, SSE streaming, agentic loop.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../../db/index.js';
import { apiTools, agentSecrets } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { encrypt, decrypt } from '../../crypto/index.js';
import { runApiToolThrottled } from '../../orchestrator/api-tool-runner-throttled.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProposedTool {
  name: string;
  description: string;
  httpMethod: string;
  endpointPath: string;
  whatItReturns: string;
  exampleUsage: string;
}

export type DiscoveryEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tools_proposed'; tools: ProposedTool[] }
  | { type: 'tool_built'; toolId: string; name: string; description: string; inputSchema: string }
  | { type: 'tool_test_result'; toolId: string; ok: boolean; result?: unknown; error?: string; durationMs: number; rateLimitInfo?: RateLimitInfo }
  | { type: 'tool_enabled'; toolId: string }
  | { type: 'tool_deleted'; toolId: string }
  | { type: 'rate_limit_wait'; seconds: number; reason: string }
  | { type: 'secret_stored'; key: string }
  | { type: 'reply'; content: string }
  | { type: 'error'; message: string }
  | { type: 'fatal_error'; message: string }
  | { type: 'token_usage'; inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'done' };

interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  resetAt?: string;
  retryAfterSeconds?: number;
}

export interface DiscoveryParams {
  agentId: string;
  apiKey: string;          // Agent's Claude API key (for calling Claude)
  agentName: string;
  agentSystemPrompt: string;
  agentProfileBlob: string | null;
  messages: Anthropic.Messages.MessageParam[];
  isOpen: () => boolean;
}

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(
  secretKeys: string[],
  existingTools: Array<{ name: string; description: string }>,
  agentContext: { name: string; systemPrompt: string; profileBlob: string | null },
): string {
  const promptTemplate = readFileSync(
    join(__dirname, 'api-tool-discovery.prompt.md'),
    'utf-8',
  );

  // Parse profileBlob for job description, focus areas, etc.
  let profileInfo = '';
  if (agentContext.profileBlob) {
    try {
      const profile = JSON.parse(agentContext.profileBlob) as {
        jobDescription?: string;
        focus?: string;
        mindset?: string;
        competitors?: string[];
      };
      const parts: string[] = [];
      if (profile.jobDescription) parts.push(`Job description: ${profile.jobDescription}`);
      if (profile.focus) parts.push(`Focus: ${profile.focus}`);
      if (profile.mindset) parts.push(`Mindset: ${profile.mindset}`);
      if (profile.competitors?.length) parts.push(`Competitors: ${profile.competitors.join(', ')}`);
      if (parts.length > 0) profileInfo = parts.join('\n');
    } catch { /* ignore parse errors */ }
  }

  const context = [
    `Agent name: ${agentContext.name}`,
    agentContext.systemPrompt
      ? `Agent system prompt (describes its role and purpose):\n${agentContext.systemPrompt}`
      : '',
    profileInfo ? `Agent profile:\n${profileInfo}` : '',
    '',
    `Available secret keys: ${secretKeys.length > 0 ? secretKeys.join(', ') : '(none stored yet)'}`,
    '',
    existingTools.length > 0
      ? `Existing API tools on this agent (avoid duplicates):\n${existingTools.map((t) => `  - ${t.name}: ${t.description}`).join('\n')}`
      : 'No existing API tools on this agent.',
    '',
    'IMPORTANT: Only propose tools that are relevant to this agent\'s role and purpose. Do not propose every possible API endpoint — focus on the ones this specific agent would actually use in its work.',
  ].filter(Boolean).join('\n');

  return promptTemplate.replace('{{CONTEXT}}', context);
}

// ── Agent tools exposed to Claude ────────────────────────────────────────────

const DISCOVERY_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'propose_tools',
    description:
      'Present a list of API tool proposals to the user. Each proposal describes one tool that could be built. The user will approve or deny each one. Call this after researching the API capabilities.',
    input_schema: {
      type: 'object' as const,
      properties: {
        api_name: { type: 'string', description: 'Name of the API (e.g. "NewsAPI", "Stripe")' },
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Tool name in snake_case (e.g. "get_top_headlines")' },
              description: { type: 'string', description: 'What the tool does in 1-2 sentences' },
              http_method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE)' },
              endpoint_path: { type: 'string', description: 'API endpoint path (e.g. "/v2/top-headlines")' },
              what_it_returns: { type: 'string', description: 'Brief description of the response data' },
              example_usage: { type: 'string', description: 'Example input values as a short JSON snippet' },
            },
            required: ['name', 'description', 'http_method', 'endpoint_path', 'what_it_returns', 'example_usage'],
          },
          description: 'List of tool proposals',
        },
      },
      required: ['api_name', 'proposals'],
    },
  },
  {
    name: 'store_secret',
    description:
      'Store an API key as a secret for this agent. The key is encrypted and accessible as secrets.KEY_NAME in tool scripts. Call this before building tools if the user provided an API key that is not yet stored.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Secret key name in UPPER_SNAKE_CASE (e.g. "NEWSAPI_KEY")' },
        value: { type: 'string', description: 'The API key value to store' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'build_tool',
    description:
      'Build a complete API tool and save it as a disabled draft. Generates the JS script code and input schema. The user can then test it before approving.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Tool name in snake_case' },
        description: { type: 'string', description: 'What the tool does' },
        input_schema: {
          type: 'object',
          description: 'JSON Schema for the tool inputs — must be { type: "object", properties: {...}, required: [...] }',
        },
        code: {
          type: 'string',
          description: 'Complete JS script. Use input.* for arguments, secrets.* for API keys. Must end with a return statement.',
        },
        secret_key_used: {
          type: 'string',
          description: 'The secret key name this tool uses (e.g. "NEWSAPI_KEY") — for documentation',
        },
      },
      required: ['name', 'description', 'input_schema', 'code'],
    },
  },
  {
    name: 'test_tool',
    description:
      'Test a built tool with sample input. Returns the result, timing, and any rate limit headers detected. If the test returns a 429 (rate limited), the result will include rate limit info.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tool_id: { type: 'string', description: 'ID of the tool to test (returned by build_tool)' },
        test_input: { type: 'object', description: 'Test input values matching the tool\'s inputSchema' },
      },
      required: ['tool_id', 'test_input'],
    },
  },
  {
    name: 'wait_for_rate_limit',
    description:
      'Wait for a specified number of seconds before retrying a test. Use this when a 429 rate limit response is received, or when you know the API has tight rate limits and need to space out calls.',
    input_schema: {
      type: 'object' as const,
      properties: {
        seconds: { type: 'number', description: 'Number of seconds to wait' },
        reason: { type: 'string', description: 'Brief explanation (shown to user)' },
      },
      required: ['seconds', 'reason'],
    },
  },
  {
    name: 'enable_tool',
    description:
      'Enable a draft tool after the user approves it. The tool becomes active and available to the agent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tool_id: { type: 'string', description: 'ID of the tool to enable' },
      },
      required: ['tool_id'],
    },
  },
  {
    name: 'rebuild_tool',
    description:
      'Replace a tool\'s code and schema with a new version. Use when the user rejects a tool and you need to fix it. The tool stays as a disabled draft.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tool_id: { type: 'string', description: 'ID of the tool to rebuild' },
        code: { type: 'string', description: 'New complete JS script' },
        input_schema: { type: 'object', description: 'New JSON Schema for inputs' },
        description: { type: 'string', description: 'Updated description (optional)' },
      },
      required: ['tool_id', 'code', 'input_schema'],
    },
  },
  {
    name: 'delete_tool',
    description:
      'Delete a tool that the user rejected and does not want rebuilt.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tool_id: { type: 'string', description: 'ID of the tool to delete' },
      },
      required: ['tool_id'],
    },
  },
  {
    name: 'set_rate_limit',
    description:
      'Set the rate limit (requests per minute) for an API key secret. Call this when you detect rate limit headers or know the API tier. This ensures all future tool calls using this secret are automatically throttled to avoid 429 errors.',
    input_schema: {
      type: 'object' as const,
      properties: {
        secret_key: { type: 'string', description: 'The secret key name (e.g. "NEWSAPI_KEY")' },
        requests_per_minute: { type: 'number', description: 'Maximum requests per minute for this API key' },
      },
      required: ['secret_key', 'requests_per_minute'],
    },
  },
];

// ── Helper: extract text from response ───────────────────────────────────────

function extractText(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ── Main agent loop ──────────────────────────────────────────────────────────

export async function runApiToolDiscoveryAgent(
  params: DiscoveryParams,
  emit: (event: DiscoveryEvent) => void,
): Promise<void> {
  const db = getDb();
  const anthropic = new Anthropic({ apiKey: params.apiKey });

  // Load context
  const secretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, params.agentId));
  const secretKeys = secretRows.map((s) => s.key);
  const existingToolRows = await db.select().from(apiTools).where(eq(apiTools.agentId, params.agentId));
  const existingToolSummaries = existingToolRows.map((t) => ({ name: t.name, description: t.description }));

  const systemPrompt = buildSystemPrompt(secretKeys, existingToolSummaries, {
    name: params.agentName,
    systemPrompt: params.agentSystemPrompt,
    profileBlob: params.agentProfileBlob,
  });
  const messages = params.messages.slice();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  while (true) {
    if (!params.isOpen()) return;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: DISCOVERY_TOOLS,
    });

    // Token tracking
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    const estimatedCostUsd = (totalInputTokens * 3 + totalOutputTokens * 15) / 1_000_000;
    emit({ type: 'token_usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, estimatedCostUsd });

    const textContent = extractText(response).trim();

    // end_turn → final reply
    if (response.stop_reason === 'end_turn') {
      if (textContent) emit({ type: 'reply', content: textContent });
      return;
    }

    if (response.stop_reason !== 'tool_use') {
      if (textContent) emit({ type: 'reply', content: textContent });
      return;
    }

    // Show thinking text alongside tool calls
    if (textContent) {
      emit({ type: 'thinking', text: textContent });
    }

    if (!params.isOpen()) return;

    // Process tool calls
    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (!params.isOpen()) break;

      const inp = block.input as Record<string, unknown>;
      let result: string;

      try {
        switch (block.name) {
          // ── propose_tools ──────────────────────────────────────────────
          case 'propose_tools': {
            const proposals = (inp.proposals as Array<{
              name: string; description: string; http_method: string;
              endpoint_path: string; what_it_returns: string; example_usage: string;
            }>).map((p) => ({
              name: p.name,
              description: p.description,
              httpMethod: p.http_method,
              endpointPath: p.endpoint_path,
              whatItReturns: p.what_it_returns,
              exampleUsage: p.example_usage,
            }));

            emit({ type: 'tools_proposed', tools: proposals });
            result = JSON.stringify({
              ok: true,
              message: `Proposed ${proposals.length} tools. Waiting for user to approve/deny each one. The user will reply with their choices.`,
            });
            break;
          }

          // ── store_secret ───────────────────────────────────────────────
          case 'store_secret': {
            const key = inp.key as string;
            const value = inp.value as string;

            // Guard: reject if the "value" looks like the key name repeated (not a real API key)
            const valueLooksLikeKeyName =
              value.replace(/[_\s-]/g, '').toLowerCase() === key.replace(/[_\s-]/g, '').toLowerCase();
            if (valueLooksLikeKeyName) {
              result = JSON.stringify({
                ok: false,
                error: `Rejected: the value you provided ("${value}") looks like the key name, not an actual API key. Do NOT call store_secret unless the user has given you a real API key string. If a secret named "${key}" is already stored, just use secrets.${key} in your code.`,
                available_secrets: secretKeys,
              });
              break;
            }

            // Guard: don't overwrite an existing secret unless the new value is meaningfully different
            const [existing] = await db.select().from(agentSecrets)
              .where(and(eq(agentSecrets.agentId, params.agentId), eq(agentSecrets.key, key)));
            if (existing) {
              const existingValue = decrypt(existing.value);
              if (existingValue === value) {
                result = JSON.stringify({ ok: true, message: `Secret "${key}" already stored with this value. Use secrets.${key} in tool scripts.`, available_secrets: secretKeys });
                break;
              }
              await db.update(agentSecrets).set({ value: encrypt(value) }).where(eq(agentSecrets.id, existing.id));
            } else {
              await db.insert(agentSecrets).values({ id: uuidv4(), agentId: params.agentId, key, value: encrypt(value) });
            }
            // Update local tracking
            if (!secretKeys.includes(key)) secretKeys.push(key);

            emit({ type: 'secret_stored', key });
            result = JSON.stringify({ ok: true, message: `Secret "${key}" stored. You can now reference it as secrets.${key} in tool scripts.`, available_secrets: secretKeys });
            break;
          }

          // ── build_tool ─────────────────────────────────────────────────
          case 'build_tool': {
            const name = inp.name as string;
            const description = inp.description as string;
            const inputSchema = inp.input_schema as Record<string, unknown>;
            const code = inp.code as string;

            const toolId = uuidv4();
            const inputSchemaStr = JSON.stringify(inputSchema);
            const config = JSON.stringify({ code });

            await db.insert(apiTools).values({
              id: toolId,
              agentId: params.agentId,
              name,
              description,
              inputSchema: inputSchemaStr,
              type: 'script',
              config,
              enabled: false, // Draft — user must approve
            });

            emit({ type: 'tool_built', toolId, name, description, inputSchema: inputSchemaStr });
            result = JSON.stringify({
              ok: true,
              tool_id: toolId,
              message: `Tool "${name}" saved as draft. Call test_tool with sample input.`,
              available_secrets: secretKeys,
              reminder: 'Use secrets.KEY_NAME in code — never embed raw API key values.',
            });
            break;
          }

          // ── test_tool ──────────────────────────────────────────────────
          case 'test_tool': {
            const toolId = inp.tool_id as string;
            const testInput = inp.test_input as Record<string, unknown>;

            const [tool] = await db.select().from(apiTools)
              .where(and(eq(apiTools.agentId, params.agentId), eq(apiTools.id, toolId)));
            if (!tool) {
              result = JSON.stringify({ ok: false, error: `Tool "${toolId}" not found` });
              emit({ type: 'tool_test_result', toolId, ok: false, error: 'Tool not found', durationMs: 0 });
              break;
            }

            // Load secrets + rate limits
            const freshSecretRows = await db.select().from(agentSecrets).where(eq(agentSecrets.agentId, params.agentId));
            const secretsMap = Object.fromEntries(freshSecretRows.map((s) => [s.key, decrypt(s.value)]));
            const rateLimitsMap = Object.fromEntries(freshSecretRows.map((s) => [s.key, s.requestsPerMinute]));

            const config = JSON.parse(tool.config) as Record<string, unknown>;
            const started = Date.now();

            try {
              const testResult = await runApiToolThrottled(tool.type, config, testInput, secretsMap, params.agentId, rateLimitsMap, tool.name);
              const durationMs = Date.now() - started;

              // Try to extract rate limit info from the result
              let rateLimitInfo: RateLimitInfo | undefined;
              if (testResult && typeof testResult === 'object') {
                const r = testResult as Record<string, unknown>;
                if (r._rateLimitInfo) {
                  rateLimitInfo = r._rateLimitInfo as RateLimitInfo;
                }
              }

              emit({ type: 'tool_test_result', toolId, ok: true, result: testResult, durationMs, rateLimitInfo });
              result = JSON.stringify({ ok: true, result: testResult, durationMs, rateLimitInfo, secrets_used: Object.keys(secretsMap) });
            } catch (err) {
              const durationMs = Date.now() - started;
              const error = err instanceof Error ? err.message : String(err);

              // Check for rate limit (429)
              let rateLimitInfo: RateLimitInfo | undefined;
              if (error.includes('429') || error.toLowerCase().includes('rate limit')) {
                // Try to parse retry-after from error
                const retryMatch = error.match(/retry.?after[:\s]*(\d+)/i);
                rateLimitInfo = {
                  retryAfterSeconds: retryMatch ? parseInt(retryMatch[1], 10) : 60,
                };
              }

              emit({ type: 'tool_test_result', toolId, ok: false, error, durationMs, rateLimitInfo });
              result = JSON.stringify({ ok: false, error, durationMs, rateLimitInfo, secrets_used: Object.keys(secretsMap) });
            }
            break;
          }

          // ── wait_for_rate_limit ────────────────────────────────────────
          case 'wait_for_rate_limit': {
            const seconds = Math.min(inp.seconds as number, 120); // Cap at 2 minutes
            const reason = inp.reason as string;

            emit({ type: 'rate_limit_wait', seconds, reason });

            // Actually wait
            await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

            result = JSON.stringify({ ok: true, message: `Waited ${seconds} seconds. You can now retry the test.` });
            break;
          }

          // ── enable_tool ────────────────────────────────────────────────
          case 'enable_tool': {
            const toolId = inp.tool_id as string;
            await db.update(apiTools)
              .set({ enabled: true, updatedAt: new Date().toISOString() })
              .where(and(eq(apiTools.id, toolId), eq(apiTools.agentId, params.agentId)));

            emit({ type: 'tool_enabled', toolId });
            result = JSON.stringify({ ok: true, message: 'Tool enabled and ready to use.' });
            break;
          }

          // ── rebuild_tool ───────────────────────────────────────────────
          case 'rebuild_tool': {
            const toolId = inp.tool_id as string;
            const code = inp.code as string;
            const inputSchema = inp.input_schema as Record<string, unknown>;
            const description = inp.description as string | undefined;

            const updates: Record<string, unknown> = {
              config: JSON.stringify({ code }),
              inputSchema: JSON.stringify(inputSchema),
              updatedAt: new Date().toISOString(),
            };
            if (description) updates.description = description;

            await db.update(apiTools)
              .set(updates)
              .where(and(eq(apiTools.id, toolId), eq(apiTools.agentId, params.agentId)));

            emit({ type: 'tool_built', toolId, name: '', description: description ?? '', inputSchema: JSON.stringify(inputSchema) });
            result = JSON.stringify({ ok: true, message: 'Tool rebuilt. Call test_tool to test again.', available_secrets: secretKeys });
            break;
          }

          // ── delete_tool ────────────────────────────────────────────────
          case 'delete_tool': {
            const toolId = inp.tool_id as string;
            await db.delete(apiTools)
              .where(and(eq(apiTools.id, toolId), eq(apiTools.agentId, params.agentId)));

            emit({ type: 'tool_deleted', toolId });
            result = JSON.stringify({ ok: true, message: 'Tool deleted.' });
            break;
          }

          // ── set_rate_limit ──────────────────────────────────────────
          case 'set_rate_limit': {
            const secretKey = inp.secret_key as string;
            const rpm = Math.max(1, Math.round(inp.requests_per_minute as number));

            const [secretRow] = await db.select().from(agentSecrets)
              .where(and(eq(agentSecrets.agentId, params.agentId), eq(agentSecrets.key, secretKey)));
            if (!secretRow) {
              result = JSON.stringify({ ok: false, error: `Secret "${secretKey}" not found. Available: ${secretKeys.join(', ')}` });
              break;
            }

            await db.update(agentSecrets)
              .set({ requestsPerMinute: rpm })
              .where(eq(agentSecrets.id, secretRow.id));

            result = JSON.stringify({ ok: true, message: `Rate limit set: ${rpm} requests/minute for ${secretKey}. All future tool calls using this key will be throttled automatically.` });
            break;
          }

          default:
            result = JSON.stringify({ error: `Unknown tool: ${block.name}` });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        result = JSON.stringify({ error: errMsg });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    }

    // Feed results back to Claude
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }
}
