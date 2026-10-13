import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import type { Agent, Run } from '../types/index.js';
import AgentCard from '../components/AgentCard.js';
import { drafts } from '../lib/drafts.js';
import type { OnboardingDraft, GeneratorDraft } from '../utils/session-draft.js';

export default function Home() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeRuns, setActiveRuns] = useState<Record<string, Run>>({});
  const [onboardingDraft, setOnboardingDraft] = useState<OnboardingDraft | null>(null);
  const [generatorDrafts, setGeneratorDrafts] = useState<GeneratorDraft[]>([]);
  // Track run IDs that have been stopped but DB hasn't confirmed yet
  const stoppingRunIds = useRef<Set<string>>(new Set());
  const navigate = useNavigate();

  useEffect(() => {
    api.getAgents().then(setAgents).catch(console.error).finally(() => setLoading(false));
  }, []);

  // Check for saved draft sessions on mount
  useEffect(() => {
    const ob = drafts.load<OnboardingDraft>(drafts.keys.onboarding);
    if (ob) setOnboardingDraft(ob);

    const gd = drafts.list<GeneratorDraft>(drafts.keys.generatorPrefix);
    if (gd.length > 0) setGeneratorDrafts(gd);
  }, []);

  // Poll autonomous status for all agents every 8s
  const pollStatus = useCallback(async (agentList: Agent[]) => {
    const results = await Promise.allSettled(
      agentList.map((a) => api.getAutonomousStatus(a.id))
    );
    const next: Record<string, Run> = {};
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const run = r.value.latestRun;
      if (!run) return;
      if (run.status === 'running' && !stoppingRunIds.current.has(run.id)) {
        // Actively running and not in our "stop sent" set
        next[agentList[i]!.id] = run;
      } else if (run.status !== 'running') {
        // DB confirmed it's no longer running — remove from stopping set
        stoppingRunIds.current.delete(run.id);
      }
    });
    setActiveRuns(next);
  }, []);

  useEffect(() => {
    if (agents.length === 0) return;
    pollStatus(agents);
    const interval = setInterval(() => pollStatus(agents), 8000);
    return () => clearInterval(interval);
  }, [agents, pollStatus]);

  const handleStop = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    const run = activeRuns[agentId];
    if (!run) return;

    // Mark as stopping immediately — prevents poll from re-adding it
    stoppingRunIds.current.add(run.id);
    // Optimistically remove from UI
    setActiveRuns((prev) => { const n = { ...prev }; delete n[agentId]; return n; });

    try {
      await api.stopRun(run.id);
    } catch (err) {
      // Stop failed — put it back and remove from stopping set
      console.error(err);
      stoppingRunIds.current.delete(run.id);
      setActiveRuns((prev) => ({ ...prev, [agentId]: run }));
    }
  };

  const activeCount = Object.keys(activeRuns).length;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '2rem 1rem' }}>

      {/* ── Onboarding draft resume banner ── */}
      {onboardingDraft && (
        <div style={{
          background: 'rgba(56,139,253,0.08)',
          border: '1px solid rgba(56,139,253,0.3)',
          borderLeft: '3px solid #58a6ff',
          borderRadius: 8,
          padding: '0.75rem 1rem',
          marginBottom: '1.25rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: '0.85rem' }}>
            <span style={{ color: '#58a6ff', fontWeight: 600 }}>↩ Unfinished setup — </span>
            <span style={{ color: 'var(--text)' }}>
              {onboardingDraft.agentName}
              {' '}({onboardingDraft.phase === 'flow_building'
                ? `building flow ${onboardingDraft.currentFlowIndex + 1} of ${onboardingDraft.plannedFlows.length}`
                : `${onboardingDraft.plannedFlows.filter((f) => f.built).length} of ${onboardingDraft.plannedFlows.length} flows built`})
            </span>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
            <button
              onClick={() => navigate('/agents/new?resume=true')}
              style={{ background: '#58a6ff', color: '#fff', border: 'none', borderRadius: 5, padding: '0.35rem 0.85rem', fontSize: '0.8rem', cursor: 'pointer', fontWeight: 600 }}
            >
              Continue building →
            </button>
            <button
              onClick={() => { drafts.clear(drafts.keys.onboarding); setOnboardingDraft(null); }}
              style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 5, padding: '0.35rem 0.6rem', fontSize: '0.78rem', cursor: 'pointer', color: 'var(--muted)' }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* ── Generator draft resume banners (per-agent) ── */}
      {generatorDrafts.filter((d) => !d.completedFlow || true).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.25rem' }}>
          {generatorDrafts.map((d) => (
            <div key={d.agentId} style={{
              background: 'rgba(35,134,54,0.07)',
              border: '1px solid rgba(35,134,54,0.25)',
              borderLeft: '3px solid #3fb950',
              borderRadius: 8,
              padding: '0.65rem 1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              flexWrap: 'wrap',
            }}>
              <div style={{ fontSize: '0.82rem' }}>
                <span style={{ color: '#3fb950', fontWeight: 600 }} title="Flows are the browser-automation steps your agent uses to get things done.">↩ Flow in progress — </span>
                <span style={{ color: 'var(--text)' }}>
                  {d.flowHint ? `"${d.flowHint}"` : 'unnamed flow'}
                  {' · '}{d.conversationHistory.length} messages
                  {' · '}saved {(() => {
                    const diff = Date.now() - new Date(d.savedAt).getTime();
                    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
                    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
                    return `${Math.round(diff / 86_400_000)}d ago`;
                  })()}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                <button
                  onClick={() => navigate(`/agents/${d.agentId}/flows`)}
                  style={{ background: '#3fb950', color: '#fff', border: 'none', borderRadius: 5, padding: '0.3rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer', fontWeight: 600 }}
                >
                  Resume →
                </button>
                <button
                  onClick={() => { drafts.clear(drafts.keys.generator(d.agentId)); setGeneratorDrafts((prev) => prev.filter((x) => x.agentId !== d.agentId)); }}
                  style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 5, padding: '0.3rem 0.55rem', fontSize: '0.75rem', cursor: 'pointer', color: 'var(--muted)' }}
                >
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>AgentSpawner</h1>
          {activeCount > 0 && (
            <span style={{
              fontSize: '0.75rem',
              padding: '0.2rem 0.6rem',
              borderRadius: 99,
              background: '#238636',
              color: '#fff',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', background: '#7ee787',
                display: 'inline-block',
                animation: 'pulse 1.5s infinite',
              }} />
              {activeCount} running
            </span>
          )}
        </div>
        <button onClick={() => navigate('/agents/new')} style={btnStyle('#238636')}>
          + New Agent
        </button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Loading agents...</p>
      ) : agents.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--muted)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '1rem', opacity: 0.3 }}>✦</div>
          <p style={{ fontSize: '1.1rem', marginBottom: '0.5rem', color: 'var(--text)', opacity: 0.7 }}>No agents yet</p>
          <p style={{ marginBottom: '1.5rem' }}>Create your first agent to get started</p>
          <button onClick={() => navigate('/agents/new')} style={btnStyle('#238636')}>+ New Agent</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              activeRun={activeRuns[agent.id] ?? null}
              onDelete={() => setAgents((prev) => prev.filter((a) => a.id !== agent.id))}
              onStop={(e) => handleStop(e, agent.id)}
              onGoToChat={() => navigate(`/agents/${agent.id}/chat`)}
            />
          ))}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg,
    color: '#fff',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 6,
    padding: '0.4rem 0.9rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  };
}
