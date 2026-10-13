/**
 * ActionFlowTestPage — /test/action-flow
 *
 * Fast path for iterating on the action flow builder.
 * Pick an agent, type a task, hit Build — straight into FlowGenerator.
 * No onboarding wizard, no job description, no scraping flows first.
 *
 * Optional "Guide me with a recording" section lets the user demonstrate
 * an action once before building. The recording events are injected into
 * the FlowGenerator's initial message so the agent doesn't have to discover
 * URL structure or selectors from scratch.
 */

import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client.js';
import type { Agent, RecordEvent } from '../types/index.js';
import FlowGenerator from './agent/FlowGenerator.js';
import type { FlowInput } from '../types/index.js';

const STORAGE_KEY = 'actionFlowTest_agentId';

// Format recorded events as a numbered list for the AI
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

export default function ActionFlowTestPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? '',
  );
  const [task, setTask] = useState('');
  const [building, setBuilding] = useState(false);
  const [initialMessages, setInitialMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);

  // Recording state
  const [recordingOpen, setRecordingOpen] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recording, setRecording] = useState(false);
  const [recordingDone, setRecordingDone] = useState(false);
  const [recordEvents, setRecordEvents] = useState<RecordEvent[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api.getAgents().then(setAgents).catch(() => null);
  }, []);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;

  const handleAgentChange = (id: string) => {
    setSelectedAgentId(id);
    localStorage.setItem(STORAGE_KEY, id);
  };

  // ── Recording handlers ────────────────────────────────────────────────

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
    setRecordingOpen(false);
  };

  // ── Build ─────────────────────────────────────────────────────────────

  const handleBuild = () => {
    if (!task.trim() || !selectedAgent) return;

    let content: string;
    if (recordEvents.length > 0) {
      content = buildMessageWithRecording(task, recordEvents, recordingDone);
      // Clean up recording session before handing off
      void api.cancelRecording().catch(() => null);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } else {
      content = task.trim();
    }

    setInitialMessages([{ role: 'user', content }]);
    setBuilding(true);
  };

  const handleCancel = () => {
    setBuilding(false);
    setInitialMessages([]);
  };

  const handleFlow = (_def: FlowInput) => {
    setBuilding(false);
    setInitialMessages([]);
    setTask('');
    setRecordEvents([]);
    setRecordingDone(false);
    setRecordingOpen(false);
    setRecordingUrl('');
  };

  // ── FlowGenerator view ────────────────────────────────────────────────

  if (building && selectedAgent) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--bg)', flexShrink: 0 }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
            Action Flow Test · <strong>{selectedAgent.name}</strong>
          </span>
          <button
            onClick={handleCancel}
            style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '0.25rem 0.75rem', cursor: 'pointer', color: 'var(--muted)', fontSize: '0.8rem' }}
          >
            ← Back
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <FlowGenerator
            agent={selectedAgent}
            onFlow={handleFlow}
            onCancel={handleCancel}
            initialMessages={initialMessages}
            autoSend={true}
            flowType="action"
            title="Action Flow Builder"
          />
        </div>
      </div>
    );
  }

  // ── Setup form ────────────────────────────────────────────────────────

  return (
    <div style={{ maxWidth: 560, margin: '4rem auto', padding: '0 1.5rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginBottom: '0.25rem', fontSize: '1.2rem' }}>Action Flow Test</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 0, marginBottom: '2rem' }}>
        Skip straight to the action flow builder — no wizard, no onboarding.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

        {/* Agent picker */}
        <div>
          <label style={labelStyle}>Agent</label>
          <select
            value={selectedAgentId}
            onChange={(e) => handleAgentChange(e.target.value)}
            style={selectStyle}
          >
            <option value="">— pick an agent —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Task */}
        <div>
          <label style={labelStyle}>Task description</label>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleBuild();
            }}
            placeholder="e.g. Reply to a specific Reddit comment identified by comment_id"
            rows={4}
            style={textareaStyle}
          />
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>⌘↵ to build</span>
        </div>

        {/* Recording section */}
        <div style={{ borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
          {/* Header toggle */}
          <button
            onClick={() => setRecordingOpen((o) => !o)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0.6rem 0.75rem',
              background: 'var(--bg-subtle, #1a1a1a)',
              border: 'none',
              cursor: 'pointer',
              color: recordEvents.length > 0 ? 'var(--fg, #fff)' : 'var(--muted)',
              fontSize: '0.85rem',
              fontWeight: recordEvents.length > 0 ? 600 : 400,
            }}
          >
            <span>
              {recordEvents.length > 0
                ? `✓ Recording ready — ${recordEvents.length} event${recordEvents.length !== 1 ? 's' : ''} captured`
                : 'Guide me with a recording'}
            </span>
            <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>{recordingOpen ? '▲' : '▼'}</span>
          </button>

          {recordingOpen && (
            <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', background: 'var(--bg, #111)' }}>

              {/* Start recording form */}
              {!recording && !recordingDone && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                    <strong style={{ color: 'var(--fg, #fff)' }}>Get to the page first, then start recording.</strong>{' '}
                    The recording captures what you do — not how you got there. Navigate to the exact target (the comment, the profile, the post) before pressing Start.
                  </p>
                  <label style={labelStyle}>Page URL to record</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="url"
                      value={recordingUrl}
                      onChange={(e) => setRecordingUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleStartRecording(); }}
                      placeholder="https://…"
                      style={{ ...selectStyle, flex: 1 }}
                    />
                    <button
                      onClick={() => void handleStartRecording()}
                      disabled={!recordingUrl.trim()}
                      style={recBtnStyle(!recordingUrl.trim(), false)}
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
                  <button onClick={() => void handleStopRecording()} style={recBtnStyle(false, true)}>
                    Stop
                  </button>
                </div>
              )}

              {/* Done — show events */}
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
                    background: 'var(--bg-subtle, #1a1a1a)',
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

        <button
          onClick={handleBuild}
          disabled={!task.trim() || !selectedAgentId}
          style={buildBtnStyle(!task.trim() || !selectedAgentId)}
        >
          {recordEvents.length > 0 ? 'Build flow from recording →' : 'Build flow →'}
        </button>

      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '0.4rem',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg-subtle, #1a1a1a)',
  color: 'inherit',
  fontSize: '0.9rem',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.6rem 0.75rem',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--bg-subtle, #1a1a1a)',
  color: 'inherit',
  fontSize: '0.9rem',
  resize: 'vertical',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const buildBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '0.6rem 1.5rem',
  borderRadius: 8,
  border: 'none',
  background: disabled ? 'var(--border)' : '#3b82f6',
  color: disabled ? 'var(--muted)' : '#fff',
  fontWeight: 600,
  fontSize: '0.9rem',
  cursor: disabled ? 'default' : 'pointer',
  alignSelf: 'flex-start',
  transition: 'background 0.15s',
});

const recBtnStyle = (disabled: boolean, isStop: boolean): React.CSSProperties => ({
  padding: '0.4rem 0.9rem',
  borderRadius: 6,
  border: 'none',
  background: disabled ? 'var(--border)' : isStop ? '#ef4444' : '#3b82f6',
  color: disabled ? 'var(--muted)' : '#fff',
  fontWeight: 600,
  fontSize: '0.8rem',
  cursor: disabled ? 'default' : 'pointer',
  whiteSpace: 'nowrap',
  flexShrink: 0,
});
