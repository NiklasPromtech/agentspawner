import { runExtensionTool } from './tool-types/extension.js';
import { runWebFetch } from './tool-types/web-fetch.js';
import { runLocalTool } from './tool-types/local.js';
import { runBuiltinTool } from './tool-types/builtin.js';

export interface ToolRecord {
  id: string;
  name: string;
  toolType: string;
  code: string;
}

export interface RunToolOptions {
  /** True when this step's output will be consumed by a downstream step rather
   *  than returned directly to the agent.  Relaxes the web_fetch response cap
   *  so filtering/transform steps receive the full payload. */
  isMidPipeline?: boolean;
}

// ── Poll-until helper ─────────────────────────────────────────────────────────
// Retries `fn` every `intervalMs` until `isReady` returns true or `timeoutMs` elapses.
// Returns the last result regardless — the caller decides what to do with it.

async function pollUntil<T>(
  fn: () => Promise<T>,
  isReady: (r: T) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!isReady(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, deadline - Date.now())));
    last = await fn();
  }
  return last;
}

// ── DOM filter helper (used by get_dom_filtered) ──────────────────────────────

const KEEP_ATTRS = new Set([
  'href', 'src', 'alt', 'aria-label', 'aria-hidden',
  'id', 'type', 'name', 'value', 'placeholder', 'title',
]);

function coerceHtml(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (typeof r['html'] === 'string') return r['html'];
  }
  return String(raw ?? '');
}

function applyLightDomFilter(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applyDomFilter(raw: unknown): string {
  const html = coerceHtml(raw);
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g, (_match, tagName: string, attrStr = '') => {
      let kept = '';
      for (const attr of KEEP_ATTRS) {
        const m = (attrStr as string).match(new RegExp(`\\s${attr}=["']([^"']*)["']`, 'i'));
        if (m) kept += ` ${attr}="${m[1]}"`;
      }
      return `<${tagName}${kept}>`;
    })
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 50_000);
}

// ─────────────────────────────────────────────────────────────────────────────

export async function runTool(
  tool: ToolRecord,
  input: Record<string, unknown>,
  agentId: string,
  options?: RunToolOptions,
): Promise<string> {
  // wait_ms must always run server-side regardless of the DB toolType value —
  // the extension content script may not be injected yet when this step fires.
  if (tool.name === 'wait_ms') {
    const ms = typeof input['ms'] === 'number' ? Math.min(input['ms'], 30_000) : 1_000;
    await new Promise((r) => setTimeout(r, ms));
    return JSON.stringify({ waited: ms });
  }

  // get_dom_filtered — fetches DOM via extension then filters server-side.
  // The 50k cap is applied to the filtered output, not the raw HTML.
  // Implicit wait: retries until the filtered HTML is non-empty, up to `timeout` ms (default 10s).
  if (tool.name === 'get_dom_filtered') {
    const tabId = input['tabId'];
    if (typeof tabId !== 'number') {
      return JSON.stringify({ error: 'get_dom_filtered requires a numeric tabId' });
    }
    const extInput: Record<string, unknown> = { tabId };
    if (input['selector']) extInput['selector'] = input['selector'];
    const timeoutMs = typeof input['timeout'] === 'number' ? input['timeout'] : 10_000;

    const attempt = async (): Promise<{ html: string }> => {
      const raw = await runExtensionTool('get_dom_raw', extInput, '');
      let htmlStr: string;
      try { htmlStr = (JSON.parse(raw) as Record<string, unknown>)['html'] as string ?? raw; }
      catch { htmlStr = raw; }
      return { html: applyDomFilter(htmlStr) };
    };

    const result = await pollUntil(attempt, (r) => r.html.trim().length > 0, timeoutMs);
    return JSON.stringify(result);
  }

  // get_dom_filtered_all — querySelectorAll via extension, applyDomFilter per element server-side.
  // Returns { items: string[], count: number } where each item is filtered HTML capped at 10k chars.
  // Implicit wait: retries until at least one element is found, up to `timeout` ms (default 10s).
  if (tool.name === 'get_dom_filtered_all') {
    const tabId = input['tabId'];
    if (typeof tabId !== 'number') {
      return JSON.stringify({ error: 'get_dom_filtered_all requires a numeric tabId' });
    }
    if (!input['selector']) {
      return JSON.stringify({ error: 'get_dom_filtered_all requires a selector' });
    }
    const extInput: Record<string, unknown> = { tabId, selector: input['selector'] };
    if (input['limit']) extInput['limit'] = input['limit'];
    const timeoutMs = typeof input['timeout'] === 'number' ? input['timeout'] : 10_000;

    const attempt = async (): Promise<{ items: string[]; count: number } | { error: string }> => {
      const raw = await runExtensionTool('get_dom_raw_all', extInput, '');
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; }
      catch { return { error: 'failed to parse extension response' }; }
      if (parsed['error']) return parsed as { error: string };
      const rawItems = Array.isArray(parsed['items']) ? parsed['items'] as string[] : [];
      const items = rawItems.map((html) => applyDomFilter(html).slice(0, 10_000));
      return { items, count: items.length };
    };

    const result = await pollUntil(attempt, (r) => !('error' in r) && (r as { count: number }).count > 0, timeoutMs);
    return JSON.stringify(result);
  }

  // get_dom_filtered_all_contains — like get_dom_filtered_all but only returns elements
  // whose filtered HTML includes the `contains` string (case-sensitive substring match).
  // Implicit wait: retries until at least one element passes BOTH the selector AND the contains
  // filter, up to `timeout` ms (default 10s). This is intentional — waiting for the selector
  // alone is not sufficient; the content you care about must also be present.
  if (tool.name === 'get_dom_filtered_all_contains') {
    const tabId = input['tabId'];
    if (typeof tabId !== 'number') {
      return JSON.stringify({ error: 'get_dom_filtered_all_contains requires a numeric tabId' });
    }
    if (!input['selector']) {
      return JSON.stringify({ error: 'get_dom_filtered_all_contains requires a selector' });
    }
    if (!input['contains']) {
      return JSON.stringify({ error: 'get_dom_filtered_all_contains requires a contains string' });
    }
    const contains = String(input['contains']);
    const extInput: Record<string, unknown> = { tabId, selector: input['selector'] };
    if (input['limit']) extInput['limit'] = input['limit'];
    const timeoutMs = typeof input['timeout'] === 'number' ? input['timeout'] : 10_000;

    const attempt = async (): Promise<{ items: string[]; count: number } | { error: string }> => {
      const raw = await runExtensionTool('get_dom_raw_all', extInput, '');
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; }
      catch { return { error: 'failed to parse extension response' }; }
      if (parsed['error']) return parsed as { error: string };
      const rawItems = Array.isArray(parsed['items']) ? parsed['items'] as string[] : [];
      const items: string[] = [];
      for (const html of rawItems) {
        const filtered = applyDomFilter(html).slice(0, 10_000);
        if (filtered.includes(contains)) items.push(filtered);
      }
      return { items, count: items.length };
    };

    const result = await pollUntil(attempt, (r) => !('error' in r) && (r as { count: number }).count > 0, timeoutMs);
    return JSON.stringify(result);
  }

  // scroll_load — always routes to the extension primitive regardless of DB toolType
  if (tool.name === 'scroll_load') {
    return runExtensionTool('scroll_load', input, '');
  }

  // get_dom — apply light filter (strips head/script/style/svg/comments) server-side
  // before returning. Class names and all other attributes stay intact.
  if (tool.name === 'get_dom') {
    const raw = await runExtensionTool('get_dom', input, '');
    let html: string;
    try { html = (JSON.parse(raw) as Record<string, unknown>)['html'] as string ?? raw; }
    catch { html = raw; }
    return JSON.stringify({ html: applyLightDomFilter(html).slice(0, 50_000) });
  }

  switch (tool.toolType) {
    case 'extension':
      return runExtensionTool(tool.name, input, tool.code ?? '');

    case 'web_fetch':
      return runWebFetch(input, options);

    case 'local':
      return runLocalTool(tool.code, input, agentId);

    case 'builtin':
      // tool.code holds the builtin name (e.g. "vision_check", "screenshot")
      return runBuiltinTool(tool.code, input, agentId);

    case 'web_search':
      // web_search is handled natively by Anthropic; we shouldn't get here
      return JSON.stringify({ error: 'web_search is handled natively by the API' });

    default:
      return JSON.stringify({ error: `Unknown tool type: ${tool.toolType}` });
  }
}
