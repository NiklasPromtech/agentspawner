import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Tool } from '../../types/index.js';
import ToolEditor from './ToolEditor.js';

interface Props {
  agent: Agent;
}

// ── Built-in primitive definitions ────────────────────────────────────────────

interface PrimitiveDef {
  name: string;
  description: string;
  category: string;
  inputSchema: string;
  code: string;
}

const PRIMITIVES: PrimitiveDef[] = [
  {
    name: 'open_tab',
    category: 'Navigation',
    description: 'Open a new browser tab and return its tabId',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
        active: { type: 'boolean', description: 'Make the tab active (default: true)', default: true },
      },
      required: ['url'],
    }),
    code: [
      'const tabId = await tab.open(input.url, input.active !== false);',
      'return { tabId };',
    ].join('\n'),
  },
  {
    name: 'close_tab',
    category: 'Navigation',
    description: 'Close a browser tab by its tabId',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to close' },
      },
      required: ['tabId'],
    }),
    code: [
      'await tab.close(input.tabId);',
      'return { closed: true };',
    ].join('\n'),
  },
  {
    name: 'navigate',
    category: 'Navigation',
    description: 'Navigate a tab to a URL and wait for page load',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to navigate' },
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['tabId', 'url'],
    }),
    code: [
      'await tab.navigate(input.tabId, input.url);',
      'await tab.waitForLoad(input.tabId);',
      'return { navigated: true, url: input.url };',
    ].join('\n'),
  },
  {
    name: 'wait_for',
    category: 'Waiting',
    description: 'Wait for a CSS selector to appear in a tab',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector to wait for' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 10)', default: 10 },
      },
      required: ['tabId', 'selector'],
    }),
    code: [
      'const start = Date.now();',
      'const timeout = (input.timeout || 10) * 1000;',
      'while (Date.now() - start < timeout) {',
      '  const found = await tab.domCheck(input.tabId, input.selector);',
      '  if (found) return { found: true, elapsed: Date.now() - start };',
      '  await tab.sleep(500);',
      '}',
      'return { found: false, elapsed: Date.now() - start };',
    ].join('\n'),
  },
  {
    name: 'wait_for_any',
    category: 'Waiting',
    description: 'Race multiple CSS selectors — returns the label of whichever appears first, or "timeout"',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID' },
        selectors: { type: 'array', description: 'Array of {selector, label} objects to race', items: { type: 'object' } },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default: 15000)', default: 15000 },
      },
      required: ['tabId', 'selectors'],
    }),
    code: [
      'const result = await tab.waitForAny(input.tabId, input.selectors, input.timeoutMs || 15000);',
      'return result.label;',
    ].join('\n'),
  },
  {
    name: 'click',
    category: 'Interaction',
    description: 'Click an element matching a CSS selector',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of element to click' },
      },
      required: ['tabId', 'selector'],
    }),
    code: 'return await tab.domClick(input.tabId, input.selector);',
  },
  {
    name: 'type_text',
    category: 'Interaction',
    description: 'Type text into an input field',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of input element' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['tabId', 'selector', 'text'],
    }),
    code: 'return await tab.domType(input.tabId, input.selector, input.text);',
  },
  {
    name: 'scroll',
    category: 'Interaction',
    description: 'Scroll a tab — by pixels or scroll an element into view',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector to scroll into view (takes priority over x/y)' },
        x: { type: 'number', description: 'Horizontal scroll pixels (default: 0)', default: 0 },
        y: { type: 'number', description: 'Vertical scroll pixels (default: 300)', default: 300 },
      },
      required: ['tabId'],
    }),
    code: 'return await tab.domScroll(input.tabId, input.selector || null, Number(input.x) || 0, Number(input.y) || 300);',
  },
  {
    name: 'get_dom',
    category: 'Reading',
    description: 'Return the outer HTML of an element or the full page',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector (omit for full document)' },
      },
      required: ['tabId'],
    }),
    code: [
      'const html = await tab.domGet(input.tabId, input.selector || null);',
      'return { html, length: typeof html === "string" ? html.length : 0 };',
    ].join('\n'),
  },
  {
    name: 'screenshot',
    category: 'Capture',
    description: 'Capture a screenshot of a tab (returned as a PNG data URL)',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to screenshot' },
      },
      required: ['tabId'],
    }),
    code: [
      'const dataUrl = await tab.screenshot(input.tabId);',
      'return { dataUrl };',
    ].join('\n'),
  },
  {
    name: 'execute_code',
    category: 'Code',
    description: 'Execute arbitrary JavaScript in a tab and return the result',
    inputSchema: JSON.stringify({
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        code: { type: 'string', description: 'JS code to execute (must include a return statement)' },
      },
      required: ['tabId', 'code'],
    }),
    code: 'return await tab.exec(input.tabId, input.code);',
  },
];

// ── Type colours & helpers ────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  extension: '#58a6ff',
  web_fetch: '#3fb950',
  web_search: '#d29922',
  local: '#bc8cff',
};

interface TestState {
  inputJson: string;
  running: boolean;
  result: string | null;
  error: string | null;
  durationMs: number | null;
}

function buildExampleInput(schemaJson: string): string {
  try {
    const schema = JSON.parse(schemaJson) as {
      properties?: Record<string, { type?: string; description?: string; default?: unknown }>;
      required?: string[];
    };
    const example: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(schema.properties ?? {})) {
      if (def.default !== undefined) { example[key] = def.default; continue; }
      switch (def.type) {
        case 'string': example[key] = ''; break;
        case 'number': case 'integer': example[key] = 0; break;
        case 'boolean': example[key] = false; break;
        case 'array': example[key] = []; break;
        default: example[key] = null;
      }
    }
    return JSON.stringify(example, null, 2);
  } catch {
    return '{}';
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ToolManagerTab({ agent }: Props) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [editing, setEditing] = useState<Tool | null | undefined>(undefined);
  const [testing, setTesting] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [loading, setLoading] = useState(true);
  const [primitivesOpen, setPrimitivesOpen] = useState(false);
  const [adding, setAdding] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getTools(agent.id).then(setTools).catch(console.error).finally(() => setLoading(false));
  }, [agent.id]);

  const installedNames = new Set(tools.map((t) => t.name));

  const addPrimitive = async (prim: PrimitiveDef) => {
    setAdding((prev) => new Set(prev).add(prim.name));
    try {
      const saved = await api.createTool(agent.id, {
        name: prim.name,
        description: prim.description,
        toolType: 'extension',
        inputSchema: prim.inputSchema,
        code: prim.code,
      });
      setTools((prev) => [...prev, saved]);
    } catch (err) {
      alert(`Failed to add ${prim.name}: ${(err as Error).message}`);
    } finally {
      setAdding((prev) => { const s = new Set(prev); s.delete(prim.name); return s; });
    }
  };

  const addAllPrimitives = async () => {
    for (const prim of PRIMITIVES) {
      if (!installedNames.has(prim.name)) await addPrimitive(prim);
    }
  };

  const openTest = (tool: Tool) => {
    setTesting((prev) => (prev === tool.id ? null : tool.id));
    setTestStates((prev) => ({
      ...prev,
      [tool.id]: prev[tool.id] ?? {
        inputJson: buildExampleInput(tool.inputSchema),
        running: false,
        result: null,
        error: null,
        durationMs: null,
      },
    }));
  };

  const runTest = async (tool: Tool) => {
    const state = testStates[tool.id];
    if (!state) return;

    let input: Record<string, unknown>;
    try {
      input = JSON.parse(state.inputJson) as Record<string, unknown>;
    } catch {
      setTestStates((prev) => ({ ...prev, [tool.id]: { ...state, error: 'Input is not valid JSON', result: null } }));
      return;
    }

    setTestStates((prev) => ({ ...prev, [tool.id]: { ...state, running: true, result: null, error: null, durationMs: null } }));

    try {
      const res = await api.testTool(agent.id, tool.id, input);
      setTestStates((prev) => ({
        ...prev,
        [tool.id]: {
          ...state,
          running: false,
          result: res.ok ? (res.result ?? 'null') : null,
          error: res.ok ? null : (res.error ?? 'Unknown error'),
          durationMs: res.durationMs,
        },
      }));
    } catch (err) {
      setTestStates((prev) => ({
        ...prev,
        [tool.id]: { ...state, running: false, result: null, error: (err as Error).message, durationMs: null },
      }));
    }
  };

  const handleDelete = async (tool: Tool) => {
    if (!confirm(`Delete tool "${tool.name}"?`)) return;
    try {
      await api.deleteTool(agent.id, tool.id);
      setTools((prev) => prev.filter((t) => t.id !== tool.id));
      if (testing === tool.id) setTesting(null);
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    }
  };

  if (editing !== undefined) {
    return (
      <ToolEditor
        agent={agent}
        tool={editing}
        onSave={(saved) => {
          setTools((prev) => {
            const idx = prev.findIndex((t) => t.id === saved.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
            return [...prev, saved];
          });
          setEditing(undefined);
        }}
        onCancel={() => setEditing(undefined)}
      />
    );
  }

  const uninstalledCount = PRIMITIVES.filter((p) => !installedNames.has(p.name)).length;

  return (
    <div style={{ padding: '1.5rem', maxWidth: 900 }}>

      {/* ── Primitives library ── */}
      <div style={{ marginBottom: '1.5rem', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        <button
          onClick={() => setPrimitivesOpen((o) => !o)}
          style={{
            width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '0.75rem 1.25rem', background: 'var(--surface)', border: 'none',
            cursor: 'pointer', textAlign: 'left',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
            {primitivesOpen ? '▼' : '▶'}&nbsp; Built-in Primitives
            <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: '0.5rem', fontSize: '0.8rem' }}>
              ({PRIMITIVES.length} available{uninstalledCount > 0 ? `, ${uninstalledCount} not installed` : ', all installed'})
            </span>
          </span>
          {primitivesOpen && uninstalledCount > 0 && (
            <span
              onClick={(e) => { e.stopPropagation(); void addAllPrimitives(); }}
              style={{
                fontSize: '0.8rem', padding: '0.25rem 0.75rem', borderRadius: 4,
                background: '#1f6feb', color: '#fff', cursor: 'pointer',
              }}
            >
              + Add All
            </span>
          )}
        </button>

        {primitivesOpen && (
          <div style={{ padding: '1rem 1.25rem', background: 'var(--bg)', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.6rem' }}>
            {PRIMITIVES.map((prim) => {
              const installed = installedNames.has(prim.name);
              const isAdding = adding.has(prim.name);
              return (
                <div
                  key={prim.name}
                  style={{
                    background: 'var(--surface)',
                    border: `1px solid ${installed ? '#3fb95044' : 'var(--border)'}`,
                    borderRadius: 6,
                    padding: '0.75rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.35rem',
                  }}
                >
                  <code style={{ fontSize: '0.82rem', fontWeight: 700, color: '#58a6ff' }}>{prim.name}</code>
                  <p style={{ fontSize: '0.78rem', color: 'var(--muted)', margin: 0, lineHeight: 1.4 }}>{prim.description}</p>
                  <button
                    onClick={() => void addPrimitive(prim)}
                    disabled={installed || isAdding}
                    style={{
                      marginTop: '0.25rem', fontSize: '0.75rem', padding: '0.25rem 0.5rem',
                      borderRadius: 4, border: '1px solid var(--border)', cursor: installed ? 'default' : 'pointer',
                      background: installed ? 'transparent' : '#1f6feb22',
                      color: installed ? '#3fb950' : 'var(--text)',
                    }}
                  >
                    {installed ? '✓ Installed' : isAdding ? 'Adding…' : '+ Add to Agent'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Installed tools ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Tools ({tools.length})</h3>
        <button
          onClick={() => setEditing(null)}
          style={{ background: '#238636', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1rem', fontSize: '0.875rem', cursor: 'pointer' }}
        >
          + Add Tool
        </button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading...</p>
      ) : tools.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--muted)' }}>
          <p>No tools yet. Add a tool or install primitives above.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {tools.map((tool) => {
            const ts = testStates[tool.id];
            const isOpen = testing === tool.id;
            return (
              <div
                key={tool.id}
                style={{
                  background: 'var(--surface)',
                  border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8,
                  overflow: 'hidden',
                }}
              >
                {/* Tool header row */}
                <div style={{ padding: '1rem 1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.4rem' }}>
                      <code style={{ fontSize: '0.9rem', fontWeight: 600 }}>{tool.name}</code>
                      <span style={{
                        fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: 3,
                        background: `${TYPE_COLORS[tool.toolType] ?? '#666'}22`,
                        color: TYPE_COLORS[tool.toolType] ?? '#666',
                        border: `1px solid ${TYPE_COLORS[tool.toolType] ?? '#666'}55`,
                      }}>
                        {tool.toolType}
                      </span>
                    </div>
                    <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{tool.description}</p>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', marginLeft: '1rem', flexShrink: 0 }}>
                    <button
                      onClick={() => openTest(tool)}
                      style={{ ...actionBtn, color: isOpen ? 'var(--accent)' : 'var(--muted)', borderColor: isOpen ? 'var(--accent)' : 'var(--border)' }}
                    >
                      {isOpen ? '▲ Test' : '▶ Test'}
                    </button>
                    <button onClick={() => setEditing(tool)} style={actionBtn}>Edit</button>
                    <button onClick={() => void handleDelete(tool)} style={{ ...actionBtn, color: 'var(--error)' }}>Delete</button>
                  </div>
                </div>

                {/* Test panel */}
                {isOpen && ts && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '1rem 1.25rem', background: 'var(--bg)' }}>
                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                      {/* Input */}
                      <div style={{ flex: 1 }}>
                        <label style={labelStyle}>Input (JSON)</label>
                        <textarea
                          value={ts.inputJson}
                          onChange={(e) => setTestStates((prev) => ({ ...prev, [tool.id]: { ...ts, inputJson: e.target.value } }))}
                          rows={Math.min(10, ts.inputJson.split('\n').length + 1)}
                          spellCheck={false}
                          style={{
                            width: '100%',
                            background: 'var(--surface)',
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            color: 'var(--text)',
                            padding: '0.5rem 0.75rem',
                            fontSize: '0.82rem',
                            fontFamily: 'monospace',
                            resize: 'vertical',
                          }}
                        />
                        <button
                          onClick={() => void runTest(tool)}
                          disabled={ts.running}
                          style={{
                            marginTop: '0.5rem',
                            background: ts.running ? '#21262d' : '#1f6feb',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            padding: '0.45rem 1.1rem',
                            fontSize: '0.875rem',
                            fontWeight: 500,
                            cursor: ts.running ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {ts.running ? '⏳ Running…' : '▶ Run Test'}
                        </button>
                      </div>

                      {/* Result */}
                      {(ts.result !== null || ts.error !== null) && (
                        <div style={{ flex: 1 }}>
                          <label style={labelStyle}>
                            Result {ts.durationMs !== null && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({ts.durationMs}ms)</span>}
                          </label>
                          <pre style={{
                            background: 'var(--surface)',
                            border: `1px solid ${ts.error ? '#f8514933' : '#3fb95033'}`,
                            borderRadius: 6,
                            padding: '0.6rem 0.75rem',
                            fontSize: '0.82rem',
                            fontFamily: 'monospace',
                            color: ts.error ? 'var(--error)' : 'var(--text)',
                            overflowX: 'auto',
                            maxHeight: 300,
                            overflowY: 'auto',
                            margin: 0,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}>
                            {ts.error ?? formatResult(ts.result!)}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatResult(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const actionBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  padding: '0.3rem 0.75rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.78rem',
  color: 'var(--muted)',
  fontWeight: 600,
  marginBottom: '0.35rem',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
