import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';
import type { Agent, ApiTool, AgentSecret, ApiToolType, HttpToolConfig, ScriptToolConfig } from '../../types/index.js';
import ApiToolDiscovery from '../../components/ApiToolDiscovery.js';

interface Props { agent: Agent }

const BLANK_TOOL: Omit<ApiTool, 'id' | 'agentId' | 'createdAt' | 'updatedAt'> = {
  name: '',
  description: '',
  inputSchema: '{"type":"object","properties":{},"required":[]}',
  type: 'script',
  config: JSON.stringify({ code: '// Write your script here.\n// Use `input` for tool arguments, `secrets` for API keys.\n// Return a value (can be an object, array, or string).\n// Example:\nconst res = await fetch(`https://api.example.com/data?q=${input.query}`, {\n  headers: { Authorization: `Bearer ${secrets.API_KEY}` }\n});\nreturn await res.json();\n' } satisfies ScriptToolConfig),
  enabled: true,
};

const BLANK_HTTP_CONFIG: HttpToolConfig = {
  method: 'GET',
  url: '',
  headers: { 'Content-Type': 'application/json' },
  body: null,
};

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: { display: 'flex', height: 'calc(100vh - 100px)' } as React.CSSProperties,
  sidebar: { width: 240, borderRight: '1px solid var(--border)', padding: '1rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' } as React.CSSProperties,
  main: { flex: 1, overflowY: 'auto', padding: '1.5rem' } as React.CSSProperties,
  sideHeader: { fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.25rem' } as React.CSSProperties,
  toolCard: (active: boolean): React.CSSProperties => ({
    padding: '0.6rem 0.75rem', borderRadius: 6, cursor: 'pointer',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--text)',
    border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  }),
  input: { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '0.4rem 0.6rem', fontSize: '0.875rem', boxSizing: 'border-box' } as React.CSSProperties,
  select: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '0.4rem 0.6rem', fontSize: '0.875rem' } as React.CSSProperties,
  label: { fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600, marginBottom: '0.3rem', display: 'block' } as React.CSSProperties,
  field: { marginBottom: '1rem' } as React.CSSProperties,
  row: { display: 'flex', gap: '0.75rem', alignItems: 'flex-start' } as React.CSSProperties,
  btn: (variant: 'primary' | 'ghost' | 'danger'): React.CSSProperties => ({
    padding: '0.4rem 0.9rem', borderRadius: 5, fontSize: '0.85rem', cursor: 'pointer',
    background: variant === 'primary' ? 'var(--accent)' : variant === 'danger' ? '#c0392b' : 'transparent',
    color: variant === 'ghost' ? 'var(--muted)' : '#fff',
    border: variant === 'ghost' ? '1px solid var(--border)' : 'none',
  } as React.CSSProperties),
  code: { width: '100%', background: '#0d0d0d', border: '1px solid var(--border)', borderRadius: 4, color: '#e8e8e8', padding: '0.75rem', fontSize: '0.82rem', fontFamily: 'monospace', lineHeight: 1.6, resize: 'vertical', minHeight: 220, boxSizing: 'border-box' } as React.CSSProperties,
  section: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.25rem', marginBottom: '1.5rem' } as React.CSSProperties,
  h3: { fontSize: '0.95rem', fontWeight: 700, marginBottom: '1rem', marginTop: 0 } as React.CSSProperties,
  result: (ok: boolean): React.CSSProperties => ({
    marginTop: '0.75rem', padding: '0.75rem', borderRadius: 5, fontSize: '0.82rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    background: ok ? '#0f2a1a' : '#2a0f0f', border: `1px solid ${ok ? '#2ecc71' : '#e74c3c'}`, color: ok ? '#2ecc71' : '#e74c3c',
  }),
  tag: (enabled: boolean): React.CSSProperties => ({
    fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: 3, fontWeight: 700,
    background: enabled ? '#1a3a1a' : '#2a1a1a', color: enabled ? '#2ecc71' : '#e74c3c',
  }),
};

// ── Main component ────────────────────────────────────────────────────────────

export default function ApiToolsTab({ agent }: Props) {
  const [tools, setTools] = useState<ApiTool[]>([]);
  const [secrets, setSecrets] = useState<AgentSecret[]>([]);
  const [selected, setSelected] = useState<ApiTool | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; result?: unknown; error?: string; durationMs: number } | null>(null);
  const [testInput, setTestInput] = useState('{}');
  // AI Assist
  const [assistOpen, setAssistOpen] = useState(false);
  const [assistPrompt, setAssistPrompt] = useState('');
  const [assisting, setAssisting] = useState(false);
  const [assistError, setAssistError] = useState('');
  // Secret form
  const [newSecretKey, setNewSecretKey] = useState('');
  const [newSecretValue, setNewSecretValue] = useState('');
  const [savingSecret, setSavingSecret] = useState(false);
  // Discovery mode
  const [discoveryOpen, setDiscoveryOpen] = useState(false);

  const load = useCallback(async () => {
    const [t, s] = await Promise.all([api.getApiTools(agent.id), api.getSecrets(agent.id)]);
    setTools(t);
    setSecrets(s);
    setLoading(false);
  }, [agent.id]);

  useEffect(() => { void load(); }, [load]);

  // ── Edit form state ────────────────────────────────────────────────────────

  const [form, setForm] = useState<Omit<ApiTool, 'id' | 'agentId' | 'createdAt' | 'updatedAt'>>(BLANK_TOOL);

  const openNew = () => {
    setForm(BLANK_TOOL);
    setSelected(null);
    setIsNew(true);
    setTestResult(null);
    setTestInput('{}');
  };

  const openTool = (t: ApiTool) => {
    setForm({ name: t.name, description: t.description, inputSchema: t.inputSchema, type: t.type, config: t.config, enabled: t.enabled });
    setSelected(t);
    setIsNew(false);
    setTestResult(null);
    setTestInput('{}');
  };

  const updateForm = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  // Switch type resets config to blank template
  const switchType = (type: ApiToolType) => {
    const config = type === 'script'
      ? JSON.stringify({ code: '// write your script here\nreturn {};\n' } satisfies ScriptToolConfig)
      : JSON.stringify(BLANK_HTTP_CONFIG);
    updateForm({ type, config });
  };

  // Parsed config helpers
  const scriptCode = (): string => {
    try { return (JSON.parse(form.config) as ScriptToolConfig).code ?? ''; } catch { return ''; }
  };
  const setScriptCode = (code: string) => updateForm({ config: JSON.stringify({ code }) });

  const httpCfg = (): HttpToolConfig => {
    try { return JSON.parse(form.config) as HttpToolConfig; } catch { return BLANK_HTTP_CONFIG; }
  };
  const setHttpCfg = (patch: Partial<HttpToolConfig>) => updateForm({ config: JSON.stringify({ ...httpCfg(), ...patch }) });

  // ── Save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const t = await api.createApiTool(agent.id, form);
        setTools((prev) => [...prev, t]);
        setSelected(t);
        setIsNew(false);
      } else if (selected) {
        const t = await api.updateApiTool(agent.id, selected.id, form);
        setTools((prev) => prev.map((x) => x.id === t.id ? t : x));
        setSelected(t);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || !confirm(`Delete "${selected.name}"?`)) return;
    await api.deleteApiTool(agent.id, selected.id);
    setTools((prev) => prev.filter((t) => t.id !== selected.id));
    setSelected(null);
    setIsNew(false);
  };

  // ── Test ──────────────────────────────────────────────────────────────────

  const handleTest = async (saveFirst = false, overrideInput?: Record<string, unknown>) => {
    if (!selected) return;
    setTesting(true);
    setTestResult(null);
    try {
      // Optionally save current editor state before running
      if (saveFirst) {
        const t = await api.updateApiTool(agent.id, selected.id, form);
        setTools((prev) => prev.map((x) => x.id === t.id ? t : x));
        setSelected(t);
      }
      const res = await api.testApiTool(agent.id, selected.id, overrideInput ?? {});
      setTestResult(res);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err), durationMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  // Detect unsaved changes vs what's in DB
  const hasUnsavedChanges = selected !== null && (
    form.config !== selected.config ||
    form.name !== selected.name ||
    form.description !== selected.description ||
    form.inputSchema !== selected.inputSchema ||
    form.enabled !== selected.enabled
  );

  // ── Secrets ───────────────────────────────────────────────────────────────

  const handleAddSecret = async () => {
    if (!newSecretKey || !newSecretValue) return;
    setSavingSecret(true);
    try {
      await api.upsertSecret(agent.id, newSecretKey.trim(), newSecretValue.trim());
      setNewSecretKey('');
      setNewSecretValue('');
      const s = await api.getSecrets(agent.id);
      setSecrets(s);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save secret');
    } finally {
      setSavingSecret(false);
    }
  };

  const handleDeleteSecret = async (secretId: string) => {
    await api.deleteSecret(agent.id, secretId);
    setSecrets((prev) => prev.filter((s) => s.id !== secretId));
  };

  const handleUpdateRateLimit = async (secretId: string, rpm: number | null) => {
    try {
      await api.updateSecretRateLimit(agent.id, secretId, rpm);
      setSecrets((prev) => prev.map((s) => s.id === secretId ? { ...s, requestsPerMinute: rpm } : s));
    } catch (err) {
      console.error('Failed to update rate limit', err);
    }
  };

  // ── AI Assist ──────────────────────────────────────────────────────────────

  const handleAssist = async () => {
    if (!assistPrompt.trim()) return;
    setAssisting(true);
    setAssistError('');
    try {
      const res = await api.assistApiTool(agent.id, {
        prompt: assistPrompt,
        currentCode: scriptCode() || undefined,
        toolName: form.name || undefined,
        toolDescription: form.description || undefined,
        inputSchema: form.inputSchema,
      });
      setScriptCode(res.code);
      if (res.inputSchema) {
        updateForm({ inputSchema: res.inputSchema });
      }
      setAssistOpen(false);
      setAssistPrompt('');
    } catch (err) {
      setAssistError(err instanceof Error ? err.message : 'AI assist failed');
    } finally {
      setAssisting(false);
    }
  };

  // ── Dynamic test inputs from inputSchema ────────────────────────────────────

  interface SchemaField { name: string; type: string; description: string; required: boolean }

  const parseSchemaFields = (schemaStr: string): SchemaField[] => {
    try {
      const s = JSON.parse(schemaStr) as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
      const required = new Set(s.required ?? []);
      return Object.entries(s.properties ?? {}).map(([name, def]) => ({
        name,
        type: def.type ?? 'string',
        description: def.description ?? '',
        required: required.has(name),
      }));
    } catch { return []; }
  };

  // testInputValues: { [fieldName]: string } — what's typed into each test field
  const [testInputValues, setTestInputValues] = useState<Record<string, string>>({});
  const setTestField = (key: string, val: string) => setTestInputValues((prev) => ({ ...prev, [key]: val }));

  // Build the input object for the test call from the field values
  const buildTestInput = (fields: SchemaField[]): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = testInputValues[f.name] ?? '';
      if (raw === '' && !f.required) continue;
      if (f.type === 'number') obj[f.name] = Number(raw);
      else if (f.type === 'boolean') obj[f.name] = raw === 'true';
      else obj[f.name] = raw;
    }
    return obj;
  };

  // ── HTTP header editor ────────────────────────────────────────────────────

  const HeaderEditor = () => {
    const cfg = httpCfg();
    const entries = Object.entries(cfg.headers ?? {});
    const addHeader = () => setHttpCfg({ headers: { ...cfg.headers, '': '' } });
    const updateHeader = (oldKey: string, newKey: string, val: string) => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(cfg.headers ?? {})) {
        h[k === oldKey ? newKey : k] = k === oldKey ? val : v;
      }
      setHttpCfg({ headers: h });
    };
    const removeHeader = (key: string) => {
      const h = { ...cfg.headers };
      delete h[key];
      setHttpCfg({ headers: h });
    };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {entries.map(([k, v], i) => (
          <div key={i} style={{ display: 'flex', gap: '0.5rem' }}>
            <input style={{ ...s.input, flex: 1 }} value={k} placeholder="Header-Name" onChange={(e) => updateHeader(k, e.target.value, v)} />
            <input style={{ ...s.input, flex: 2 }} value={v} placeholder="value or {{secrets.KEY}}" onChange={(e) => updateHeader(k, k, e.target.value)} />
            <button style={s.btn('ghost')} onClick={() => removeHeader(k)}>×</button>
          </div>
        ))}
        <button style={{ ...s.btn('ghost'), alignSelf: 'flex-start', fontSize: '0.78rem' }} onClick={addHeader}>+ Add header</button>
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <div style={{ padding: '2rem', color: 'var(--muted)' }}>Loading…</div>;

  // ── Discovery mode: full-screen chat panel ──────────────────────────────
  if (discoveryOpen) {
    return (
      <div style={{ height: 'calc(100vh - 100px)' }}>
        <ApiToolDiscovery
          agent={agent}
          onClose={() => { setDiscoveryOpen(false); void load(); }}
          onToolsChanged={() => void load()}
        />
      </div>
    );
  }

  const showEditor = isNew || selected !== null;

  return (
    <div style={s.page}>
      {/* Sidebar */}
      <div style={s.sidebar}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={s.sideHeader}>API Tools</span>
          <button onClick={openNew} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1 }}>+</button>
        </div>

        <button
          onClick={() => setDiscoveryOpen(true)}
          style={{
            width: '100%',
            padding: '0.5rem',
            borderRadius: 6,
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            background: 'linear-gradient(135deg, #1a1a3a, #0a1628)',
            color: 'var(--accent)',
            border: '1px solid var(--accent)',
            marginBottom: '0.5rem',
          }}
        >
          ✦ Discover & Build
        </button>

        {tools.length === 0 && !isNew && (
          <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.5rem' }}>No tools yet. Click + to create one, or use Discover & Build above.</p>
        )}

        {tools.map((t) => (
          <div key={t.id} style={s.toolCard(selected?.id === t.id)} onClick={() => openTool(t)}>
            <div>
              <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{t.name}</div>
              <div style={{ fontSize: '0.72rem', opacity: 0.7, marginTop: 2 }}>{t.type}</div>
            </div>
            <span style={s.tag(t.enabled)}>{t.enabled ? 'ON' : 'OFF'}</span>
          </div>
        ))}

        {isNew && (
          <div style={{ ...s.toolCard(false), borderColor: 'var(--accent)', opacity: 0.7 }}>
            <span style={{ fontSize: '0.82rem', fontStyle: 'italic' }}>New tool…</span>
          </div>
        )}

        {/* Secrets section */}
        <div style={{ marginTop: '1.5rem' }}>
          <span style={s.sideHeader}>Secrets</span>
          <p style={{ fontSize: '0.72rem', color: 'var(--muted)', margin: '0.25rem 0 0.75rem' }}>
            Available as <code>secrets.KEY</code> in scripts and <code>{'{{secrets.KEY}}'}</code> in HTTP tools.
          </p>
          {secrets.map((sec) => (
            <div key={sec.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border)', fontSize: '0.8rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>{sec.key}</span>
                <button onClick={() => void handleDeleteSecret(sec.id)} style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '0.8rem' }}>×</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.25rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>Rate limit:</span>
                <input
                  type="number"
                  min="1"
                  placeholder="req/min"
                  value={sec.requestsPerMinute ?? ''}
                  onChange={(e) => {
                    const val = e.target.value ? parseInt(e.target.value, 10) : null;
                    void handleUpdateRateLimit(sec.id, val);
                  }}
                  style={{ width: 60, padding: '0.15rem 0.3rem', fontSize: '0.72rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', fontFamily: 'monospace' }}
                />
                <span style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>req/min</span>
              </div>
            </div>
          ))}
          <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <input
              style={s.input}
              placeholder="KEY_NAME (UPPER_SNAKE_CASE)"
              value={newSecretKey}
              onChange={(e) => setNewSecretKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            />
            <input
              style={s.input}
              type="password"
              placeholder="secret value"
              value={newSecretValue}
              onChange={(e) => setNewSecretValue(e.target.value)}
            />
            <button style={s.btn('primary')} onClick={() => void handleAddSecret()} disabled={savingSecret || !newSecretKey || !newSecretValue}>
              {savingSecret ? 'Saving…' : 'Save Secret'}
            </button>
          </div>
        </div>
      </div>

      {/* Main editor */}
      <div style={s.main}>
        {!showEditor && (
          <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--muted)' }}>
            <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>No tool selected</p>
            <p style={{ fontSize: '0.85rem' }}>Select a tool from the list or click + to create one.</p>
          </div>
        )}

        {showEditor && (
          <>
            {/* Meta */}
            <div style={s.section}>
              <h3 style={s.h3}>{isNew ? 'New API Tool' : 'Edit Tool'}</h3>

              <div style={s.row}>
                <div style={{ ...s.field, flex: 1 }}>
                  <label style={s.label}>Tool name <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(snake_case, used as function name)</span></label>
                  <input style={s.input} value={form.name} onChange={(e) => updateForm({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} placeholder="fetch_cmc_listings" />
                </div>
                <div style={s.field}>
                  <label style={s.label}>Type</label>
                  <select style={s.select} value={form.type} onChange={(e) => switchType(e.target.value as ApiToolType)}>
                    <option value="script">Script (JS)</option>
                    <option value="http">HTTP Request</option>
                  </select>
                </div>
                <div style={s.field}>
                  <label style={s.label}>Enabled</label>
                  <select style={s.select} value={form.enabled ? 'true' : 'false'} onChange={(e) => updateForm({ enabled: e.target.value === 'true' })}>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
              </div>

              <div style={s.field}>
                <label style={s.label}>Description <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(the agent reads this to decide when to use the tool)</span></label>
                <input style={s.input} value={form.description} onChange={(e) => updateForm({ description: e.target.value })} placeholder="Fetches the latest coin listings from CoinMarketCap, filtered by date and social presence" />
              </div>

              <div style={s.field}>
                <label style={s.label}>Input schema (JSON Schema) <span style={{ color: 'var(--muted)', fontWeight: 400 }}>— available as <code>input</code> in your script</span></label>
                <textarea
                  style={{ ...s.input, fontFamily: 'monospace', resize: 'vertical', minHeight: 80 } as React.CSSProperties}
                  value={form.inputSchema}
                  onChange={(e) => updateForm({ inputSchema: e.target.value })}
                />
              </div>
            </div>

            {/* Implementation */}
            <div style={s.section}>
              <h3 style={s.h3}>{form.type === 'script' ? 'Script' : 'HTTP Request'}</h3>

              {form.type === 'script' && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <p style={{ fontSize: '0.8rem', color: 'var(--muted)', margin: 0 }}>
                      Use <code>input</code> for arguments, <code>secrets</code> for API keys, <code>fetch</code> for HTTP. The return value goes back to the agent.
                    </p>
                    <button
                      style={{ ...s.btn('primary'), fontSize: '0.78rem', padding: '0.3rem 0.75rem', whiteSpace: 'nowrap', marginLeft: '1rem' }}
                      onClick={() => { setAssistOpen((v) => !v); setAssistError(''); }}
                    >
                      ✦ AI Assist
                    </button>
                  </div>

                  {/* AI Assist panel */}
                  {assistOpen && (
                    <div style={{ background: '#0a1628', border: '1px solid var(--accent)', borderRadius: 6, padding: '1rem', marginBottom: '0.75rem' }}>
                      <p style={{ fontSize: '0.78rem', color: 'var(--accent)', fontWeight: 700, margin: '0 0 0.5rem' }}>✦ AI Script Assistant</p>
                      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', margin: '0 0 0.6rem' }}>
                        Describe what you want the script to do. The AI knows your available secrets and input schema.
                      </p>
                      <textarea
                        style={{ ...s.input, fontFamily: 'inherit', resize: 'vertical', minHeight: 70, marginBottom: '0.5rem' } as React.CSSProperties}
                        placeholder={`e.g. "Fetch the latest listings from CoinMarketCap, filter to only coins added in the last 7 days that have a Twitter handle, return an array of { name, symbol, twitter }"`}
                        value={assistPrompt}
                        onChange={(e) => setAssistPrompt(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleAssist(); }}
                      />
                      {assistError && <p style={{ color: '#e74c3c', fontSize: '0.78rem', margin: '0 0 0.5rem' }}>{assistError}</p>}
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button style={s.btn('primary')} onClick={() => void handleAssist()} disabled={assisting || !assistPrompt.trim()}>
                          {assisting ? 'Generating…' : scriptCode().trim() ? 'Rewrite with AI' : 'Generate Script'}
                        </button>
                        <button style={s.btn('ghost')} onClick={() => { setAssistOpen(false); setAssistPrompt(''); }}>Cancel</button>
                      </div>
                    </div>
                  )}

                  <textarea
                    style={s.code}
                    value={scriptCode()}
                    onChange={(e) => setScriptCode(e.target.value)}
                    spellCheck={false}
                  />
                </>
              )}

              {form.type === 'http' && (
                <>
                  <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 0, marginBottom: '0.75rem' }}>
                    Use <code>{'{{secrets.KEY}}'}</code> and <code>{'{{input.field}}'}</code> anywhere in URL, headers, or body.
                  </p>
                  <div style={s.row}>
                    <div style={{ ...s.field, width: 120 }}>
                      <label style={s.label}>Method</label>
                      <select style={s.select} value={httpCfg().method} onChange={(e) => setHttpCfg({ method: e.target.value })}>
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}
                      </select>
                    </div>
                    <div style={{ ...s.field, flex: 1 }}>
                      <label style={s.label}>URL</label>
                      <input style={s.input} value={httpCfg().url} onChange={(e) => setHttpCfg({ url: e.target.value })} placeholder="https://api.example.com/endpoint?key={{secrets.API_KEY}}" />
                    </div>
                  </div>
                  <div style={s.field}>
                    <label style={s.label}>Headers</label>
                    <HeaderEditor />
                  </div>
                  <div style={s.field}>
                    <label style={s.label}>Body <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional, for POST/PUT)</span></label>
                    <textarea
                      style={{ ...s.input, fontFamily: 'monospace', resize: 'vertical', minHeight: 80 } as React.CSSProperties}
                      value={httpCfg().body ?? ''}
                      onChange={(e) => setHttpCfg({ body: e.target.value || null })}
                      placeholder={'{"query": "{{input.query}}"}'}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
              <button style={s.btn('primary')} onClick={() => void handleSave()} disabled={saving}>
                {saving ? 'Saving…' : isNew ? 'Create Tool' : 'Save Changes'}
              </button>
              {!isNew && (
                <button style={s.btn('danger')} onClick={() => void handleDelete()}>Delete</button>
              )}
              <button style={s.btn('ghost')} onClick={() => { setSelected(null); setIsNew(false); }}>Cancel</button>
            </div>

            {/* Test panel — only for saved tools */}
            {!isNew && selected && (() => {
              const fields = parseSchemaFields(form.inputSchema);
              const builtInput = buildTestInput(fields);
              return (
                <div style={s.section}>
                  <h3 style={s.h3}>Test</h3>

                  {hasUnsavedChanges && (
                    <div style={{ background: '#2a1f00', border: '1px solid #f39c12', borderRadius: 5, padding: '0.5rem 0.75rem', marginBottom: '0.75rem', fontSize: '0.8rem', color: '#f39c12' }}>
                      ⚠ You have unsaved changes. Use <strong>Save & Run</strong> to test your latest code.
                    </div>
                  )}

                  {fields.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '0.75rem' }}>
                      {fields.map((f) => (
                        <div key={f.name}>
                          <label style={s.label}>
                            <code style={{ color: 'var(--accent)' }}>{f.name}</code>
                            {f.required && <span style={{ color: '#e74c3c', marginLeft: 3 }}>*</span>}
                            <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: 6 }}>{f.type}</span>
                            {f.description && <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: 6 }}>— {f.description}</span>}
                          </label>
                          {f.type === 'boolean' ? (
                            <select
                              style={{ ...s.select, width: '100%' }}
                              value={testInputValues[f.name] ?? ''}
                              onChange={(e) => setTestField(f.name, e.target.value)}
                            >
                              <option value="">(not set)</option>
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          ) : (
                            <input
                              style={s.input}
                              type={f.type === 'number' ? 'number' : 'text'}
                              value={testInputValues[f.name] ?? ''}
                              onChange={(e) => setTestField(f.name, e.target.value)}
                              placeholder={f.type === 'number' ? '0' : `Enter ${f.name}…`}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>
                      No input fields defined. Use AI Assist to generate a script and it will set up your inputs automatically.
                    </p>
                  )}

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button style={s.btn('primary')} onClick={() => void handleTest(true, builtInput)} disabled={testing}>
                      {testing ? 'Running…' : '▶ Save & Run'}
                    </button>
                    {!hasUnsavedChanges && (
                      <button style={s.btn('ghost')} onClick={() => void handleTest(false, builtInput)} disabled={testing}>
                        Run saved
                      </button>
                    )}
                  </div>
                  {testResult && (
                    <div style={s.result(testResult.ok)}>
                      {testResult.ok
                        ? testResult.result === undefined || testResult.result === null
                          ? `✓ ${testResult.durationMs}ms\n\n(script returned ${String(testResult.result)} — make sure your script ends with a return statement)`
                          : `✓ ${testResult.durationMs}ms\n\n${JSON.stringify(testResult.result, null, 2)}`
                        : `✗ Error\n\n${testResult.error ?? 'Unknown error'}`
                      }
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}
