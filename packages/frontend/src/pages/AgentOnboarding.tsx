import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import type { Agent, Flow, FlowInput, RecordEvent } from '../types/index.js';
import FlowGenerator from './agent/FlowGenerator.js';
import FlowEditor from './agent/FlowEditor.js';
import { drafts } from '../lib/drafts.js';
import type { OnboardingDraft } from '../utils/session-draft.js';
import MarkdownContent from '../components/MarkdownContent.js';
import { formatFlowName } from '../utils/formatFlowName.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

interface AgentConfig {
  name: string;
  systemPrompt: string;
  goals?: { type: string; title: string; description: string; priority: number }[];
}

interface PlannedFlow {
  id: string; // local id for list key
  name: string;
  type: 'scrape' | 'action';
  description: string;
  purpose: string;
  built: boolean;
}

// ── Recording helpers (action flow pre-dialog) ────────────────────────────────

function eventsToDescription(events: RecordEvent[]): string {
  return events.map((ev, i) => {
    if (ev.type === 'navigate') return `${i + 1}. Navigated to: ${ev.url}`;
    if (ev.type === 'click') return `${i + 1}. Clicked: ${ev.selector}${ev.text ? ` ("${ev.text}")` : ''}`;
    if (ev.type === 'type') return `${i + 1}. Typed "${ev.value}" into: ${ev.selector}`;
    return `${i + 1}. ${ev.type}`;
  }).join('\n');
}

// Prepend recording context to the pre-built action flow initial message
function buildOnboardingMsgWithRecording(initialMsg: string, events: RecordEvent[], done: boolean): string {
  const description = eventsToDescription(events);
  const completionNote = !done
    ? '\nNote: recording may be incomplete — the user did not press Stop. Infer the remaining steps from the goal.'
    : '';
  return (
    `I recorded the following browser interaction:\n\n${description}${completionNote}\n\n` +
    `Use the selectors from the recording directly — they are known to work. ` +
    `The URL shows the full structure — identify which parts are variable inputs vs. fixed structure.\n\n` +
    initialMsg
  );
}

type SetupPhase = 'key_confirm' | 'chat' | 'brief_review' | 'flow_building' | 'complete';

// ── Onboarding progress stepper ───────────────────────────────────────────────

function phaseToStepIndex(phase: SetupPhase): number {
  switch (phase) {
    case 'chat':          return 0;
    case 'brief_review':  return 1;
    case 'flow_building': return 2;
    case 'complete':      return 3;
    default:              return 0;
  }
}

function OnboardingProgress({ phase, plannedFlows, currentFlowIndex }: {
  phase: SetupPhase;
  plannedFlows: PlannedFlow[];
  currentFlowIndex: number;
}) {
  const activeStep = phaseToStepIndex(phase);
  const allDone = phase === 'complete';
  const steps = ['Describe', 'Review', 'Build', 'Wake Up'];

  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {steps.map((label, i) => {
        const isDone = allDone || i < activeStep;
        const isActive = !allDone && i === activeStep;
        const isBuild = i === 2;
        const hasSubSteps = isBuild && plannedFlows.length > 0;

        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center' }}>
            {i > 0 && (
              <div style={{
                width: 18, height: 1, flexShrink: 0,
                background: isDone || isActive ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)',
                transition: 'background 0.4s',
              }} />
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.3rem',
              padding: '0.18rem 0.55rem',
              borderRadius: 20,
              background: isActive
                ? 'rgba(88,166,255,0.13)'
                : isDone ? 'rgba(63,185,80,0.09)' : 'transparent',
              border: `1px solid ${
                isActive ? 'rgba(88,166,255,0.4)'
                  : isDone ? 'rgba(63,185,80,0.28)'
                  : 'rgba(255,255,255,0.07)'
              }`,
              transition: 'all 0.4s ease',
            }}>
              {isDone && (
                <span style={{ fontSize: '0.5rem', color: '#3fb950', lineHeight: 1 }}>✓</span>
              )}
              <span style={{
                fontSize: '0.72rem',
                fontWeight: isActive ? 600 : 400,
                color: isActive ? '#58a6ff' : isDone ? '#3fb950' : 'rgba(255,255,255,0.25)',
                transition: 'color 0.4s',
                whiteSpace: 'nowrap',
              }}>
                {label}
              </span>
              {hasSubSteps && (
                <div style={{ display: 'flex', gap: '0.18rem', alignItems: 'center', marginLeft: '0.05rem' }}>
                  {plannedFlows.map((f, fi) => {
                    const flowDone = f.built || allDone;
                    const flowActive = phase === 'flow_building' && fi === currentFlowIndex;
                    return (
                      <div
                        key={f.id}
                        title={f.name}
                        style={{
                          width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                          background: flowDone ? '#3fb950' : flowActive ? '#58a6ff' : 'rgba(255,255,255,0.15)',
                          boxShadow: flowActive ? '0 0 0 2px rgba(88,166,255,0.28)' : 'none',
                          transition: 'all 0.3s',
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const OPENING_MESSAGE: ChatMessage = {
  id: 'opening',
  role: 'assistant',
  content: `Hey! Let's set up your agent. Tell me what job you want it to do — in plain English. What should it actually be doing every day?

(The more detail the better: what platform, who it should engage with, what it should say or do. I'll research the context and ask a few clarifying questions before we configure everything.)`,
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function AgentOnboarding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resumeMode = searchParams.get('resume') === 'true';

  // ── Auth ──────────────────────────────────────────────────────────────────
  const [apiKey, setApiKey] = useState('');
  const [existingAgents, setExistingAgents] = useState<{ id: string; name: string }[]>([]);
  const [borrowAgentId, setBorrowAgentId] = useState<string>('');

  // ── Phase ─────────────────────────────────────────────────────────────────
  // Resume mode skips key_confirm — the session is already underway
  const [phase, setPhase] = useState<SetupPhase>(resumeMode ? 'chat' : 'key_confirm');

  // Tracks whether the agents fetch has settled (prevents key_confirm flicker)
  const [agentsLoaded, setAgentsLoaded] = useState(false);

  // ── Chat (phases 1-2) ─────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([OPENING_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const isFirstMessageRef = useRef(true); // true until first user message is sent
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Brief review (phase 3) ────────────────────────────────────────────────
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [editedPrompt, setEditedPrompt] = useState('');
  const [editedName, setEditedName] = useState('');
  const [applying, setApplying] = useState(false);

  // ── Flow planning (lives inside brief_review panel) ───────────────────────
  const [createdAgent, setCreatedAgent] = useState<Agent | null>(null);
  const [plannedFlows, setPlannedFlows] = useState<PlannedFlow[]>([]);
  const [planningLoading, setPlanningLoading] = useState(false);
  const [addingFlow, setAddingFlow] = useState(false);
  const [newFlowName, setNewFlowName] = useState('');
  const [newFlowType, setNewFlowType] = useState<'scrape' | 'action'>('scrape');
  const [newFlowDesc, setNewFlowDesc] = useState('');
  const [flowFeedback, setFlowFeedback] = useState('');
  const [refiningFlows, setRefiningFlows] = useState(false);

  // ── Complete (phase 6) — Wake Up budget ──────────────────────────────────
  const [wakeUpBudget, setWakeUpBudget] = useState<number>(5); // default $5/hr on first run

  // ── Flow building (phase 5) ───────────────────────────────────────────────
  const [currentFlowIndex, setCurrentFlowIndex] = useState(0);
  // Bridge shown after a flow is saved — lets user open editor or continue
  const [lastSavedFlowId, setLastSavedFlowId] = useState<string | null>(null);
  const [lastSavedFlow, setLastSavedFlow] = useState<Flow | null>(null);
  const [showFlowBridge, setShowFlowBridge] = useState(false);
  // Inline editor — shown alongside the generator chat when "Edit in Editor" is clicked
  const [inlineEditorOpen, setInlineEditorOpen] = useState(false);
  const [inlineEditorFlow, setInlineEditorFlow] = useState<Flow | null>(null);
  // Job description overlay — shows system prompt + flow plan for alignment checks
  const [showJobDesc, setShowJobDesc] = useState(false);

  // ── Recording / pre-dialog (action + scrape flows) ───────────────────────
  // When false and the current flow is an action or scrape flow, show the pre-dialog
  // so the user can optionally guide building (recording for action, selectors for scrape).
  const [onboardingReadyToGenerate, setOnboardingReadyToGenerate] = useState(false);

  // ── Quick Build seed — scrape flows only ──────────────────────────────────
  const [onboardingSeed, setOnboardingSeed] = useState<{ pageUrl: string; feedSelector: string; postCardSelector: string; expandSelector: string; notes: string }>({
    pageUrl: '', feedSelector: '', postCardSelector: '', expandSelector: '', notes: '',
  });
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordingDone, setRecordingDone] = useState(false);
  const [recordEvents, setRecordEvents] = useState<RecordEvent[]>([]);
  const [recordingPreOpen, setRecordingPreOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Draft restoration ─────────────────────────────────────────────────────
  const draftRestoredRef = useRef(false);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // On mount: if ?resume=true is in the URL, auto-restore the saved onboarding draft.
  // This is triggered by clicking "Continue building" on the Home page.
  useEffect(() => {
    if (!resumeMode || draftRestoredRef.current) return;
    const draft = drafts.load<OnboardingDraft>(drafts.keys.onboarding);
    if (!draft) return;

    // Verify the agent still exists before restoring
    api.getAgent(draft.agentId).then((agent) => {
      draftRestoredRef.current = true;
      setCreatedAgent(agent);
      setPlannedFlows(draft.plannedFlows);
      setCurrentFlowIndex(draft.currentFlowIndex);
      setPhase(draft.phase);
    }).catch(() => {
      // Agent was deleted — discard the stale draft
      drafts.clear(drafts.keys.onboarding);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeMode]);

  // Kick off flow planning as soon as config is ready (brief_review phase).
  // Runs in the background while the user reads the system prompt + goals.
  useEffect(() => {
    if (phase !== 'brief_review' || !config || planningLoading || plannedFlows.length > 0) return;
    setPlanningLoading(true);
    api.planFlows(getAuth(), { systemPrompt: config.systemPrompt, description: firstUserMessage })
      .then((result) => {
        setPlannedFlows(result.flows.map((f) => ({ id: crypto.randomUUID(), ...f, built: false })));
      })
      .catch(() => { /* non-fatal — user can still proceed */ })
      .finally(() => setPlanningLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, config]);

  // Auto-save the onboarding draft whenever planning/building state changes.
  // Only saves once an agent has been created (we have a real agentId).
  useEffect(() => {
    if (!createdAgent) return;
    if (phase !== 'flow_building') return;
    drafts.save(drafts.keys.onboarding, {
      agentId: createdAgent.id,
      agentName: createdAgent.name,
      phase,
      plannedFlows,
      currentFlowIndex,
    });
  }, [createdAgent, phase, plannedFlows, currentFlowIndex]);

  useEffect(() => {
    api.getAgents().then((agents) => {
      const withKey = agents.filter((a) => a.hasApiKey);
      setExistingAgents(withKey.map((a) => ({ id: a.id, name: a.name })));
      if (withKey.length > 0) {
        setBorrowAgentId(withKey[0].id);
      } else {
        const saved = localStorage.getItem('anthropic_api_key');
        if (saved) setApiKey(saved);
      }
      setAgentsLoaded(true);
    }).catch(() => {
      const saved = localStorage.getItem('anthropic_api_key');
      if (saved) setApiKey(saved);
      setAgentsLoaded(true);
    });
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const getAuth = useCallback((): { apiKey: string } | { agentId: string } => {
    if (borrowAgentId) return { agentId: borrowAgentId };
    return { apiKey: apiKey.trim() };
  }, [borrowAgentId, apiKey]);

  const hasAuth = borrowAgentId || apiKey.trim().length > 0;

  // First user message content (used as description for planFlows)
  const firstUserMessage = messages.find((m) => m.role === 'user')?.content ?? '';

  // ── Phase 1-2: Chat / clarification ──────────────────────────────────────

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    if (!hasAuth) {
      alert('Please select an existing agent or enter an API key first.');
      return;
    }

    const isFirst = isFirstMessageRef.current;
    isFirstMessageRef.current = false;

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: input.trim() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    if (apiKey.trim()) localStorage.setItem('anthropic_api_key', apiKey.trim());

    try {
      const history = nextMessages
        .filter((m) => m.id !== 'opening')
        .map((m) => ({ role: m.role, content: m.content }));

      const result = await api.setupConverse(history, getAuth());

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.reply || "I've got everything I need. Let's create your agent!",
      };
      setMessages((prev) => [...prev, assistantMsg]);

      if (result.done && result.config) {
        setConfig(result.config);
        setEditedPrompt(result.config.systemPrompt);
        setEditedName(result.config.name);
        // If already in brief_review, stay there and let the panel refresh in place
        if (phase !== 'brief_review') {
          setPhase('brief_review');
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `Sorry, something went wrong: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
      void isFirst; // used for potential future indicator
    }
  };

  // ── Phase 3: Apply — create agent + fetch flow plan ──────────────────────

  const handleApply = async () => {
    if (!config || applying) return;
    setApplying(true);

    const finalPrompt = editingPrompt ? editedPrompt : config.systemPrompt;
    const finalName = editedName || config.name;

    try {
      // 1. Create the agent
      const agent = await api.createAgent({
        name: finalName,
        systemPrompt: finalPrompt,
        model: 'claude-haiku-4-5-20251001',
        apiKey: apiKey.trim() || undefined,
        copyKeyFromAgentId: (!apiKey.trim() && borrowAgentId) ? borrowAgentId : undefined,
      });

      // 2. Create initial goals
      for (const goal of config.goals ?? []) {
        await fetch(`http://localhost:3001/agents/${agent.id}/goals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: goal.type, title: goal.title, description: goal.description, priority: goal.priority, status: 'pending' }),
        }).catch(() => { /* goals are nice-to-have */ });
      }

      setCreatedAgent(agent);

      // 3. Go straight to flow building — flows were already proposed during brief_review
      setCurrentFlowIndex(0);
      setPhase('flow_building');

      // Parse prompt in background (non-critical)
      api.parsePrompt(agent.id).catch(() => {});
    } catch (err) {
      alert(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      setApplying(false);
      return;
    } finally {
      setApplying(false);
    }
  };

  // ── Phase 4: Start building ───────────────────────────────────────────────

  const handleStartBuilding = () => {
    if (plannedFlows.length === 0) return;
    setCurrentFlowIndex(0);
    setPhase('flow_building');
  };

  const handleAddFlow = () => {
    if (!newFlowName.trim()) return;
    setPlannedFlows((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: newFlowName.trim(), type: newFlowType, description: newFlowDesc.trim() || `A ${newFlowType} flow`, purpose: 'User-added flow', built: false },
    ]);
    setNewFlowName('');
    setNewFlowDesc('');
    setAddingFlow(false);
  };

  const handleRemoveFlow = (id: string) => {
    setPlannedFlows((prev) => prev.filter((f) => f.id !== id));
  };

  const handleRefineFlows = async () => {
    if (!config || refiningFlows || !flowFeedback.trim()) return;
    setRefiningFlows(true);
    try {
      const result = await api.planFlows(getAuth(), {
        systemPrompt: config.systemPrompt,
        description: firstUserMessage,
        brief_flows: plannedFlows.map(({ name, type, description, purpose }) => ({ name, type, description, purpose })),
        feedback: flowFeedback.trim(),
      });
      setPlannedFlows(result.flows.map((f) => ({ id: crypto.randomUUID(), ...f, built: false })));
      setFlowFeedback('');
    } catch (err) {
      alert(`Refine failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefiningFlows(false);
    }
  };

  // ── Phase 5: Flow built callback ──────────────────────────────────────────

  const advanceAfterFlow = useCallback(() => {
    setShowFlowBridge(false);
    setLastSavedFlowId(null);
    setLastSavedFlow(null);
    const next = currentFlowIndex + 1;
    if (next < plannedFlows.length) {
      setCurrentFlowIndex(next);
    } else {
      drafts.clear(drafts.keys.onboarding); // all flows built — session complete
      setPhase('complete');
    }
  }, [currentFlowIndex, plannedFlows.length]);

  const handleFlowBuilt = useCallback(async (definition: FlowInput) => {
    if (!createdAgent) return;

    let savedFlow: Flow | null = null;
    try {
      savedFlow = await api.createFlow(createdAgent.id, definition);
    } catch (err) {
      console.error('Failed to save flow:', err);
    }

    setPlannedFlows((prev) =>
      prev.map((f, i) => i === currentFlowIndex ? { ...f, built: true } : f),
    );

    // Show bridge instead of auto-advancing — user can open editor or continue
    setLastSavedFlowId(savedFlow?.id ?? null);
    setLastSavedFlow(savedFlow);
    setShowFlowBridge(true);
  }, [createdAgent, currentFlowIndex]);

  const handleSkipFlow = useCallback(() => {
    const next = currentFlowIndex + 1;
    if (next < plannedFlows.length) {
      setCurrentFlowIndex(next);
    } else {
      drafts.clear(drafts.keys.onboarding);
      setPhase('complete');
    }
  }, [currentFlowIndex, plannedFlows.length]);

  // ── Recording handlers for the action flow pre-dialog ────────────────────

  const handleStartRecording = async () => {
    if (!recordingUrl.trim()) return;
    try {
      await api.startRecording(recordingUrl.trim());
    } catch (err) {
      alert(`Could not start recording: ${(err as Error).message}`);
      return;
    }
    setRecording(true);
    setRecordingDone(false);
    setRecordEvents([]);
    const interval = setInterval(async () => {
      try {
        const { events, done } = await api.getRecordingEvents();
        setRecordEvents(events);
        if (done) {
          clearInterval(interval);
          pollRef.current = null;
          setRecording(false);
          setRecordingDone(true);
        }
      } catch {
        clearInterval(interval);
        pollRef.current = null;
      }
    }, 800);
    pollRef.current = interval;
  };

  const handleStopRecording = async () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    try { await api.stopRecording(); } catch { /* ignore */ }
    const { events } = await api.getRecordingEvents().catch(() => ({ events: recordEvents, done: true }));
    setRecordEvents(events);
    setRecording(false);
    setRecordingDone(true);
  };

  const handleDiscardRecording = async () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    await api.cancelRecording().catch(() => null);
    setRecording(false);
    setRecordingDone(false);
    setRecordEvents([]);
    setRecordingUrl('');
    setRecordingPreOpen(false);
  };

  // Reset inline editor whenever the user switches to a different flow
  useEffect(() => {
    setInlineEditorOpen(false);
    setInlineEditorFlow(null);
    // Also reset the recording pre-dialog so each action flow starts fresh
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    void api.cancelRecording().catch(() => null);
    setOnboardingReadyToGenerate(false);
    setRecording(false);
    setRecordingDone(false);
    setRecordEvents([]);
    setRecordingUrl('');
    setRecordingPreOpen(false);
    setOnboardingSeed({ pageUrl: '', feedSelector: '', postCardSelector: '', expandSelector: '', notes: '' });
  }, [currentFlowIndex]);

  // "Edit in Editor" from within the generator: save the current flow definition and open
  // the inline editor alongside the chat — no navigation, context preserved.
  // If a flow with this name already exists (e.g. user previously clicked Apply Flow or
  // rebuilt the flow), we UPDATE it with the latest steps rather than opening the old one.
  const handleEditInEditorFromGenerator = useCallback(async (definition: FlowInput) => {
    if (!createdAgent) return;
    try {
      let targetFlow: Flow;
      try {
        // Happy path: first save for this flow
        targetFlow = await api.createFlow(createdAgent.id, definition);
      } catch {
        // Name conflict — find the existing flow and overwrite it with the latest definition
        const flows = await api.getFlows(createdAgent.id);
        const existing = flows.find((f) => f.name === definition.name);
        if (!existing) throw new Error('Could not create or locate flow');
        targetFlow = await api.updateFlow(createdAgent.id, existing.id, definition);
      }
      setPlannedFlows((prev) =>
        prev.map((f, i) => i === currentFlowIndex ? { ...f, built: true } : f),
      );
      setLastSavedFlow(targetFlow);
      setLastSavedFlowId(targetFlow.id);
      setInlineEditorFlow(targetFlow);
      setInlineEditorOpen(true);
      setShowFlowBridge(false);
    } catch (err) {
      console.error('Failed to save flow for inline editor:', err);
      setShowFlowBridge(true);
    }
  }, [createdAgent, currentFlowIndex]);

  // ── Auth header ───────────────────────────────────────────────────────────

  const renderAuthHeader = () => (
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      {existingAgents.length > 0 ? (
        <>
          <label style={{ fontSize: '0.78rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>Using key from</label>
          <select
            value={borrowAgentId}
            onChange={(e) => { setBorrowAgentId(e.target.value); setApiKey(''); }}
            style={{
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
              color: 'var(--text)', padding: '0.35rem 0.6rem', fontSize: '0.8rem', cursor: 'pointer',
            }}
          >
            {existingAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
            <option value="">Enter new key…</option>
          </select>
          {!borrowAgentId && (
            <input
              type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-..." autoFocus
              style={{
                background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                color: 'var(--text)', padding: '0.35rem 0.6rem', fontSize: '0.8rem', width: 190,
              }}
            />
          )}
        </>
      ) : (
        <>
          <label style={{ fontSize: '0.78rem', color: 'var(--muted)', whiteSpace: 'nowrap' }}>API Key</label>
          <input
            type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            style={{
              background: 'var(--bg)',
              border: `1px solid ${!apiKey.trim() ? 'var(--error)' : 'var(--border)'}`,
              borderRadius: 6, color: 'var(--text)', padding: '0.35rem 0.6rem', fontSize: '0.8rem', width: 200,
            }}
          />
        </>
      )}
    </div>
  );

  // ── Phase 0: Key confirmation ─────────────────────────────────────────────

  if (phase === 'key_confirm') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
        {/* Header */}
        <div style={{
          borderBottom: '1px solid var(--border)', padding: '1rem 1.5rem',
          display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)',
        }}>
          <button
            onClick={() => navigate('/')}
            style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
          >
            ← Back
          </button>
          <div>
            <div style={{ fontWeight: 600, fontSize: '1rem' }}>New Agent</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>Choose the API key for this session</div>
          </div>
        </div>

        {/* Centered confirmation card */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '2rem 2.5rem', maxWidth: 480, width: '100%', display: 'flex', flexDirection: 'column', gap: '1.25rem',
          }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '0.4rem' }}>🔑 API key for this agent</div>
              <div style={{ fontSize: '0.88rem', color: 'var(--muted)', lineHeight: 1.55 }}>
                All conversations and flow builds during setup will use this key. You can change it at any time from the agent's settings.
              </div>
            </div>

            {!agentsLoaded ? (
              <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>Loading…</div>
            ) : existingAgents.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Borrow key from an existing agent</label>
                <select
                  value={borrowAgentId}
                  onChange={(e) => { setBorrowAgentId(e.target.value); setApiKey(''); }}
                  style={{
                    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                    color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.9rem', cursor: 'pointer',
                  }}
                >
                  {existingAgents.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                  <option value="">Enter a new key instead…</option>
                </select>
                {!borrowAgentId && (
                  <input
                    type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-ant-..." autoFocus
                    style={{
                      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                      color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.9rem',
                    }}
                  />
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Anthropic API key</label>
                <input
                  type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-..." autoFocus
                  style={{
                    background: 'var(--bg)',
                    border: `1px solid ${!apiKey.trim() ? 'var(--error)' : 'var(--border)'}`,
                    borderRadius: 6, color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.9rem',
                  }}
                />
              </div>
            )}

            <button
              onClick={() => setPhase('chat')}
              disabled={!agentsLoaded || !hasAuth}
              style={{
                background: hasAuth && agentsLoaded ? '#238636' : 'var(--surface)',
                border: `1px solid ${hasAuth && agentsLoaded ? '#238636' : 'var(--border)'}`,
                color: hasAuth && agentsLoaded ? '#fff' : 'var(--muted)',
                borderRadius: 8, padding: '0.6rem 1.25rem', fontSize: '0.95rem',
                fontWeight: 600, cursor: hasAuth && agentsLoaded ? 'pointer' : 'not-allowed',
                alignSelf: 'flex-start', transition: 'all 0.15s',
              }}
            >
              Start building →
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Phase 5: Flow building ────────────────────────────────────────────────

  if (phase === 'flow_building' && createdAgent) {
    const currentFlow = plannedFlows[currentFlowIndex];
    const builtCount = plannedFlows.filter((f) => f.built).length;

    const initialMsg = `Build the "${currentFlow.name}" flow: ${currentFlow.description}${
      currentFlow.type === 'action'
        ? '\n\nIMPORTANT: This is an action flow with side effects. The first step MUST be a guard that queries the action log for this key before proceeding. Pattern:\n1. __query_action_log__ step — check if action was done for this key\n2. condition on step 1 — if found and not enough time passed, skip with a helpful message\n3. (actual action steps)\n4. Final step writes to action_log table'
        : ''
    }

SIMPLICITY RULE: Build the simplest single-target version. If the description mentions multiple targets (subreddits, users, URLs, keywords), build a flow that handles ONE at a time using parameterized flow inputs (e.g. {{subreddit}}, {{username}}, {{query}}). Do NOT try to fan-out across all targets in a single flow — the agent will call this flow in a loop. A clean 1-target parameterized flow is always better than a brittle multi-target flow.`;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)' }}>
        {/* Progress strip */}
        <div style={{
          borderBottom: '1px solid rgba(255,255,255,0.04)', padding: '0.35rem 1.5rem',
          display: 'flex', justifyContent: 'center', background: 'var(--surface)',
          flexShrink: 0,
        }}>
          <OnboardingProgress phase={phase} plannedFlows={plannedFlows} currentFlowIndex={currentFlowIndex} />
        </div>
        {/* Header */}
        <div style={{
          borderBottom: '1px solid var(--border)', padding: '0.75rem 1.5rem',
          display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>
              Building flow {currentFlowIndex + 1} of {plannedFlows.length}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
              {createdAgent.name} · {builtCount} built so far
            </div>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {/* Back button — only shown when not on the first flow */}
            {currentFlowIndex > 0 && (
              <button
                onClick={() => {
                  setShowFlowBridge(false);
                  setLastSavedFlowId(null);
                  setCurrentFlowIndex(currentFlowIndex - 1);
                }}
                style={{
                  background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                  color: 'var(--muted)', padding: '0.3rem 0.75rem', fontSize: '0.8rem',
                  cursor: 'pointer',
                }}
              >
                ← Back
              </button>
            )}
            {/* Job description button — opens overlay with system prompt + all planned flows */}
            <button
              onClick={() => setShowJobDesc(true)}
              style={{
                background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                color: 'var(--muted)', padding: '0.3rem 0.75rem', fontSize: '0.8rem',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem',
              }}
            >
              📋 Job description
            </button>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              background: currentFlow.type === 'action' ? 'rgba(210,153,34,0.15)' : 'rgba(63,185,80,0.15)',
              border: `1px solid ${currentFlow.type === 'action' ? 'rgba(210,153,34,0.35)' : 'rgba(63,185,80,0.35)'}`,
              borderRadius: 6, padding: '0.25rem 0.6rem',
            }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: currentFlow.type === 'action' ? '#d29922' : '#3fb950', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {currentFlow.type}
              </span>
              <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text)' }}>{formatFlowName(currentFlow.name)}</span>
            </div>
            <button
              onClick={handleSkipFlow}
              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', padding: '0.3rem 0.75rem', fontSize: '0.8rem', cursor: 'pointer' }}
            >
              Skip this flow
            </button>
          </div>
        </div>

        {/* ── Job description modal ─────────────────────────────────────────── */}
        {showJobDesc && (
          <div
            onClick={() => setShowJobDesc(false)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
              zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
                width: 'min(640px, 92vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
                boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
              }}
            >
              {/* Modal header */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)', flexShrink: 0,
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{createdAgent.name}</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.1rem' }}>Agent job description</div>
                </div>
                <button
                  onClick={() => setShowJobDesc(false)}
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: '1.2rem', cursor: 'pointer', padding: '0.25rem 0.5rem', lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>

              {/* Modal body — scrollable */}
              <div style={{ overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {/* Original request */}
                {firstUserMessage && (
                  <div>
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
                      Original request
                    </div>
                    <div style={{
                      fontSize: '0.85rem', color: 'var(--text)', lineHeight: 1.6,
                      background: 'var(--bg)', borderRadius: 8, padding: '0.75rem 1rem',
                      border: '1px solid var(--border)', whiteSpace: 'pre-wrap',
                    }}>
                      {firstUserMessage}
                    </div>
                  </div>
                )}

                {/* System prompt */}
                {createdAgent.systemPrompt && (
                  <div>
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
                      System prompt
                    </div>
                    <div style={{
                      fontSize: '0.82rem', color: 'var(--text)', lineHeight: 1.6,
                      background: 'var(--bg)', borderRadius: 8, padding: '0.75rem 1rem',
                      border: '1px solid var(--border)', whiteSpace: 'pre-wrap',
                      fontFamily: 'monospace',
                    }}>
                      {createdAgent.systemPrompt}
                    </div>
                  </div>
                )}

                {/* Planned flows */}
                <div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.5rem' }}>
                    Planned flows ({plannedFlows.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {plannedFlows.map((f, i) => (
                      <div
                        key={f.id}
                        style={{
                          background: i === currentFlowIndex ? 'rgba(31,111,235,0.08)' : 'var(--bg)',
                          border: `1px solid ${i === currentFlowIndex ? 'rgba(88,166,255,0.4)' : 'var(--border)'}`,
                          borderRadius: 8, padding: '0.65rem 0.9rem',
                          display: 'flex', gap: '0.75rem', alignItems: 'flex-start',
                        }}
                      >
                        {/* Status dot */}
                        <div style={{
                          width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: '0.35rem',
                          background: f.built ? '#3fb950' : i === currentFlowIndex ? '#1f6feb' : 'var(--border)',
                        }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                            <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{f.name}</span>
                            <span style={{
                              fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                              color: f.type === 'action' ? '#d29922' : '#3fb950',
                              background: f.type === 'action' ? 'rgba(210,153,34,0.12)' : 'rgba(63,185,80,0.12)',
                              border: `1px solid ${f.type === 'action' ? 'rgba(210,153,34,0.3)' : 'rgba(63,185,80,0.3)'}`,
                              borderRadius: 4, padding: '0.1rem 0.4rem',
                            }}>
                              {f.type}
                            </span>
                            {f.built && <span style={{ fontSize: '0.7rem', color: '#3fb950' }}>✓ built</span>}
                            {i === currentFlowIndex && !f.built && <span style={{ fontSize: '0.7rem', color: '#58a6ff' }}>← current</span>}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }}>{f.description}</div>
                          {f.purpose && f.purpose !== f.description && (
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontStyle: 'italic', marginTop: '0.2rem' }}>{f.purpose}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bridge panel shown after flow is applied */}
        {showFlowBridge ? (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            gap: '1.5rem', padding: '3rem',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>✓</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#3fb950', marginBottom: '0.35rem' }}>
                {formatFlowName(currentFlow.name)} saved
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                What would you like to do next?
              </div>
            </div>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                onClick={() => {
                  if (lastSavedFlow) {
                    setInlineEditorFlow(lastSavedFlow);
                    setInlineEditorOpen(true);
                    setShowFlowBridge(false);
                  }
                }}
                disabled={!lastSavedFlow}
                style={{
                  background: 'var(--surface)', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 8,
                  padding: '0.65rem 1.5rem', fontSize: '0.9rem', fontWeight: 500,
                  cursor: lastSavedFlow ? 'pointer' : 'not-allowed',
                  opacity: lastSavedFlow ? 1 : 0.5,
                }}
              >
                ⊞ Edit Steps
              </button>
              <button
                onClick={advanceAfterFlow}
                style={{
                  background: '#238636', color: '#fff',
                  border: 'none', borderRadius: 8,
                  padding: '0.65rem 1.5rem', fontSize: '0.9rem', fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {currentFlowIndex + 1 < plannedFlows.length ? `Next Flow →` : 'Finish Setup →'}
              </button>
            </div>
          </div>
        ) : (
          /* Split-screen: generator chat on the left, inline editor on the right.
             The generator is always rendered (key forces remount on flow index change).
             When inlineEditorOpen, the generator shrinks to a sidebar and the full
             FlowEditor appears on the right — no navigation, no lost context. */
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex' }}>

            {/* Left: generator (full width normally, sidebar when editor is open) */}
            <div style={inlineEditorOpen
              ? { width: 400, flexShrink: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }
              : { flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
            }>
              {(currentFlow.type === 'action' || currentFlow.type === 'scrape') && !onboardingReadyToGenerate ? (
                /* Pre-dialog: optionally guide building (recording for action, selectors for scrape) */
                <div style={{ overflowY: 'auto', flex: 1, padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ width: '100%', maxWidth: 520 }}>

                    {/* Flow context */}
                    <div style={{ marginBottom: '1.75rem' }}>
                      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: '0.35rem' }}>Building</div>
                      <div style={{ fontWeight: 600, fontSize: '1rem' }}>{formatFlowName(currentFlow.name)}</div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: '0.35rem', lineHeight: 1.5 }}>{currentFlow.description}</div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

                      {/* Scrape flow — Quick Build form */}
                      {currentFlow.type === 'scrape' && (
                        <div style={{ borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
                          <div style={{ padding: '0.6rem 0.75rem', background: 'var(--surface)', borderBottom: '1px solid var(--border)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>
                            Quick Build — skip exploration (optional)
                          </div>
                          <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.65rem', background: 'var(--bg)' }}>
                            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                              If you already know the page URL and CSS selectors, fill them in here and the builder will skip the $10 exploration run.
                              Leave everything blank to let the explorer figure it out.
                            </p>
                            {([
                              ['pageUrl',          'Page URL',                  'https://linkedin.com/feed/'],
                              ['feedSelector',     'Feed container selector',   "[data-testid='lazy-column']"],
                              ['postCardSelector', 'Post card selector',        "[role='listitem']"],
                              ['expandSelector',   'Expand button selector',    "leave blank if none"],
                              ['notes',            'Additional notes',          'Anything the builder should know…'],
                            ] as [keyof typeof onboardingSeed, string, string][]).map(([key, label, ph]) => (
                              <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                                <label style={{ fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>{label}</label>
                                <input
                                  value={onboardingSeed[key]}
                                  onChange={(e) => setOnboardingSeed((s) => ({ ...s, [key]: e.target.value }))}
                                  placeholder={ph}
                                  style={{ background: 'var(--input-bg, #161b22)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '5px 8px', fontSize: '0.78rem', fontFamily: 'monospace' }}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Action flow — optional recording section */}
                      {currentFlow.type === 'action' && <div style={{ borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
                        <button
                          onClick={() => setRecordingPreOpen((o) => !o)}
                          style={{
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '0.6rem 0.75rem', background: 'var(--surface)', border: 'none',
                            cursor: 'pointer', color: recordEvents.length > 0 ? 'var(--text)' : 'var(--muted)',
                            fontSize: '0.85rem', fontWeight: recordEvents.length > 0 ? 600 : 400,
                          }}
                        >
                          <span>
                            {recordEvents.length > 0
                              ? `✓ Recording ready — ${recordEvents.length} event${recordEvents.length !== 1 ? 's' : ''} captured`
                              : 'Guide me with a recording (optional)'}
                          </span>
                          <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>{recordingPreOpen ? '▲' : '▼'}</span>
                        </button>

                        {recordingPreOpen && (
                          <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--bg)', borderTop: '1px solid var(--border)' }}>

                            {!recording && !recordingDone && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                                  <strong style={{ color: 'var(--text)' }}>Get to the page first, then start recording.</strong>{' '}
                                  The recording captures what you do — not how you got there. Navigate to the exact target before pressing Start.
                                </p>
                                <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>Page URL to record</label>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                  <input
                                    type="url"
                                    value={recordingUrl}
                                    onChange={(e) => setRecordingUrl(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') void handleStartRecording(); }}
                                    placeholder="https://…"
                                    style={{ flex: 1, padding: '0.5rem 0.75rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.9rem' }}
                                  />
                                  <button
                                    onClick={() => void handleStartRecording()}
                                    disabled={!recordingUrl.trim()}
                                    style={{ padding: '0.4rem 0.9rem', borderRadius: 8, border: 'none', background: '#ef4444', color: '#fff', fontSize: '0.8rem', cursor: recordingUrl.trim() ? 'pointer' : 'default', opacity: recordingUrl.trim() ? 1 : 0.4, whiteSpace: 'nowrap' as const, flexShrink: 0 }}
                                  >
                                    Start
                                  </button>
                                </div>
                              </div>
                            )}

                            {recording && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                                  <span style={{ color: '#ef4444', marginRight: '0.4rem' }}>●</span>
                                  Recording… {recordEvents.length} event{recordEvents.length !== 1 ? 's' : ''}
                                </span>
                                <button
                                  onClick={() => void handleStopRecording()}
                                  style={{ padding: '0.4rem 0.9rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.8rem', cursor: 'pointer' }}
                                >
                                  Stop
                                </button>
                              </div>
                            )}

                            {recordingDone && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                  <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{recordEvents.length} event{recordEvents.length !== 1 ? 's' : ''} captured</span>
                                  <button onClick={() => void handleDiscardRecording()} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '0.75rem', padding: '0.2rem 0.4rem' }}>Discard</button>
                                </div>
                                <div style={{ background: 'var(--surface)', borderRadius: 6, padding: '0.5rem 0.6rem', fontSize: '0.75rem', color: 'var(--muted)', fontFamily: 'monospace', maxHeight: 140, overflowY: 'auto', lineHeight: 1.6 }}>
                                  {recordEvents.map((ev, i) => (
                                    <div key={i}>
                                      {ev.type === 'navigate' && `${i + 1}. navigate → ${ev.url}`}
                                      {ev.type === 'click' && `${i + 1}. click ${ev.selector}${ev.text ? ` ("${ev.text}")` : ''}`}
                                      {ev.type === 'type' && `${i + 1}. type "${ev.value}" → ${ev.selector}`}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                          </div>
                        )}
                      </div>}

                      {/* Build button */}
                      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                          onClick={() => setOnboardingReadyToGenerate(true)}
                          style={{ background: '#238636', color: '#fff', border: 'none', borderRadius: 8, padding: '0.65rem 1.5rem', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer' }}
                        >
                          {currentFlow.type === 'scrape'
                            ? (onboardingSeed.pageUrl.trim() ? 'Build flow with selectors →' : 'Build flow →')
                            : (recordEvents.length > 0 ? 'Build flow from recording →' : 'Build flow →')}
                        </button>
                      </div>

                    </div>
                  </div>
                </div>
              ) : (
                <FlowGenerator
                  key={`flow-gen-${currentFlowIndex}`}
                  agent={createdAgent}
                  onFlow={handleFlowBuilt}
                  onCancel={handleSkipFlow}
                  initialMessages={[{ role: 'user', content: recordEvents.length > 0 ? buildOnboardingMsgWithRecording(initialMsg, recordEvents, recordingDone) : initialMsg }]}
                  autoSend={true}
                  confirmOnFlow={true}
                  title={`Building: ${currentFlow.name}`}
                  persistDraftForAgent={`${createdAgent.id}-flow-${currentFlowIndex}`}
                  onEditInEditor={handleEditInEditorFromGenerator}
                  hidePreview={inlineEditorOpen}
                  flowType={currentFlow.type}
                  seedContext={currentFlow.type === 'scrape' && onboardingSeed.pageUrl.trim()
                    ? {
                        pageUrl: onboardingSeed.pageUrl.trim(),
                        ...(onboardingSeed.feedSelector.trim()     ? { feedSelector:     onboardingSeed.feedSelector.trim() }     : {}),
                        ...(onboardingSeed.postCardSelector.trim() ? { postCardSelector: onboardingSeed.postCardSelector.trim() } : {}),
                        ...(onboardingSeed.expandSelector.trim()   ? { expandSelector:   onboardingSeed.expandSelector.trim() }   : {}),
                        ...(onboardingSeed.notes.trim()            ? { notes:            onboardingSeed.notes.trim() }            : {}),
                      }
                    : undefined}
                />
              )}
            </div>

            {/* Right: inline flow editor — shown when "Edit in Editor" is clicked */}
            {inlineEditorOpen && inlineEditorFlow && (
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
                {/* Editor sub-header */}
                <div style={{
                  padding: '0.55rem 1rem', borderBottom: '1px solid var(--border)',
                  background: 'var(--surface)', display: 'flex', alignItems: 'center',
                  gap: '0.75rem', flexShrink: 0,
                }}>
                  <button
                    onClick={() => setInlineEditorOpen(false)}
                    style={{
                      background: 'none', border: '1px solid var(--border)', borderRadius: 6,
                      color: 'var(--muted)', padding: '0.25rem 0.65rem', fontSize: '0.8rem', cursor: 'pointer',
                    }}
                  >
                    ← Back to chat
                  </button>
                  <span style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
                    Editing: <code style={{ color: 'var(--accent)', fontSize: '0.85rem' }}>{inlineEditorFlow.name}</code>
                  </span>
                </div>
                {/* Editor body — scrollable */}
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  <FlowEditor
                    agent={createdAgent}
                    flow={inlineEditorFlow}
                    onSave={(saved) => setInlineEditorFlow(saved)}
                    onCancel={(refreshed) => {
                      // Keep the builder's view of the flow in sync with the DB version
                      // the editor just fetched — no extra network request needed.
                      if (refreshed) setInlineEditorFlow(refreshed);
                      setInlineEditorOpen(false);
                    }}
                  />
                </div>
              </div>
            )}

          </div>
        )}
      </div>
    );
  }

  // ── Phase 6: Complete ─────────────────────────────────────────────────────

  if (phase === 'complete' && createdAgent) {
    const builtFlows = plannedFlows.filter((f) => f.built);
    const skippedFlows = plannedFlows.filter((f) => !f.built);

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', height: '100vh',
        background: 'var(--bg)', color: 'var(--text)',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ textAlign: 'center', maxWidth: 520 }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '2rem' }}>
            <OnboardingProgress phase={phase} plannedFlows={plannedFlows} currentFlowIndex={currentFlowIndex} />
          </div>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✓</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem', color: '#3fb950' }}>
            {createdAgent.name} is ready
          </div>
          <div style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '2rem', lineHeight: 1.6 }}>
            {builtFlows.length} flow{builtFlows.length !== 1 ? 's' : ''} built
            {skippedFlows.length > 0 ? ` · ${skippedFlows.length} skipped (can add later)` : ''}
          </div>

          {builtFlows.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '2rem', textAlign: 'left' }}>
              {builtFlows.map((f) => (
                <div
                  key={f.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    borderRadius: 8, padding: '0.5rem 0.75rem',
                  }}
                >
                  <span style={{ color: '#3fb950', fontSize: '0.8rem' }}>✓</span>
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                    color: f.type === 'action' ? '#d29922' : '#3fb950',
                    background: f.type === 'action' ? 'rgba(210,153,34,0.12)' : 'rgba(63,185,80,0.12)',
                    border: `1px solid ${f.type === 'action' ? 'rgba(210,153,34,0.3)' : 'rgba(63,185,80,0.3)'}`,
                    borderRadius: 4, padding: '0.1rem 0.35rem',
                  }}>{f.type}</span>
                  <span style={{ fontWeight: 500, fontSize: '0.85rem' }}>{f.name}</span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted)', marginLeft: 'auto', maxWidth: 220, textAlign: 'right', lineHeight: 1.3 }}>{f.description}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem' }}>
              <button
                onClick={() => navigate(`/agents/${createdAgent.id}/chat`)}
                style={{
                  background: 'var(--surface)', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 8,
                  padding: '0.65rem 1.5rem', fontSize: '0.9rem', fontWeight: 500, cursor: 'pointer',
                }}
              >
                Open Agent →
              </button>
              <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>View settings, flows, and history</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem' }}>
              <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #238636' }}>
                <select
                  value={String(wakeUpBudget)}
                  onChange={(e) => setWakeUpBudget(Number(e.target.value))}
                  title="Hourly spend limit — the agent will pause if it exceeds this amount in an hour."
                  style={{
                    background: '#0d1f0d', color: '#3fb950',
                    border: 'none', borderRight: '1px solid #238636',
                    padding: '0 0.6rem', fontSize: '0.82rem',
                    cursor: 'pointer', outline: 'none', fontWeight: 500,
                  }}
                >
                  <option value="0">No limit</option>
                  <option value="5">$5 / hr</option>
                  <option value="1">$1 / hr</option>
                  <option value="0.25">$0.25 / hr</option>
                </select>
                <button
                  onClick={async () => {
                    try {
                      await api.wakeUp(createdAgent.id, wakeUpBudget > 0 ? wakeUpBudget : undefined);
                      navigate(`/agents/${createdAgent.id}/chat`);
                    } catch (err) {
                      alert(`Could not wake up agent: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                  style={{
                    background: '#238636', color: '#fff', border: 'none',
                    padding: '0.65rem 1.25rem', fontSize: '0.9rem', fontWeight: 600,
                    cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  🟢 Wake Up
                </button>
              </div>
              <span style={{ fontSize: '0.72rem', color: 'var(--muted)' }}>
                {wakeUpBudget > 0
                  ? 'The agent will pause if it exceeds this amount in an hour.'
                  : 'The agent will run uncapped. Set a limit to control spend.'}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Phase 1-3: Chat + brief review ───────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Progress strip */}
      <div style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)', padding: '0.35rem 1.5rem',
        display: 'flex', justifyContent: 'center', background: 'var(--surface)',
      }}>
        <OnboardingProgress phase={phase} plannedFlows={plannedFlows} currentFlowIndex={currentFlowIndex} />
      </div>
      {/* Header */}
      <div style={{
        borderBottom: '1px solid var(--border)', padding: '1rem 1.5rem',
        display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)',
      }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '0.85rem', padding: 0 }}
        >
          ← Back
        </button>
        <div>
          <div style={{ fontWeight: 600, fontSize: '1rem' }}>New Agent</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
            {phase === 'brief_review'
              ? 'Review the proposed configuration before creating'
              : "Describe the job \u2014 I\u2019ll research and configure everything"}
          </div>
        </div>
        {renderAuthHeader()}
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Chat column */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          maxWidth: phase === 'brief_review' ? 380 : '100%',
          minWidth: phase === 'brief_review' ? 300 : undefined,
          transition: 'max-width 0.3s ease',
        }}>
          {/* Messages */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {messages.map((msg) => (
              <div key={msg.id} style={{ display: 'flex', justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '75%',
                  background: msg.role === 'user' ? 'rgba(31,111,235,0.2)' : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${msg.role === 'user' ? 'rgba(31,111,235,0.35)' : 'var(--border)'}`,
                  borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                  padding: '0.75rem 1rem', fontSize: '0.9rem', lineHeight: 1.6,
                  // user messages keep pre-wrap; assistant messages are rendered as markdown
                  whiteSpace: msg.role === 'user' ? 'pre-wrap' : undefined,
                  color: 'var(--text)',
                }}>
                  {msg.role === 'user'
                    ? msg.content
                    : <MarkdownContent>{msg.content}</MarkdownContent>}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)',
                  borderRadius: '18px 18px 18px 4px', padding: '0.75rem 1rem',
                  fontSize: '0.85rem', color: 'var(--muted)',
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                }}>
                  <span style={{ color: '#3fb950', fontSize: '0.6rem', animation: 'pulse 1.2s ease-in-out infinite' }}>●</span>
                  {!isFirstMessageRef.current && messages.filter((m) => m.role === 'user').length === 1
                    ? 'Researching your role… (~30-60s)'
                    : 'Thinking…'}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input — available in both chat and brief_review phases */}
          {(phase === 'chat' || phase === 'brief_review') && (
            <div style={{
              borderTop: '1px solid var(--border)', padding: '1rem 2rem',
              display: 'flex', gap: '0.75rem', background: 'var(--surface)',
            }}>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); }
                }}
                placeholder={phase === 'brief_review'
                  ? 'Refine the config… e.g. "focus only on text posts" or "add a delay between requests"'
                  : 'Describe the agent\'s job… (Enter to send)'}
                rows={2}
                disabled={loading}
                autoFocus={phase === 'chat'}
                style={{
                  flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8,
                  color: 'var(--text)', padding: '0.6rem 0.85rem', fontSize: '0.9rem',
                  resize: 'none', opacity: loading ? 0.6 : 1,
                }}
              />
              <button
                onClick={() => void handleSend()}
                disabled={loading || !input.trim()}
                style={{
                  background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 8,
                  padding: '0 1.25rem', fontSize: '0.9rem', fontWeight: 500,
                  cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                  opacity: loading || !input.trim() ? 0.5 : 1,
                  alignSelf: 'flex-end', height: 42, flexShrink: 0,
                }}
              >
                Send
              </button>
            </div>
          )}
        </div>

        {/* Config preview panel — brief_review only */}
        {phase === 'brief_review' && config && (
          <div style={{
            flex: 1, borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface)',
          }}>
            {/* Compact header: status + name input + create button */}
            <div style={{
              padding: '0.75rem 1.25rem', borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: '1rem',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                {planningLoading
                  ? <span style={{ color: '#1f6feb', fontSize: '0.7rem', animation: 'pulse 1.2s ease-in-out infinite' }}>●</span>
                  : <span style={{ color: '#3fb950' }}>✓</span>
                }
                <span style={{ fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap' }}>
                  {planningLoading ? 'Proposing flows…' : 'Configuration ready'}
                </span>
              </div>
              <input
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                style={{
                  flex: 1, background: 'var(--bg)', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--text)', padding: '0.38rem 0.65rem', fontSize: '0.9rem', fontWeight: 600,
                }}
              />
              <button
                onClick={() => void handleApply()}
                disabled={applying || planningLoading}
                style={{
                  background: '#238636', color: '#fff', border: 'none', borderRadius: 8,
                  padding: '0.45rem 1.15rem', fontSize: '0.88rem', fontWeight: 600, flexShrink: 0,
                  cursor: (applying || planningLoading) ? 'not-allowed' : 'pointer',
                  opacity: (applying || planningLoading) ? 0.5 : 1,
                }}
              >
                {applying ? 'Creating…' : planningLoading ? 'Proposing flows…' : 'Create Agent & Build →'}
              </button>
            </div>

            {/* 3-column grid: System Prompt | Goals | Flows */}
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', overflow: 'hidden' }}>

              {/* Column 1: System Prompt */}
              <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{
                  padding: '0.6rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
                }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>System Prompt</span>
                  <button
                    onClick={() => { setEditingPrompt((prev) => !prev); if (!editingPrompt) setEditedPrompt(config.systemPrompt); }}
                    style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.72rem', padding: 0 }}
                  >
                    {editingPrompt ? 'Done editing' : 'Edit raw'}
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.85rem 1rem' }}>
                  {editingPrompt ? (
                    <textarea
                      value={editedPrompt}
                      onChange={(e) => setEditedPrompt(e.target.value)}
                      style={{
                        width: '100%', height: '100%', minHeight: 300,
                        background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                        color: 'var(--text)', padding: '0.6rem 0.75rem', fontSize: '0.8rem', lineHeight: 1.5,
                        resize: 'none', boxSizing: 'border-box',
                      }}
                    />
                  ) : (
                    <div style={{ fontSize: '0.8rem', lineHeight: 1.6, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
                      {config.systemPrompt}
                    </div>
                  )}
                </div>
              </div>

              {/* Column 2: Goals */}
              <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '0.6rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Initial Goals {config.goals && config.goals.length > 0 && `(${config.goals.length})`}
                  </span>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.85rem 1rem' }}>
                  {config.goals && config.goals.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {config.goals.map((goal, i) => (
                        <div key={i} style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 6, padding: '0.6rem 0.75rem', border: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                            <span style={{
                              fontSize: '0.65rem',
                              background: goal.type === 'objective' ? 'rgba(31,111,235,0.2)' : 'rgba(35,134,54,0.2)',
                              color: goal.type === 'objective' ? '#58a6ff' : '#3fb950',
                              border: `1px solid ${goal.type === 'objective' ? 'rgba(31,111,235,0.3)' : 'rgba(35,134,54,0.3)'}`,
                              borderRadius: 4, padding: '0.1rem 0.35rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                            }}>
                              {goal.type}
                            </span>
                            <span style={{ fontSize: '0.65rem', color: 'var(--muted)' }}>P{goal.priority}</span>
                          </div>
                          <div style={{ fontWeight: 500, fontSize: '0.82rem', color: 'var(--text)', marginBottom: '0.15rem' }}>{goal.title}</div>
                          <div style={{ fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.4 }}>{goal.description}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>No goals proposed.</div>
                  )}
                </div>
              </div>

              {/* Column 3: Proposed Flows */}
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{
                  padding: '0.6rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)',
                  display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0,
                }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Proposed Flows {!planningLoading && plannedFlows.length > 0 && `(${plannedFlows.length})`}
                  </span>
                  {planningLoading && (
                    <span style={{ color: '#1f6feb', fontSize: '0.65rem', animation: 'pulse 1.2s ease-in-out infinite' }}>●</span>
                  )}
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '0.85rem 1rem' }}>
                  {planningLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', color: 'var(--muted)', fontSize: '0.82rem', padding: '0.5rem 0' }}>
                      <span style={{ color: '#1f6feb', fontSize: '0.65rem', animation: 'pulse 1.2s ease-in-out infinite' }}>●</span>
                      Analyzing system prompt and proposing flows…
                    </div>
                  ) : (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        {plannedFlows.map((flow) => (
                          <div
                            key={flow.id}
                            style={{
                              background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border)',
                              borderRadius: 8, padding: '0.7rem 0.85rem',
                              display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
                            }}
                          >
                            <div style={{ flexShrink: 0, marginTop: '0.05rem' }}>
                              <span style={{
                                display: 'inline-block',
                                fontSize: '0.6rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                                color: flow.type === 'action' ? '#d29922' : '#3fb950',
                                background: flow.type === 'action' ? 'rgba(210,153,34,0.12)' : 'rgba(63,185,80,0.12)',
                                border: `1px solid ${flow.type === 'action' ? 'rgba(210,153,34,0.3)' : 'rgba(63,185,80,0.3)'}`,
                                borderRadius: 4, padding: '0.1rem 0.35rem',
                              }}>
                                {flow.type}
                              </span>
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.82rem', marginBottom: '0.15rem' }}>{formatFlowName(flow.name)}</div>
                              <div style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.4 }}>{flow.description}</div>
                              {flow.purpose && (
                                <div style={{ fontSize: '0.72rem', color: '#58a6ff', marginTop: '0.2rem', lineHeight: 1.35 }}>
                                  ↳ {flow.purpose}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => handleRemoveFlow(flow.id)}
                              style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '1rem', padding: '0 0.2rem', flexShrink: 0 }}
                              title="Remove flow"
                            >
                              ×
                            </button>
                          </div>
                        ))}

                        {/* Add flow */}
                        {addingFlow ? (
                          <div style={{ background: 'rgba(0,0,0,0.15)', border: '1px dashed var(--border)', borderRadius: 8, padding: '0.7rem 0.85rem' }}>
                            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                              <input
                                value={newFlowName}
                                onChange={(e) => setNewFlowName(e.target.value)}
                                placeholder="flow_name (snake_case)"
                                autoFocus
                                style={{
                                  flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                                  color: 'var(--text)', padding: '0.35rem 0.55rem', fontSize: '0.82rem',
                                }}
                              />
                              <select
                                value={newFlowType}
                                onChange={(e) => setNewFlowType(e.target.value as 'scrape' | 'action')}
                                style={{
                                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                                  color: 'var(--text)', padding: '0.35rem 0.55rem', fontSize: '0.82rem', cursor: 'pointer',
                                }}
                              >
                                <option value="scrape">scrape</option>
                                <option value="action">action</option>
                              </select>
                            </div>
                            <input
                              value={newFlowDesc}
                              onChange={(e) => setNewFlowDesc(e.target.value)}
                              placeholder="What this flow does (optional)"
                              style={{
                              width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                              color: 'var(--text)', padding: '0.35rem 0.55rem', fontSize: '0.78rem', marginBottom: '0.5rem', boxSizing: 'border-box',
                            }}
                          />
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                              onClick={handleAddFlow}
                              disabled={!newFlowName.trim()}
                              style={{
                                background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 6,
                                padding: '0.3rem 0.75rem', fontSize: '0.78rem', cursor: newFlowName.trim() ? 'pointer' : 'not-allowed', opacity: newFlowName.trim() ? 1 : 0.5,
                              }}
                            >
                              Add
                            </button>
                            <button
                              onClick={() => setAddingFlow(false)}
                              style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', padding: '0.3rem 0.75rem', fontSize: '0.78rem', cursor: 'pointer' }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setAddingFlow(true)}
                          style={{
                            background: 'none', border: '1px dashed var(--border)', borderRadius: 8,
                            color: 'var(--muted)', padding: '0.55rem 0.85rem', fontSize: '0.78rem', cursor: 'pointer',
                            textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.4rem',
                          }}
                        >
                          <span style={{ fontSize: '1rem', lineHeight: 1 }}>+</span> Add a flow
                        </button>
                      )}
                    </div>

                    {/* Refine feedback */}
                    {plannedFlows.length > 0 && (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.4rem' }}>
                          Something off? Describe the change and I'll regenerate the flow list.
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                          <input
                            value={flowFeedback}
                            onChange={(e) => setFlowFeedback(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleRefineFlows(); } }}
                            placeholder="e.g. split Post Comment into two flows — one for posts, one for replies"
                            disabled={refiningFlows}
                            style={{
                              flex: 1, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
                              color: 'var(--text)', padding: '0.35rem 0.6rem', fontSize: '0.78rem',
                              opacity: refiningFlows ? 0.6 : 1,
                            }}
                          />
                          <button
                            onClick={() => void handleRefineFlows()}
                            disabled={refiningFlows || !flowFeedback.trim()}
                            style={{
                              background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 6,
                              padding: '0.35rem 0.75rem', fontSize: '0.78rem', fontWeight: 500,
                              cursor: (refiningFlows || !flowFeedback.trim()) ? 'not-allowed' : 'pointer',
                              opacity: (refiningFlows || !flowFeedback.trim()) ? 0.5 : 1,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {refiningFlows ? 'Refining…' : 'Refine →'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
