import { useState, useEffect, useCallback } from 'react';
import type { Agent } from '../../types/index.js';

/**
 * ReviewsTab — Voice & Tone Guide
 *
 * The legacy `pendingHumanReviews` section was removed in OPERATION CONVERGENCE
 * Task 4.5 (the table has been dropped). New approvals happen in ReviewActionsTab.
 *
 * What remains: the Voice & Tone guide — still functional, backed by toneEdits.
 */

interface ToneData {
  toneGuide: string[];
  editCount: number;
  toneGuideUpdatedAt?: string | null;
}

interface Props {
  agent: Agent;
}

export default function ReviewsTab({ agent }: Props) {
  const [loading, setLoading] = useState(true);
  const [toneData, setToneData] = useState<ToneData>({ toneGuide: [], editCount: 0 });
  const [editingTone, setEditingTone] = useState(false);
  const [toneBullets, setToneBullets] = useState<string[]>([]);
  const [refreshingTone, setRefreshingTone] = useState(false);

  const fetchData = useCallback(() => {
    fetch(`http://localhost:3001/agents/${agent.id}/reviews/tone`)
      .then(r => r.json())
      .then((t) => {
        setToneData(t as ToneData);
        setToneBullets((t as ToneData).toneGuide);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [agent.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const saveTone = async () => {
    await fetch(`http://localhost:3001/agents/${agent.id}/reviews/tone`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toneGuide: toneBullets.filter(b => b.trim()) }),
    });
    setEditingTone(false);
    fetchData();
  };

  const refreshTone = async () => {
    setRefreshingTone(true);
    try {
      const res = await fetch(`http://localhost:3001/agents/${agent.id}/reviews/tone/refresh`, { method: 'POST' });
      if (!res.ok) { const e = await res.json() as {error?: string}; alert(e.error ?? 'Failed'); return; }
      fetchData();
    } finally {
      setRefreshingTone(false);
    }
  };

  const btn: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', padding: '0.3rem 0.75rem', fontSize: '0.8rem', cursor: 'pointer' };

  if (loading) return <div style={{ padding: '2rem', color: 'var(--muted)' }}>Loading…</div>;

  return (
    <div style={{ padding: '1.5rem', maxWidth: 800 }}>

      {/* ── Tone guide ──────────────────────────────────────── */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Voice & Tone</h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
            Based on {toneData.editCount} edit{toneData.editCount !== 1 ? 's' : ''}
          </span>
          {!editingTone && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
              {toneData.editCount >= 3 && (
                <button onClick={() => void refreshTone()} disabled={refreshingTone} style={btn}>
                  {refreshingTone ? '⏳ Analysing…' : '↻ Re-analyse'}
                </button>
              )}
              <button onClick={() => { setEditingTone(true); setToneBullets(toneData.toneGuide); }} style={btn}>Edit</button>
            </div>
          )}
        </div>

        {toneData.toneGuide.length === 0 && toneData.editCount < 3 ? (
          <p style={{ color: 'var(--muted)', fontSize: '0.82rem', lineHeight: 1.6 }}>
            Tone guide will appear after you've reviewed and edited at least 3 drafts.
            Each edit you make teaches the agent your preferred voice.
          </p>
        ) : editingTone ? (
          <div>
            {toneBullets.map((b, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)', fontSize: '0.8rem', flexShrink: 0 }}>•</span>
                <input
                  value={b}
                  onChange={e => setToneBullets(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                  style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '0.35rem 0.65rem', fontSize: '0.82rem' }}
                />
                <button onClick={() => setToneBullets(prev => prev.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1rem', padding: '0 0.25rem' }}>×</button>
              </div>
            ))}
            <button onClick={() => setToneBullets(prev => [...prev, ''])} style={{ ...btn, marginTop: '0.4rem', marginBottom: '0.75rem' }}>+ Add bullet</button>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button onClick={() => setEditingTone(false)} style={btn}>Cancel</button>
              <button onClick={() => void saveTone()} style={{ background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.82rem', fontWeight: 500, cursor: 'pointer' }}>Save</button>
            </div>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {toneData.toneGuide.map((b, i) => (
              <li key={i} style={{ fontSize: '0.85rem', color: 'var(--text)', display: 'flex', gap: '0.5rem', lineHeight: 1.5 }}>
                <span style={{ color: '#58a6ff', flexShrink: 0 }}>•</span>
                {b}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
