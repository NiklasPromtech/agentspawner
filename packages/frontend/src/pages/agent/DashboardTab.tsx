// OPERATION CONVERGENCE Task 10 — Agent Activity Dashboard
// Single-glance view of what the agent is doing right now.

import { useState, useEffect, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { Agent, AgentDashboard } from '../../types/index.js';
import { formatFlowName } from '../../utils/formatFlowName.js';

interface Props {
  agent: Agent;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function costStr(usd: number) {
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(3)}`;
}

function tokenStr(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; pulse: boolean }> = {
  running: { label: 'Running',    color: '#3fb950', bg: 'rgba(63,185,80,0.12)',  pulse: true  },
  idle:    { label: 'Idle',       color: '#8b949e', bg: 'rgba(139,148,158,0.1)', pulse: false },
  error:   { label: 'Error',      color: '#da3633', bg: 'rgba(218,54,51,0.12)',  pulse: false },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG['idle']!;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
      padding: '0.3rem 0.75rem', borderRadius: 6,
      background: cfg.bg, color: cfg.color,
      fontSize: '0.85rem', fontWeight: 600,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: cfg.color,
        boxShadow: cfg.pulse ? `0 0 5px ${cfg.color}` : 'none',
        animation: cfg.pulse ? 'pulse 1.4s ease-in-out infinite' : 'none',
        display: 'inline-block',
      }} />
      {cfg.label}
    </span>
  );
}

// ── Action log status badge ───────────────────────────────────────────────────

const ACTION_STATUS: Record<string, { label: string; color: string }> = {
  pending_review:       { label: '⏳ Pending',          color: '#f59e0b' },
  executing:            { label: '▶ Executing',          color: '#60a5fa' },
  approved:             { label: '✅ Approved',          color: '#3fb950' },
  approved_with_edits:  { label: '✏️ Approved (edited)', color: '#3fb950' },
  rejected:             { label: '❌ Rejected',          color: '#da3633' },
  executed:             { label: '✅ Done',              color: '#3fb950' },
  failed:               { label: '💥 Failed',            color: '#da3633' },
  blocked:              { label: '🚫 Blocked',           color: '#8b949e' },
};

function ActionBadge({ status }: { status: string }) {
  const cfg = ACTION_STATUS[status] ?? { label: status, color: '#8b949e' };
  return (
    <span style={{ fontSize: '0.75rem', color: cfg.color, fontWeight: 500 }}>
      {cfg.label}
    </span>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '0.9rem 1.1rem',
      minWidth: 120,
    }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '0.3rem' }}>{label}</div>
      <div style={{ fontSize: '1.35rem', fontWeight: 700, color: accent ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.15rem' }}>{sub}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DashboardTab({ agent }: Props) {
  const [data, setData] = useState<AgentDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getDashboard(agent.id);
      setData(d);
      setLastRefreshed(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh: 10s when running, 60s otherwise
  useEffect(() => {
    const interval = setInterval(() => {
      void load();
    }, data?.status === 'running' ? 10_000 : 60_000);
    return () => clearInterval(interval);
  }, [load, data?.status]);

  if (loading) {
    return <div style={{ padding: '2rem', color: 'var(--muted)' }}>Loading dashboard…</div>;
  }

  if (error || !data) {
    return (
      <div style={{ padding: '2rem', color: '#da3633' }}>
        Failed to load dashboard: {error}
        <button
          onClick={() => void load()}
          style={{ marginLeft: '1rem', cursor: 'pointer', color: 'var(--accent)', background: 'none', border: 'none', textDecoration: 'underline' }}
        >
          Retry
        </button>
      </div>
    );
  }

  const pendingCount = data.pendingApprovalsCount;

  return (
    <div style={{ padding: '1.5rem', maxWidth: 900 }}>

      {/* ── Header row ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <StatusBadge status={data.status} />
          {data.lastActiveAt && (
            <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
              Last active {relativeTime(data.lastActiveAt)}
            </span>
          )}
        </div>
        <button
          onClick={() => void load()}
          style={{ fontSize: '0.78rem', color: 'var(--muted)', background: 'none', border: '1px solid var(--border)', borderRadius: 5, padding: '0.3rem 0.7rem', cursor: 'pointer' }}
        >
          ↻ Refresh {lastRefreshed ? `· ${relativeTime(lastRefreshed.toISOString())}` : ''}
        </button>
      </div>

      {/* ── Current task ── */}
      {data.currentTask && (
        <div style={{
          background: 'linear-gradient(90deg, rgba(63,185,80,0.1) 0%, rgba(63,185,80,0.03) 100%)',
          border: '1px solid rgba(63,185,80,0.3)',
          borderLeft: '3px solid #3fb950',
          borderRadius: 8,
          padding: '0.8rem 1rem',
          marginBottom: '1.25rem',
          fontSize: '0.875rem',
          color: 'var(--text)',
        }}>
          <span style={{ color: '#3fb950', fontWeight: 600, marginRight: '0.5rem' }}>Current task:</span>
          {data.currentTask}
          {data.statusUpdatedAt && (
            <span style={{ color: 'var(--muted)', fontSize: '0.75rem', marginLeft: '0.75rem' }}>
              updated {relativeTime(data.statusUpdatedAt)}
            </span>
          )}
        </div>
      )}

      {/* ── Stat cards row ── */}
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <StatCard
          label="Pending approvals"
          value={pendingCount}
          accent={pendingCount > 0 ? '#f59e0b' : undefined}
          sub={pendingCount > 0 ? 'needs review' : 'queue clear'}
        />
        <StatCard
          label="Today's cost"
          value={costStr(data.todayTokens.costUsd)}
          sub={`${tokenStr(data.todayTokens.inputTokens + data.todayTokens.outputTokens)} tokens`}
        />
        <StatCard
          label="Today's tokens in"
          value={tokenStr(data.todayTokens.inputTokens)}
          sub="input"
        />
        <StatCard
          label="Today's tokens out"
          value={tokenStr(data.todayTokens.outputTokens)}
          sub="output"
        />
        {/* Extension status */}
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '0.9rem 1.1rem',
          minWidth: 120,
        }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '0.3rem' }}>Extension</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: data.extensionConnected ? '#3fb950' : '#da3633',
              boxShadow: data.extensionConnected ? '0 0 4px #3fb950' : 'none',
              display: 'inline-block',
            }} />
            <span style={{ fontSize: '0.9rem', fontWeight: 600, color: data.extensionConnected ? '#3fb950' : '#da3633' }}>
              {data.extensionConnected ? 'Connected' : 'Offline'}
            </span>
          </div>
          {data.extensionLastSeenAt && !data.extensionConnected && (
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
              last seen {relativeTime(data.extensionLastSeenAt)}
            </div>
          )}
        </div>
      </div>

      {/* ── Pending approvals CTA ── */}
      {pendingCount > 0 && (
        <div style={{
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.3)',
          borderLeft: '3px solid #f59e0b',
          borderRadius: 8,
          padding: '0.75rem 1rem',
          marginBottom: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
        }}>
          <span style={{ fontSize: '0.875rem', color: '#f59e0b', fontWeight: 600 }}>
            {pendingCount} action{pendingCount !== 1 ? 's' : ''} waiting for review
          </span>
          <NavLink
            to={`/agents/${agent.id}/review-actions`}
            style={{ fontSize: '0.8rem', color: '#f59e0b', textDecoration: 'none', padding: '0.2rem 0.6rem', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 4 }}
          >
            Open Review Actions →
          </NavLink>
        </div>
      )}

      {/* ── Latest run ── */}
      {data.latestRun && (
        <div style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '0.85rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.6rem' }}>
            Latest Autonomous Run
          </h3>
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '0.85rem 1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '0.5rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span style={{
                fontSize: '0.78rem', fontWeight: 600, padding: '0.2rem 0.5rem', borderRadius: 4,
                background: data.latestRun.status === 'running' ? 'rgba(63,185,80,0.15)' :
                             data.latestRun.status === 'failed' ? 'rgba(218,54,51,0.15)' :
                             data.latestRun.status === 'stopped' ? 'rgba(139,148,158,0.15)' :
                             'rgba(63,185,80,0.1)',
                color: data.latestRun.status === 'running' ? '#3fb950' :
                       data.latestRun.status === 'failed' ? '#da3633' :
                       data.latestRun.status === 'stopped' ? '#8b949e' : '#3fb950',
              }}>
                {data.latestRun.status.toUpperCase()}
              </span>
              <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
                Started {relativeTime(data.latestRun.createdAt)}
              </span>
              {(data.latestRun.costUsd ?? 0) > 0 && (
                <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
                  · {costStr(data.latestRun.costUsd ?? 0)}
                </span>
              )}
            </div>
            <NavLink
              to={`/agents/${agent.id}/trace`}
              style={{ fontSize: '0.78rem', color: 'var(--accent)', textDecoration: 'none' }}
            >
              View trace →
            </NavLink>
          </div>
        </div>
      )}

      {/* ── Recent actions ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
          <h3 style={{ fontSize: '0.85rem', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Recent Actions
          </h3>
          <NavLink
            to={`/agents/${agent.id}/review-actions`}
            style={{ fontSize: '0.78rem', color: 'var(--accent)', textDecoration: 'none' }}
          >
            View all →
          </NavLink>
        </div>

        {data.recentActions.length === 0 ? (
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
            padding: '1.25rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.875rem',
          }}>
            No actions logged yet
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {data.recentActions.map((action) => (
              <div key={action.id} style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderLeft: action.blocked ? '3px solid #8b949e' : '3px solid transparent',
                borderRadius: 8,
                padding: '0.65rem 0.9rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
                flexWrap: 'wrap',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0 }}>
                  <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                    {formatFlowName(action.flowName)}
                  </span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                    {action.keyValue}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexShrink: 0 }}>
                  <ActionBadge status={action.status} />
                  <span style={{ fontSize: '0.72rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {relativeTime(action.createdAt)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
