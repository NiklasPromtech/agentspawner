import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/index.js';
import { memory } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../lib/logger.js';
import { v4 as uuidv4 } from 'uuid';

interface StoreToMemoryParams {
  raw: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  agentId: string;
  agentName: string;
  apiKey: string;
}

const TRIVIAL_PATTERNS = [
  /^\s*\{"success"\s*:\s*true\}/,
  /^\s*\{"closed"\s*:\s*true\}/,
  /^\s*\{"navigated"\s*:\s*true\}/,
  /^\s*\{"ok"\s*:\s*true\}/,
  /^\s*\{"clicked"\s*:\s*true\}/,
  /^\s*\{"typed"\s*:\s*true\}/,
  /^\s*\{"scrolled"\s*:\s*true\}/,
];

export async function storeToMemory({
  raw,
  toolName,
  toolInput,
  agentId,
  agentName,
  apiKey,
}: StoreToMemoryParams): Promise<void> {
  // Skip trivial results
  if (raw.length < 60) return;
  if (TRIVIAL_PATTERNS.some((p) => p.test(raw))) return;

  // Dedup via sha256
  const rawHash = crypto.createHash('sha256').update(raw).digest('hex');
  const db = getDb();
  const existing = await db.select().from(memory).where(eq(memory.rawHash, rawHash));
  if (existing.length > 0) return;

  // Call Haiku to enrich
  const client = new Anthropic({ apiKey });
  const inputPreview = JSON.stringify(toolInput).slice(0, 300);

  // Retry up to 3 times with exponential backoff on 529 overloaded errors
  let response: Anthropic.Message | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [
          {
            role: 'user',
            content: `Tool: ${toolName}, Input: ${inputPreview}\nResult: ${raw.slice(0, 3000)}\n\nReturn JSON only:\n{"store":bool,"entities":["@handle",...],"category":"profile|post|interaction|research|market_data|web_content|data|other","content":"1-3 sentence summary","metadata":{}}\nOnly store if genuinely informative. Entities must include @ prefix for social handles.`,
          },
        ],
      });
      break; // success
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 529 && attempt < 2) {
        const delayMs = 2000 * Math.pow(2, attempt); // 2s, 4s
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      // Non-retryable error or exhausted retries — log quietly and give up
      if (status !== 529) logger.error({ err }, 'Librarian: Haiku call failed');
      return;
    }
  }
  if (!response) return;

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Extract JSON (handle markdown code fences)
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return;

  let parsed: { store: boolean; entities?: string[]; category?: string; content?: string; metadata?: Record<string, unknown> };
  try {
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch {
    return;
  }

  if (!parsed.store) return;
  if (!parsed.content) return;

  const sourceUrl = typeof toolInput.url === 'string' ? toolInput.url : undefined;

  await db.insert(memory).values({
    id: uuidv4(),
    content: parsed.content,
    category: parsed.category ?? 'other',
    entities: JSON.stringify(parsed.entities ?? []),
    sourceAgentId: agentId,
    sourceAgentName: agentName,
    sourceTool: toolName,
    sourceUrl: sourceUrl ?? null,
    metadata: JSON.stringify(parsed.metadata ?? {}),
    rawHash,
  });
}
