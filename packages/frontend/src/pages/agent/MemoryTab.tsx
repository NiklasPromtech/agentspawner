import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api/client.js';
import type { Agent, MemoryEntry } from '../../types/index.js';
import TabLayout from '../../components/TabLayout.js';

interface Props {
  agent: Agent;
}

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  profile:     { bg: '#238636', text: '#fff', border: '#238636' },
  post:        { bg: '#1a5fb4', text: '#fff', border: '#1a5fb4' },
  interaction: { bg: '#7c3aed', text: '#fff', border: '#7c3aed' },
  research:    { bg: '#c96000', text: '#fff', border: '#c96000' },
  market_data: { bg: '#b83a4b', text: '#fff', border: '#b83a4b' },
  web_content: { bg: '#2e7d32', text: '#fff', border: '#2e7d32' },
  data:        { bg: '#3a6bc9', text: '#fff', border: '#3a6bc9' },
  other:       { bg: '#555', text: '#fff', border: '#555' },
};

export default function MemoryTab({ agent }: Props) {
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRecent = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getRecentMemory(100)
      .then(setEntries)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  const handleSearch = (q: string) => {
    setSearchQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      const promise = q.trim()
        ? api.searchMemory(q.trim(), 50)
        : api.getRecentMemory(100);
      promise.then(setEntries).catch((e) => setError((e as Error).message)).finally(() => setLoading(false));
    }, 350);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteMemoryEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    }
  };

  const handleClearAgent = async () => {
    if (!confirm(`Delete all memories collected by "${agent.name}"?`)) return;
    try {
      const result = await api.clearAgentMemory(agent.id);
      alert(`Deleted ${result.deleted} entries`);
      loadRecent();
    } catch (err) {
      alert(`Failed: ${(err as Error).message}`);
    }
  };

  // Group entries by category
  const grouped: Record<string, MemoryEntry[]> = {};
  for (const e of entries) {
    const cat = e.category || 'other';
    grouped[cat] = grouped[cat] ?? [];
    grouped[cat].push(e);
  }
  const categories = Object.keys(grouped).sort();

  const toggleCollapse = (cat: string) => {
    setCollapsed((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  return (
    <TabLayout
      title={`Shared Memory${!loading && !error ? ` (${entries.length})` : ''}`}
      description="Memories are collected across all agents and persist between sessions. They inform the agent's responses and flow context."
      loading={loading}
      error={error}
      onRetry={loadRecent}
      isEmpty={!loading && entries.length === 0}
      emptyState={{
        icon: '🧠',
        title: 'No memories yet',
        description: 'As the agent runs flows and chat sessions, it will learn and store memories here. You can also add memories manually via the API.',
      }}
      maxWidth={900}
      actions={[{
        label: 'Clear this agent\'s memories',
        onClick: handleClearAgent,
        variant: 'secondary',
      }]}
    >
      {/* Search */}
      <input
        type="text"
        placeholder="Search by entity, handle, or keyword…"
        value={searchQuery}
        onChange={(e) => handleSearch(e.target.value)}
        style={{
          width: '100%',
          padding: '0.6rem 0.9rem',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--text)',
          fontSize: '0.875rem',
          marginBottom: '1.25rem',
          boxSizing: 'border-box',
        }}
      />

      {entries.length === 0 && searchQuery.trim() ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>
          <p>No memories match <strong style={{ color: 'var(--text)' }}>"{searchQuery}"</strong></p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {categories.map((cat) => {
            const catEntries = grouped[cat]!;
            const isCollapsed = collapsed[cat];
            const colors = CATEGORY_COLORS[cat] ?? CATEGORY_COLORS['other']!;
            return (
              <div key={cat} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                {/* Category header */}
                <button
                  onClick={() => toggleCollapse(cat)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.6rem 1rem',
                    background: 'var(--surface)',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{
                    fontSize: '0.7rem',
                    padding: '0.15rem 0.6rem',
                    borderRadius: 10,
                    background: colors.bg,
                    color: colors.text,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}>
                    {cat}
                  </span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{catEntries.length} entries</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: '0.85rem' }}>
                    {isCollapsed ? '▶' : '▼'}
                  </span>
                </button>

                {/* Entries */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {catEntries.map((entry) => {
                      let entityArr: string[] = [];
                      try { entityArr = JSON.parse(entry.entities) as string[]; } catch { /* ignore */ }
                      const isOwnAgent = entry.sourceAgentId === agent.id;

                      return (
                        <div
                          key={entry.id}
                          style={{
                            borderTop: '1px solid var(--border)',
                            padding: '0.85rem 1rem',
                            display: 'flex',
                            gap: '0.75rem',
                            alignItems: 'flex-start',
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontSize: '0.875rem', margin: '0 0 0.5rem', lineHeight: 1.5 }}>
                              {entry.content}
                            </p>

                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
                              {/* Entity chips */}
                              {entityArr.map((e) => (
                                <span key={e} style={{
                                  fontSize: '0.7rem',
                                  padding: '0.1rem 0.5rem',
                                  borderRadius: 10,
                                  background: '#23863622',
                                  color: '#4ade80',
                                  border: '1px solid #23863644',
                                }}>
                                  {e}
                                </span>
                              ))}

                              {/* Source agent badge */}
                              {entry.sourceAgentName && (
                                <span style={{
                                  fontSize: '0.7rem',
                                  padding: '0.1rem 0.5rem',
                                  borderRadius: 10,
                                  background: isOwnAgent ? '#23863622' : 'var(--surface)',
                                  color: isOwnAgent ? '#4ade80' : 'var(--muted)',
                                  border: `1px solid ${isOwnAgent ? '#23863644' : 'var(--border)'}`,
                                }}>
                                  {isOwnAgent ? '★ ' : ''}
                                  {entry.sourceAgentName}
                                </span>
                              )}

                              {/* Tool badge */}
                              {entry.sourceTool && (
                                <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>
                                  via {entry.sourceTool}
                                </span>
                              )}

                              {/* Timestamp */}
                              <span style={{ fontSize: '0.7rem', color: 'var(--muted)', marginLeft: 'auto' }}>
                                {new Date(entry.createdAt).toLocaleString()}
                              </span>
                            </div>

                            {entry.sourceUrl && (
                              <p style={{ fontSize: '0.75rem', color: 'var(--muted)', margin: '0.35rem 0 0', wordBreak: 'break-all' }}>
                                {entry.sourceUrl}
                              </p>
                            )}
                          </div>

                          {/* Delete button */}
                          <button
                            onClick={() => void handleDelete(entry.id)}
                            title="Delete entry"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--muted)',
                              cursor: 'pointer',
                              fontSize: '0.9rem',
                              padding: '0 0.25rem',
                              flexShrink: 0,
                              lineHeight: 1,
                            }}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </TabLayout>
  );
}
