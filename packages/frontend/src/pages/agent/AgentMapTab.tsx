/**
 * T8 — Connected Agent Brain View
 *
 * A single page that shows everything connected: goals, flows, tools, and tables.
 * For each flow you can see what tables it reads/writes, its recent run stats,
 * and whether it's been pinned, infeasible, or requires human review.
 *
 * This is the answer to "I want to understand how everything in this agent connects."
 * Instead of jumping between Flows / Tools / Tables / Goals tabs, you get the full
 * picture in one place.
 */

import { useEffect, useState } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Flow, Goal, Table, FlowRun } from '../../types/index.js';

interface Props {
  agent: Agent;
}

interface FlowStats {
  total: number;
  succeeded: number;
  failed: number;
  lastRan: string | null;
  avgDurationMs: number | null;
}

function computeStats(runs: FlowRun[]): FlowStats {
  if (runs.length === 0) return { total: 0, succeeded: 0, failed: 0, lastRan: null, avgDurationMs: null };
  const succeeded = runs.filter((r) => r.success).length;
  const withDuration = runs.filter((r) => r.durationMs != null);
  const avgDurationMs = withDuration.length > 0
    ? Math.round(withDuration.reduce((s, r) => s + r.durationMs!, 0) / withDuration.length)
    : null;
  return {
    total: runs.length,
    succeeded,
    failed: runs.length - succeeded,
    lastRan: runs[0]?.createdAt ?? null,
    avgDurationMs,
  };
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function parseJsonList(s: string | null | undefined): string[] {
  if (!s) return [];
  try { return JSON.parse(s) as string[]; } catch { return []; }
}

export default function AgentMapTab({ agent }: Props) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [flowRunsMap, setFlowRunsMap] = useState<Record<string, FlowRun[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.getFlows(agent.id),
      api.getGoals(agent.id),
      api.getTables(agent.id),
      api.getFlowRuns(agent.id),
    ]).then(([f, g, t, allRuns]) => {
      setFlows(f);
      setGoals(g);
      setTables(t);
      // Group runs by flowId
      const byFlow: Record<string, FlowRun[]> = {};
      for (const run of allRuns) {
        if (!byFlow[run.flowId]) byFlow[run.flowId] = [];
        byFlow[run.flowId].push(run);
      }
      setFlowRunsMap(byFlow);
    }).catch(console.error).finally(() => setLoading(false));
  }, [agent.id]);

  if (loading) {
    return <div style={{ padding: '2rem', color: 'var(--muted)', fontSize: '0.9rem' }}>Loading…</div>;
  }

  const tableById = Object.fromEntries(tables.map((t) => [t.id, t]));
  const tableByName = Object.fromEntries(tables.map((t) => [t.name.toLowerCase(), t]));

  const activeGoals = goals.filter((g) => g.status !== 'completed' && g.status !== 'cancelled');
  const actionFlows = flows.filter((f) => f.flowType === 'action');
  const scrapeFlows = flows.filter((f) => f.flowType === 'scrape');
  const otherFlows  = flows.filter((f) => !f.flowType);

  function resolveTableRef(ref: string): string {
    // ref might be a table ID or a table name
    const byId = tableById[ref];
    if (byId) return byId.name;
    const byName = tableByName[ref.toLowerCase()];
    if (byName) return byName.name;
    return ref;
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: 960 }}>
      <div style={{ marginBottom: '1.25rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>Agent Brain Map</h2>
        <p style={{ fontSize: '0.82rem', color: 'var(--muted)', margin: '0.3rem 0 0' }}>
          Everything this agent knows how to do, and how it connects.
        </p>
      </div>

      {/* Summary bar */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        {[
          { label: 'Goals active', value: activeGoals.length, color: '#58a6ff' },
          { label: 'Action flows', value: actionFlows.length, color: '#f0883e' },
          { label: 'Scrape flows', value: scrapeFlows.length, color: '#3fb950' },
          { label: 'Other flows', value: otherFlows.length, color: '#8b949e' },
          { label: 'Tables', value: tables.length, color: '#e3b341' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '0.5rem 0.85rem',
            minWidth: 80,
            textAlign: 'center',
          }}>
            <div style={{ fontSize: '1.4rem', fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.1rem' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Active goals */}
      {activeGoals.length > 0 && (
        <Section title="Active Goals" color="#58a6ff">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {activeGoals.map((g) => (
              <div key={g.id} style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: 5,
                padding: '0.5rem 0.75rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.6rem',
              }}>
                <span style={{ fontSize: '0.72rem', background: 'rgba(56,139,253,0.15)', color: '#58a6ff', padding: '0.1rem 0.4rem', borderRadius: 3, flexShrink: 0 }}>
                  {g.type}
                </span>
                <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>{g.title}</span>
                {g.notes && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    — {g.notes.slice(0, 100)}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--muted)', flexShrink: 0 }}>
                  p{g.priority} · {g.status}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Flows by type */}
      {[
        { label: 'Action Flows', color: '#f0883e', items: actionFlows },
        { label: 'Scrape / Read Flows', color: '#3fb950', items: scrapeFlows },
        { label: 'Flows (type unset)', color: '#8b949e', items: otherFlows },
      ].map(({ label, color, items }) => items.length > 0 && (
        <Section key={label} title={`${label} (${items.length})`} color={color}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {items.map((flow) => {
              const stats = computeStats(flowRunsMap[flow.id] ?? []);
              const reads = parseJsonList(flow.readsFrom);
              const writes = parseJsonList(flow.writesTo);
              const successRate = stats.total > 0 ? Math.round((stats.succeeded / stats.total) * 100) : null;

              return (
                <div key={flow.id} style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderLeft: `3px solid ${flow.infeasible ? '#e3b341' : flow.pinned ? '#58a6ff' : color}`,
                  borderRadius: 5,
                  padding: '0.6rem 0.75rem',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: reads.length > 0 || writes.length > 0 ? '0.4rem' : 0 }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: flow.infeasible ? 'var(--muted)' : 'var(--text)', textDecoration: flow.infeasible ? 'line-through' : 'none' }}>
                      {flow.name}
                    </span>
                    {flow.pinned && <Pill bg="rgba(56,139,253,0.15)" color="#58a6ff">pinned</Pill>}
                    {flow.infeasible && <Pill bg="rgba(210,153,34,0.2)" color="#e3b341">⚠ infeasible</Pill>}
                    {flow.requiresHumanReview && <Pill bg="rgba(139,148,158,0.15)" color="#8b949e">📋 review</Pill>}
                    {flow.requiresApproval && <Pill bg="rgba(218,54,51,0.12)" color="#da3633">🔒 approval</Pill>}

                    <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
                      {stats.total > 0 && (
                        <>
                          <span style={{ fontSize: '0.72rem', color: successRate !== null && successRate < 70 ? '#e3b341' : 'var(--muted)' }}>
                            {successRate}% success
                          </span>
                          <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>·</span>
                          <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{stats.total} runs</span>
                          <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>·</span>
                          <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>{formatDuration(stats.avgDurationMs)} avg</span>
                          <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>·</span>
                          <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>last {relativeTime(stats.lastRan)}</span>
                        </>
                      )}
                      {stats.total === 0 && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>never run</span>
                      )}
                    </div>
                  </div>

                  {flow.description && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: (reads.length > 0 || writes.length > 0) ? '0.4rem' : 0 }}>
                      {flow.description.slice(0, 140)}{flow.description.length > 140 ? '…' : ''}
                    </div>
                  )}

                  {/* Table connections */}
                  {(reads.length > 0 || writes.length > 0) && (
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                      {reads.length > 0 && (
                        <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.68rem', color: '#3fb950', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>reads</span>
                          {reads.map((r) => (
                            <Pill key={r} bg="rgba(35,134,54,0.12)" color="#3fb950">{resolveTableRef(r)}</Pill>
                          ))}
                        </div>
                      )}
                      {writes.length > 0 && (
                        <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.68rem', color: '#f0883e', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>writes</span>
                          {writes.map((w) => (
                            <Pill key={w} bg="rgba(240,136,62,0.15)" color="#f0883e">{resolveTableRef(w)}</Pill>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      ))}

      {/* Tables */}
      {tables.length > 0 && (
        <Section title={`Data Tables (${tables.length})`} color="#e3b341">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {tables.map((t) => {
              // find flows that read or write this table
              const readerFlows = flows.filter((f) => parseJsonList(f.readsFrom).some((r) => r === t.id || r.toLowerCase() === t.name.toLowerCase()));
              const writerFlows = flows.filter((f) => parseJsonList(f.writesTo).some((w) => w === t.id || w.toLowerCase() === t.name.toLowerCase()));
              return (
                <div key={t.id} style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  padding: '0.5rem 0.75rem',
                  minWidth: 160,
                  maxWidth: 280,
                }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e3b341', marginBottom: '0.3rem' }}>{t.name}</div>
                  {writerFlows.length > 0 && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>
                      Written by: {writerFlows.map((f) => f.name).join(', ')}
                    </div>
                  )}
                  {readerFlows.length > 0 && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>
                      Read by: {readerFlows.map((f) => f.name).join(', ')}
                    </div>
                  )}
                  {writerFlows.length === 0 && readerFlows.length === 0 && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontStyle: 'italic' }}>not yet linked to flows</div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div style={{
        fontSize: '0.75rem',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.07em',
        color,
        borderBottom: `1px solid ${color}30`,
        paddingBottom: '0.35rem',
        marginBottom: '0.6rem',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Pill({ bg, color, children }: { bg: string; color: string; children: React.ReactNode }) {
  return (
    <span style={{
      background: bg,
      color,
      fontSize: '0.68rem',
      fontWeight: 500,
      padding: '0.1rem 0.4rem',
      borderRadius: 3,
    }}>
      {children}
    </span>
  );
}
