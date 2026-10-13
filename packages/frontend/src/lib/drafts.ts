/**
 * drafts.ts — Generic localStorage draft persistence service
 *
 * Provides a single `drafts` object with typed save/load/clear/list methods.
 * Every entry is automatically stamped with a `savedAt` timestamp, and
 * entries older than 7 days are silently discarded on load.
 *
 * Key namespaces live in `drafts.keys` so callers never hard-code strings.
 *
 * Usage:
 *   drafts.save(drafts.keys.onboarding, { agentId, ... });
 *   const ob = drafts.load<OnboardingDraft>(drafts.keys.onboarding);
 *   drafts.clear(drafts.keys.onboarding);
 *
 *   drafts.save(drafts.keys.generator(agentId), { agentId, ... });
 *   const gd = drafts.load<GeneratorDraft>(drafts.keys.generator(agentId));
 *   const all = drafts.list<GeneratorDraft>(drafts.keys.generatorPrefix);
 */

const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const drafts = {
  // ── Key namespace ────────────────────────────────────────────────────────

  keys: {
    /** Single global onboarding draft key */
    onboarding: 'agentspawner:onboarding-current',

    /** Per-agent generator draft key */
    generator(agentId: string): string {
      return `agentspawner:generator:${agentId}`;
    },

    /** Prefix used to enumerate all generator drafts */
    generatorPrefix: 'agentspawner:generator:',

    /** Per-agent session facts — facts discovered while building flows, expire after 24h */
    sessionFacts(agentId: string): string {
      return `agentspawner:session-facts:${agentId}`;
    },
  },

  // ── Core methods ─────────────────────────────────────────────────────────

  /**
   * Save `data` under `key`.  A `savedAt` ISO timestamp is merged into the
   * stored object automatically (overwriting any existing `savedAt` field).
   */
  save<T extends object>(key: string, data: T): void {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ ...data, savedAt: new Date().toISOString() }),
      );
    } catch {
      // Quota exceeded or private-mode — silently ignore
    }
  },

  /**
   * Load the entry at `key` and return it as `T`, or `null` if:
   *   - the key is missing,
   *   - the JSON is malformed,
   *   - the entry is older than 7 days (stale entry is also removed).
   */
  load<T extends { savedAt?: string }>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const item = JSON.parse(raw) as T;
      if (item.savedAt) {
        const age = Date.now() - new Date(item.savedAt).getTime();
        if (age > DRAFT_TTL_MS) {
          try { localStorage.removeItem(key); } catch { /* ignore */ }
          return null;
        }
      }
      return item;
    } catch {
      return null;
    }
  },

  /** Remove the entry at `key` (no-op if absent). */
  clear(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },

  /**
   * Return all entries whose key starts with `prefix`, applying the same
   * TTL and parse-error filtering as `load`.
   */
  list<T extends { savedAt?: string }>(prefix: string): T[] {
    const out: T[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const item = drafts.load<T>(key);
        if (item !== null) out.push(item);
      }
    } catch {
      // Safari private mode — localStorage.length throws
    }
    return out;
  },
} as const;
