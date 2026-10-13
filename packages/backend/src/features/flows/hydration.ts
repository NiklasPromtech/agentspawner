// OPERATION VANTAGE — Task 3: __hydrate__ step logic
//
// Isolated hydration module so it can be unit-tested independently of the
// full flow runner.  The flow runner imports `hydrateActionBrief` and calls
// it when it encounters a step with toolId === '__hydrate__'.

import { getDb } from '../../db/index.js';
import { tools, memory, rows } from '../../db/schema.js';
import { eq, and, like, desc } from 'drizzle-orm';
import { runTool } from '../../orchestrator/tool-runner.js';
import { logger } from '../../lib/logger.js';
import {
  ActionBriefSchema,
} from '@agentspawner/shared';
import type {
  ActionBrief,
  HydratedContext,
  HydratedScrapeReference,
  HydratedDbReference,
  MemoryQueryResult,
} from '@agentspawner/shared';

// ── Public helpers ──────────────────────────────────────────────────────────

/**
 * Safely parse and validate an ActionBrief from an arbitrary value.
 * Returns `null` if the value does not conform to the ActionBrief schema.
 */
export function parseActionBrief(value: unknown): ActionBrief | null {
  const result = ActionBriefSchema.safeParse(value);
  if (!result.success) {
    logger.debug({ issues: result.error.issues }, 'parseActionBrief: validation failed');
    return null;
  }
  return result.data;
}

/**
 * Re-executes all references in an `ActionBrief` and assembles the full
 * `HydratedContext` that the `__generate__` step (Task 4) consumes.
 *
 * Three classes of reference are hydrated:
 *   1. `supporting_scrapes`  — each tool is looked up by name and re-run with
 *      the inputs Haiku specified.  Fresh data, not cached.
 *   2. `memory_queries`      — each key is used in a fuzzy entity search.
 *   3. `database_context`    — each table_id is queried for its most recent rows.
 *
 * All three are run concurrently (Promise.all) to keep latency low.
 *
 * Errors in individual references are caught and stored as `{ error: "..." }`
 * so a single bad reference cannot abort the whole hydration step.
 */
export async function hydrateActionBrief(
  brief: ActionBrief,
  agentId: string,
): Promise<HydratedContext> {
  const [hydratedScrapes, memoryResults, hydratedDbRefs] = await Promise.all([
    hydrateScrapes(brief, agentId),
    hydrateMemoryQueries(brief),
    hydrateDbRefs(brief),
  ]);

  return {
    action: brief.action,
    decision_context: {
      reason: brief.decision_context.reason,
      supporting_scrapes: hydratedScrapes,
      memory_queries: brief.decision_context.memory_queries,
      memory_results: memoryResults,
      database_context: hydratedDbRefs,
    },
  };
}

// ── Private helpers ─────────────────────────────────────────────────────────

async function hydrateScrapes(
  brief: ActionBrief,
  agentId: string,
): Promise<HydratedScrapeReference[]> {
  const db = getDb();
  return Promise.all(
    brief.decision_context.supporting_scrapes.map(async (ref) => {
      try {
        // Look up tool by name, scoped to this agent
        const [tool] = await db
          .select()
          .from(tools)
          .where(and(eq(tools.agentId, agentId), eq(tools.name, ref.tool)))
          .limit(1);

        if (!tool) {
          logger.warn({ agentId, toolName: ref.tool }, '__hydrate__: tool not found by name');
          return { ...ref, return: { error: `Tool "${ref.tool}" not found for agent` } };
        }

        const raw = await runTool(
          tool,
          ref.input as Record<string, unknown>,
          agentId,
          { isMidPipeline: true },
        );
        return { ...ref, return: tryParseJson(raw) };
      } catch (err) {
        logger.error({ err, toolName: ref.tool }, '__hydrate__: scrape execution failed');
        return {
          ...ref,
          return: {
            error: `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }),
  );
}

async function hydrateMemoryQueries(brief: ActionBrief): Promise<MemoryQueryResult[]> {
  const db = getDb();
  return Promise.all(
    brief.decision_context.memory_queries.map(async (query) => {
      try {
        const memRows = await db
          .select()
          .from(memory)
          .where(like(memory.entities, `%${query}%`))
          .orderBy(desc(memory.createdAt))
          .limit(10);
        return {
          query,
          results: memRows.map((r) => ({
            content: r.content,
            category: r.category,
            entities: r.entities,
            createdAt: r.createdAt,
          })),
        };
      } catch (err) {
        logger.error({ err, query }, '__hydrate__: memory query failed');
        return { query, results: [] };
      }
    }),
  );
}

async function hydrateDbRefs(brief: ActionBrief): Promise<HydratedDbReference[]> {
  const db = getDb();
  return Promise.all(
    brief.decision_context.database_context.map(async (ref) => {
      try {
        const tableRows = await db
          .select()
          .from(rows)
          .where(eq(rows.tableId, ref.table_id))
          .orderBy(desc(rows.createdAt))
          .limit(50);

        const parsed = tableRows.map((r) => {
          try {
            return JSON.parse(r.data) as unknown;
          } catch {
            return r.data as unknown;
          }
        });
        return { ...ref, return: parsed };
      } catch (err) {
        logger.error({ err, tableId: ref.table_id }, '__hydrate__: DB table query failed');
        return { ...ref, return: [] };
      }
    }),
  );
}

/** Parse JSON string from tool output; falls back to the raw value on failure. */
function tryParseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
