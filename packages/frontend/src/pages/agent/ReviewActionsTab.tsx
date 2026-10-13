import { useState, useEffect, useCallback } from 'react';
import type {
  Agent, ActionLogEntry, FlowRun,
  ActionBrief, ScrapeReference, DbReference, HydratedContext,
  HydratedScrapeReference, HydratedDbReference, MemoryQueryResult,
} from '../../types/index.js';
import { formatFlowName } from '../../utils/formatFlowName.js';

interface Props {
  agent: Agent;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const BASE = 'http://localhost:3001';

function statusColor(status: string): string {
  switch (status) {
    case 'approved':
    case 'approved_with_edits':
    case 'executed': return '#3fb950';
    case 'pending_review': return '#d29922';
    case 'rejected': return '#f85149';
    case 'failed': return '#f85149';
    case 'blocked': return '#8b949e';
    default: return '#8b949e';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'approved': return '✅ APPROVED';
    case 'approved_with_edits': return '✅ APPROVED (edited)';
    case 'executed': return '✅ EXECUTED';
    case 'pending_review': return '⏳ PENDING';
    case 'rejected': return '❌ REJECTED';
    case 'failed': return '⚠ FAILED';
    case 'blocked': return '⛔ BLOCKED';
    default: return status.toUpperCase();
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = now.toDateString() === d.toDateString();
  if (today) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (yesterday.toDateString() === d.toDateString()) {
    return `yesterday ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Extract URL-like strings from a value for rendering as links
function extractUrls(val: unknown): string[] {
  if (typeof val !== 'string') return [];
  const matches = val.match(/https?:\/\/[^\s"',]+/g);
  return matches ?? [];
}

const CONTENT_FIELDS = ['content', 'message', 'text', 'comment_text', 'body', 'tweet_text', 'post_text', 'comment', 'reply'];

// ── ActionBrief / HydratedContext detection helpers ──────────────────────────

function isActionBrief(obj: Record<string, unknown>): obj is ActionBrief {
  return (
    typeof obj.action === 'object' && obj.action !== null &&
    typeof obj.decision_context === 'object' && obj.decision_context !== null &&
    typeof (obj.action as Record<string, unknown>).type === 'string' &&
    typeof (obj.decision_context as Record<string, unknown>).reason === 'string'
  );
}

function isHydratedContext(obj: Record<string, unknown>): obj is HydratedContext {
  if (!isActionBrief(obj)) return false;
  const dc = obj.decision_context as Record<string, unknown>;
  return Array.isArray(dc.memory_results);
}

// ── Rich Context Panel — rendered when input is ActionBrief or HydratedContext ─

interface RichContextPanelProps {
  brief: ActionBrief | HydratedContext;
  /** When true, show the return data from hydrated references */
  hydrated?: boolean;
}

function CollapsibleSection({
  label, count, accent, children,
}: { label: string; count?: number; accent?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: '1px solid var(--border)', marginTop: '0.5rem' }}>
      <button
        onClick={() => setOpen((p) => !p)}
        style={{
          width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer',
          padding: '0.4rem 0', display: 'flex', alignItems: 'center', gap: '0.4rem',
        }}
      >
        <span style={{ fontSize: '0.72rem', color: accent ?? 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {open ? '▼' : '▶'} {label}
        </span>
        {count !== undefined && (
          <span style={{ fontSize: '0.68rem', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '0.05rem 0.4rem', color: 'var(--muted)' }}>
            {count}
          </span>
        )}
      </button>
      {open && <div style={{ paddingBottom: '0.5rem' }}>{children}</div>}
    </div>
  );
}

function RichContextPanel({ brief, hydrated }: RichContextPanelProps) {
  const dc = brief.decision_context;
  const action = brief.action;

  // Extra action fields (beyond type and draft)
  const extraActionFields = Object.entries(action).filter(([k]) => k !== 'type' && k !== 'draft');

  return (
    <div style={{ fontSize: '0.82rem' }}>
      {/* Action type + URL chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.45rem' }}>
        <span style={{ fontSize: '0.7rem', background: 'rgba(63,185,80,0.12)', color: '#3fb950', border: '1px solid rgba(63,185,80,0.3)', borderRadius: 4, padding: '0.1rem 0.45rem', fontWeight: 700 }}>
          {action.type}
        </span>
        {extraActionFields.map(([k, v]) => {
            const str = String(v);
            const isUrl = str.startsWith('http');
            return isUrl ? (
              <a key={k} href={str} target="_blank" rel="noopener noreferrer"
                style={{ fontSize: '0.75rem', color: '#58a6ff', wordBreak: 'break-all' }}>
                ↗ {str}
              </a>
            ) : (
              <span key={k} style={{ fontSize: '0.75rem', color: 'var(--text)', opacity: 0.85 }}>
                <span style={{ color: 'var(--muted)' }}>{k}: </span>{str}
              </span>
            );
          })}
      </div>

      {/* Manager Draft — the rough shape Haiku wants to say */}
      {action.draft && (
        <div style={{ marginBottom: '0.45rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#d29922', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.2rem' }}>
            Manager Draft
          </div>
          <div style={{ background: 'rgba(210,153,34,0.07)', border: '1px solid rgba(210,153,34,0.2)', borderRadius: 6, padding: '0.45rem 0.65rem', color: 'var(--text)', opacity: 0.9, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {action.draft}
          </div>
        </div>
      )}

      {/* Supporting scrapes */}
      {dc.supporting_scrapes.length > 0 && (
        <CollapsibleSection label="Supporting evidence" count={dc.supporting_scrapes.length} accent="#58a6ff">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {dc.supporting_scrapes.map((s: ScrapeReference | HydratedScrapeReference, i: number) => {
              const hydratedScrape = hydrated ? (s as HydratedScrapeReference) : null;
              const returnData = hydratedScrape?.return;
              return (
                <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.4rem 0.6rem' }}>
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.2rem', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: '#79c0ff', background: 'rgba(121,192,255,0.1)', border: '1px solid rgba(121,192,255,0.2)', borderRadius: 3, padding: '0.05rem 0.35rem' }}>
                      {s.tool}
                    </span>
                    {Object.entries(s.input).map(([k, v]) => {
                      const str = String(v);
                      const isUrl = str.startsWith('http');
                      return isUrl ? (
                        <a key={k} href={str} target="_blank" rel="noopener noreferrer"
                          style={{ fontSize: '0.72rem', color: '#58a6ff' }}>↗ {str}</a>
                      ) : (
                        <span key={k} style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{k}={str}</span>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text)', opacity: 0.8, fontStyle: 'italic', marginBottom: returnData ? '0.3rem' : 0 }}>
                    {s.relevance}
                  </div>
                  {returnData != null && (
                    <pre style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text)', opacity: 0.75, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 140, overflow: 'auto', marginTop: '0.25rem', background: 'rgba(0,0,0,0.15)', borderRadius: 4, padding: '0.3rem 0.5rem' }}>
                      {typeof returnData === 'string' ? returnData : JSON.stringify(returnData, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      )}

      {/* Memory queries / results */}
      {dc.memory_queries.length > 0 && (
        <CollapsibleSection label="Memory" count={dc.memory_queries.length} accent="#bc8cff">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {hydrated && isHydratedContext(brief as Record<string, unknown>)
              ? (brief as unknown as HydratedContext).decision_context.memory_results.map((mr: MemoryQueryResult, i: number) => (
                <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.35rem 0.6rem' }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#bc8cff', marginBottom: '0.2rem' }}>"{mr.query}"</div>
                  {(mr.results as Array<{ content?: string; score?: number }>).length === 0
                    ? <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>No results</div>
                    : (mr.results as Array<{ content?: string; score?: number }>).map((r, j) => (
                      <div key={j} style={{ fontSize: '0.72rem', color: 'var(--text)', opacity: 0.8, marginBottom: '0.15rem' }}>
                        {r.score !== undefined && <span style={{ color: '#bc8cff', marginRight: '0.3rem' }}>{(r.score * 100).toFixed(0)}%</span>}
                        {r.content ?? JSON.stringify(r)}
                      </div>
                    ))}
                </div>
              ))
              : dc.memory_queries.map((q: string, i: number) => (
                <div key={i} style={{ fontSize: '0.75rem', color: '#bc8cff', background: 'rgba(188,140,255,0.07)', border: '1px solid rgba(188,140,255,0.2)', borderRadius: 4, padding: '0.25rem 0.5rem' }}>
                  🧠 {q}
                </div>
              ))
            }
          </div>
        </CollapsibleSection>
      )}

      {/* Database context */}
      {dc.database_context.length > 0 && (
        <CollapsibleSection label="Database context" count={dc.database_context.length} accent="#56d364">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {dc.database_context.map((dbRef: DbReference | HydratedDbReference, i: number) => {
              const hydratedDb = hydrated ? (dbRef as HydratedDbReference) : null;
              const rows = hydratedDb?.return ?? [];
              return (
                <div key={i} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.35rem 0.6rem' }}>
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.15rem' }}>
                    <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: '#56d364', background: 'rgba(86,211,100,0.1)', border: '1px solid rgba(86,211,100,0.2)', borderRadius: 3, padding: '0.05rem 0.35rem' }}>
                      {dbRef.table_id.slice(0, 8)}…
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text)', opacity: 0.8, fontStyle: 'italic' }}>
                      {dbRef.description}
                    </span>
                  </div>
                  {rows.length > 0 && (
                    <pre style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text)', opacity: 0.75, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 100, overflow: 'auto', background: 'rgba(0,0,0,0.15)', borderRadius: 4, padding: '0.3rem 0.5rem', marginTop: '0.2rem' }}>
                      {JSON.stringify(rows, null, 2)}
                    </pre>
                  )}
                  {hydrated && rows.length === 0 && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>No rows found</div>
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

// ── Step Trace Panel ────────────────────────────────────────────────────────

interface StepsPanelProps {
  agentId: string;
  flowId: string;
  entryCreatedAt: string;
}

type StepsPanelState = { phase: 'loading' } | { phase: 'none' } | { phase: 'ready'; run: FlowRun };

function StepsPanel({ agentId, flowId, entryCreatedAt }: StepsPanelProps) {
  const [state, setState] = useState<StepsPanelState>({ phase: 'loading' });

  useEffect(() => {
    fetch(`${BASE}/agents/${agentId}/flow-runs?flow_id=${encodeURIComponent(flowId)}&limit=20`)
      .then((r) => r.json())
      .then((runs: FlowRun[]) => {
        if (!runs.length) { setState({ phase: 'none' }); return; }
        // Pick the run closest in time to entryCreatedAt
        const entryMs = new Date(entryCreatedAt).getTime();
        const sorted = [...runs].sort((a, b) => {
          const da = Math.abs(new Date(a.createdAt).getTime() - entryMs);
          const db = Math.abs(new Date(b.createdAt).getTime() - entryMs);
          return da - db;
        });
        setState({ phase: 'ready', run: sorted[0] });
      })
      .catch(() => setState({ phase: 'none' }));
  }, [agentId, flowId, entryCreatedAt]);

  if (state.phase === 'loading') return <div style={{ padding: '0.75rem 1rem', color: 'var(--muted)', fontSize: '0.8rem' }}>Loading step trace…</div>;
  if (state.phase === 'none') return <div style={{ padding: '0.75rem 1rem', color: 'var(--muted)', fontSize: '0.8rem' }}>No flow run found.</div>;

  const flowRun = state.run;
  let stepResults: Record<string, unknown> = {};
  try { stepResults = JSON.parse(flowRun.stepResults ?? '{}') as Record<string, unknown>; } catch { /* ignore */ }

  const stepEntries = Object.entries(stepResults);

  return (
    <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.1)' }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.5rem' }}>
        Step trace · {flowRun.success ? <span style={{ color: '#3fb950' }}>OK</span> : <span style={{ color: '#f85149' }}>FAILED</span>}
        {flowRun.durationMs != null && <span style={{ fontWeight: 400, marginLeft: '0.5rem' }}>{flowRun.durationMs}ms</span>}
      </div>
      {flowRun.error && (
        <div style={{ marginBottom: '0.5rem', background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.3)', borderRadius: 4, padding: '0.4rem 0.65rem', fontSize: '0.78rem', color: '#f85149' }}>
          {flowRun.error}
        </div>
      )}
      {stepEntries.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: '0.78rem' }}>No step data recorded.</div>
      ) : (
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
      )}
    </div>
  );
}

// ── Pending Entry Card ───────────────────────────────────────────────────────

interface PendingCardProps {
  entry: ActionLogEntry;
  agentId: string;
  onDone: () => void;
}

function PendingCard({ entry, agentId, onDone }: PendingCardProps) {
  const [mode, setMode] = useState<'default' | 'amend' | 'reject' | 'thought'>('default');
  const [thoughtMode, setThoughtMode] = useState<'play' | 'edit'>('play');
  const [amendedContent, setAmendedContent] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [thoughtText, setThoughtText] = useState('');
  const [thoughtLoading, setThoughtLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [flowIdCopied, setFlowIdCopied] = useState(false);
  // Track expanded state for individual long text fields
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set());
  // Hydrated context fetched from the flow run step results (__hydrate__ output)
  const [hydratedContext, setHydratedContext] = useState<HydratedContext | null>(null);
  const [hydrateError, setHydrateError] = useState<string | null>(null);

  let inputObj: Record<string, unknown> = {};
  try { inputObj = JSON.parse(entry.input) as Record<string, unknown>; } catch { /* ignore */ }

  // Detect rich brief format (OPERATION VANTAGE pipeline).
  // action_brief is stored as a JSON string nested inside inputObj, NOT as the top-level object.
  const richBrief = (() => {
    const rawBrief = inputObj['action_brief'];
    if (!rawBrief) return null;
    try {
      const parsed = typeof rawBrief === 'string'
        ? JSON.parse(rawBrief) as Record<string, unknown>
        : rawBrief as Record<string, unknown>;
      return isActionBrief(parsed) ? parsed as ActionBrief : null;
    } catch { return null; }
  })();

  // When a rich brief is detected, fetch the nearest flow run and extract the HydratedContext
  // from the __hydrate__ step result (hydration ran before the review pause).
  useEffect(() => {
    if (!richBrief) return;
    const entryMs = new Date(entry.createdAt).getTime();
    fetch(`${BASE}/agents/${agentId}/flow-runs?flow_id=${encodeURIComponent(entry.flowId)}&limit=20`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`flow-runs fetch returned HTTP ${r.status}`);
        return r.json() as Promise<FlowRun[]>;
      })
      .then((runs) => {
        if (!runs.length) {
          setHydrateError(`No flow runs found for flow_id ${entry.flowId} — the flow may not have started yet.`);
          return;
        }
        const sorted = [...runs].sort((a, b) =>
          Math.abs(new Date(a.createdAt).getTime() - entryMs) -
          Math.abs(new Date(b.createdAt).getTime() - entryMs)
        );
        const run = sorted[0];
        let stepResults: Record<string, unknown> = {};
        try {
          stepResults = JSON.parse(run.stepResults ?? '{}') as Record<string, unknown>;
        } catch (e) {
          setHydrateError(`Could not parse stepResults for run ${run.id}: ${(e as Error).message}`);
          return;
        }
        const stepKeys = Object.keys(stepResults);
        if (stepKeys.length === 0) {
          setHydrateError(`Flow run ${run.id} has no step results recorded — __hydrate__ may not have stored its output.`);
          return;
        }
        // Scan all step results for the one that is a HydratedContext
        for (const [stepId, val] of Object.entries(stepResults)) {
          if (val && typeof val === 'object' && isHydratedContext(val as Record<string, unknown>)) {
            setHydratedContext(val as HydratedContext);
            return;
          }
          if (typeof val === 'string') {
            try {
              const parsed = JSON.parse(val) as Record<string, unknown>;
              if (isHydratedContext(parsed)) { setHydratedContext(parsed as HydratedContext); return; }
            } catch { /* not JSON */ }
          }
          void stepId; // suppress unused-var lint
        }
        setHydrateError(
          `No HydratedContext found in step results for run ${run.id}. ` +
          `Steps present: [${stepKeys.join(', ')}]. ` +
          `Check that __hydrate__ is storing its output and that isHydratedContext passes (needs action + decision_context.memory_results).`
        );
      })
      .catch((e: Error) => {
        setHydrateError(`Failed to fetch flow runs: ${e.message}`);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id]);

  // Use the hydrated context if available, otherwise fall back to the raw brief
  const displayBrief: ActionBrief | HydratedContext | null = hydratedContext ?? richBrief;
  const isHydrated = hydratedContext !== null;

  // Extract content field value for the amend editor
  // In rich brief format, the manager draft can be edited
  const contentField = displayBrief ? null : CONTENT_FIELDS.find((f) => f in inputObj);
  const contentValue = displayBrief
    ? (displayBrief.action.draft ?? '')
    : contentField ? String(inputObj[contentField] ?? '') : '';

  // reason_for_action — displayed prominently, excluded from the regular input list
  // In rich brief format, reason comes from decision_context.reason instead
  const reasonForAction = displayBrief
    ? displayBrief.decision_context.reason
    : inputObj['reason_for_action'] as string | undefined;

  // For flat format: filter out reason_for_action and action_brief from the field list
  const filteredInputObj = displayBrief
    ? {} // not used in rich format — all fields rendered via RichContextPanel
    : Object.fromEntries(Object.entries(inputObj).filter(([k]) => k !== 'reason_for_action' && k !== 'action_brief'));

  const play = async (amended?: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${BASE}/agents/${agentId}/action-log/${entry.id}/play`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(amended !== undefined ? { amendedContent: amended } : {}),
      });
      if (!res.ok) { const b = await res.json() as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
      onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  const reject = async () => {
    if (!rejectReason.trim()) { setError('Rejection reason required'); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${BASE}/agents/${agentId}/action-log/${entry.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason.trim() }),
      });
      if (!res.ok) { const b = await res.json() as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
      onDone();
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  };

  const applyThought = async () => {
    if (!thoughtText.trim()) { setError('Please enter an instruction'); return; }
    setThoughtLoading(true); setError(null);
    try {
      const res = await fetch(`${BASE}/agents/${agentId}/action-log/${entry.id}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thought: thoughtText.trim() }),
      });
      if (!res.ok) { const b = await res.json() as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
      const { revisedContent } = await res.json() as { revisedContent: string };
      if (thoughtMode === 'play') {
        // Immediately play with the revised content
        await play(revisedContent);
      } else {
        // Pre-fill the amend editor and switch to amend mode
        setAmendedContent(revisedContent);
        setMode('amend');
      }
    } catch (e) { setError((e as Error).message); }
    finally { setThoughtLoading(false); }
  };

  const copyId = () => {
    void navigator.clipboard.writeText(entry.id).then(() => {
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 1500);
    });
  };

  const copyFlowId = () => {
    void navigator.clipboard.writeText(entry.flowId).then(() => {
      setFlowIdCopied(true);
      setTimeout(() => setFlowIdCopied(false), 1500);
    });
  };

  const toggleFieldExpand = (key: string) => {
    setExpandedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const btn: React.CSSProperties = {
    background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--muted)', padding: '0.3rem 0.75rem', fontSize: '0.8rem', cursor: 'pointer',
  };

  const chipBtn: React.CSSProperties = {
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
    padding: '0.1rem 0.4rem', fontSize: '0.68rem', fontFamily: 'monospace', cursor: 'pointer',
  };

  const visibleEntries = Object.entries(filteredInputObj).slice(0, showInput ? undefined : 3);

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid rgba(210,153,34,0.35)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '0.65rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.7rem', background: 'rgba(210,153,34,0.15)', color: '#d29922', border: '1px solid rgba(210,153,34,0.3)', borderRadius: 4, padding: '0.15rem 0.4rem', fontWeight: 700, flexShrink: 0 }}>
          ⏳ PENDING
        </span>
        <span style={{ fontSize: '0.85rem', color: 'var(--accent)', fontWeight: 600 }}>⚡ {formatFlowName(entry.flowName)}</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text)', opacity: 0.8 }}>
          {entry.keyValue}
        </span>
        {/* Action ID chip */}
        <button
          title={idCopied ? 'Copied!' : 'Copy Action ID'}
          onClick={copyId}
          style={{ ...chipBtn, color: idCopied ? '#3fb950' : 'var(--muted)' }}
        >
          {idCopied ? '✓ copied' : entry.id.slice(0, 8) + '…'}
        </button>
        {/* Flow ID chip — hidden for infrastructure actions (no real flow) */}
        {entry.flowType === 'infrastructure' ? (
          <span style={{ fontSize: '0.68rem', background: 'rgba(88,166,255,0.1)', color: '#79c0ff', border: '1px solid rgba(88,166,255,0.25)', borderRadius: 4, padding: '0.1rem 0.4rem', fontFamily: 'monospace' }}>
            infrastructure
          </span>
        ) : (
          <button
            title={flowIdCopied ? 'Copied!' : 'Copy Flow ID'}
            onClick={copyFlowId}
            style={{ ...chipBtn, color: flowIdCopied ? '#3fb950' : '#79c0ff' }}
          >
            {flowIdCopied ? '✓ flow copied' : `flow:${entry.flowId.slice(0, 6)}…`}
          </button>
        )}
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)', marginLeft: 'auto', flexShrink: 0 }}>
          queued {fmtTime(entry.createdAt)}
        </span>
      </div>

      {/* Reason for action — prominent banner */}
      {reasonForAction && (
        <div style={{ padding: '0.55rem 1rem', borderBottom: '1px solid var(--border)', background: 'rgba(88,166,255,0.06)', display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#79c0ff', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0, paddingTop: '0.1rem' }}>
            Why
          </span>
          <span style={{ fontSize: '0.82rem', color: 'var(--text)', lineHeight: 1.45 }}>
            {reasonForAction}
          </span>
        </div>
      )}

      {/* Input preview — rich context panel for ActionBrief format, flat list otherwise */}
      <div style={{ padding: '0.55rem 1rem', borderBottom: '1px solid var(--border)' }}>
        {displayBrief ? (
          <RichContextPanel brief={displayBrief} hydrated={isHydrated} />
        ) : (
          <>
            {visibleEntries.map(([k, v]) => {
              const str = typeof v === 'string' ? v : JSON.stringify(v);
              const isUrl = str.startsWith('http');
              const isContentField = CONTENT_FIELDS.includes(k);
              const isExpanded = expandedFields.has(k);
              // For content fields: always show full text (they're the main thing to review)
              // For other long strings: truncate at 200 chars with expand toggle
              const TRUNCATE_AT = isContentField ? Infinity : 200;
              const needsTruncation = !isContentField && str.length > TRUNCATE_AT;
              const displayStr = needsTruncation && !isExpanded ? str.slice(0, TRUNCATE_AT) + '…' : str;

              return (
                <div key={k} style={{ marginBottom: '0.35rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.8rem', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', flexShrink: 0, minWidth: 110, fontWeight: isContentField ? 600 : 400 }}>{k}:</span>
                    {isUrl ? (
                      <a href={str} target="_blank" rel="noopener noreferrer" style={{ color: '#58a6ff', wordBreak: 'break-all' }}>{str}</a>
                    ) : (
                      <span style={{
                        color: 'var(--text)',
                        opacity: isContentField ? 1 : 0.9,
                        wordBreak: 'break-word',
                        whiteSpace: 'pre-wrap',
                        lineHeight: 1.5,
                      }}>
                        {displayStr}
                      </span>
                    )}
                  </div>
                  {needsTruncation && (
                    <button
                      onClick={() => toggleFieldExpand(k)}
                      style={{ ...btn, fontSize: '0.7rem', padding: '0.1rem 0.4rem', marginTop: '0.1rem', marginLeft: 118 }}
                    >
                      {isExpanded ? '▲ Less' : '▸ More'}
                    </button>
                  )}
                </div>
              );
            })}
            {Object.keys(filteredInputObj).length > 3 && (
              <button onClick={() => setShowInput((p) => !p)} style={{ ...btn, fontSize: '0.72rem', padding: '0.1rem 0.4rem', marginTop: '0.2rem' }}>
                {showInput ? '▲ Show less' : `▸ Show all fields (${Object.keys(filteredInputObj).length} total)`}
              </button>
            )}
          </>
        )}
      </div>

      {/* Hydration fetch error — shown when __hydrate__ output could not be located */}
      {hydrateError && !hydratedContext && (
        <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', background: 'rgba(248,81,73,0.06)', display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#f85149', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0, paddingTop: '0.1rem' }}>
            ⚠ Hydration fetch failed
          </span>
          <span style={{ fontSize: '0.78rem', color: '#f85149', opacity: 0.9, lineHeight: 1.45, wordBreak: 'break-word' }}>
            {hydrateError}
          </span>
        </div>
      )}

      {/* Supervisor Draft — content produced by __generate__ after flow execution */}
      {entry.finalContent && (
        <div style={{ padding: '0.55rem 1rem', borderBottom: '1px solid var(--border)', background: 'rgba(63,185,80,0.04)' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#3fb950', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.3rem' }}>
            Supervisor Draft
          </div>
          <div style={{ background: 'rgba(63,185,80,0.07)', border: '1px solid rgba(63,185,80,0.2)', borderRadius: 6, padding: '0.5rem 0.75rem', color: 'var(--text)', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.85rem' }}>
            {entry.finalContent}
          </div>
        </div>
      )}

      {/* Amend editor */}
      {mode === 'amend' && (
        <div style={{ padding: '0.65rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.35rem' }}>
            {displayBrief ? 'Edit manager draft before playing — Sonnet will use this as guidance' : 'Edit content before playing'}
          </div>
          <textarea
            autoFocus
            value={amendedContent}
            onChange={(e) => setAmendedContent(e.target.value)}
            rows={6}
            style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.82rem', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.5 }}
          />
        </div>
      )}

      {/* Thought input */}
      {mode === 'thought' && (
        <div style={{ padding: '0.65rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.35rem' }}>
            {thoughtMode === 'play' ? 'Instruction → AI revises → plays' : 'Instruction → AI revises → review before playing'}
          </div>
          <textarea
            autoFocus
            value={thoughtText}
            onChange={(e) => setThoughtText(e.target.value)}
            placeholder="e.g. tone it down a bit, less salesy…"
            rows={3}
            style={{ width: '100%', background: 'var(--bg)', border: '1px solid rgba(121,192,255,0.3)', borderRadius: 6, color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.82rem', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.5 }}
          />
        </div>
      )}

      {/* Reject reason input */}
      {mode === 'reject' && (
        <div style={{ padding: '0.65rem 1rem', borderBottom: '1px solid var(--border)' }}>
          <input
            autoFocus
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void reject(); if (e.key === 'Escape') setMode('default'); }}
            placeholder="Reason for rejection…"
            style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '0.4rem 0.65rem', fontSize: '0.82rem', boxSizing: 'border-box' }}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '0.4rem 1rem', background: 'rgba(248,81,73,0.08)', color: '#f85149', fontSize: '0.78rem', borderBottom: '1px solid var(--border)' }}>
          ⚠ {error}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ padding: '0.55rem 1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {mode === 'default' && (
          <>
            <button
              onClick={() => void play()}
              disabled={loading}
              style={{ background: '#238636', color: '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 1rem', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
            >
              {loading ? '…' : entry.flowType === 'infrastructure' ? '✓ Approve' : '▶ Play'}
            </button>
            {/* Amend/thought buttons only make sense for flows with editable content */}
            {entry.flowType !== 'infrastructure' && (
              <>
                <button
                  onClick={() => { setAmendedContent(contentValue); setMode('amend'); }}
                  style={{ ...btn, color: '#58a6ff', border: '1px solid rgba(88,166,255,0.3)' }}
                >
                  ✎ Play Amended
                </button>
                <button
                  onClick={() => { setThoughtMode('play'); setThoughtText(''); setMode('thought'); }}
                  style={{ ...btn, color: '#d2a679', border: '1px solid rgba(210,153,34,0.3)' }}
                >
                  💭 Play with thought
                </button>
                <button
                  onClick={() => { setThoughtMode('edit'); setThoughtText(''); setMode('thought'); }}
                  style={{ ...btn, color: '#d2a679', border: '1px solid rgba(210,153,34,0.3)' }}
                >
                  ✎💭 Edit with thought
                </button>
              </>
            )}
            <button
              onClick={() => setMode('reject')}
              style={{ ...btn, color: '#f85149', border: '1px solid rgba(248,81,73,0.3)' }}
            >
              ✗ Reject
            </button>
          </>
        )}
        {mode === 'amend' && (
          <>
            <button
              onClick={() => void play(amendedContent)}
              disabled={loading || !amendedContent.trim()}
              style={{ background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 1rem', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}
            >
              {loading ? '…' : '▶ Play with edits'}
            </button>
            <button onClick={() => setMode('default')} style={btn}>Cancel</button>
          </>
        )}
        {mode === 'thought' && (
          <>
            <button
              onClick={() => void applyThought()}
              disabled={thoughtLoading || !thoughtText.trim()}
              style={{ background: '#6e4c1e', color: '#d2a679', border: '1px solid rgba(210,153,34,0.4)', borderRadius: 6, padding: '0.35rem 1rem', fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', opacity: (thoughtLoading || !thoughtText.trim()) ? 0.5 : 1 }}
            >
              {thoughtLoading
                ? '⏳ Revising…'
                : thoughtMode === 'play'
                  ? '💭 Apply & Play'
                  : '💭 Apply → Review edits'}
            </button>
            <button onClick={() => { setMode('default'); setThoughtText(''); }} style={btn}>Cancel</button>
          </>
        )}
        {mode === 'reject' && (
          <>
            <button
              onClick={() => void reject()}
              disabled={loading}
              style={{ background: '#b91c1c', color: '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: 'pointer' }}
            >
              {loading ? '…' : 'Confirm reject'}
            </button>
            <button onClick={() => { setMode('default'); setRejectReason(''); }} style={btn}>Cancel</button>
          </>
        )}
        <button
          onClick={() => setShowSteps((p) => !p)}
          style={{ ...btn, marginLeft: 'auto', fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
        >
          {showSteps ? '▲ Steps' : '▸ Steps'}
        </button>
      </div>

      {/* Steps panel */}
      {showSteps && <StepsPanel agentId={agentId} flowId={entry.flowId} entryCreatedAt={entry.createdAt} />}
    </div>
  );
}

// ── History Entry Row ────────────────────────────────────────────────────────

interface HistoryRowProps {
  entry: ActionLogEntry;
  agentId: string;
  onRerun: () => void;
}

function HistoryRow({ entry, agentId, onRerun }: HistoryRowProps) {
  const [showSteps, setShowSteps] = useState(false);
  const [rerunLoading, setRerunLoading] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [idCopied, setIdCopied] = useState(false);
  const [flowIdCopied, setFlowIdCopied] = useState(false);

  const rerun = async () => {
    setRerunLoading(true); setRerunError(null);
    try {
      const res = await fetch(`${BASE}/agents/${agentId}/action-log/${entry.id}/rerun`, { method: 'POST' });
      if (!res.ok) { const b = await res.json() as { error?: string }; throw new Error(b.error ?? `HTTP ${res.status}`); }
      onRerun();
    } catch (e) { setRerunError((e as Error).message); }
    finally { setRerunLoading(false); }
  };

  const copyId = () => {
    void navigator.clipboard.writeText(entry.id).then(() => {
      setIdCopied(true);
      setTimeout(() => setIdCopied(false), 1500);
    });
  };

  const copyFlowId = () => {
    void navigator.clipboard.writeText(entry.flowId).then(() => {
      setFlowIdCopied(true);
      setTimeout(() => setFlowIdCopied(false), 1500);
    });
  };

  // Extract reason_for_action / decision context if present
  let inputObj: Record<string, unknown> = {};
  try { inputObj = JSON.parse(entry.input) as Record<string, unknown>; } catch { /* ignore */ }
  const richBrief = isActionBrief(inputObj) ? inputObj as ActionBrief : null;
  const reasonForAction = richBrief
    ? richBrief.decision_context.reason
    : inputObj['reason_for_action'] as string | undefined;

  const [showContext, setShowContext] = useState(false);

  const btn: React.CSSProperties = {
    background: 'transparent', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--muted)', padding: '0.2rem 0.5rem', fontSize: '0.72rem', cursor: 'pointer',
  };

  const chipBtn: React.CSSProperties = {
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
    padding: '0.1rem 0.4rem', fontSize: '0.65rem', fontFamily: 'monospace', cursor: 'pointer',
  };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', padding: '0.45rem 0.75rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: statusColor(entry.status), flexShrink: 0, textTransform: 'uppercase', minWidth: 80 }}>
          {statusLabel(entry.status)}
        </span>
        <span style={{ fontSize: '0.78rem', color: 'var(--accent)' }}>{formatFlowName(entry.flowName)}</span>
        <span style={{ fontSize: '0.78rem', color: 'var(--text)', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 240 }}>
          {entry.keyValue}
        </span>
        {entry.reRunCount > 0 && (
          <span style={{ fontSize: '0.68rem', color: 'var(--muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: '0.1rem 0.35rem' }}>
            ↺ ×{entry.reRunCount}
          </span>
        )}
        {/* Copy chips */}
        <button title={idCopied ? 'Copied!' : 'Copy Action ID'} onClick={copyId}
          style={{ ...chipBtn, color: idCopied ? '#3fb950' : 'var(--muted)' }}>
          {idCopied ? '✓' : entry.id.slice(0, 6) + '…'}
        </button>
        <button title={flowIdCopied ? 'Copied!' : 'Copy Flow ID'} onClick={copyFlowId}
          style={{ ...chipBtn, color: flowIdCopied ? '#3fb950' : '#79c0ff' }}>
          {flowIdCopied ? '✓' : `flow:${entry.flowId.slice(0, 6)}…`}
        </button>
        <span style={{ fontSize: '0.72rem', color: 'var(--muted)', marginLeft: 'auto', flexShrink: 0 }}>
          {fmtTime(entry.createdAt)}
        </span>
        <button onClick={() => setShowSteps((p) => !p)} style={btn}>{showSteps ? '▲ Steps' : '▸ Steps'}</button>
        {richBrief && (
          <button onClick={() => setShowContext((p) => !p)} style={btn}>{showContext ? '▲ Context' : '▸ Context'}</button>
        )}
        <button onClick={() => void rerun()} disabled={rerunLoading} style={btn}>{rerunLoading ? '…' : '↺ Re-run'}</button>
      </div>
      {reasonForAction && (
        <div style={{ padding: '0 0.75rem 0.4rem', fontSize: '0.76rem', color: '#79c0ff', display: 'flex', gap: '0.4rem' }}>
          <span style={{ fontWeight: 700, flexShrink: 0 }}>Why:</span>
          <span>{reasonForAction}</span>
        </div>
      )}
      {entry.blockedReason && (
        <div style={{ padding: '0 0.75rem 0.4rem', fontSize: '0.76rem', color: '#d29922' }}>
          {entry.blockedReason}
        </div>
      )}
      {entry.finalContent && (
        <div style={{ padding: '0 0.75rem 0.4rem', fontSize: '0.76rem', color: 'var(--muted)' }}>
          <span style={{ fontWeight: 600 }}>Final: </span>{entry.finalContent.length > 160 ? entry.finalContent.slice(0, 160) + '…' : entry.finalContent}
        </div>
      )}
      {rerunError && (
        <div style={{ padding: '0.3rem 0.75rem', color: '#f85149', fontSize: '0.75rem', background: 'rgba(248,81,73,0.06)' }}>
          ⚠ {rerunError}
        </div>
      )}
      {showContext && richBrief && (
        <div style={{ padding: '0.5rem 0.75rem', borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.06)' }}>
          <RichContextPanel brief={richBrief} hydrated={isHydratedContext(inputObj)} />
        </div>
      )}
      {showSteps && <StepsPanel agentId={agentId} flowId={entry.flowId} entryCreatedAt={entry.createdAt} />}
    </div>
  );
}

// ── Main Tab ─────────────────────────────────────────────────────────────────

export default function ReviewActionsTab({ agent }: Props) {
  const [entries, setEntries] = useState<ActionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<'pending' | 'history'>('pending');

  const fetchEntries = useCallback(() => {
    // No flowType filter — show action, infrastructure, and any future types
    fetch(`${BASE}/agents/${agent.id}/action-log?limit=200`)
      .then((r) => r.json())
      .then((data: ActionLogEntry[]) => setEntries(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [agent.id]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  // Poll for pending entries every 15s
  useEffect(() => {
    const t = setInterval(fetchEntries, 15000);
    return () => clearInterval(t);
  }, [fetchEntries]);

  const pending = entries.filter((e) => e.status === 'pending_review');
  const history = entries.filter((e) => e.status !== 'pending_review');

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    background: 'transparent',
    border: 'none',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    color: active ? 'var(--accent)' : 'var(--muted)',
    padding: '0.5rem 1rem',
    fontSize: '0.875rem',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  });

  if (loading) return <div style={{ padding: '2rem', color: 'var(--muted)' }}>Loading…</div>;

  return (
    <div style={{ padding: '1.5rem', maxWidth: 860 }}>
      {/* Sub-tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', marginBottom: '1.25rem', gap: '0.25rem' }}>
        <button style={tabBtnStyle(activeSection === 'pending')} onClick={() => setActiveSection('pending')}>
          Pending
          {pending.length > 0 && (
            <span style={{ marginLeft: '0.4rem', background: '#d29922', color: '#000', borderRadius: 10, fontSize: '0.68rem', fontWeight: 700, padding: '0.1rem 0.45rem' }}>
              {pending.length}
            </span>
          )}
        </button>
        <button style={tabBtnStyle(activeSection === 'history')} onClick={() => setActiveSection('history')}>
          History
          {history.length > 0 && (
            <span style={{ marginLeft: '0.4rem', color: 'var(--muted)', fontSize: '0.75rem' }}>({history.length})</span>
          )}
        </button>
        <button
          onClick={fetchEntries}
          style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', padding: '0.25rem 0.65rem', fontSize: '0.78rem', cursor: 'pointer' }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Pending section */}
      {activeSection === 'pending' && (
        <>
          {pending.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
              No pending actions. Actions that require human approval will appear here.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {pending.map((entry) => (
                <PendingCard key={entry.id} entry={entry} agentId={agent.id} onDone={fetchEntries} />
              ))}
            </div>
          )}
        </>
      )}

      {/* History section */}
      {activeSection === 'history' && (
        <>
          {history.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>No completed action entries yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {history.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} agentId={agent.id} onRerun={fetchEntries} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
