import { getDb } from '../db/index.js';
import { agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../crypto/index.js';
import { logger } from './logger.js';
import Anthropic from '@anthropic-ai/sdk';

// ── OPERATION VANTAGE Task 4 ──────────────────────────────────────────────────

/**
 * Both layers of tone context for an agent:
 *  - `toneGuide`   — learned corrections from human reviewer edits (override layer)
 *  - `profileTone` — base tone bullets parsed from the system prompt via profileBlob
 */
export interface ToneContext {
  toneGuide: string[];    // override layer — highest priority
  profileTone: string[];  // base layer — from profileBlob.tone
}

/**
 * Pull both tone layers for an agent in a single DB query.
 * Safe to call from any context — returns empty arrays if data is missing/invalid.
 */
export async function getToneContext(agentId: string): Promise<ToneContext> {
  const db = getDb();
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agent) return { toneGuide: [], profileTone: [] };

  let toneGuide: string[] = [];
  if (agent.toneGuide) {
    try {
      const parsed = JSON.parse(agent.toneGuide) as unknown;
      if (Array.isArray(parsed)) toneGuide = parsed as string[];
    } catch { /* malformed JSON — skip */ }
  }

  let profileTone: string[] = [];
  if (agent.profileBlob) {
    try {
      const blob = JSON.parse(agent.profileBlob) as Record<string, unknown>;
      if (Array.isArray(blob.tone)) profileTone = blob.tone as string[];
    } catch { /* malformed JSON — skip */ }
  }

  return { toneGuide, profileTone };
}

/**
 * Regenerate the tone guide for an agent from its accumulated edit pairs.
 * Fire-and-forget — callers should not await unless they need the result.
 *
 * ── OPERATION CONVERGENCE Task 8 — transactional note ────────────────────────
 * The full pattern here is: read agent → call Anthropic → update toneGuide.
 * A single DB transaction cannot span the async Anthropic API call in the middle,
 * so the read and write are necessarily separate statements.  This is safe in
 * practice because:
 *   1. The agent record is only read to extract the API key — the key doesn't
 *      change during normal operation.
 *   2. The toneGuide update is a single UPDATE statement and is atomic by itself.
 *   3. The worst-case failure (crash between Anthropic response and DB write)
 *      leaves toneGuide unchanged, which is correct — no partial state possible.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function refreshToneGuide(
  agentId: string,
  editPairs: { draft: string; final: string }[],
): Promise<void> {
  const db = getDb();
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return;
  const apiKey = decrypt(agent.apiKeyEncrypted);
  if (!apiKey) return;

  const pairsText = editPairs
    .slice(-20)
    .map(
      (p, i) =>
        `Edit ${i + 1}:\nAGENT wrote: "${p.draft.slice(0, 500)}"\nHUMAN changed to: "${p.final.slice(0, 500)}"`,
    )
    .join('\n\n');

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `Below are ${editPairs.length} examples where a human edited AI-generated text before approving it. Identify the consistent patterns in what the human changed — tone, voice, style, length, vocabulary, honesty, personal vs. formal.

Output a tone guide as a JSON array of 4-8 bullet strings (no commentary, just the array):
["bullet 1", "bullet 2", ...]

Edit examples:
${pairsText}`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const bullets = JSON.parse(arrayMatch[0]) as string[];
      // Success — save bullets and clear any previous error state
      await db
        .update(agents)
        .set({
          toneGuide: JSON.stringify(bullets),
          toneGuideUpdatedAt: new Date().toISOString(),
          toneRefreshError: null,
          toneRefreshErrorAt: null,
        })
        .where(eq(agents.id, agentId));
    } else {
      // Anthropic responded but the output wasn't a parseable JSON array
      const parseError = 'Tone guide refresh succeeded but response could not be parsed as a JSON array.';
      logger.error({ agentId, text }, parseError);
      await db
        .update(agents)
        .set({ toneRefreshError: parseError, toneRefreshErrorAt: new Date().toISOString() })
        .where(eq(agents.id, agentId));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, agentId }, 'ToneGuide: failed to refresh');
    // Persist the error so the frontend can surface it to the user
    await db
      .update(agents)
      .set({ toneRefreshError: message, toneRefreshErrorAt: new Date().toISOString() })
      .where(eq(agents.id, agentId))
      .catch(() => { /* best-effort — don't throw from a catch block */ });
  }
}
