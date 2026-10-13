import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';
import type { Agent, AnalyticsSummary } from '../../types/index.js';

interface Props {
  agent: Agent;
}

const OUTCOME_COLOR: Record<string, string> = {
  success: '#22c55e',
  failure: '#ef4444',
  pending: '#f59e0b',
  unknown: '#6b7280',
};

const CATEGORY_ICON: Record<string, string> = {
  outreach:  '📨',
  lead:      '🎯',
  content:   '✍️',
  tool:      '🔧',
  flow:      '⚡',
  research:  '🔍',
  other:     '📊',
};

function costStr(usd: number) {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(3)}`;
}

function SparkLine({ data }: { data: { date: string; runs: number; cost: number }[] }) {
  if (data.length < 2) return null;
  const maxRuns = Math.max(...data.map((d) => d.runs), 1);
  const w = 200;
  const h = 48;
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - (d.runs / maxRuns) * h;
    return `${x},${y}`;
  });

  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        points={pts.join(' ')}
      />
      {data.map((d, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - (d.runs / maxRuns) * h;
        return (
          <circle key={d.date} cx={x} cy={y} r={3} fill="var(--accent)">
            <title>{d.date}: {d.runs} run{d.runs !== 1 ? 's' : ''}, {costStr(d.cost)}</title>
          </circle>
        );
      })}
    </svg>
  );
}

export default function AnalyticsTab({ agent }: Props) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [journalExpanded, setJournalExpanded] = useState<Record<string, boolean>>({});

  // ── Audit state ────────────────────────────────────────────────────────────
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditReport, setAuditReport] = useState<{ report: string; timestamp: string } | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  const handleRunAudit = async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const result = await api.runAudit(agent.id);
      setAuditReport({ report: result.report, timestamp: result.timestamp });
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuditLoading(false);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    api.getAnalytics(agent.id, days)
      .then(setSummary)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [agent.id, days]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: '2rem', color: 'var(--muted)' }}>Loading analytics…</div>;
  if (!summary) return <div style={{ padding: '2rem', color: 'var(--muted)' }}>No data.</div>;

  const { runs: rs, performance: perf, sessionJournal } = summary;
  const successRate = rs.total > 0 ? Math.round((rs.completed / rs.total) * 100) : 0;

  return (
    <div style={{ padding: '1.5rem', maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>Analytics</h2>
        <div style={{ display: 'flex', gap: '0.25rem', marginLeft: 'auto' }}>
          {[7, 14, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              style={{
                padding: '0.25rem 0.6rem',
                fontSize: '0.78rem',
                background: days === d ? 'var(--accent)' : 'transparent',
                color: days === d ? '#fff' : 'var(--muted)',
                border: days === d ? 'none' : '1px solid var(--border)',
                borderRadius: 5,
                cursor: 'pointer',
              }}
            >
              {d}d
            </button>
          ))}
        </div>
        <button
          onClick={() => void handleRunAudit()}
          disabled={auditLoading || !agent.hasApiKey}
          title={!agent.hasApiKey ? 'Configure API key first' : 'Run Sonnet audit (~30s)'}
          style={{
            background: auditLoading ? 'transparent' : 'rgba(31,111,235,0.15)',
            color: auditLoading ? 'var(--muted)' : '#58a6ff',
            border: '1px solid rgba(31,111,235,0.35)',
            borderRadius: 6,
            padding: '0.3rem 0.75rem',
            fontSize: '0.78rem',
            fontWeight: 500,
            cursor: auditLoading || !agent.hasApiKey ? 'not-allowed' : 'pointer',
            opacity: !agent.hasApiKey ? 0.5 : 1,
          }}
        >
          {auditLoading ? '⟳ Auditing…' : '✦ Run Audit'}
        </button>
      </div>

      {/* Audit report panel */}
      {(auditReport || auditError) && (
        <div style={{
          background: auditError ? 'rgba(248,81,73,0.08)' : 'rgba(31,111,235,0.06)',
          border: `1px solid ${auditError ? 'rgba(248,81,73,0.3)' : 'rgba(31,111,235,0.25)'}`,
          borderRadius: 10,
          padding: '1rem 1.25rem',
          marginBottom: '1.5rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 600, color: auditError ? 'var(--error)' : '#58a6ff', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {auditError ? 'Audit Error' : `✦ Audit Report · ${auditReport?.timestamp.slice(0, 16).replace('T', ' ')}`}
            </div>
            <button
              onClick={() => { setAuditReport(null); setAuditError(null); }}
              style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1rem', padding: 0 }}
            >
              ×
            </button>
          </div>
          <div style={{ fontSize: '0.83rem', lineHeight: 1.65, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
            {auditError ?? auditReport?.report}
          </div>
        </div>
      )}

      {/* Run Stats Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {[
          { label: 'Total Runs',    value: rs.total,                  color: 'var(--text)' },
          { label: 'Success Rate',  value: `${successRate}%`,          color: successRate >= 80 ? '#22c55e' : successRate >= 50 ? '#f59e0b' : '#ef4444' },
          { label: 'Failed',        value: rs.failed,                  color: rs.failed > 0 ? '#ef4444' : 'var(--muted)' },
          { label: 'Total Cost',    value: costStr(rs.totalCostUsd),   color: 'var(--text)' },
          { label: 'Input Tokens',  value: (rs.totalInputTokens / 1000).toFixed(0) + 'k',  color: 'var(--muted)' },
          { label: 'Output Tokens', value: (rs.totalOutputTokens / 1000).toFixed(0) + 'k', color: 'var(--muted)' },
        ].map((card) => (
          <div key={card.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '0.9rem 1rem' }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.3rem' }}>{card.label}</div>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color: card.color }}>{card.value}</div>
          </div>
        ))}
      </div>

      {/* Sparkline */}
      {rs.byDay.length > 1 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.75rem' }}>
            Runs per day (last {days} days)
          </div>
          <SparkLine data={rs.byDay} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
            <span>{rs.byDay[0]?.date}</span>
            <span>{rs.byDay[rs.byDay.length - 1]?.date}</span>
          </div>
        </div>
      )}

      {/* Performance by Category */}
      {perf.byCategory.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.75rem' }}>
            Performance by Category ({perf.entries} logged outcomes)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {perf.byCategory.map((cat) => {
              const pct = cat.total > 0 ? Math.round((cat.success / cat.total) * 100) : 0;
              const icon = CATEGORY_ICON[cat.category] ?? '📊';
              return (
                <div key={cat.category} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span style={{ fontSize: '1rem', width: 24, textAlign: 'center' }}>{icon}</span>
                  <span style={{ fontSize: '0.85rem', width: 90, textTransform: 'capitalize' }}>{cat.category}</span>
                  {/* Bar */}
                  <div style={{ flex: 1, height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: pct >= 70 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444', borderRadius: 3, transition: 'width 0.3s' }} />
                  </div>
                  <span style={{ fontSize: '0.78rem', color: pct >= 70 ? '#22c55e' : pct >= 40 ? '#f59e0b' : '#ef4444', width: 36, textAlign: 'right', fontWeight: 600 }}>
                    {cat.successRate}
                  </span>
                  <span style={{ fontSize: '0.72rem', color: 'var(--muted)', width: 60, textAlign: 'right' }}>
                    {cat.success}✓ {cat.failure}✗ / {cat.total}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {perf.entries === 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.5rem', marginBottom: '1.5rem', textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>📊</div>
          <p style={{ fontSize: '0.9rem', margin: 0 }}>No performance data yet.</p>
          <p style={{ fontSize: '0.82rem', marginTop: '0.25rem' }}>The agent logs outcomes with <code>log_outcome</code> after each significant action. This builds strategy over time.</p>
        </div>
      )}

      {/* Session Journal */}
      {sessionJournal.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem' }}>
          <div style={{ fontSize: '0.78rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.75rem' }}>
            Session Journal (last {sessionJournal.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {sessionJournal.map((entry) => {
              const isExpanded = journalExpanded[entry.id];
              const isLong = entry.content.length > 150;
              const preview = isLong && !isExpanded ? entry.content.slice(0, 150) + '…' : entry.content;

              return (
                <div key={entry.id} style={{ borderLeft: '2px solid var(--border)', paddingLeft: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>
                      {new Date(entry.createdAt).toLocaleString()}
                    </span>
                    {typeof entry.metadata?.runId === 'string' && (
                      <span style={{ fontSize: '0.68rem', color: 'var(--muted)', fontFamily: 'monospace' }}>
                        run:{entry.metadata.runId.slice(0, 8)}
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text)', margin: 0, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                    {preview}
                  </p>
                  {isLong && (
                    <button
                      onClick={() => setJournalExpanded((prev) => ({ ...prev, [entry.id]: !prev[entry.id] }))}
                      style={{ fontSize: '0.75rem', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.2rem 0' }}
                    >
                      {isExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {sessionJournal.length === 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.5rem', textAlign: 'center', color: 'var(--muted)' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>📓</div>
          <p style={{ fontSize: '0.9rem', margin: 0 }}>No session journal entries yet.</p>
          <p style={{ fontSize: '0.82rem', marginTop: '0.25rem' }}>Each time the agent calls <code>end_session</code>, a journal entry is saved here automatically.</p>
        </div>
      )}
    </div>
  );
}
