/**
 * inject_rows — Bulk-insert rows into a table from a stored API response.
 *
 * The agent writes a mapping script that transforms each item from the response
 * into a table row. The script runs in the same VM sandbox as API tool scripts.
 *
 * Usage by the agent:
 *   inject_rows({
 *     request_id: "abc-123",       // from api_request_log
 *     table_id: "tbl-456",         // target table
 *     path: "articles",            // dot-path to the array in the response (e.g. "articles" or "data.results")
 *     indices: [0, 1, 3, 5],       // which items to insert (optional — all if omitted)
 *     script: `return {            // mapping script — `item` is the current array element, `index` is its position
 *       article_url: item.url,
 *       headline: item.title,
 *       author_name: item.author,
 *       topic_tags: "politics",
 *     }`
 *   })
 */

import vm from 'vm';
import { getDb } from '../../db/index.js';
import { apiRequestLog, rows } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export interface InjectRowsInput {
  request_id: string;
  table_id: string;
  /** Dot-path to the array in the response JSON. e.g. "articles" or "data.results". If omitted, treats the entire response as the array. */
  path?: string;
  /** Which indices to process. If omitted, processes all items in the array. */
  indices?: number[];
  /** JS mapping script. Receives `item` (current element) and `index` (position). Must return an object matching the table columns. */
  script: string;
  /** Optional run/flow attribution */
  runId?: string;
  flowRunId?: string;
}

export interface InjectRowsResult {
  ok: boolean;
  inserted: number;
  failed: number;
  errors: Array<{ index: number; error: string }>;
  rowIds: string[];
}

/**
 * Resolve a dot-path on an object: "data.results" → obj.data.results
 */
function resolvePath(obj: unknown, path: string): unknown {
  let current = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Run a mapping script against a single item in the sandbox.
 */
function runMappingScript(script: string, item: unknown, index: number): Record<string, unknown> {
  const sandbox = vm.createContext({
    item,
    index,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    // block dangerous globals
    process: undefined,
    require: undefined,
    module: undefined,
    globalThis: undefined,
    global: undefined,
    fetch: undefined,
  });

  const wrapped = `(function() { ${script} })()`;
  const vmScript = new vm.Script(wrapped, { filename: 'inject-rows-mapping' });
  const result = vmScript.runInContext(sandbox);

  if (!result || typeof result !== 'object') {
    throw new Error(`Mapping script must return an object, got ${typeof result}`);
  }
  return result as Record<string, unknown>;
}

/**
 * Execute inject_rows: load stored response, run mapping script per item, bulk-insert.
 */
export async function executeInjectRows(
  agentId: string,
  input: InjectRowsInput,
): Promise<InjectRowsResult> {
  const db = getDb();

  // Load the stored response
  const [requestRow] = await db.select().from(apiRequestLog)
    .where(and(eq(apiRequestLog.id, input.request_id), eq(apiRequestLog.agentId, agentId)));

  if (!requestRow) {
    return { ok: false, inserted: 0, failed: 0, errors: [{ index: -1, error: `Request "${input.request_id}" not found` }], rowIds: [] };
  }

  let responseData: unknown;
  try {
    responseData = JSON.parse(requestRow.response);
  } catch {
    return { ok: false, inserted: 0, failed: 0, errors: [{ index: -1, error: 'Failed to parse stored response as JSON' }], rowIds: [] };
  }

  // Resolve the array from the response
  let items: unknown[];
  if (input.path) {
    const resolved = resolvePath(responseData, input.path);
    if (!Array.isArray(resolved)) {
      return { ok: false, inserted: 0, failed: 0, errors: [{ index: -1, error: `Path "${input.path}" does not point to an array (got ${typeof resolved})` }], rowIds: [] };
    }
    items = resolved;
  } else if (Array.isArray(responseData)) {
    items = responseData;
  } else {
    // Try to find the first array-valued property
    const obj = responseData as Record<string, unknown>;
    const arrayKey = Object.keys(obj).find((k) => Array.isArray(obj[k]));
    if (arrayKey) {
      items = obj[arrayKey] as unknown[];
    } else {
      return { ok: false, inserted: 0, failed: 0, errors: [{ index: -1, error: 'Response is not an array and no array found at top level. Specify a "path".' }], rowIds: [] };
    }
  }

  // Determine which indices to process
  const indicesToProcess = input.indices ?? items.map((_, i) => i);

  const result: InjectRowsResult = { ok: true, inserted: 0, failed: 0, errors: [], rowIds: [] };

  for (const idx of indicesToProcess) {
    if (idx < 0 || idx >= items.length) {
      result.errors.push({ index: idx, error: `Index ${idx} out of bounds (array has ${items.length} items)` });
      result.failed++;
      continue;
    }

    try {
      const rowData = runMappingScript(input.script, items[idx], idx);
      const rowId = uuidv4();
      await db.insert(rows).values({
        id: rowId,
        tableId: input.table_id,
        data: JSON.stringify(rowData),
        runId: input.runId ?? null,
        flowRunId: input.flowRunId ?? null,
      });
      result.rowIds.push(rowId);
      result.inserted++;
    } catch (err) {
      result.errors.push({ index: idx, error: err instanceof Error ? err.message : String(err) });
      result.failed++;
    }
  }

  result.ok = result.failed === 0;
  return result;
}
