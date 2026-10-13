import { useState } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Tool } from '../../types/index.js';
import CodeEditor from '../../components/CodeEditor.js';

interface Props {
  agent: Agent;
  tool?: Tool | null;
  onSave: (tool: Tool) => void;
  onCancel: () => void;
}

const DEFAULT_SCHEMA = JSON.stringify({ type: 'object', properties: {}, required: [] }, null, 2);

export default function ToolEditor({ agent, tool, onSave, onCancel }: Props) {
  const [form, setForm] = useState({
    name: tool?.name ?? '',
    description: tool?.description ?? '',
    toolType: (tool?.toolType ?? 'extension') as Tool['toolType'],
    inputSchema: tool?.inputSchema ? JSON.stringify(JSON.parse(tool.inputSchema), null, 2) : DEFAULT_SCHEMA,
    code: tool?.code ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [schemaError, setSchemaError] = useState('');
  const [copied, setCopied] = useState(false);

  const handleCopyRunnable = () => {
    const runnable = `(async () => {\n${form.code}\n})();`;
    void navigator.clipboard.writeText(runnable).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const validateSchema = (val: string) => {
    try {
      JSON.parse(val);
      setSchemaError('');
      return true;
    } catch {
      setSchemaError('Invalid JSON');
      return false;
    }
  };

  const handleSave = async () => {
    if (!validateSchema(form.inputSchema)) return;
    setSaving(true);
    try {
      const payload = { ...form, inputSchema: JSON.stringify(JSON.parse(form.inputSchema)) };
      const saved = tool
        ? await api.updateTool(agent.id, tool.id, payload)
        : await api.createTool(agent.id, payload);
      onSave(saved);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    try {
      const result = await api.generateTool(agent.id, aiPrompt, form.toolType, form.code || undefined);
      setForm((f) => ({
        ...f,
        name: result.name ?? f.name,
        description: result.description ?? f.description,
        inputSchema: result.inputSchema ? JSON.stringify(JSON.parse(result.inputSchema), null, 2) : f.inputSchema,
        code: result.code ?? f.code,
      }));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div style={{ padding: '1.5rem', overflowY: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>{tool ? 'Edit Tool' : 'New Tool'}</h3>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={onCancel} style={btnStyle('#21262d')}>Cancel</button>
          <button onClick={() => void handleSave()} disabled={saving} style={btnStyle('#1f6feb')}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {/* AI Generation */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem', marginBottom: '1.5rem' }}>
        <label style={labelStyle}>Generate with AI</label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleGenerate(); }}
            placeholder="Describe what this tool should do..."
            style={{ ...inputStyle, flex: 1 }}
          />
          <button onClick={() => void handleGenerate()} disabled={generating || !aiPrompt.trim()} style={btnStyle('#6f42c1')}>
            {generating ? '...' : 'Generate'}
          </button>
        </div>
      </div>

      <Field label="Tool Type">
        <select value={form.toolType} onChange={(e) => setForm((f) => ({ ...f, toolType: e.target.value as Tool['toolType'] }))} style={inputStyle}>
          <option value="extension">Extension (Chrome)</option>
          <option value="web_fetch">Web Fetch (server-side)</option>
          <option value="web_search">Web Search (Anthropic native)</option>
          <option value="local">Local (SQLite)</option>
        </select>
      </Field>

      <Field label="Name (snake_case)">
        <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="get_page_title" style={inputStyle} />
      </Field>

      <Field label="Description">
        <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2} placeholder="What this tool does..." style={{ ...inputStyle, resize: 'vertical' }} />
      </Field>

      <Field label={`Input Schema (JSON)${schemaError ? ' — ' + schemaError : ''}`}>
        <CodeEditor
          language="json"
          value={form.inputSchema}
          onChange={(v) => { setForm((f) => ({ ...f, inputSchema: v })); validateSchema(v); }}
          height={160}
        />
      </Field>

      {(form.toolType === 'extension' || form.toolType === 'local') && (
        <Field label="Code (JavaScript)">
          <CodeEditor
            language="javascript"
            value={form.code}
            onChange={(v) => setForm((f) => ({ ...f, code: v }))}
            height={300}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.4rem' }}>
            <p style={{ fontSize: '0.75rem', color: 'var(--muted)', margin: 0 }}>
              {form.toolType === 'extension'
                ? 'Use tab.domQueryAll / domClick / domType. Return value is sent back.'
                : 'Runs server-side. Use db.select/insert/deleteRows. Use input for parameters.'}
            </p>
            {form.toolType === 'extension' && form.code.trim() && (
              <button
                onClick={handleCopyRunnable}
                title="Copies code wrapped in (async () => { ... })() — paste directly into DevTools console"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  color: copied ? '#3fb950' : 'var(--muted)',
                  padding: '0.2rem 0.6rem',
                  fontSize: '0.72rem',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  marginLeft: '0.75rem',
                }}
              >
                {copied ? '✓ Copied' : 'Copy as runnable'}
              </button>
            )}
          </div>
        </Field>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.85rem',
  color: 'var(--muted)',
  marginBottom: '0.4rem',
  fontWeight: 500,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '0.5rem 0.75rem',
  fontSize: '0.9rem',
};

function btnStyle(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500 };
}
