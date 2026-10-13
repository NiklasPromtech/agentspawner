/**
 * agents.service.ts
 * Business logic for the agents feature.
 * Orchestrates repository calls, encryption, Telegram polling, and tool provisioning.
 */
import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { encrypt, decrypt } from '../../crypto/index.js';
import { startTelegramPolling, stopTelegramPolling } from '../../telegram/index.js';
import { DEFAULT_TOOLS } from '../../orchestrator/default-tools.js';
import { childLogger } from '../../lib/logger.js';
import {
  findAllAgents,
  findAgentById,
  insertAgent,
  updateAgent,
  deleteAgent,
  insertTool,
  type AgentRow,
} from './agents.repository.js';

const log = childLogger({ feature: 'agents' });

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateSuppressionToken(): string {
  return `__done_${randomBytes(6).toString('hex')}__`;
}

/** Strip sensitive fields for API responses. */
function toPublicAgent(agent: AgentRow) {
  return {
    ...agent,
    apiKey: '',
    telegramKey: '',
    hasApiKey: !!agent.apiKeyEncrypted,
  };
}

/** Lazily ensure an agent has a suppression token, creating one if absent. */
async function ensureToken(agent: AgentRow): Promise<AgentRow> {
  if (!agent.suppressionToken) {
    const token = generateSuppressionToken();
    const updated = await updateAgent(agent.id, { suppressionToken: token });
    log.info({ agentId: agent.id }, 'Generated missing suppression token');
    return updated;
  }
  return agent;
}

// ── Service methods ───────────────────────────────────────────────────────────

export async function listAgents() {
  const rows = await findAllAgents();
  const withTokens = await Promise.all(rows.map(ensureToken));
  return withTokens.map(toPublicAgent);
}

export async function getAgent(id: string) {
  const raw = await findAgentById(id);
  if (!raw) return null;
  const agent = await ensureToken(raw);
  return toPublicAgent(agent);
}

export interface CreateAgentInput {
  name: string;
  systemPrompt?: string;
  model?: string;
  apiKey?: string;
  telegramKey?: string;
  telegramChatId?: string;
  copyKeyFromAgentId?: string;
}

export async function createAgent(input: CreateAgentInput) {
  const id = uuidv4();

  // Resolve encrypted API key — prefer raw key, fall back to copying from another agent
  let apiKeyEncrypted = input.apiKey ? encrypt(input.apiKey) : '';
  if (!apiKeyEncrypted && input.copyKeyFromAgentId) {
    const source = await findAgentById(input.copyKeyFromAgentId);
    if (source?.apiKeyEncrypted) apiKeyEncrypted = source.apiKeyEncrypted;
  }

  const agent = await insertAgent({
    id,
    name: input.name,
    systemPrompt: input.systemPrompt ?? '',
    model: input.model ?? 'claude-sonnet-4-6',
    apiKeyEncrypted,
    telegramKeyEncrypted: input.telegramKey ? encrypt(input.telegramKey) : '',
    telegramChatId: input.telegramChatId ?? '',
    suppressionToken: generateSuppressionToken(),
  });

  log.info({ agentId: id }, 'Agent created — provisioning default tools');

  // Auto-provision web_fetch tool
  await insertTool({
    id: uuidv4(),
    agentId: id,
    name: 'web_fetch',
    description:
      'Fetch the content of any URL and return the raw text. Use for reading web pages, APIs, or public documents.',
    toolType: 'web_fetch',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
      },
      required: ['url'],
    }),
    code: '',
  });

  // Auto-provision all browser extension primitives
  for (const tool of DEFAULT_TOOLS) {
    await insertTool({
      id: uuidv4(),
      agentId: id,
      name: tool.name,
      description: tool.description,
      toolType: tool.toolType,
      inputSchema: JSON.stringify(tool.inputSchema),
      code: tool.code,
    });
  }

  // Start Telegram polling if a token is present
  if (agent.telegramKeyEncrypted) {
    const token = decrypt(agent.telegramKeyEncrypted);
    if (token) startTelegramPolling(agent.id, token, agent.telegramChatId ?? '');
  }

  return toPublicAgent(agent);
}

export interface UpdateAgentInput {
  name?: string;
  systemPrompt?: string;
  model?: string;
  apiKey?: string;
  telegramKey?: string;
  telegramChatId?: string;
  profileBlob?: string | null;
}

export async function updateAgentById(id: string, input: UpdateAgentInput) {
  const existing = await findAgentById(id);
  if (!existing) return null;

  const patch: Parameters<typeof updateAgent>[1] = {
    updatedAt: new Date().toISOString(),
  };
  if (input.name !== undefined) patch.name = input.name;
  if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
  if (input.model !== undefined) patch.model = input.model;
  if (input.apiKey !== undefined) {
    patch.apiKeyEncrypted = input.apiKey ? encrypt(input.apiKey) : existing.apiKeyEncrypted;
  }
  if (input.telegramKey !== undefined) {
    patch.telegramKeyEncrypted = input.telegramKey
      ? encrypt(input.telegramKey)
      : existing.telegramKeyEncrypted;
  }
  if (input.telegramChatId !== undefined) patch.telegramChatId = input.telegramChatId;
  if (input.profileBlob !== undefined) {
    patch.profileBlob = input.profileBlob;
    if (input.profileBlob !== null) patch.profileBlobUpdatedAt = new Date().toISOString();
  }

  const agent = await updateAgent(id, patch);

  // Restart or stop Telegram polling based on new token state
  if (agent.telegramKeyEncrypted) {
    const token = decrypt(agent.telegramKeyEncrypted);
    if (token) startTelegramPolling(agent.id, token, agent.telegramChatId ?? '');
    else stopTelegramPolling(agent.id);
  } else {
    stopTelegramPolling(agent.id);
  }

  log.info({ agentId: id }, 'Agent updated');
  return toPublicAgent(agent);
}

export async function removeAgent(id: string): Promise<boolean> {
  const existing = await findAgentById(id);
  if (!existing) return false;
  stopTelegramPolling(id);
  await deleteAgent(id);
  log.info({ agentId: id }, 'Agent deleted');
  return true;
}
