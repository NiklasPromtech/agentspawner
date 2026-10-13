import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';
import type { Agent, FlowInput, FlowStep } from '../../types/index.js';
import { drafts } from '../../lib/drafts.js';
import type { GeneratorDraft } from '../../utils/session-draft.js';

// ── Session facts persistence (24h TTL) ──────────────────────────────────────
const SESSION_FACTS_TTL_MS = 24 * 60 * 60 * 1000;

interface SessionFactsEntry { facts: string[]; savedAt: string; }
function loadSessionFacts(agentId: string): string[] {
  try {
    const raw = localStorage.getItem(drafts.keys.sessionFacts(agentId));
    if (!raw) return [];
    const item = JSON.parse(raw) as SessionFactsEntry;
    if (item.savedAt && Date.now() - new Date(item.savedAt).getTime() > SESSION_FACTS_TTL_MS) {
      localStorage.removeItem(drafts.keys.sessionFacts(agentId));
      return [];
    }
    return Array.isArray(item.facts) ? item.facts : [];
  } catch { return []; }
}
function saveSessionFacts(agentId: string, facts: string[]): void {
  try {
    if (facts.length === 0) { localStorage.removeItem(drafts.keys.sessionFacts(agentId)); return; }
    localStorage.setItem(drafts.keys.sessionFacts(agentId), JSON.stringify({ facts, savedAt: new Date().toISOString() }));
  } catch { /* quota / private mode */ }
}
import {
  useFlowGeneratorStream,
} from '../../hooks/useFlowGeneratorStream.js';
import MarkdownContent from '../../components/MarkdownContent.js';

// Re-export types that other files import from this module (backwards-compat).
export type { GeneratorMessage, InputRequestField } from '../../hooks/useFlowGeneratorStream.js';
import type { GeneratorMessage, ChatItem, InputRequestField, ExplorerLogItem, ExplorerPhase } from '../../hooks/useFlowGeneratorStream.js';

// ── Tool icons ────────────────────────────────────────────────────────────────
const TOOL_ICONS: Record<string, string> = {
  inspect_page: '🔍',
  analyze_dom: '🧠',
  test_flow: '🧪',
  submit_flow: '✅',
};

interface Props {
  agent: Agent;
  onFlow: (definition: FlowInput) => void | Promise<void>;
  onCancel: () => void;
  initialMessages?: GeneratorMessage[];
  autoSend?: boolean;
  title?: string;
  /** @deprecated ignored — kept for compat */
  loadingText?: string;
  confirmOnFlow?: boolean;
  /** When true, automatically apply the flow as soon as it's ready (no user click needed) */
  autoApply?: boolean;
  /** Called after autoApply completes — use to navigate away */
  onApplyComplete?: () => void;
  /**
   * When set, the generator automatically saves its conversation state to localStorage
   * under this agent ID. On next open it will offer to resume where you left off.
   * Pass agent.id to enable; omit to disable (e.g. for auto-apply flows where resuming
   * doesn't make sense).
   */
  persistDraftForAgent?: string;
  /**
   * Optional override for the "Edit in Editor" button. When provided, clicking that button
   * calls this instead of the default onFlow + onCancel combination. Use this when the
   * parent needs to save the flow AND navigate to the editor in one atomic step, without
   * also triggering the normal onCancel side-effect (e.g. skipping to the next flow in
   * the onboarding wizard).
   */
  onEditInEditor?: (definition: FlowInput) => void;
  /**
   * When true, hides the right "Flow Preview" panel so the chat fills the full width.
   * Use when the parent is showing an inline editor alongside the generator and the
   * preview pane would be redundant / take up valuable space.
   */
  hidePreview?: boolean;
  /**
   * When set, a "↺ Repull" button appears in the Flow Preview panel header.
   * Clicking it re-fetches this flow from the DB and updates both the step list
   * display and the completedFlow that "Edit Steps" will open with — without
   * touching the chat history or any other state.
   */
  flowId?: string;
  /**
   * When set, passes the flow type to the backend generator so it can use a
   * type-specific system prompt (scrape vs action focus).
   */
  flowType?: 'scrape' | 'action';
  /**
   * When both `flowId` and this callback are set, "Apply Flow" and "Edit Steps"
   * call this instead of `onFlow`, passing both the definition and the existing
   * flow ID. The parent can then open FlowEditor in edit mode (targeting the
   * DB record) rather than new-flow mode — preventing stale chat state from
   * overwriting debugger edits.
   */
  onFlowWithId?: (definition: FlowInput, flowId: string) => void;
  /**
   * When set, the explorer phase is skipped and this seed context is synthesised
   * directly into an ExplorationReport for the builder.
   */
  seedContext?: { pageUrl: string; feedSelector?: string; postCardSelector?: string; expandSelector?: string; notes?: string };
}

export default function FlowGenerator({
  agent,
  onFlow,
  onCancel,
  initialMessages,
  autoSend = false,
  title = 'Flow Generator',
  confirmOnFlow = false,
  autoApply = false,
  onApplyComplete,
  persistDraftForAgent,
  onEditInEditor: onEditInEditorProp,
  hidePreview = false,
  flowId,
  onFlowWithId,
  flowType,
  seedContext: seedContextProp,
}: Props) {
  // ── Draft restoration: check localStorage on mount if persistDraftForAgent is set ──
  const savedDraft = persistDraftForAgent && !autoApply
    ? drafts.load<GeneratorDraft>(drafts.keys.generator(persistDraftForAgent))
    : null;

  // ── Session facts — loaded from localStorage, passed to the backend on each build ──
  const [initialSessionFacts] = useState<string[]>(() => loadSessionFacts(agent.id));

  // ── Quick Build (seed) state — scrape flows only ───────────────────────────
  const [seedOpen, setSeedOpen] = useState(false);
  const [seed, setSeed] = useState<{ pageUrl: string; feedSelector: string; postCardSelector: string; expandSelector: string; notes: string }>({
    pageUrl: '', feedSelector: '', postCardSelector: '', expandSelector: '', notes: '',
  });

  // ── SSE stream state (managed by hook) ───────────────────────────────────
  const {
    loading,
    chatItems,
    setChatItems,
    conversationHistory,
    setConversationHistory,
    previewSteps,
    setPreviewSteps,
    previewName,
    previewDesc,
    completedFlow,
    setCompletedFlow,
    pendingInputId,
    setPendingInputId,
    sessionFacts,
    setSessionFacts,
    tokenUsage,
    explorerLog,
    explorerPhase,
    appendItem,
    sendMessages,
    cancel,
  } = useFlowGeneratorStream({
    agentId: agent.id,
    confirmOnFlow,
    onFlow,
    autoSend,
    savedDraft,
    initialMessages,
    flowType,
    initialSessionFacts,
    // Prop takes priority (parent pre-dialog), then fall back to in-component Quick Build form
    seedContext: seedContextProp ?? (seedOpen && seed.pageUrl.trim()
      ? {
          pageUrl: seed.pageUrl.trim(),
          ...(seed.feedSelector.trim()     ? { feedSelector:     seed.feedSelector.trim() }     : {}),
          ...(seed.postCardSelector.trim() ? { postCardSelector: seed.postCardSelector.trim() } : {}),
          ...(seed.expandSelector.trim()   ? { expandSelector:   seed.expandSelector.trim() }   : {}),
          ...(seed.notes.trim()            ? { notes:            seed.notes.trim() }            : {}),
        }
      : undefined),
  });

  // ── UI-only state ─────────────────────────────────────────────────────────
  const [input, setInput] = useState('');

  // Whether the flow has been applied (sent to parent) — used to switch button states
  const [flowApplied, setFlowApplied] = useState(false);

  // API key confirmation handled in setup step before flow builder — always skip here
  const [keyConfirmed, setKeyConfirmed] = useState<boolean>(true);

  // TASK 8.3 — Session facts panel
  const [factsExpanded, setFactsExpanded] = useState(false);

  // TASK 8.5 — Inspectable flow steps
  const [inspectedStepIdx, setInspectedStepIdx] = useState<number | null>(null);

  // ── Repull from DB ────────────────────────────────────────────────────────
  const [repullLoading, setRepullLoading] = useState(false);
  const [repullUpdated, setRepullUpdated] = useState(false);

  const handleRepull = () => {
    if (!flowId) return;
    setRepullLoading(true);
    setRepullUpdated(false);
    api.getFlow(agent.id, flowId)
      .then((fetched) => {
        // Parse the steps JSON string into a FlowStep array
        let parsedSteps: FlowStep[] = [];
        try { parsedSteps = JSON.parse(fetched.steps) as FlowStep[]; } catch { /* use empty */ }
        // Update what "Edit Steps" will open with
        setCompletedFlow({
          name: fetched.name,
          description: fetched.description,
          inputSchema: fetched.inputSchema,
          steps: parsedSteps,
          returnStepId: fetched.returnStepId ?? null,
          returnSteps: fetched.returnSteps ?? null,
          reasoningModel: fetched.reasoningModel ?? null,
          reasoningPrompt: fetched.reasoningPrompt ?? null,
          resultMessage: fetched.resultMessage ?? null,
          flowType: fetched.flowType ?? null,
          dedupKeyField: fetched.dedupKeyField ?? null,
          dedupBreakType: fetched.dedupBreakType ?? null,
          dedupIntervalHours: fetched.dedupIntervalHours ?? null,
          dedupBlockMessage: fetched.dedupBlockMessage ?? null,
          readsFrom: fetched.readsFrom ?? null,
          writesTo: fetched.writesTo ?? null,
          updatesFields: fetched.updatesFields ? JSON.parse(fetched.updatesFields) as string[] : null,
          requiresApproval: fetched.requiresApproval,
          requiresHumanReview: fetched.requiresHumanReview,
        });
        // Update the step list display in the right panel
        setPreviewSteps(parsedSteps.map((s) => ({ label: s.label ?? '(step)', toolName: s.toolId ?? '' })));
        setRepullUpdated(true);
        setTimeout(() => setRepullUpdated(false), 2500);
      })
      .catch((err: unknown) => {
        alert(`Repull failed: ${err instanceof Error ? err.message : 'Failed to reload from server'}`);
      })
      .finally(() => setRepullLoading(false));
  };

  // Inline test panel (confirmOnFlow mode) — shown in right panel before applying
  const [testPanelOpen, setTestPanelOpen] = useState(false);
  const [testInput, setTestInput] = useState('{}');
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; result?: string; error?: string; durationMs?: number } | null>(null);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ── Persist session facts whenever they change (TASK 8.3) ─────────────────
  useEffect(() => {
    saveSessionFacts(agent.id, sessionFacts);
  }, [agent.id, sessionFacts]);

  // ── Auto-save draft whenever conversation or preview state changes ─────────
  // Debounced to 800ms to avoid thrashing on rapid updates
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!persistDraftForAgent || autoApply || flowApplied) return;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => {
      // Don't persist empty sessions — wait until there's at least one exchange
      if (conversationHistory.length === 0) return;
      drafts.save(drafts.keys.generator(persistDraftForAgent), {
        agentId: persistDraftForAgent,
        flowHint: previewName || undefined,
        conversationHistory,
        previewName,
        previewDesc,
        previewSteps,
        completedFlow,
      });
    }, 800);
    return () => {
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    };
  }, [persistDraftForAgent, autoApply, flowApplied, conversationHistory, previewName, previewDesc, previewSteps, completedFlow]);

  // ── Auto-apply: when autoApply=true and a flow is ready, apply it immediately ──
  useEffect(() => {
    if (autoApply && completedFlow && !flowApplied) {
      setFlowApplied(true);
      const result = onFlow(completedFlow);
      // If onFlow returns a promise (e.g. saving to DB), wait for it before navigating away
      if (result && typeof (result as Promise<void>).then === 'function') {
        (result as Promise<void>).then(() => onApplyComplete?.()).catch(() => onApplyComplete?.());
      } else {
        onApplyComplete?.();
      }
    }
  }, [autoApply, completedFlow, flowApplied, onFlow, onApplyComplete]);

  // ── Scroll chat to bottom whenever items change ───────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatItems, loading]);

  // ── User-initiated send ───────────────────────────────────────────────────
  const send = async () => {
    const text = input.trim();
    if (!text || !!pendingInputId) return;

    // If the agent is mid-run, cancel it first so the user's message
    // interrupts the current loop and steers the builder.
    if (loading) cancel();

    const userMsg: GeneratorMessage = { role: 'user', content: text };
    const updatedHistory = [...conversationHistory, userMsg];
    setConversationHistory(updatedHistory);
    appendItem({ kind: 'user', text });
    setInput('');
    await sendMessages(updatedHistory);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  // ── Flow action handlers ──────────────────────────────────────────────────

  const handleApply = () => {
    if (completedFlow) {
      if (persistDraftForAgent) drafts.clear(drafts.keys.generator(persistDraftForAgent));
      // TASK 8.3 — clear accumulated session facts after successful flow apply
      setSessionFacts([]);
      if (flowId && onFlowWithId) {
        onFlowWithId(completedFlow, flowId);
      } else {
        onFlow(completedFlow);
      }
      setFlowApplied(true);
      appendItem({ kind: 'reply', text: '✓ Flow applied — click "Open Editor" above to continue editing, or keep chatting to refine.' });
    }
  };

  // One-click: pass flow to parent (sets prefill) then immediately open the editor.
  // This is the primary action when you want to review/tweak steps before saving.
  const handleEditInEditor = () => {
    if (completedFlow) {
      if (persistDraftForAgent) drafts.clear(drafts.keys.generator(persistDraftForAgent));
      cancel();
      if (onEditInEditorProp) {
        // Parent has its own handling (e.g. onboarding wizard: save flow + navigate to
        // editor directly, without also triggering the onCancel skip-to-next-flow logic).
        onEditInEditorProp(completedFlow);
      } else if (flowId && onFlowWithId) {
        // Known existing flow: open editor in edit mode so we don't create a duplicate.
        onFlowWithId(completedFlow, flowId);
        onCancel();
      } else {
        onFlow(completedFlow);   // parent receives definition & prepares editor
        onCancel();              // close generator → parent transitions to FlowEditor
      }
    }
  };

  const handleCancel = () => {
    // Don't clear the draft on cancel — user may want to resume later
    cancel();
    onCancel();
  };

  const handleTest = async () => {
    if (!completedFlow?.steps) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      let parsedInput: Record<string, unknown> = {};
      try { parsedInput = JSON.parse(testInput) as Record<string, unknown>; } catch { /* use empty */ }
      const result = await api.testFlowInline(
        agent.id,
        completedFlow.steps as import('../../types/index.js').FlowStep[],
        completedFlow.inputSchema ?? '{}',
        completedFlow.returnStepId ?? null,
        completedFlow.returnSteps ?? null,
        parsedInput,
        completedFlow.resultMessage ?? null,
      );
      setTestResult({ ok: result.ok, result: result.result, error: result.error, durationMs: result.durationMs });
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestRunning(false);
    }
  };

  // Called when user submits an input_request form
  const handleInputSubmit = useCallback(async (formId: string, values: Record<string, string>) => {
    // Mark the form as submitted
    setChatItems((prev) => prev.map((item) =>
      item.kind === 'input_request' && item.id === formId
        ? { ...item, submitted: true }
        : item
    ));
    setPendingInputId(null);

    // Format values as a readable user message
    const valueLines = Object.entries(values)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const userText = `Here are the test values:\n${valueLines}`;

    const userMsg: GeneratorMessage = { role: 'user', content: userText };
    const updatedHistory = [...conversationHistory, userMsg];
    setConversationHistory(updatedHistory);
    appendItem({ kind: 'user', text: userText });
    await sendMessages(updatedHistory);
  }, [conversationHistory, sendMessages, appendItem, setChatItems, setPendingInputId, setConversationHistory]);

  return (
    <div style={outerStyle}>
      {/* ── Header ── */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '1.1rem' }}>✦</span>
          <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>{title}</span>
          {loading && explorerPhase === 'exploring' && (
            <span style={{ fontSize: '0.75rem', color: '#e3b341', background: '#e3b34111', border: '1px solid #e3b34133', borderRadius: 10, padding: '0.1rem 0.6rem' }}>
              ● exploring
            </span>
          )}
          {loading && explorerPhase !== 'exploring' && (
            <span style={{ fontSize: '0.75rem', color: 'var(--accent)', background: 'var(--accent)11', border: '1px solid var(--accent)33', borderRadius: 10, padding: '0.1rem 0.6rem' }}>
              ● building
            </span>
          )}
          {/* TASK 8.4 — live token cost counter */}
          {tokenUsage && tokenUsage.estimatedCostUsd > 0 && (
            <span style={{ fontSize: '0.73rem', color: 'var(--muted)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '0.1rem 0.55rem' }} title={`${tokenUsage.inputTokens.toLocaleString()} input tokens · ${tokenUsage.outputTokens.toLocaleString()} output tokens`}>
              ~${tokenUsage.estimatedCostUsd < 0.01 ? tokenUsage.estimatedCostUsd.toFixed(4) : tokenUsage.estimatedCostUsd.toFixed(3)}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {flowApplied ? (
            <button onClick={handleCancel} style={applyBtnStyle}>Open Editor →</button>
          ) : completedFlow ? (
            <>
              <button onClick={handleApply} style={applyBtnStyle}>✓ Apply Flow</button>
              <button onClick={handleEditInEditor} style={editBtnStyle}>⊞ Edit Steps</button>
              <button onClick={() => setCompletedFlow(null)} style={discardBtnStyle}>Discard</button>
            </>
          ) : null}
          <button onClick={handleCancel} style={cancelBtnStyle}>{flowApplied ? 'Close' : 'Cancel'}</button>
        </div>
      </div>

      {/* ── Body: split layout ── */}
      <div style={bodyStyle}>

        {/* ── Left: chat stream ── */}
        <div style={leftPanelStyle}>

          {/* TASK 8.2 — API key confirmation: shown once before first build starts */}
          {!keyConfirmed && (
            <div style={{
              margin: '0 0 0.75rem',
              padding: '0.75rem 1rem',
              borderRadius: 8,
              background: 'rgba(88,166,255,0.08)',
              border: '1px solid rgba(88,166,255,0.3)',
              fontSize: '0.85rem',
              lineHeight: 1.55,
            }}>
              <div style={{ fontWeight: 600, color: '#58a6ff', marginBottom: '0.35rem' }}>
                🔑 API key confirmation
              </div>
              <div style={{ color: 'var(--text)', marginBottom: '0.6rem' }}>
                This build session will use the API key configured for <strong>{agent.name}</strong>. Any page interactions and API calls made during building will authenticate with that key.
              </div>
              <button
                onClick={() => setKeyConfirmed(true)}
                style={{
                  padding: '0.35rem 1rem', borderRadius: 6, fontSize: '0.82rem',
                  fontWeight: 600, cursor: 'pointer',
                  border: '1px solid rgba(88,166,255,0.4)',
                  background: 'rgba(88,166,255,0.15)', color: '#58a6ff',
                }}
              >
                Confirm, let's build ▶
              </button>
            </div>
          )}

          <div style={chatListStyle}>
            {chatItems.length === 0 && !loading && (
              <div style={{ color: 'var(--muted)', fontSize: '0.85rem', padding: '1rem 0', textAlign: 'center' }}>
                Describe the flow you want to build below ↓
              </div>
            )}
            {chatItems.map((item, i) => (
              <ChatItemView
                key={item.kind === 'input_request' ? item.id : i}
                item={item}
                onInputSubmit={handleInputSubmit}
              />
            ))}
            {loading && (
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.5rem 0', color: 'var(--muted)', fontSize: '0.8rem' }}>
                <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>●</span>
                <span>Thinking…</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Quick Build — scrape flows, first turn only */}
          {flowType === 'scrape' && chatItems.length === 0 && !loading && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.6rem', marginTop: '0.25rem' }}>
              <button
                onClick={() => setSeedOpen((v) => !v)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: seedOpen ? 'var(--accent)' : 'var(--muted)', fontSize: '0.75rem', fontWeight: 600, padding: '0 0 0.4rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}
              >
                <span style={{ fontSize: '0.65rem' }}>{seedOpen ? '▼' : '▶'}</span>
                Quick Build — skip exploration (I already know the selectors)
              </button>
              {seedOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingBottom: '0.6rem' }}>
                  {([
                    ['pageUrl',          'Page URL *',               'https://linkedin.com/search/results/content/?keywords={{keyword}}', false],
                    ['feedSelector',     'Feed container selector *', "[data-testid='lazy-column']",                                       true],
                    ['postCardSelector', 'Post card selector',        "[role='listitem']",                                                  true],
                    ['expandSelector',   'Expand button selector',    "[data-testid='expandable-text-button']  (leave blank if none)",      true],
                    ['notes',            'Additional notes',          'Anything the builder should know…',                                  false],
                  ] as [keyof typeof seed, string, string, boolean][]).map(([key, label, ph]) => (
                    <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <label style={{ fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 600 }}>{label}</label>
                      <input
                        value={seed[key]}
                        onChange={(e) => setSeed((s) => ({ ...s, [key]: e.target.value }))}
                        placeholder={ph}
                        style={{ background: 'var(--input-bg, #161b22)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)', padding: '4px 7px', fontSize: '0.75rem', fontFamily: 'monospace' }}
                      />
                    </div>
                  ))}
                  <div style={{ fontSize: '0.68rem', color: 'var(--muted)', marginTop: '0.1rem' }}>
                    Fields marked * are required for Quick Build. Use the ◎ Picker in the extension to capture selectors from the live page.
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Input */}
          <div style={inputAreaStyle}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={pendingInputId ? 'Fill in the form above to continue…' : loading ? 'Type to interrupt and steer the builder… (Enter to send)' : 'Describe the flow, or ask a follow-up… (Enter to send)'}
              disabled={!!pendingInputId}
              rows={2}
              style={textareaStyle}
              autoFocus={!autoSend}
            />
            <button onClick={() => void send()} disabled={!!pendingInputId || !input.trim()} style={sendBtnStyle}>
              {loading ? 'Steer' : 'Send'}
            </button>
          </div>
        </div>

        {/* ── Right: explorer log during exploration, flow preview otherwise ── */}
        <div style={{ ...rightPanelStyle, display: hidePreview ? 'none' : undefined }}>

          {/* Explorer log panel — shown while exploring */}
          {explorerPhase === 'exploring' && (
            <ExplorerLogPanel log={explorerLog} />
          )}

          {/* After exploration: compact summary bar + flow preview */}
          {explorerPhase === 'building' && explorerLog.length > 0 && (
            <ExplorerSummaryBar log={explorerLog} />
          )}

          {/* Flow preview panel — shown when not exploring */}
          {explorerPhase !== 'exploring' && (
          <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Flow Preview
            </span>
            {flowId && (
              <button
                onClick={handleRepull}
                disabled={repullLoading}
                title="Re-fetch this flow from the database"
                style={{
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 5,
                  color: repullUpdated ? '#3fb950' : 'var(--muted)',
                  borderColor: repullUpdated ? '#3fb95055' : undefined,
                  cursor: repullLoading ? 'default' : 'pointer',
                  fontSize: '0.72rem',
                  padding: '0.15rem 0.5rem',
                  opacity: repullLoading ? 0.6 : 1,
                  flexShrink: 0,
                }}
              >
                {repullLoading ? '⏳' : repullUpdated ? '✓ Updated' : '↺ Repull'}
              </button>
            )}
          </div>
          {previewSteps.length === 0 ? (
            <div style={{ color: 'var(--muted)', fontSize: '0.82rem', textAlign: 'center', padding: '2rem 1rem', border: '1px dashed var(--border)', borderRadius: 8 }}>
              Steps will appear here as the flow is built
            </div>
          ) : (
            <>
              {previewName && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <code style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--accent)' }}>{previewName}</code>
                  {previewDesc && <p style={{ fontSize: '0.8rem', color: 'var(--muted)', margin: '0.25rem 0 0' }}>{previewDesc}</p>}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {previewSteps.map((step, idx) => {
                  const isInspected = inspectedStepIdx === idx;
                  // Full step data available once flow is complete
                  const fullStep = completedFlow?.steps?.[idx];
                  return (
                    <div key={idx}>
                      {/* TASK 8.5 — steps are clickable when flow is complete */}
                      <div
                        key={idx}
                        onClick={() => completedFlow ? setInspectedStepIdx(isInspected ? null : idx) : undefined}
                        style={{
                          ...stepCardStyle,
                          cursor: completedFlow ? 'pointer' : 'default',
                          background: isInspected ? 'var(--accent)18' : undefined,
                          borderColor: isInspected ? 'var(--accent)55' : undefined,
                        }}
                        title={completedFlow ? 'Click to inspect step configuration' : undefined}
                      >
                        <span style={{ color: 'var(--muted)', fontSize: '0.75rem', minWidth: 18, flexShrink: 0 }}>{idx + 1}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.82rem', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{step.label}</div>
                          <code style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{step.toolName}</code>
                        </div>
                        {completedFlow && (
                          <span style={{ fontSize: '0.65rem', color: 'var(--muted)', flexShrink: 0 }}>{isInspected ? '▴' : '▾'}</span>
                        )}
                      </div>
                      {/* Inspector panel */}
                      {isInspected && fullStep && (
                        <div style={{
                          marginTop: '0.25rem',
                          padding: '0.6rem 0.75rem',
                          background: 'var(--bg)',
                          border: '1px solid var(--accent)33',
                          borderRadius: 6,
                          fontSize: '0.75rem',
                          lineHeight: 1.55,
                        }}>
                          <div style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: '0.35rem', textTransform: 'uppercase', fontSize: '0.68rem', letterSpacing: '0.04em' }}>Step config</div>
                          <div><code style={{ color: 'var(--accent)' }}>id</code>: <span style={{ color: 'var(--text)' }}>{fullStep.id}</span></div>
                          <div style={{ marginTop: '0.3rem' }}><code style={{ color: 'var(--accent)' }}>tool</code>: <span style={{ color: 'var(--text)', fontFamily: 'monospace' }}>{fullStep.toolId}</span></div>
                          {fullStep.inputMapping && Object.keys(fullStep.inputMapping).length > 0 && (
                            <div style={{ marginTop: '0.3rem' }}>
                              <code style={{ color: 'var(--accent)' }}>inputs</code>:
                              <div style={{ paddingLeft: '0.75rem', marginTop: '0.2rem' }}>
                                {Object.entries(fullStep.inputMapping).map(([k, v]) => (
                                  <div key={k} style={{ color: 'var(--muted)', wordBreak: 'break-all' }}>
                                    <code style={{ color: 'var(--text)' }}>{k}</code>: {JSON.stringify(v)}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {fullStep.condition && (
                            <div style={{ marginTop: '0.3rem' }}>
                              <code style={{ color: 'var(--accent)' }}>condition</code>: <span style={{ color: 'var(--muted)' }}>{fullStep.condition.check} — "{fullStep.condition.failMessage}"</span>
                            </div>
                          )}
                          {fullStep.transform?.script && (
                            <div style={{ marginTop: '0.3rem' }}>
                              <code style={{ color: 'var(--accent)' }}>transform</code>:
                              <pre style={{ margin: '0.2rem 0 0', padding: '0.35rem 0.5rem', background: 'var(--surface)', borderRadius: 4, fontSize: '0.68rem', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text)' }}>{fullStep.transform.script}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {flowApplied ? (
                <div style={{ marginTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ fontSize: '0.8rem', color: '#3fb950', fontWeight: 600, textAlign: 'center' }}>✓ Applied</div>
                  <button onClick={handleCancel} style={{ ...applyBtnStyle, width: '100%', justifyContent: 'center' }}>
                    Open Editor →
                  </button>
                </div>
              ) : completedFlow ? (
                <div style={{ marginTop: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <button onClick={handleApply} style={{ ...applyBtnStyle, width: '100%', justifyContent: 'center' }}>
                    ✓ Apply Flow
                  </button>
                  <button onClick={handleEditInEditor} style={{ ...editBtnStyle, width: '100%', justifyContent: 'center' }}>
                    ⊞ Edit Steps
                  </button>

                  {/* Test panel */}
                  <button
                    onClick={() => { setTestPanelOpen((v) => !v); setTestResult(null); }}
                    style={{
                      width: '100%', padding: '0.45rem', borderRadius: 6, fontSize: '0.82rem',
                      fontWeight: 500, cursor: 'pointer', border: '1px solid var(--border)',
                      background: testPanelOpen ? 'var(--surface)' : 'transparent', color: 'var(--muted)',
                    }}
                  >
                    {testPanelOpen ? '▾ Hide test' : '▸ Test it first'}
                  </button>

                  {testPanelOpen && (() => {
                    // Parse inputSchema → per-field labeled inputs (same pattern as FlowEditor)
                    let schemaProps: Record<string, { description?: string }> = {};
                    try {
                      const s = JSON.parse(completedFlow.inputSchema ?? '{}') as { properties?: Record<string, { description?: string }> };
                      schemaProps = s.properties ?? {};
                    } catch { /* use empty */ }
                    const inputKeys = Object.keys(schemaProps);

                    const getVals = (): Record<string, unknown> => {
                      try { return JSON.parse(testInput) as Record<string, unknown>; } catch { return {}; }
                    };
                    const setField = (key: string, value: string) => {
                      const cur = getVals(); cur[key] = value;
                      setTestInput(JSON.stringify(cur, null, 2));
                    };

                    return (
                      <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem', background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Test Inputs</div>

                        {inputKeys.length > 0 ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {inputKeys.map((k) => {
                              const vals = getVals();
                              const fieldInputStyle = {
                                width: '100%', boxSizing: 'border-box' as const,
                                background: 'var(--surface)', border: '1px solid var(--border)',
                                borderRadius: 5, color: 'var(--text)',
                                fontFamily: 'monospace', fontSize: '0.82rem', padding: '0.35rem 0.5rem',
                              };
                              if (k === 'action_brief') {
                                // Parse existing value back into user-facing sub-fields
                                let raw: Record<string, unknown> = {};
                                try { raw = typeof vals[k] === 'string' ? JSON.parse(vals[k] as string) : (vals[k] as Record<string, unknown>) ?? {}; } catch { /* use defaults */ }
                                const action = (raw.action as Record<string, unknown>) ?? {};
                                const ctx = (raw.decision_context as Record<string, unknown>) ?? {};
                                const briefVals = {
                                  type: String(action.type ?? ''),
                                  reason: String(ctx.reason ?? ''),
                                  draft: String(action.draft ?? ''),
                                };
                                const setActionBrief = (updated: typeof briefVals) => {
                                  const assembled = {
                                    action: { type: updated.type, ...(updated.draft.trim() ? { draft: updated.draft } : {}) },
                                    decision_context: { reason: updated.reason, supporting_scrapes: [], memory_queries: [], database_context: [] },
                                  };
                                  setField(k, JSON.stringify(assembled));
                                };
                                return (
                                  <div key={k}>
                                    <code style={{ fontSize: '0.78rem', color: 'var(--accent)', display: 'block', marginBottom: '0.3rem' }}>{k}</code>
                                    <div style={{ border: '1px solid var(--border)', borderRadius: 5, padding: '0.4rem 0.5rem', background: 'rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                      {(['type', 'reason', 'draft'] as const).map((sub) => (
                                        <div key={sub}>
                                          <label style={{ fontSize: '0.68rem', color: 'var(--muted)', display: 'block', marginBottom: '0.1rem', textTransform: 'capitalize' }}>
                                            {sub === 'reason' ? 'reason / generation brief' : sub}
                                            {sub === 'draft' ? ' (optional)' : ''}
                                          </label>
                                          <input
                                            type="text"
                                            value={briefVals[sub]}
                                            onChange={(e) => setActionBrief({ ...briefVals, [sub]: e.target.value })}
                                            style={fieldInputStyle}
                                          />
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              }
                              return (
                                <div key={k}>
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', marginBottom: '0.2rem' }}>
                                    <code style={{ fontSize: '0.78rem', color: 'var(--accent)' }}>{k}</code>
                                    {schemaProps[k]?.description && (
                                      <span style={{ fontSize: '0.7rem', color: 'var(--muted)' }}>{schemaProps[k].description}</span>
                                    )}
                                  </div>
                                  <input
                                    type="text"
                                    value={String(vals[k] ?? '')}
                                    onChange={(e) => setField(k, e.target.value)}
                                    style={fieldInputStyle}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <textarea
                            value={testInput}
                            onChange={(e) => setTestInput(e.target.value)}
                            rows={3}
                            spellCheck={false}
                            placeholder="{}"
                            style={{
                              width: '100%', boxSizing: 'border-box', resize: 'vertical',
                              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5,
                              color: 'var(--text)', fontFamily: 'monospace', fontSize: '0.78rem', padding: '0.4rem',
                            }}
                          />
                        )}

                        <button
                          onClick={() => { void handleTest(); }}
                          disabled={testRunning}
                          style={{
                            padding: '0.4rem', borderRadius: 6, fontSize: '0.82rem', fontWeight: 600,
                            cursor: testRunning ? 'default' : 'pointer',
                            border: '1px solid rgba(88,166,255,0.3)',
                            background: 'rgba(88,166,255,0.1)', color: '#58a6ff', opacity: testRunning ? 0.6 : 1,
                          }}
                        >
                          {testRunning ? '⏳ Running…' : '▶ Run Test'}
                        </button>

                        {testResult && (
                          <div style={{
                            padding: '0.5rem 0.6rem', borderRadius: 6, fontSize: '0.78rem',
                            border: `1px solid ${testResult.ok ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.3)'}`,
                            background: testResult.ok ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.08)',
                          }}>
                            <div style={{ fontWeight: 700, color: testResult.ok ? '#3fb950' : '#f85149', marginBottom: '0.25rem' }}>
                              {testResult.ok ? '✅ Passed' : '❌ Failed'}{testResult.durationMs ? ` · ${(testResult.durationMs / 1000).toFixed(1)}s` : ''}
                            </div>
                            <div style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflowY: 'auto' }}>
                              {(() => {
                                const raw = testResult.error ?? testResult.result ?? '';
                                try {
                                  const parsed = JSON.parse(raw);
                                  // OPERATION SCREENSHOT REFS — render screenshot_ref objects as images
                                  if (parsed && typeof parsed === 'object' && parsed.type === 'screenshot_ref' && parsed.url) {
                                    return <img src={`http://localhost:3001${parsed.url}`} alt="Flow result screenshot" style={{ maxWidth: '100%', borderRadius: 4 }} />;
                                  }
                                } catch { /* not JSON — fall through */ }
                                return raw;
                              })()}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <button onClick={() => setCompletedFlow(null)} style={{ ...discardBtnStyle, width: '100%', justifyContent: 'center' }}>
                    Discard
                  </button>
                </div>
              ) : null}
            </>
          )}

          </div>
          )}

          {/* TASK 8.3 — "What I've learned this session" panel */}
          {sessionFacts.length > 0 && explorerPhase !== 'exploring' && (
            <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '0.75rem' }}>
              <button
                onClick={() => setFactsExpanded((v) => !v)}
                style={{
                  background: 'transparent', border: 'none', padding: 0,
                  cursor: 'pointer', color: 'var(--muted)', fontSize: '0.72rem',
                  fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                  display: 'flex', alignItems: 'center', gap: '0.3rem', width: '100%',
                }}
              >
                <span>{factsExpanded ? '▾' : '▸'}</span>
                <span>What I've learned ({sessionFacts.length})</span>
              </button>
              {factsExpanded && (
                <ul style={{ margin: '0.45rem 0 0', paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {sessionFacts.map((fact, i) => (
                    <li key={i} style={{ fontSize: '0.75rem', color: 'var(--text)', lineHeight: 1.5 }}>{fact}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Chat item renderer ────────────────────────────────────────────────────────

function ChatItemView({
  item,
  onInputSubmit,
}: {
  item: ChatItem;
  onInputSubmit?: (formId: string, values: Record<string, string>) => void;
}) {
  const [screenshotExpanded, setScreenshotExpanded] = useState(false);
  const [devInfoExpanded, setDevInfoExpanded] = useState(false);
  // action_brief maps to the ActionBrief Zod schema.
  // We expose three user-facing sub-fields and assemble the full schema on submit.
  const ACTION_BRIEF_KEYS = ['type', 'reason', 'draft'] as const;

  const [formValues, setFormValues] = useState<Record<string, string>>(() => {
    if (item.kind === 'input_request') {
      const entries: [string, string][] = [];
      for (const f of item.fields) {
        if (f.key === 'action_brief') {
          // Try to parse defaults from placeholder if the builder sent one
          let defaults: Record<string, string> = {};
          try {
            const p = JSON.parse(f.placeholder ?? '');
            if (p && typeof p === 'object') {
              // Support both flat {type,reason,draft} and full ActionBrief {action,decision_context}
              const flat = p as Record<string, unknown>;
              defaults = {
                type: String((flat.action as Record<string, unknown>)?.type ?? flat.type ?? ''),
                reason: String((flat.decision_context as Record<string, unknown>)?.reason ?? flat.reason ?? ''),
                draft: String((flat.action as Record<string, unknown>)?.draft ?? flat.draft ?? ''),
              };
            }
          } catch { /* no placeholder */ }
          for (const k of ACTION_BRIEF_KEYS) entries.push([`action_brief__${k}`, defaults[k] ?? '']);
        } else {
          entries.push([f.key, f.placeholder ?? '']);
        }
      }
      return Object.fromEntries(entries);
    }
    return {};
  });

  // Assemble action_brief sub-fields into a valid ActionBrief JSON string before submitting.
  const assembleSubmitValues = (): Record<string, string> => {
    if (item.kind !== 'input_request') return formValues;
    const out: Record<string, string> = {};
    for (const f of item.fields) {
      if (f.key === 'action_brief') {
        const actionBrief = {
          action: {
            type: formValues['action_brief__type'] ?? '',
            ...(formValues['action_brief__draft']?.trim() ? { draft: formValues['action_brief__draft'] } : {}),
          },
          decision_context: {
            reason: formValues['action_brief__reason'] ?? '',
            supporting_scrapes: [],
            memory_queries: [],
            database_context: [],
          },
        };
        out[f.key] = JSON.stringify(actionBrief);
      } else {
        out[f.key] = formValues[f.key] ?? '';
      }
    }
    return out;
  };

  if (item.kind === 'user') {
    // Auto-initiated messages contain internal scaffolding — collapse them by default
    if (item.autoInitiated) {
      return (
        <div style={{ marginBottom: '0.5rem' }}>
          <button
            onClick={() => setDevInfoExpanded((v) => !v)}
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--muted)',
              fontSize: '0.75rem',
              padding: '0.2rem 0.6rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <span style={{ fontSize: '0.65rem' }}>{devInfoExpanded ? '▾' : '▸'}</span>
            Developer info
          </button>
          {devInfoExpanded && (
            <div style={{
              marginTop: '0.35rem',
              padding: '0.55rem 0.85rem',
              borderRadius: 8,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              fontSize: '0.78rem',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--muted)',
            }}>{item.text}</div>
          )}
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
        <div style={{
          maxWidth: '80%', padding: '0.55rem 0.85rem',
          borderRadius: '12px 12px 2px 12px',
          background: '#238636', fontSize: '0.875rem',
          lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{item.text}</div>
      </div>
    );
  }

  if (item.kind === 'thinking') {
    return (
      <div style={{ marginBottom: '0.5rem' }}>
        <div style={{
          padding: '0.55rem 0.85rem', borderRadius: '12px 12px 12px 2px',
          background: 'var(--surface)', border: '1px solid var(--border)',
          fontSize: '0.875rem', lineHeight: 1.5, wordBreak: 'break-word',
        }}><MarkdownContent>{item.text}</MarkdownContent></div>
      </div>
    );
  }

  if (item.kind === 'tool_call') {
    const icon = TOOL_ICONS[item.tool] ?? '⚙️';
    return (
      <div style={{ marginBottom: '0.35rem' }}>
        <div style={{
          padding: '0.45rem 0.75rem', borderRadius: 8,
          background: '#1d4ed811', border: '1px solid #3b82f633',
          fontSize: '0.8rem', display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
        }}>
          <span style={{ flexShrink: 0 }}>{icon}</span>
          <div>
            <span style={{ color: '#60a5fa', fontWeight: 600, marginRight: '0.4rem' }}>{item.tool}</span>
            <span style={{ color: 'var(--muted)' }}>{item.displayText}</span>
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === 'tool_result') {
    return (
      <div style={{ marginBottom: '0.5rem', paddingLeft: '0.5rem', borderLeft: '2px solid var(--border)' }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{item.summary}</span>
      </div>
    );
  }

  if (item.kind === 'screenshot') {
    return (
      <div style={{ marginBottom: '0.5rem' }}>
        <button
          onClick={() => setScreenshotExpanded((v) => !v)}
          style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 6,
            padding: '0.3rem 0.6rem', cursor: 'pointer', fontSize: '0.78rem',
            color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: '0.4rem',
          }}
        >
          📸 {screenshotExpanded ? 'Hide' : 'View'} screenshot
        </button>
        {screenshotExpanded && (
          <img
            src={`http://localhost:3001${item.url}`}
            alt="Flow test screenshot"
            style={{ marginTop: '0.5rem', maxWidth: '100%', borderRadius: 6, border: '1px solid var(--border)' }}
          />
        )}
      </div>
    );
  }

  if (item.kind === 'reply') {
    return (
      <div style={{ marginBottom: '0.5rem' }}>
        <div style={{
          padding: '0.55rem 0.85rem', borderRadius: '12px 12px 12px 2px',
          background: 'var(--surface)', border: '1px solid var(--accent)44',
          fontSize: '0.875rem', lineHeight: 1.5, wordBreak: 'break-word',
        }}><MarkdownContent>{item.text}</MarkdownContent></div>
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <div style={{ marginBottom: '0.5rem' }}>
        <div style={{
          padding: '0.55rem 0.85rem', borderRadius: 8,
          background: '#f8514911', border: '1px solid #f8514944',
          fontSize: '0.875rem', color: 'var(--error)',
        }}>⚠️ {item.text}</div>
      </div>
    );
  }

  // TASK 8.4 — fatal error (credit exhaustion etc.) — prominent, unmissable banner
  if (item.kind === 'fatal_error') {
    return (
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{
          padding: '0.85rem 1rem', borderRadius: 8,
          background: 'rgba(248,81,73,0.1)', border: '2px solid rgba(248,81,73,0.5)',
          fontSize: '0.875rem',
        }}>
          <div style={{ fontWeight: 700, color: '#f85149', fontSize: '0.95rem', marginBottom: '0.35rem' }}>
            🛑 Build stopped
          </div>
          <div style={{ color: 'var(--text)', lineHeight: 1.55 }}>{item.text}</div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--muted)' }}>
            Any flows completed before this point have been saved. You can resume building after topping up your API credits.
          </div>
        </div>
      </div>
    );
  }

  // TASK 8.1 — research summary — distinct box showing what was found during page analysis
  if (item.kind === 'research_summary') {
    return (
      <div style={{ marginBottom: '0.5rem' }}>
        <div style={{
          padding: '0.55rem 0.85rem', borderRadius: 8,
          background: 'rgba(56,189,248,0.07)', border: '1px solid rgba(56,189,248,0.25)',
          fontSize: '0.8rem', lineHeight: 1.5,
        }}>
          <div style={{ fontWeight: 600, color: '#38bdf8', marginBottom: '0.2rem', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            🔍 Research summary
          </div>
          <div style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.text}</div>
        </div>
      </div>
    );
  }

  if (item.kind === 'input_request') {
    const canSubmit = item.fields.every((f) => {
      if (!f.required) return true;
      if (f.key === 'action_brief') return ACTION_BRIEF_KEYS.every((k) => (formValues[`action_brief__${k}`] ?? '').trim());
      return (formValues[f.key] ?? '').trim();
    });

    const inputStyle = {
      width: '100%', boxSizing: 'border-box' as const,
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 5, color: 'inherit',
      fontSize: '0.85rem', padding: '0.35rem 0.6rem',
      fontFamily: 'inherit',
    };

    return (
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{
          padding: '1rem 1.1rem', borderRadius: 10,
          background: 'var(--surface)',
          border: `1px solid ${item.submitted ? 'var(--border)' : 'var(--accent)55'}`,
          opacity: item.submitted ? 0.6 : 1,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 600 }}>
              📋 Test values needed
            </span>
            {item.submitted && (
              <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>✓ submitted</span>
            )}
          </div>

          {item.fields.map((field) => {
            if (field.key === 'action_brief') {
              // action_brief is a protocol type — always render goal / tone / context sub-fields
              return (
                <div key={field.key} style={{ marginBottom: '0.75rem' }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.4rem' }}>
                    {field.label}
                    {field.required && <span style={{ color: '#f85149', marginLeft: '0.2rem' }}>*</span>}
                  </div>
                  <div style={{
                    border: '1px solid var(--border)', borderRadius: 6,
                    padding: '0.5rem 0.7rem', background: 'rgba(0,0,0,0.1)',
                    display: 'flex', flexDirection: 'column', gap: '0.45rem',
                  }}>
                    {ACTION_BRIEF_KEYS.map((k) => (
                      <div key={k}>
                        <label style={{ display: 'block', fontSize: '0.72rem', color: 'var(--muted)', marginBottom: '0.15rem', textTransform: 'capitalize' }}>
                          {k}
                        </label>
                        <input
                          value={formValues[`action_brief__${k}`] ?? ''}
                          onChange={(e) => setFormValues((prev) => ({ ...prev, [`action_brief__${k}`]: e.target.value }))}
                          disabled={item.submitted}
                          style={inputStyle}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              );
            }
            // Plain field
            return (
              <div key={field.key} style={{ marginBottom: '0.6rem' }}>
                <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.2rem' }}>
                  {field.label}
                  {field.required && <span style={{ color: '#f85149', marginLeft: '0.2rem' }}>*</span>}
                </label>
                <input
                  value={formValues[field.key] ?? ''}
                  onChange={(e) => setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder ?? ''}
                  disabled={item.submitted}
                  style={inputStyle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSubmit && !item.submitted) {
                      onInputSubmit?.(item.id, assembleSubmitValues());
                    }
                  }}
                />
              </div>
            );
          })}

          {!item.submitted && (
            <button
              onClick={() => onInputSubmit?.(item.id, assembleSubmitValues())}
              disabled={!canSubmit}
              style={{
                marginTop: '0.25rem',
                background: canSubmit ? '#238636' : 'var(--surface)',
                color: canSubmit ? '#fff' : 'var(--muted)',
                border: `1px solid ${canSubmit ? '#238636' : 'var(--border)'}`,
                borderRadius: 5, padding: '0.35rem 0.9rem',
                fontSize: '0.8rem', fontWeight: 600,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
            >
              Submit test values →
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ── Explorer Log Panel ────────────────────────────────────────────────────────

function ExplorerLogPanel({ log }: { log: ExplorerLogItem[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#e3b341', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>◉</span>
        Explorer
      </div>
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {log.length === 0 && (
          <div style={{ color: 'var(--muted)', fontSize: '0.82rem', textAlign: 'center', padding: '2rem 1rem' }}>
            Opening target page…
          </div>
        )}
        {log.map((item, i) => (
          <ExplorerLogItemView key={i} item={item} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ExplorerSummaryBar({ log }: { log: ExplorerLogItem[] }) {
  const lastItem = log[log.length - 1];
  if (!lastItem || lastItem.kind !== 'explorer_complete') return null;

  return (
    <div style={{
      marginBottom: '0.75rem',
      padding: '0.5rem 0.75rem',
      borderRadius: 6,
      background: lastItem.success ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.08)',
      border: `1px solid ${lastItem.success ? 'rgba(63,185,80,0.25)' : 'rgba(248,81,73,0.25)'}`,
      fontSize: '0.78rem',
    }}>
      <span style={{ fontWeight: 600, color: lastItem.success ? '#3fb950' : '#f85149' }}>
        {lastItem.success ? '✓ Explored' : '⚠ Exploration partial'}
      </span>
      <span style={{ color: 'var(--muted)', marginLeft: '0.4rem' }}>
        {lastItem.summary.slice(0, 90)}{lastItem.summary.length > 90 ? '…' : ''}
      </span>
    </div>
  );
}

function ExplorerLogItemView({ item }: { item: ExplorerLogItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === 'explorer_thinking') {
    return (
      <div style={{ fontSize: '0.8rem', color: 'var(--text)', lineHeight: 1.55, padding: '0.35rem 0.5rem', borderLeft: '2px solid rgba(227,179,65,0.4)', background: 'rgba(255,255,255,0.03)', borderRadius: '0 4px 4px 0' }}>
        {item.text.length > 180 ? (
          <>
            <span>{expanded ? item.text : item.text.slice(0, 180) + '…'}</span>
            <button onClick={() => setExpanded((v) => !v)} style={{ marginLeft: '0.3rem', background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.73rem', padding: 0 }}>
              {expanded ? 'less' : 'more'}
            </button>
          </>
        ) : item.text}
      </div>
    );
  }

  if (item.kind === 'explorer_tool_call') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem' }}>
        <span style={{ color: '#e3b341', flexShrink: 0 }}>→</span>
        <code style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{item.displayText}</code>
      </div>
    );
  }

  if (item.kind === 'explorer_tool_result') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', paddingLeft: '1rem' }}>
        <span style={{ color: item.ok ? '#3fb950' : '#f85149', flexShrink: 0 }}>{item.ok ? '✓' : '✗'}</span>
        <span style={{ color: 'var(--muted)', wordBreak: 'break-word' }}>{item.summary}</span>
      </div>
    );
  }

  if (item.kind === 'explorer_complete') {
    return (
      <div style={{
        padding: '0.4rem 0.6rem',
        borderRadius: 5,
        background: item.success ? 'rgba(63,185,80,0.08)' : 'rgba(248,81,73,0.08)',
        border: `1px solid ${item.success ? 'rgba(63,185,80,0.25)' : 'rgba(248,81,73,0.25)'}`,
        fontSize: '0.78rem',
        marginTop: '0.2rem',
      }}>
        <span style={{ fontWeight: 600, color: item.success ? '#3fb950' : '#f85149' }}>
          {item.success ? '✓ Found working approach' : '⚠ Could not complete exploration'}
        </span>
        <div style={{ color: 'var(--muted)', marginTop: '0.2rem', lineHeight: 1.45 }}>
          {item.summary.slice(0, 140)}{item.summary.length > 140 ? '…' : ''}
        </div>
      </div>
    );
  }

  return null;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const outerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.85rem 1.5rem',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
};

const leftPanelStyle: React.CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  borderRight: '1px solid var(--border)',
  overflow: 'hidden',
};

const chatListStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '1rem 1.25rem',
  minHeight: 0,
};

const inputAreaStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'flex-end',
  padding: '0.75rem 1.25rem',
  borderTop: '1px solid var(--border)',
  flexShrink: 0,
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'inherit',
  fontSize: '0.875rem',
  padding: '0.5rem 0.75rem',
  resize: 'none',
  fontFamily: 'inherit',
  lineHeight: 1.5,
};

const rightPanelStyle: React.CSSProperties = {
  width: 300,
  flexShrink: 0,
  overflowY: 'auto',
  padding: '1.25rem',
  background: 'var(--bg)',
};

const stepCardStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'flex-start',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '0.45rem 0.65rem',
};

const applyBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  background: '#238636',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.45rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  fontWeight: 600,
};

const editBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  background: 'transparent',
  border: '1px solid rgba(88,166,255,0.5)',
  borderRadius: 6,
  color: '#58a6ff',
  padding: '0.45rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  fontWeight: 500,
};

const discardBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  padding: '0.45rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
};

const sendBtnStyle: React.CSSProperties = {
  background: '#238636',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.5rem 1.25rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  flexShrink: 0,
  alignSelf: 'flex-end',
};

const cancelBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  padding: '0.3rem 0.75rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
};
