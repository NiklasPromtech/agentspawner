import { useState, useEffect, useCallback } from 'react';
import type { Agent, FlowRun } from '../../types/index.js';

interface Props {
  agent: Agent;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:3001';

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = now.toDateString() === d.toDateString();
  if (today) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (yesterday.toDateString() === d.toDateString()) {
    return `yesterday ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// Extract URL-like strings from a value for rendering as links
function extractUrls(val: unknown): string[] {
  if (typeof val !== 'string') return [];
  const matches = val.match(/https?:\/\/[^\s"',]+/g);
  return matches ?? [];
}

// ── Step Trace ────────────────────────────────────────────────────────────────

interface StepTraceProps {
  run: FlowRun;
}

function StepTrace({ run }: StepTraceProps) {
  let stepResults: Record<string, unknown> = {};
  try { stepResults = JSON.parse(run.stepResults ?? '{}') as Record<string, unknown>; } catch { /* ignore */ }

  const stepEntries = Object.entries(stepResults);

  if (stepEntries.length === 0) {
    return (
      <div style={{ padding: '0.75rem 1rem', color: 'var(--muted)', fontSize: '0.8rem', borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.1)' }}>
        No step data recorded.
      </div>
    );
  }

  return (
    <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.1)' }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' }}>
        Step trace · {run.success
          ? <span style={{ color: '#3fb950' }}>OK</span>
          : <span style={{ color: '#f85149' }}>FAILED</span>}
        {run.durationMs != null && <span style={{ fontWeight: 400, marginLeft: '0.5rem' }}>{fmtDuration(run.durationMs)}</span>}
      </div>
      {run.error && (
        <div style={{ marginBottom: '0.5rem', background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.3)', borderRadius: 4, padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#f85149' }}>
          {run.error}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {stepEntries.map(([stepId, val]) => {
          const valStr = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
          const urls = extractUrls(typeof val === 'string' ? val : JSON.stringify(val));
          return (
            <div key={stepId} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.45rem 0.65rem' }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--accent)', marginBottom: '0.25rem' }}>
                {stepId}
              </div>
              <pre style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text)', opacity: 0.85, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }}>
                {valStr}
              </pre>
              {urls.length > 0 && (
                <div style={{ marginTop: '0.3rem', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                  {urls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: '0.75rem', color: '#58a6ff', wordBreak: 'break-all' }}>
                      ↗ {url}
                    </a>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Scrape Run Row ────────────────────────────────────────────────────────────

interface ScrapeRunRowProps {
  run: FlowRun;
  agentId: string;
  onRerun: () => void;
}

function ScrapeRunRow({ run, agentId, onRerun }: ScrapeRunRowProps) {
  const [showSteps, setShowSteps] = useState(false);
  const [rerunLoading, setRerunLoading] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  const rerun = async () => {
    setRerunLoading(true);
    setRerunError(null);
    try {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(run.input) as Record<string, unknown>; } catch { /* ignore */ }

      const res = await fetch(`${BASE}/agents/${agentId}/flows/${run.flowId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      if (!res.ok) {
        const b = await res.json() as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      onRerun();
    } catch (e) {
      setRerunError((e as Error).message);
    } finally {
      setRerunLoading(false);
    }
  };

  const btn: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--muted)',
    padding: '0.2rem 0.5rem',
    fontSize: '0.72rem',
    cursor: 'pointer',
  };

  return (
    <div style={{ background: 'var(--surface)', border: `1px solid ${run.success ? 'var(--border)' : 'rgba(248,81,73,0.25)'}`, borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.45rem 0.75rem', flexWrap: 'wrap' }}>
        {/* Status badge */}
        <span style={{
          fontSize: '0.7rem',
          fontWeight: 700,
          color: run.success ? '#3fb950' : '#f85149',
          flexShrink: 0,
          minWidth: 24,
        }}>
          {run.success ? '✅' : '❌'}
        </span>

        {/* Flow name */}
        <code style={{ fontSize: '0.82rem', color: 'var(--accent)', fontWeight: 600 }}>
          {run.flowName}
        </code>

        {/* Time */}
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
          {fmtTime(run.createdAt)}
        </span>

        {/* Duration */}
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
          {fmtDuration(run.durationMs)}
        </span>

        {/* Actions */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.35rem', alignItems: 'center', flexShrink: 0 }}>
          <button onClick={() => setShowSteps((p) => !p)} style={btn}>
            {showSteps ? '▲ Steps' : '▸ Steps'}
          </button>
          <button onClick={() => void rerun()} disabled={rerunLoading} style={btn}>
            {rerunLoading ? '…' : '↺ Re-run'}
          </button>
        </div>
      </div>

      {/* Error summary */}
      {!run.success && run.error && (
        <div style={{ padding: '0 0.75rem 0.4rem', fontSize: '0.76rem', color: '#f85149', fontFamily: 'monospace' }}>
          {run.error.length > 160 ? run.error.slice(0, 160) + '…' : run.error}
        </div>
      )}

      {/* Re-run error */}
      {rerunError && (
        <div style={{ padding: '0.3rem 0.75rem', color: '#f85149', fontSize: '0.75rem', background: 'rgba(248,81,73,0.06)', borderTop: '1px solid var(--border)' }}>
          ⚠ {rerunError}
        </div>
      )}

      {/* Step trace */}
      {showSteps && <StepTrace run={run} />}
    </div>
  );
}

// ── Main Tab ──────────────────────────────────────────────────────────────────

export default function ReviewScrapesTab({ agent }: Props) {
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRuns = useCallback(() => {
    fetch(`${BASE}/agents/${agent.id}/flow-runs?flowType=scrape&limit=100`)
      .then((r) => r.json())
      .then((data: FlowRun[]) => setRuns(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [agent.id]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  if (loading) return <div style={{ padding: '2rem', color: 'var(--muted)' }}>Loading…</div>;

  return (
    <div style={{ padding: '1.5rem', maxWidth: 860 }}>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1.25rem', gap: '0.75rem' }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Scrape Runs</h3>
        <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>({runs.length})</span>
        <button
          onClick={fetchRuns}
          style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', padding: '0.25rem 0.65rem', fontSize: '0.78rem', cursor: 'pointer' }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Run list */}
      {runs.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
          No scrape runs yet. Scrape flows will appear here once they have been executed.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {runs.map((run) => (
            <ScrapeRunRow key={run.id} run={run} agentId={agent.id} onRerun={fetchRuns} />
          ))}
        </div>
      )}
    </div>
  );
}
