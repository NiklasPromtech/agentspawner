import { useState } from 'react';
import type { Tool } from '../../types/index.js';
import { PRIMITIVE_CATEGORIES } from './InputMappingField.js';
import { inputStyle } from './styles.js';

interface Props {
  agentTools: Tool[];
  onSelect: (tool: Tool) => void;
  onSelectBuiltin?: (toolId: string) => void;
  onClose: () => void;
}

const BUILTIN_STEPS = [
  { id: '__transform__', name: '__transform__', description: 'Run a sandboxed JavaScript script to reshape data — URL building, string manipulation, JSON transforms.' },
  { id: '__evaluate__', name: '__evaluate__', description: 'Take a screenshot and ask Claude vision "did this succeed?" — fails the flow if the answer is no.' },
];

const CATEGORY_ORDER = ['Navigation', 'Waiting', 'Interaction', 'Reading', 'Filtering', 'Capture', 'Code'];

export function ToolPickerModal({ agentTools, onSelect, onSelectBuiltin, onClose }: Props) {
  const [search, setSearch] = useState('');

  const q = search.toLowerCase();
  const filteredBuiltins = BUILTIN_STEPS.filter((b) =>
    !q || b.name.includes(q) || b.description.toLowerCase().includes(q),
  );
  const filtered = agentTools.filter((t) =>
    !q || t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q),
  );

  const grouped = new Map<string, Tool[]>();
  for (const t of filtered) {
    const cat = PRIMITIVE_CATEGORIES[t.name] ?? (t.toolType === 'local' ? 'Local' : t.toolType === 'web_fetch' ? 'Web Fetch' : 'Your Tools');
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(t);
  }
  const orderedKeys = [
    ...CATEGORY_ORDER.filter((c) => grouped.has(c)),
    ...[...grouped.keys()].filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, width: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tools…"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1.2rem', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ overflowY: 'auto', padding: '0.5rem 0' }}>
          {filteredBuiltins.length === 0 && orderedKeys.length === 0 && (
            <p style={{ padding: '1rem', color: 'var(--muted)', fontSize: '0.85rem' }}>No tools match "{search}"</p>
          )}
          {/* Built-in sentinel steps */}
          {filteredBuiltins.length > 0 && (
            <div>
              <div style={{ padding: '0.4rem 1rem', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', background: 'var(--bg)' }}>
                Built-in
              </div>
              {filteredBuiltins.map((b) => (
                <div
                  key={b.id}
                  onClick={() => { onSelectBuiltin ? onSelectBuiltin(b.id) : undefined; onClose(); }}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 1rem', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <code style={{ fontSize: '0.82rem', color: b.id === '__transform__' ? '#fb923c' : '#a78bfa', minWidth: 150, flexShrink: 0 }}>{b.name}</code>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text)', flex: 1 }}>{b.description}</span>
                </div>
              ))}
            </div>
          )}
          {orderedKeys.map((cat) => (
            <div key={cat}>
              <div style={{ padding: '0.4rem 1rem', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', background: 'var(--bg)' }}>
                {cat}
              </div>
              {grouped.get(cat)!.map((t) => {
                let inputCount = 0;
                try { inputCount = Object.keys((JSON.parse(t.inputSchema) as { properties?: object }).properties ?? {}).length; } catch { /* */ }
                return (
                  <div
                    key={t.id}
                    onClick={() => onSelect(t)}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.6rem 1rem', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <code style={{ fontSize: '0.82rem', color: 'var(--accent)', minWidth: 150, flexShrink: 0 }}>{t.name}</code>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text)', flex: 1 }}>{t.description}</span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--muted)', flexShrink: 0 }}>{inputCount} input{inputCount !== 1 ? 's' : ''}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
