/**
 * API Tool Runner
 *
 * Executes custom API tools of two types:
 *  - 'script' : sandboxed Node.js/JS with access to fetch + secrets + input
 *  - 'http'   : configured HTTP request with {{secrets.KEY}} / {{input.field}} templating
 */

import vm from 'vm';

export interface ApiToolConfig {
  // script type
  code?: string;
  // http type
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

/**
 * Run a single API tool with the given input and resolved secrets.
 */
export async function runApiTool(
  type: string,
  config: ApiToolConfig,
  input: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<unknown> {
  if (type === 'http') {
    return runHttpTool(config, input, secrets);
  }
  return runScriptTool(config.code ?? '', input, secrets);
}

// ── HTTP tool ────────────────────────────────────────────────────────────────

function substitute(template: string, input: Record<string, unknown>, secrets: Record<string, string>): string {
  return template.replace(/\{\{(secrets|input)\.([^}]+)\}\}/g, (_, source: string, key: string) => {
    if (source === 'secrets') return secrets[key] ?? '';
    if (source === 'input') return String(input[key] ?? '');
    return '';
  });
}

async function runHttpTool(
  config: ApiToolConfig,
  input: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<unknown> {
  const method = config.method ?? 'GET';
  const url = substitute(config.url ?? '', input, secrets);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    headers[k] = substitute(v, input, secrets);
  }
  const rawBody = config.body ? substitute(config.body, input, secrets) : undefined;

  const res = await fetch(url, {
    method,
    headers,
    body: rawBody ?? undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ── Script tool ──────────────────────────────────────────────────────────────

async function runScriptTool(
  code: string,
  input: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<unknown> {
  // Build a safe sandbox — no process, no require, no fs
  const sandbox = vm.createContext({
    input,
    secrets,
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    console: {
      log: (...a: unknown[]) => process.stdout.write('[api-tool] ' + a.join(' ') + '\n'),
      warn: (...a: unknown[]) => process.stderr.write('[api-tool:warn] ' + a.join(' ') + '\n'),
      error: (...a: unknown[]) => process.stderr.write('[api-tool:err] ' + a.join(' ') + '\n'),
    },
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    // block dangerous globals
    process: undefined,
    require: undefined,
    module: undefined,
    __dirname: undefined,
    __filename: undefined,
    globalThis: undefined,
    global: undefined,
  });

  // Wrap in async IIFE so `return` and `await` both work at the top level of user code
  const wrapped = `(async () => { ${code} })()`;

  try {
    const script = new vm.Script(wrapped, { filename: 'api-tool' });
    // runInContext is synchronous for the script compilation but the IIFE returns a Promise
    const promise = script.runInContext(sandbox) as Promise<unknown>;

    // Apply a 30 s wall-clock timeout
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Script execution timed out (30 s)')), 30_000),
    );
    return await Promise.race([promise, timeout]);
  } catch (err) {
    throw new Error(`Script error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
