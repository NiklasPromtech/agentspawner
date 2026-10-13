import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { Agent, Flow, FlowInput, FlowRun, FlowStep, Tool, RecordEvent } from '../../types/index.js';
import { useQueryClient } from '@tanstack/react-query';
import {
  useFlows,
  useCopyFlow,
  useDeleteFlow,
  usePinFlow,
  useMarkFlowInfeasible,
} from '../../hooks/useFlows.js';
import FlowEditor from './FlowEditor.js';
import FlowGenerator from './FlowGenerator.js';
import type { GeneratorMessage } from './FlowGenerator.js';
import { formatFlowName } from '../../utils/formatFlowName.js';

interface Props {
  agent: Agent;
}

// Describe recorded events as a human-readable list for the AI
function eventsToDescription(events: RecordEvent[]): string {
  return events.map((ev, i) => {
    if (ev.type === 'navigate') return `${i + 1}. Navigated to: ${ev.url}`;
    if (ev.type === 'click') return `${i + 1}. Clicked: ${ev.selector}${ev.text ? ` ("${ev.text}")` : ''}`;
    if (ev.type === 'type') return `${i + 1}. Typed "${ev.value}" into: ${ev.selector}`;
    return `${i + 1}. ${ev.type}`;
  }).join('\n');
}

// Build the initial message when a recording is present
function buildMessageWithRecording(task: string, events: RecordEvent[], done: boolean): string {
  const description = eventsToDescription(events);
  const completionNote = !done
    ? '\n\nNote: recording may be incomplete — the user did not press Stop. Infer the remaining steps from the goal.'
    : '';
  return (
    `I recorded the following browser interaction:\n\n${description}${completionNote}\n\n` +
    `Goal: ${task.trim()}\n\n` +
    `Build a parameterized action flow from this recording. The URL shows the full structure — ` +
    `identify which parts are variable inputs vs. fixed structure. ` +
    `Use the selectors from the recording directly — they are known to work. Replace the specific ` +
    `values I used in the recording with flow input parameters.`
  );
}

// Convert recorded events directly to FlowInput (manual path, no AI)
function eventsToFlowInput(events: RecordEvent[], agentTools: Tool[]): FlowInput {
  const find = (name: string) => agentTools.find((t) => t.name === name);
  const openTabTool = find('open_tab');
  const waitForTool = find('wait_for');
  const clickTool = find('click');
  const typeTextTool = find('type_text');
  const closeTabTool = find('close_tab');

  const steps: FlowStep[] = [];
  let openTabStepId: string | null = null;

  for (const ev of events) {
    if (ev.type === 'navigate') {
      if (!openTabTool) continue;
      if (openTabStepId === null) {
        const stepId = crypto.randomUUID();
        openTabStepId = stepId;
        steps.push({
          id: stepId,
          toolId: openTabTool.id,
          label: 'Open page',
          inputMapping: { url: { type: 'literal', value: ev.url ?? '' } },
        });
      }
    } else if (ev.type === 'click' && clickTool) {
      const tabRef = openTabStepId
        ? ({ type: 'step_ref', stepId: openTabStepId, path: '' } as const)
        : ({ type: 'literal', value: 0 } as const);
      if (waitForTool) {
        steps.push({
          id: crypto.randomUUID(),
          toolId: waitForTool.id,
          label: 'Wait for element',
          inputMapping: { tabId: tabRef, selector: { type: 'literal', value: ev.selector ?? '' } },
        });
      }
      steps.push({
        id: crypto.randomUUID(),
        toolId: clickTool.id,
        label: ev.text ? `Click "${ev.text.slice(0, 40)}"` : 'Click',
        inputMapping: { tabId: tabRef, selector: { type: 'literal', value: ev.selector ?? '' } },
      });
    } else if (ev.type === 'type' && typeTextTool) {
      const tabRef = openTabStepId
        ? ({ type: 'step_ref', stepId: openTabStepId, path: '' } as const)
        : ({ type: 'literal', value: 0 } as const);
      if (waitForTool) {
        steps.push({
          id: crypto.randomUUID(),
          toolId: waitForTool.id,
          label: 'Wait for input',
          inputMapping: { tabId: tabRef, selector: { type: 'literal', value: ev.selector ?? '' } },
        });
      }
      steps.push({
        id: crypto.randomUUID(),
        toolId: typeTextTool.id,
        label: 'Type text',
        inputMapping: {
          tabId: tabRef,
          selector: { type: 'literal', value: ev.selector ?? '' },
          text: { type: 'literal', value: ev.value ?? '' },
        },
      });
    }
  }

  if (closeTabTool && openTabStepId) {
    steps.push({
      id: crypto.randomUUID(),
      toolId: closeTabTool.id,
      label: 'Close tab',
      inputMapping: { tabId: { type: 'step_ref', stepId: openTabStepId, path: '' } },
    });
  }

  return {
    name: 'recorded_flow',
    description: 'Flow recorded from browser interactions',
    inputSchema: JSON.stringify({ type: 'object', properties: {}, required: [] }),
    steps,
  };
}

export default function FlowsTab({ agent }: Props) {
  const location = useLocation();
  const navigate = useNavigate();

  // ── React Query: flow list ──────────────────────────────────────────────
  const queryClient = useQueryClient();
  const { data: flows = [], isLoading: loading } = useFlows(agent.id);
  const deleteMutation = useDeleteFlow(agent.id);
  const copyMutation = useCopyFlow(agent.id);
  const pinMutation = usePinFlow(agent.id);
  const markInfeasibleMutation = useMarkFlowInfeasible(agent.id);

  const [editing, setEditing] = useState<Flow | null | undefined>(undefined);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run history
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [filterFlowId, setFilterFlowId] = useState<string>('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const fetchRuns = useCallback(() => {
    setRunsLoading(true);
    api.getFlowRuns(agent.id, filterFlowId || undefined)
      .then(setRuns)
      .catch(console.error)
      .finally(() => setRunsLoading(false));
  }, [agent.id, filterFlowId]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [prefill, setPrefill] = useState<FlowInput | null>(null);
  const [generatorInitialMessages, setGeneratorInitialMessages] = useState<GeneratorMessage[] | undefined>(undefined);
  const [generatorAutoSend, setGeneratorAutoSend] = useState(false);
  const [generatorAutoApply, setGeneratorAutoApply] = useState(false);
  const [generatorReturnTo, setGeneratorReturnTo] = useState<string | null>(null);
  // ID of the last flow saved while the generator was open — passed back as flowId
  // so the generator's "↺ Repull" button can stay in sync with the DB.
  const [generatorSavedFlowId, setGeneratorSavedFlowId] = useState<string | null>(null);

  // Recording state
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordingDone, setRecordingDone] = useState(false);
  const [recordEvents, setRecordEvents] = useState<RecordEvent[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Generate pre-dialog state (task + optional recording, shown before FlowGenerator launches)
  const [generatorPreDialogOpen, setGeneratorPreDialogOpen] = useState(false);
  const [generatorTask, setGeneratorTask] = useState('');
  const [recordingPreOpen, setRecordingPreOpen] = useState(false);

  // Infeasible state (F2.1)
  const [infeasibleModal, setInfeasibleModal] = useState<{ flow: Flow } | null>(null);
  const [infeasibleReason, setInfeasibleReason] = useState('');

  const handleMarkInfeasible = async (flow: Flow, reason: string) => {
    await markInfeasibleMutation.mutateAsync({ flowId: flow.id, infeasible: true, infeasibleReason: reason });
    setInfeasibleModal(null);
    setInfeasibleReason('');
  };

  // Handle deep-link navigation state (open generator or jump to a specific flow)
  useEffect(() => {
    const state = location.state as { openGenerator?: boolean; prefillMessage?: string; autoApply?: boolean; returnTo?: string; openFlowId?: string } | null;
    if (state?.openGenerator && state.prefillMessage) {
      setGeneratorInitialMessages([{ role: 'user', content: state.prefillMessage }]);
      setGeneratorAutoSend(true);
      setGeneratorAutoApply(state.autoApply ?? false);
      setGeneratorReturnTo(state.returnTo ?? null);
      setGeneratorOpen(true);
    }

    // Deep-link: open a specific flow in the editor once the query data arrives
    const openId = state?.openFlowId ?? null;
    if (openId && flows.length > 0) {
      const target = flows.find((f) => f.id === openId);
      if (target) {
        setPrefill(null);
        setEditing(target);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, flows]);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
  }, []);

  const handleDeleteClick = (flow: Flow) => {
    if (pendingDeleteId === flow.id) {
      // Second click — confirm delete
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      setPendingDeleteId(null);
      deleteMutation.mutateAsync(flow.id).catch((err) =>
        alert(`Failed to delete: ${(err as Error).message}`),
      );
    } else {
      // First click — arm the button, auto-cancel after 3s
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      setPendingDeleteId(flow.id);
      deleteTimerRef.current = setTimeout(() => setPendingDeleteId(null), 3000);
    }
  };

  const handleTogglePin = async (flow: Flow) => {
    try {
      await pinMutation.mutateAsync({ flowId: flow.id, pinned: !flow.pinned });
    } catch (err) {
      alert(`Failed to update: ${(err as Error).message}`);
    }
  };

  const handleGeneratedFlow = async (definition: FlowInput) => {
    if (generatorAutoApply) {
      // Autonomous path: save the flow directly to DB so it's immediately available.
      // The generator navigates away right after this, so there's no editor to prefill.
      try {
        const saved = await api.createFlow(agent.id, definition);
        // Invalidate the React Query cache so the flows list updates
        queryClient.invalidateQueries({ queryKey: ['flows', agent.id] });
        setGeneratorSavedFlowId(saved.id);
      } catch (err) {
        console.error('Auto-apply: failed to save flow to DB', err);
      }
      return;
    }
    // Manual path: apply the flow definition as a prefill for the editor.
    // Do NOT close the generator — it stays open so the user can review the chat
    // history and understand what was built. They'll click "Open Editor" when ready.
    setPrefill(definition);
    setEditing(null);
  };

  // Called by FlowGenerator when `flowId` is known — opens FlowEditor in edit mode
  // so we target the existing DB record instead of creating a new one.
  const handleGeneratedFlowWithId = (definition: FlowInput, flowId: string) => {
    const existingFlow = flows.find((f) => f.id === flowId) ?? null;
    setPrefill(definition);
    setEditing(existingFlow); // edit mode if found; falls back to new-flow mode if not
  };

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

  // Launch FlowGenerator from the pre-dialog (with or without a recording)
  const handleBuildFromPreDialog = () => {
    if (!generatorTask.trim()) return;

    let content: string;
    if (recordEvents.length > 0) {
      content = buildMessageWithRecording(generatorTask, recordEvents, recordingDone);
      void api.cancelRecording().catch(() => null);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } else {
      content = generatorTask.trim();
    }

    setRecording(false);
    setRecordingDone(false);
    setRecordEvents([]);
    setRecordingUrl('');
    setRecordingPreOpen(false);
    setGeneratorPreDialogOpen(false);
    setGeneratorInitialMessages([{ role: 'user', content }]);
    setGeneratorAutoSend(true);
    setGeneratorOpen(true);
  };

  // Skip AI — convert recording directly to a flow and open FlowEditor
  const handleBuildManual = async () => {
    const agentTools = await api.getTools(agent.id).catch(() => [] as Tool[]);
    const flowInput = eventsToFlowInput(recordEvents, agentTools);
    await api.cancelRecording().catch(() => null);
    setRecording(false);
    setRecordingDone(false);
    setRecordEvents([]);
    setRecordingPreOpen(false);
    setGeneratorPreDialogOpen(false);
    setGeneratorTask('');
    setPrefill(flowInput);
    setEditing(null);
  };

  if (generatorOpen) {
    const handleGeneratorCancel = () => {
      const returnTo = generatorReturnTo;
      setGeneratorOpen(false);
      setGeneratorInitialMessages(undefined);
      setGeneratorAutoSend(false);
      setGeneratorAutoApply(false);
      setGeneratorReturnTo(null);
      setGeneratorSavedFlowId(null);
      // If we came from the autonomous agent, always navigate back to chat
      // (even on cancel — don't leave the user stranded on the flows page)
      if (returnTo) {
        navigate(returnTo);
      }
      // Otherwise: if a flow was applied (editing is set), transition to the editor
    };

    return (
      <>
        {/* Banner shown when launched from autonomous agent — always provides a way back */}
        {generatorAutoApply && generatorReturnTo && (
          <div style={{
            background: '#1f6feb22',
            border: '1px solid #1f6feb44',
            borderRadius: 0,
            padding: '0.5rem 1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '0.82rem',
            color: 'var(--muted)',
          }}>
            <span>✦ Launched by autonomous agent — flow will be applied automatically when ready.</span>
            <button
              onClick={handleGeneratorCancel}
              style={{
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 6,
                color: 'var(--muted)',
                padding: '0.2rem 0.6rem',
                fontSize: '0.78rem',
                cursor: 'pointer',
              }}
            >
              ← Return to chat
            </button>
          </div>
        )}
        <FlowGenerator
          agent={agent}
          onFlow={handleGeneratedFlow}
          onFlowWithId={handleGeneratedFlowWithId}
          onCancel={handleGeneratorCancel}
          initialMessages={generatorInitialMessages}
          autoSend={generatorAutoSend}
          confirmOnFlow
          autoApply={generatorAutoApply}
          onApplyComplete={() => {
            if (generatorReturnTo) {
              navigate(generatorReturnTo);
            } else {
              setGeneratorOpen(false);
            }
          }}
          // Persist conversation so user can navigate away and resume later.
          // Disabled for auto-apply flows (autonomous agent builds) — those are
          // fire-and-forget with no manual resume path.
          persistDraftForAgent={generatorAutoApply ? undefined : agent.id}
          // After the flow is saved via FlowEditor, pass its ID back so the
          // "↺ Repull" button in the preview panel can re-fetch from DB if
          // the debugger extension edits it while the generator is still open.
          flowId={generatorSavedFlowId ?? undefined}
        />
      </>
    );
  }

  if (editing !== undefined) {
    return (
      <FlowEditor
        agent={agent}
        flow={editing}
        prefill={prefill ?? undefined}
        onSave={(saved) => {
          // React Query cache invalidation (inside useCreateFlow / useUpdateFlow)
          // takes care of refreshing the flow list. Also patch the cache entry
          // immediately so the list reflects the save without waiting for the refetch.
          queryClient.setQueryData<Flow[]>(['flows', agent.id], (prev) =>
            prev ? prev.map((f) => (f.id === saved.id ? saved : f)) : prev
          );
          // Record the saved flow ID so the generator's ↺ Repull button can
          // re-fetch this exact flow if the debugger edits it while the
          // generator is still open.
          setGeneratorSavedFlowId(saved.id);
          setEditing(undefined);
          setPrefill(null);
        }}
        onCancel={(refreshed) => {
          // If the editor fetched a fresh version from DB, update the cache now
          // so the flow list immediately reflects any debugger-made changes.
          if (refreshed) {
            queryClient.setQueryData<Flow[]>(['flows', agent.id], (prev) =>
              prev ? prev.map((f) => (f.id === refreshed.id ? refreshed : f)) : prev
            );
          }
          setEditing(undefined);
          setPrefill(null);
        }}
      />
    );
  }

  // ── Generate pre-dialog: task + optional recording, before FlowGenerator launches ──
  if (generatorPreDialogOpen) {
    const canBuild = generatorTask.trim().length > 0;
    return (
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '1.5rem', fontFamily: 'inherit' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <button
            onClick={() => {
              void handleDiscardRecording();
              setGeneratorPreDialogOpen(false);
              setGeneratorTask('');
            }}
            style={{ ...actionBtn, fontSize: '0.8rem' }}
          >
            ← Back
          </button>
          <h3 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>Generate a Flow</h3>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* Task description */}
          <div>
            <label style={preDialogLabelStyle}>Task description</label>
            <textarea
              autoFocus
              value={generatorTask}
              onChange={(e) => setGeneratorTask(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canBuild) handleBuildFromPreDialog(); }}
              placeholder="e.g. Reply to a specific Reddit comment identified by comment_id"
              rows={4}
              style={{
                width: '100%',
                padding: '0.6rem 0.75rem',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontSize: '0.9rem',
                resize: 'vertical',
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>⌘↵ to build</span>
          </div>

          {/* Optional recording section */}
          <div style={{ borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
            <button
              onClick={() => setRecordingPreOpen((o) => !o)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.6rem 0.75rem',
                background: 'var(--surface)',
                border: 'none',
                cursor: 'pointer',
                color: recordEvents.length > 0 ? 'var(--text)' : 'var(--muted)',
                fontSize: '0.85rem',
                fontWeight: recordEvents.length > 0 ? 600 : 400,
              }}
            >
              <span>
                {recordEvents.length > 0
                  ? `✓ Recording ready — ${recordEvents.length} event${recordEvents.length !== 1 ? 's' : ''} captured`
                  : 'Guide me with a recording'}
              </span>
              <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>{recordingPreOpen ? '▲' : '▼'}</span>
            </button>

            {recordingPreOpen && (
              <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--bg)', borderTop: '1px solid var(--border)' }}>

                {/* Start recording form */}
                {!recording && !recordingDone && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                      <strong style={{ color: 'var(--text)' }}>Get to the page first, then start recording.</strong>{' '}
                      The recording captures what you do — not how you got there. Navigate to the exact target (the comment, the profile, the post) before pressing Start.
                    </p>
                    <label style={preDialogLabelStyle}>Page URL to record</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <input
                        type="url"
                        value={recordingUrl}
                        onChange={(e) => setRecordingUrl(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleStartRecording(); }}
                        placeholder="https://…"
                        style={{
                          flex: 1,
                          padding: '0.5rem 0.75rem',
                          borderRadius: 8,
                          border: '1px solid var(--border)',
                          background: 'var(--surface)',
                          color: 'var(--text)',
                          fontSize: '0.9rem',
                        }}
                      />
                      <button
                        onClick={() => void handleStartRecording()}
                        disabled={!recordingUrl.trim()}
                        style={{
                          ...stopBtn,
                          opacity: !recordingUrl.trim() ? 0.4 : 1,
                          cursor: !recordingUrl.trim() ? 'default' : 'pointer',
                          fontSize: '0.8rem',
                          padding: '0.4rem 0.9rem',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                      >
                        Start
                      </button>
                    </div>
                  </div>
                )}

                {/* Active recording status */}
                {recording && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                      <span style={{ color: '#ef4444', marginRight: '0.4rem' }}>●</span>
                      Recording… {recordEvents.length} event{recordEvents.length !== 1 ? 's' : ''}
                    </span>
                    <button
                      onClick={() => void handleStopRecording()}
                      style={{ ...stopBtn, fontSize: '0.8rem', padding: '0.4rem 0.9rem' }}
                    >
                      Stop
                    </button>
                  </div>
                )}

                {/* Done — show captured events */}
                {recordingDone && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                        {recordEvents.length} event{recordEvents.length !== 1 ? 's' : ''} captured
                      </span>
                      <button
                        onClick={() => void handleDiscardRecording()}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--muted)', fontSize: '0.75rem', padding: '0.2rem 0.4rem' }}
                      >
                        Discard
                      </button>
                    </div>
                    <div style={{
                      background: 'var(--surface)',
                      borderRadius: 6,
                      padding: '0.5rem 0.6rem',
                      fontSize: '0.75rem',
                      color: 'var(--muted)',
                      fontFamily: 'monospace',
                      maxHeight: 140,
                      overflowY: 'auto',
                      lineHeight: 1.6,
                    }}>
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
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              onClick={handleBuildFromPreDialog}
              disabled={!canBuild}
              style={{ ...buildBtn, opacity: canBuild ? 1 : 0.4, cursor: canBuild ? 'pointer' : 'default' }}
            >
              {recordEvents.length > 0 ? 'Build flow from recording →' : 'Build flow →'}
            </button>
            {recordEvents.length > 0 && (
              <button onClick={() => void handleBuildManual()} style={actionBtn}>
                Skip AI (manual)
              </button>
            )}
          </div>

        </div>
      </div>
    );
  }

  return (
    <>
    {/* height: 100% + overflow: hidden so both panels fill the viewport height and
        can scroll independently.  The parent (AgentLayout content div) is
        overflow-y: auto so the page itself scrolls when necessary. */}
    <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'stretch', minHeight: '100%', padding: '1.5rem', boxSizing: 'border-box' }}>

      {/* ── Left: flow list ─────────────────────────────────────────────── */}
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Flows ({flows.length})</h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={() => setGeneratorPreDialogOpen(true)} style={generateBtn}>✦ Generate</button>
            <button onClick={() => { setPrefill(null); setEditing(null); }} style={manualBtn}>
              Build manually
            </button>
          </div>
        </div>

        {loading ? (
          <p style={{ color: 'var(--muted)' }}>Loading...</p>
        ) : flows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--muted)' }}>
            <p>No flows yet. Flows chain tools into sequential pipelines.</p>
            <p style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>The AI can call flows just like regular tools.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {flows.map((flow) => {
              let stepCount = 0;
              try { stepCount = (JSON.parse(flow.steps) as unknown[]).length; } catch { /* ignore */ }
              return (
                <div
                  key={flow.id}
                  style={{
                    background: 'var(--surface)',
                    border: `1px solid ${flow.infeasible ? '#d4a20655' : flow.pinned ? '#d4a20655' : 'var(--border)'}`,
                    borderRadius: 8,
                    padding: '1rem 1.25rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    opacity: flow.infeasible ? 0.65 : 1,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 600, textDecoration: flow.infeasible ? 'line-through' : 'none' }}>{formatFlowName(flow.name)}</span>
                      <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.5rem', borderRadius: 10, background: '#58a6ff22', color: '#58a6ff', border: '1px solid #58a6ff44' }}>
                        {stepCount} {stepCount === 1 ? 'step' : 'steps'}
                      </span>
                      {flow.flowType === 'action' && !flow.infeasible && (
                        <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.5rem', borderRadius: 10, background: 'rgba(218,54,51,0.12)', color: '#da3633', border: '1px solid rgba(218,54,51,0.3)', fontWeight: 600 }}>
                          ⚡ action
                        </span>
                      )}
                      {flow.flowType === 'scrape' && !flow.infeasible && (
                        <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.5rem', borderRadius: 10, background: 'rgba(56,139,253,0.12)', color: '#58a6ff', border: '1px solid rgba(56,139,253,0.3)' }}>
                          🔍 scrape
                        </span>
                      )}
                      {flow.infeasible && (
                        <span title={flow.infeasibleReason ?? undefined} style={{ fontSize: '0.7rem', padding: '0.1rem 0.5rem', borderRadius: 10, background: 'rgba(210,126,0,0.15)', color: '#d4a206', border: '1px solid rgba(210,126,0,0.35)', fontWeight: 600, cursor: flow.infeasibleReason ? 'help' : 'default' }}>
                          ⚠ Infeasible
                        </span>
                      )}
                      {flow.pinned && !flow.infeasible && (
                        <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.5rem', borderRadius: 10, background: '#d4a20622', color: '#d4a206', border: '1px solid #d4a20655', fontWeight: 600 }}>
                          ✓ Approved
                        </span>
                      )}
                    </div>
                    <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: 0 }}>
                      {flow.infeasible && flow.infeasibleReason
                        ? <span style={{ color: '#d4a206' }}>⚠ {flow.infeasibleReason}</span>
                        : flow.description}
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', marginLeft: '1rem', flexShrink: 0 }}>
                    {!flow.infeasible && (
                      <button
                        onClick={() => void handleTogglePin(flow)}
                        title={flow.pinned ? 'Remove approval' : 'Approve this flow'}
                        style={{ ...actionBtn, color: flow.pinned ? '#d4a206' : 'var(--muted)', border: `1px solid ${flow.pinned ? '#d4a20655' : 'var(--border)'}` }}
                      >
                        {flow.pinned ? '★ Approved' : '☆ Approve'}
                      </button>
                    )}
                    <button onClick={() => { setPrefill(null); setEditing(flow); }} style={actionBtn}>Edit</button>
                    <button
                      onClick={() => copyMutation.mutate(flow.id)}
                      disabled={copyMutation.isPending}
                      title="Duplicate this flow"
                      style={actionBtn}
                    >
                      Copy
                    </button>
                    {flow.flowType === 'action' && !flow.infeasible && (
                      <button
                        onClick={() => { setInfeasibleModal({ flow }); setInfeasibleReason(''); }}
                        title="Mark this flow as infeasible (keeps it for audit but stops it executing)"
                        style={{ ...actionBtn, color: '#d4a206', border: '1px solid rgba(210,126,0,0.35)' }}
                      >
                        ⚠ Infeasible
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteClick(flow)}
                      style={{
                        ...actionBtn,
                        color: pendingDeleteId === flow.id ? '#fff' : 'var(--error)',
                        background: pendingDeleteId === flow.id ? '#b91c1c' : 'transparent',
                        border: `1px solid ${pendingDeleteId === flow.id ? '#b91c1c' : '#f8514944'}`,
                        fontWeight: pendingDeleteId === flow.id ? 600 : 400,
                        minWidth: 64,
                      }}
                    >
                      {pendingDeleteId === flow.id ? 'Sure?' : 'Delete'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Right: run history ──────────────────────────────────────────── */}
      {/* Use a fixed viewport-relative height so flex:1 on the inner
          scrollable list gets a real size to fill. sticky + height: 100% with
          the new overflow-y:auto parent gives us a sticky scrollable panel. */}
      <div style={{ width: 360, flexShrink: 0, position: 'sticky', top: 0, alignSelf: 'flex-start', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 100px)' }}>
        {/* Panel header */}
        <div style={{ marginBottom: '0.6rem', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h4 style={{ fontSize: '0.9rem', fontWeight: 600, margin: 0 }}>Run History</h4>
            <button onClick={fetchRuns} style={{ ...actionBtn, fontSize: '0.72rem', padding: '0.15rem 0.5rem' }}>
              ↻ Refresh
            </button>
          </div>
          {/* Filter dropdown */}
          <select
            value={filterFlowId}
            onChange={(e) => setFilterFlowId(e.target.value)}
            style={{
              width: '100%',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: filterFlowId ? 'var(--text)' : 'var(--muted)',
              padding: '0.35rem 0.6rem',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            <option value="">All flows</option>
            {flows.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {runsLoading ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>Loading…</p>
          ) : runs.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>
              {filterFlowId ? 'No runs for this flow yet.' : 'No runs yet — flows will appear here as they execute.'}
            </p>
          ) : (
            runs.filter((r) => r.flowName !== '__inline_test__').map((run) => {
              const isExpanded = expandedRunId === run.id;
              const evalIcon = run.evaluationPassed === true ? '✅' : run.evaluationPassed === false ? '❌' : null;
              const time = new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const date = new Date(run.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
              return (
                <div
                  key={run.id}
                  style={{
                    background: 'var(--surface)',
                    border: `1px solid ${run.success ? 'var(--border)' : '#f8514933'}`,
                    borderRadius: 6,
                    overflow: 'hidden',
                    flexShrink: 0,   // prevent flex from squishing cards to fit container height
                  }}
                >
                  <div
                    style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.55rem 0.75rem', cursor: 'pointer', minHeight: 36 }}
                    onClick={() => setExpandedRunId(isExpanded ? null : run.id)}
                  >
                    <span style={{ fontSize: '0.85rem', flexShrink: 0, color: run.success ? 'var(--success)' : 'var(--error)', fontWeight: 700 }}>
                      {run.success ? '✓' : '✗'}
                    </span>
                    <span style={{ fontSize: '0.78rem', color: 'var(--accent)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatFlowName(run.flowName)}
                    </span>
                    {evalIcon && <span style={{ fontSize: '0.8rem', flexShrink: 0 }}>{evalIcon}</span>}
                    <span style={{ fontSize: '0.7rem', color: 'var(--muted)', flexShrink: 0 }}>{run.durationMs != null ? `${run.durationMs}ms` : ''}</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>{date} {time}</span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--muted)', flexShrink: 0 }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>

                  {isExpanded && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '0.5rem 0.75rem', fontSize: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      {run.error && (
                        <div style={{ color: '#f85149', background: '#f8514911', borderRadius: 4, padding: '0.3rem 0.5rem' }}>
                          ✗ {run.error}
                        </div>
                      )}
                      {run.evaluationReason && (
                        <div style={{ color: run.evaluationPassed ? '#3fb950' : '#f85149', background: run.evaluationPassed ? '#3fb95011' : '#f8514911', borderRadius: 4, padding: '0.3rem 0.5rem' }}>
                          🔍 {run.evaluationReason}
                        </div>
                      )}
                      <div>
                        <span style={{ color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', fontSize: '0.68rem', letterSpacing: '0.04em' }}>Input</span>
                        <pre style={{ margin: '0.2rem 0 0', fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 120, overflowY: 'auto', background: 'var(--bg)', borderRadius: 4, padding: '0.3rem 0.5rem' }}>
                          {(() => { try { return JSON.stringify(JSON.parse(run.input), null, 2); } catch { return run.input; } })()}
                        </pre>
                      </div>
                      {run.output && (
                        <div>
                          <span style={{ color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', fontSize: '0.68rem', letterSpacing: '0.04em' }}>Output</span>
                          <pre style={{ margin: '0.2rem 0 0', fontFamily: 'monospace', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflowY: 'auto', background: 'var(--bg)', borderRadius: 4, padding: '0.3rem 0.5rem' }}>
                            {(() => { try { return JSON.stringify(JSON.parse(run.output), null, 2); } catch { return run.output; } })()}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

    </div>

    {/* Infeasible modal (F2.1) */}
    {infeasibleModal && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid rgba(210,126,0,0.4)', borderRadius: 10, padding: '1.75rem', maxWidth: 480, width: '90%' }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', fontWeight: 700, color: '#d4a206' }}>⚠ Mark as infeasible</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)', margin: '0 0 1rem' }}>
            <strong style={{ color: 'var(--text)' }}>{infeasibleModal.flow.name}</strong> will be kept for audit but excluded from the agent's tool list and will not execute. Briefly explain why it's infeasible.
          </p>
          <textarea
            value={infeasibleReason}
            onChange={(e) => setInfeasibleReason(e.target.value)}
            placeholder="e.g. Shadow DOM — Reddit Chat is unreachable via CSS selectors"
            rows={3}
            style={{ width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '0.6rem 0.75rem', fontSize: '0.85rem', resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button
              onClick={() => { setInfeasibleModal(null); setInfeasibleReason(''); }}
              style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', padding: '0.4rem 1rem', fontSize: '0.85rem', cursor: 'pointer' }}
            >
              Cancel
            </button>
            <button
              onClick={() => void handleMarkInfeasible(infeasibleModal.flow, infeasibleReason)}
              disabled={markInfeasibleMutation.isPending || !infeasibleReason.trim()}
              style={{ background: markInfeasibleMutation.isPending || !infeasibleReason.trim() ? '#5a4a00' : '#92700a', border: '1px solid #d4a206', borderRadius: 6, color: '#d4a206', padding: '0.4rem 1rem', fontSize: '0.85rem', fontWeight: 600, cursor: markInfeasibleMutation.isPending || !infeasibleReason.trim() ? 'not-allowed' : 'pointer' }}
            >
              {markInfeasibleMutation.isPending ? 'Saving…' : 'Mark infeasible'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function eventIcon(type: RecordEvent['type']): string {
  if (type === 'navigate') return '🌐';
  if (type === 'click') return '👆';
  return '⌨️';
}

function eventColor(type: RecordEvent['type']): string {
  if (type === 'navigate') return '#58a6ff';
  if (type === 'click') return '#3fb950';
  return '#d2a8ff';
}

const preDialogLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '0.4rem',
};

const stopBtn: React.CSSProperties = {
  background: '#991b1b',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.5rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  fontWeight: 600,
};

const buildBtn: React.CSSProperties = {
  background: '#1f6feb',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.5rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  fontWeight: 500,
};

const generateBtn: React.CSSProperties = {
  background: 'linear-gradient(135deg, #238636, #1a6a2a)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '0.5rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
  fontWeight: 500,
};

const manualBtn: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--muted)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '0.5rem 1rem',
  fontSize: '0.875rem',
  cursor: 'pointer',
};

const actionBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--muted)',
  padding: '0.3rem 0.75rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
};
