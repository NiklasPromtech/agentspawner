/**
 * T7 — Run Trace View
 *
 * Shows the agent's recent runs as a causal timeline: for each run you can see
 * which flows were called, what the agent was thinking (reasoning), which goal
 * it was working toward, which model made the decision, and what the outcome was.
 *
 * Click any run to expand it and see the full flow call detail.
 * Click "Explain" to have Haiku synthesize a plain-English narrative of the run.
 */

import { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Run, FlowRun, RunExplanation } from '../../types/index.js';
import { formatFlowName } from '../../utils/formatFlowName.js';

interface Props {
  agent: Agent;
}

interface RunWithFlows extends Run {
  flows?: FlowRun[];
  explanation?: RunExplanation;
  loadingFlows?: boolean;
  loadingExplanation?: boolean;
}

const TRIGGER_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  manual:     { bg: 'rgba(56,139,253,0.15)',  color: '#58a6ff', label: 'chat' },
  autonomous: { bg: 'rgba(35,134,54,0.18)',   color: '#3fb950', label: 'auto' },
  schedule:   { bg: 'rgba(210,153,34,0.2)',   color: '#e3b341', label: 'cron' },
  telegram:   { bg: 'rgba(56,139,253,0.15)',  color: '#79c0ff', label: 'tg' },
};

const STATUS_BADGE: Record<string, { bg: string; color: string }> = {
  completed: { bg: 'rgba(35,134,54,0.15)',  color: '#3fb950' },
  failed:    { bg: 'rgba(218,54,51,0.15)',  color: '#da3633' },
  stopped:   { bg: 'rgba(139,148,158,0.2)', color: '#8b949e' },
  running:   { bg: 'rgba(35,134,54,0.2)',   color: '#56d364' },
  pending:   { bg: 'rgba(139,148,158,0.15)', color: '#8b949e' },
};

function badge(style: { bg: string; color: string }, text: string) {
  return (
    <span style={{
      background: style.bg,
      color: style.color,
      fontSize: '0.7rem',
      fontWeight: 600,
      padding: '0.1rem 0.4rem',
      borderRadius: 4,
      flexShrink: 0,
    }}>
      {text}
    </span>
  );
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function RunTraceTab({ agent }: Props) {
  const [runs, setRuns] = useState<RunWithFlows[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    api.getRuns(agent.id)
      .then((r) => setRuns(r.map((run) => ({ ...run }))))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [agent.id]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [load]);

  const toggleExpand = async (run: RunWithFlows) => {
    const next = new Set(expanded);
    if (next.has(run.id)) {
      next.delete(run.id);
      setExpanded(next);
      return;
    }
    next.add(run.id);
    setExpanded(next);

    // Load flows if not yet loaded
    if (!run.flows) {
      setRuns((prev) => prev.map((r) => r.id === run.id ? { ...r, loadingFlows: true } : r));
      try {
        const flows = await api.getRunFlowRuns(run.id);
        setRuns((prev) => prev.map((r) => r.id === run.id ? { ...r, flows, loadingFlows: false } : r));
      } catch {
        setRuns((prev) => prev.map((r) => r.id === run.id ? { ...r, flows: [], loadingFlows: false } : r));
      }
    }
  };

  const handleExplain = async (runId: string) => {
    setRuns((prev) => prev.map((r) => r.id === runId ? { ...r, loadingExplanation: true } : r));
    try {
      const explanation = await api.explainRun(runId);
      setRuns((prev) => prev.map((r) => r.id === runId ? { ...r, explanation, loadingExplanation: false } : r));
    } catch {
      setRuns((prev) => prev.map((r) => r.id === runId ? { ...r, loadingExplanation: false } : r));
    }
  };

  if (loading) {
    return <div style={{ padding: '2rem', color: 'var(--muted)', fontSize: '0.9rem' }}>Loading runs…</div>;
  }

  if (runs.length === 0) {
    return (
      <div style={{ padding: '2rem', color: 'var(--muted)', fontSize: '0.9rem' }}>
        No runs yet. Start a chat or trigger an autonomous run.
      </div>
    );
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: 860 }}>
      <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'baseline', gap: '0.75rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>Run Trace</h2>
        <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{runs.length} runs total — click any row to expand</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {runs.map((run) => {
          const isOpen = expanded.has(run.id);
          const trigStyle = TRIGGER_BADGE[run.trigger] ?? TRIGGER_BADGE.manual;
          const statStyle = STATUS_BADGE[run.status] ?? STATUS_BADGE.stopped;

          return (
            <div key={run.id} style={{
              background: 'var(--surface)',
              border: `1px solid ${isOpen ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 8,
              overflow: 'hidden',
            }}>
              {/* Run header row */}
              <button
                onClick={() => void toggleExpand(run)}
                style={{
                  width: '100%',
                  background: 'transparent',
                  border: 'none',
                  padding: '0.75rem 1rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ color: 'var(--muted)', fontSize: '0.8rem', flexShrink: 0 }}>
                  {isOpen ? '▾' : '▸'}
                </span>

                {badge(trigStyle, trigStyle.label)}
                {badge(statStyle, run.status)}

                {run.modelId && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--muted)', background: 'var(--bg)', padding: '0.1rem 0.4rem', borderRadius: 4, flexShrink: 0 }}>
                    {run.modelId.replace('claude-', '').replace(/-\d{8,}$/, '')}
                  </span>
                )}

                <span style={{ fontSize: '0.85rem', color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {run.input?.slice(0, 80) || '(no input)'}
                </span>

                {run.costUsd != null && run.costUsd > 0 && (
                  <span style={{ fontSize: '0.75rem', color: 'var(--muted)', flexShrink: 0 }}>
                    ${run.costUsd.toFixed(4)}
                  </span>
                )}

                <span style={{ fontSize: '0.75rem', color: 'var(--muted)', flexShrink: 0 }}>
                  {relativeTime(run.createdAt)}
                </span>
              </button>

              {/* Expanded content */}
              {isOpen && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '0.75rem 1rem' }}>

                  {/* Explain button & narrative */}
                  {!run.explanation && (
                    <button
                      onClick={() => void handleExplain(run.id)}
                      disabled={run.loadingExplanation}
                      style={{
                        marginBottom: '0.75rem',
                        fontSize: '0.78rem',
                        background: 'rgba(56,139,253,0.12)',
                        color: '#58a6ff',
                        border: '1px solid rgba(56,139,253,0.3)',
                        borderRadius: 4,
                        padding: '0.3rem 0.75rem',
                        cursor: run.loadingExplanation ? 'default' : 'pointer',
                        opacity: run.loadingExplanation ? 0.6 : 1,
                      }}
                    >
                      {run.loadingExplanation ? '⏳ Generating explanation…' : '✦ Explain this run'}
                    </button>
                  )}

                  {run.explanation && (
                    <div style={{
                      background: 'rgba(56,139,253,0.07)',
                      border: '1px solid rgba(56,139,253,0.2)',
                      borderRadius: 6,
                      padding: '0.75rem',
                      marginBottom: '0.75rem',
                    }}>
                      <div style={{ fontSize: '0.7rem', color: '#58a6ff', fontWeight: 600, marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        AI Explanation
                        {run.explanation.goalWorkedOn && (
                          <span style={{ fontWeight: 400, textTransform: 'none', marginLeft: '0.5rem', color: 'var(--muted)' }}>
                            · goal: {run.explanation.goalWorkedOn}
                          </span>
                        )}
                      </div>
                      <p style={{ fontSize: '0.85rem', color: 'var(--text)', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {run.explanation.narrative}
                      </p>
                      <div style={{ marginTop: '0.5rem', fontSize: '0.72rem', color: 'var(--muted)', display: 'flex', gap: '1rem' }}>
                        <span>{run.explanation.flowRunCount} flow calls</span>
                        <span>{run.explanation.dbRowsWritten} DB writes</span>
                        {run.explanation.modelUsed && <span>model: {run.explanation.modelUsed.replace('claude-', '')}</span>}
                      </div>
                    </div>
                  )}

                  {/* Flow call timeline */}
                  {run.loadingFlows && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Loading flow calls…</div>
                  )}

                  {run.flows && run.flows.length === 0 && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>No flow calls recorded for this run.</div>
                  )}

                  {run.flows && run.flows.length > 0 && (
                    <div>
                      <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                        Flow calls ({run.flows.length})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                        {run.flows.map((fr) => (
                          <FlowCallCard key={fr.id} fr={fr} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FlowCallCard({ fr }: { fr: FlowRun }) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{
      background: 'var(--bg)',
      border: `1px solid ${fr.success ? 'var(--border)' : 'rgba(218,54,51,0.35)'}`,
      borderLeft: `3px solid ${fr.success ? (fr.evaluationPassed === false ? '#e3b341' : '#3fb950') : '#da3633'}`,
      borderRadius: 5,
      overflow: 'hidden',
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: '0.45rem 0.65rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: '0.75rem', color: fr.success ? '#3fb950' : '#da3633', flexShrink: 0 }}>
          {fr.success ? '✓' : '✗'}
        </span>
        <span style={{ fontSize: '0.82rem', color: 'var(--text)', fontWeight: 500, flex: 1 }}>
          {formatFlowName(fr.flowName)}
        </span>
        {fr.modelId && (
          <span style={{ fontSize: '0.68rem', color: 'var(--muted)', background: 'var(--surface)', padding: '0.1rem 0.3rem', borderRadius: 3 }}>
            {fr.modelId.replace('claude-', '').replace(/-\d{8,}$/, '')}
          </span>
        )}
        {fr.durationMs != null && (
          <span style={{ fontSize: '0.72rem', color: 'var(--muted)', flexShrink: 0 }}>
            {formatDuration(fr.durationMs)}
          </span>
        )}
        <span style={{ color: 'var(--muted)', fontSize: '0.72rem' }}>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '0.5rem 0.65rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          {fr.reasoning && (
            <LabeledSection label="Reasoning" color="#58a6ff">
              {fr.reasoning}
            </LabeledSection>
          )}
          {fr.goalId && (
            <LabeledSection label="Goal" color="#e3b341">
              {fr.goalId}
            </LabeledSection>
          )}
          {fr.error && (
            <LabeledSection label="Error" color="#da3633">
              {fr.error}
            </LabeledSection>
          )}
          {fr.evaluationReason && (
            <LabeledSection label={`Eval ${fr.evaluationPassed ? 'passed' : 'failed'}`} color={fr.evaluationPassed ? '#3fb950' : '#e3b341'}>
              {fr.evaluationReason}
            </LabeledSection>
          )}
          {fr.output && (
            <LabeledSection label="Output" color="var(--muted)">
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(fr.output), null, 2).slice(0, 500);
                } catch {
                  return fr.output.slice(0, 500);
                }
              })()}
            </LabeledSection>
          )}
        </div>
      )}
    </div>
  );
}

function LabeledSection({ label, color, children }: { label: string; color: string; children: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.68rem', fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.2rem' }}>
        {label}
      </div>
      <div style={{ fontSize: '0.8rem', color: 'var(--text)', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {children}
      </div>
    </div>
  );
}
