import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import type { Agent, Flow, Run, SseEvent } from '../../types/index.js';
import MessageBubble from '../../components/MessageBubble.js';

interface Props {
  agent: Agent;
}

interface AutonomousStatus {
  latestRun: Run | null;
  currentTask: string | null;
  plan: string | null;
  statusUpdatedAt: string | null;
}

export default function ChatTab({ agent }: Props) {
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [flowIdByName, setFlowIdByName] = useState<Record<string, string>>({});
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Track the trigger type of the currently active run so we can allow chat input
  // during autonomous runs (chatRunning = manual run in progress; autonomousRunning = wake-up in progress)
  const [chatRunning, setChatRunning] = useState(false);
  const [autonomousRunning, setAutonomousRunning] = useState(false);
  const running = chatRunning || autonomousRunning;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [autonomousStatus, setAutonomousStatus] = useState<AutonomousStatus | null>(null);
  const [budgetUsdPerHour, setBudgetUsdPerHour] = useState<number>(0); // 0 = full speed
  const bottomRef = useRef<HTMLDivElement>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasReconnectedRef = useRef(false);

  // Load runs list for the history sidebar
  useEffect(() => {
    api.getRuns(agent.id).then(setRuns).catch(console.error);
  }, [agent.id]);

  // Build flowName → flowId lookup so tool call bubbles can show a copy button
  useEffect(() => {
    api.getFlows(agent.id)
      .then((flows: Flow[]) => {
        const map: Record<string, string> = {};
        for (const f of flows) map[f.name] = f.id;
        setFlowIdByName(map);
      })
      .catch(console.error);
  }, [agent.id]);

  // On mount: check if an autonomous run is already in progress and reconnect to it.
  // Poll autonomous status — refresh every 8s when a run is active, 30s otherwise.
  useEffect(() => {
    const fetchStatus = async () => {
      const status = await api.getAutonomousStatus(agent.id).catch(() => null);
      if (!status) return;
      setAutonomousStatus(status);

      // First fetch: if there's a live run and we haven't reconnected yet, reattach
      if (!hasReconnectedRef.current && status.latestRun?.status === 'running') {
        hasReconnectedRef.current = true;
        const runId = status.latestRun.id;
        setActiveRunId(runId);
        setAutonomousRunning(true);

        // Load existing messages from the run so user sees what happened before reconnect
        try {
          const msgs = await api.getMessages(runId);
          const evts: SseEvent[] = [];
          for (const msg of msgs) {
            const content = (() => { try { return JSON.parse(msg.content); } catch { return msg.content; } })();
            if (msg.role === 'user' && typeof content === 'string') {
              // Wake-up prompts start with this marker — render as a collapsible context panel
              if (content.startsWith('Continuous autonomous run started at ')) {
                evts.push({ type: 'wake_up_context', content });
              } else {
                evts.push({ type: 'message', role: 'user', content });
              }
            } else if (msg.role === 'assistant') {
              // Extract tool_use blocks first so ⚡ headers render before the result lines
              if (Array.isArray(content)) {
                for (const block of content as Array<{ type: string; id?: string; name?: string; input?: unknown }>) {
                  if (block.type === 'tool_use') {
                    evts.push({ type: 'tool_call', toolName: block.name, input: block.input, correlationId: block.id, source: 'manager' });
                  }
                }
              }
              const evt: SseEvent = { type: 'message', role: 'assistant', content, source: 'manager' };
              if (!isSuppressed(evt, agent.suppressionToken)) evts.push(evt);
            } else if (msg.role === 'tool_result') {
              const blocks = content as Array<{ type: string; tool_use_id: string; content: string }>;
              for (const b of blocks) {
                evts.push({ type: 'tool_result', correlationId: b.tool_use_id, result: b.content, source: 'manager' });
              }
            }
          }
          if (evts.length > 0) setEvents(evts);
        } catch { /* ignore, we'll still get live events */ }

        // Subscribe to live SSE stream
        unsubRef.current?.();
        unsubRef.current = api.subscribeToRun(runId, (event) => {
          if (event.type === 'open_flow_generator') {
            setAutonomousRunning(false);
            setActiveRunId(null);
            navigate(`/agents/${agent.id}/flows`, {
              state: { openGenerator: true, prefillMessage: event.prompt ?? '', autoApply: true, returnTo: `/agents/${agent.id}/chat` },
            });
            return;
          }
          if (event.type === 'done' || event.type === 'error') {
            setAutonomousRunning(false);
            setActiveRunId(null);
            setRuns((prev) => prev.map((r) => r.id === runId ? { ...r, status: event.type === 'done' ? 'completed' : 'failed' } : r));
          }
          if (event.type !== 'done' && !isSuppressed(event, agent.suppressionToken)) {
            setEvents((prev) => [...prev, event]);
          }
        });
      }
    };

    void fetchStatus();
    const interval = setInterval(() => { void fetchStatus(); }, autonomousRunning ? 8000 : 30000);
    statusPollRef.current = interval;
    return () => { clearInterval(interval); };
  }, [agent.id, agent.suppressionToken, autonomousRunning, navigate]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const loadRunMessages = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setActiveRunId(null);
    try {
      const msgs = await api.getMessages(runId);
      const evts: SseEvent[] = [];
      for (const msg of msgs) {
        const content = JSON.parse(msg.content);
        if (msg.role === 'user' && typeof content === 'string') {
          if (content.startsWith('Continuous autonomous run started at ')) {
            evts.push({ type: 'wake_up_context', content });
          } else {
            evts.push({ type: 'message', role: 'user', content });
          }
        } else if (msg.role === 'assistant') {
          // Extract tool_use blocks first so ⚡ headers render before the result lines
          if (Array.isArray(content)) {
            for (const block of content as Array<{ type: string; id?: string; name?: string; input?: unknown }>) {
              if (block.type === 'tool_use') {
                evts.push({ type: 'tool_call', toolName: block.name, input: block.input, correlationId: block.id, source: 'manager' });
              }
            }
          }
          const evt: SseEvent = { type: 'message', role: 'assistant', content, source: 'manager' };
          if (!isSuppressed(evt, agent.suppressionToken)) evts.push(evt);
        } else if (msg.role === 'tool_result') {
          const blocks = content as Array<{ type: string; tool_use_id: string; content: string }>;
          for (const b of blocks) {
            evts.push({ type: 'tool_result', correlationId: b.tool_use_id, result: b.content, source: 'manager' });
          }
        }
      }
      setEvents(evts);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const handleRun = async () => {
    if (!input.trim() || chatRunning) return;
    const userInput = input.trim();
    setInput('');
    setSelectedRunId(null);

    // Append user message to existing thread immediately (never replace)
    setEvents((prev) => [...prev, { type: 'message', role: 'user', content: userInput }]);

    // If autonomous is running, use the nudge endpoint so the message is injected
    // directly into the live loop rather than creating a parallel run.
    if (autonomousRunning) {
      try {
        await api.nudgeAgent(agent.id, userInput);
      } catch (err) {
        setEvents((prev) => [...prev, { type: 'error', message: err instanceof Error ? err.message : String(err) }]);
      }
      return;
    }

    setChatRunning(true);

    try {
      const { runId } = await api.createRun(agent.id, userInput);
      setActiveRunId(runId);
      setRuns((prev) => [{ id: runId, agentId: agent.id, status: 'running', trigger: 'manual', input: userInput, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ...prev]);

      unsubRef.current?.();
      unsubRef.current = api.subscribeToRun(runId, (event) => {
        if (event.type === 'open_flow_generator') {
          setChatRunning(false);
          setActiveRunId(null);
          navigate(`/agents/${agent.id}/flows`, {
            state: {
              openGenerator: true,
              prefillMessage: event.prompt ?? '',
              autoApply: true,
              returnTo: `/agents/${agent.id}/chat`,
            },
          });
          return;
        }
        if (event.type === 'done' || event.type === 'error') {
          setChatRunning(false);
          setActiveRunId(null);
          setRuns((prev) => prev.map((r) => r.id === runId ? { ...r, status: event.type === 'done' ? 'completed' : 'failed' } : r));
        }
        if (event.type !== 'done' && !isSuppressed(event, agent.suppressionToken)) {
          setEvents((prev) => [...prev, event]);
        }
      });
    } catch (err) {
      setChatRunning(false);
      setEvents((prev) => [...prev, { type: 'error', message: err instanceof Error ? err.message : String(err) }]);
    }
  };

  const handleStop = async () => {
    if (!activeRunId) return;
    await api.stopRun(activeRunId).catch(console.error);
  };

  const handleWakeUp = async () => {
    if (running) return;
    setSelectedRunId(null);
    setAutonomousRunning(true);

    // Collect the last 10 conversational messages from the current thread to brief the agent.
    // Skip tool_call/tool_result/error events — only include human-readable exchanges.
    const recentMessages = events
      .filter((e) => e.type === 'message' && (e.role === 'user' || e.role === 'assistant'))
      .filter((e) => {
        // Skip the autonomous separator markers
        if (typeof e.content === 'string' && e.content.includes('Autonomous session started')) return false;
        return true;
      })
      .slice(-10)
      .map((e) => {
        // Flatten assistant content blocks to plain text
        let text = '';
        if (typeof e.content === 'string') {
          text = e.content;
        } else if (Array.isArray(e.content)) {
          text = (e.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text!)
            .join('\n');
        }
        return { role: e.role as 'user' | 'assistant', content: text };
      })
      .filter((m) => m.content.trim().length > 0);

    // Append a separator into the existing thread rather than replacing it
    setEvents((prev) => [
      ...prev,
      { type: 'message', role: 'user', content: '─── 🟢 Autonomous session started ───' },
    ]);

    try {
      const { runId } = await api.wakeUp(
        agent.id,
        budgetUsdPerHour > 0 ? budgetUsdPerHour : undefined,
        recentMessages.length > 0 ? recentMessages : undefined,
      );
      setActiveRunId(runId);
      setRuns((prev) => [
        {
          id: runId,
          agentId: agent.id,
          status: 'running',
          trigger: 'autonomous',
          input: '__wake_up__',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        ...prev,
      ]);

      unsubRef.current?.();
      unsubRef.current = api.subscribeToRun(runId, (event) => {
        if (event.type === 'open_flow_generator') {
          setAutonomousRunning(false);
          setActiveRunId(null);
          navigate(`/agents/${agent.id}/flows`, {
            state: {
              openGenerator: true,
              prefillMessage: event.prompt ?? '',
              autoApply: true,
              returnTo: `/agents/${agent.id}/chat`,
            },
          });
          return;
        }
        if (event.type === 'done' || event.type === 'error') {
          setAutonomousRunning(false);
          setActiveRunId(null);
          setRuns((prev) =>
            prev.map((r) =>
              r.id === runId
                ? { ...r, status: event.type === 'done' ? 'completed' : 'failed' }
                : r,
            ),
          );
        }
        if (event.type !== 'done' && !isSuppressed(event, agent.suppressionToken)) {
          setEvents((prev) => [...prev, event]);
        }
      });
    } catch (err) {
      setAutonomousRunning(false);
      setEvents((prev) => [
        ...prev,
        { type: 'error', message: err instanceof Error ? err.message : String(err) },
      ]);
    }
  };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 100px)' }}>
      {/* Run history sidebar */}
      <div style={{
        width: 200,
        borderRight: '1px solid var(--border)',
        overflowY: 'auto',
        padding: '0.75rem 0',
        flexShrink: 0,
      }}>
        <div style={{ padding: '0 0.75rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase' }}>History</span>
          <button
            onClick={() => { setEvents([]); setSelectedRunId(null); }}
            title="New conversation"
            style={{
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: '1rem',
              lineHeight: 1,
              padding: '0 0.3rem',
              display: 'flex',
              alignItems: 'center',
            }}
          >+</button>
        </div>
        {/* "Live thread" entry — clicking it returns to the full conversation view */}
        <div
          onClick={() => { setSelectedRunId(null); api.getConversation(agent.id).then((msgs) => {
            const evts: SseEvent[] = [];
            for (const msg of msgs) {
              const content = (() => { try { return JSON.parse(msg.content); } catch { return msg.content; } })();
              if (msg.role === 'user' && typeof content === 'string') {
                if (content.startsWith('Continuous autonomous run started at ')) {
                  evts.push({ type: 'wake_up_context', content });
                } else {
                  evts.push({ type: 'message', role: 'user', content });
                }
              } else if (msg.role === 'assistant') {
                // Extract tool_use blocks first so ⚡ headers render before the result lines
                if (Array.isArray(content)) {
                  for (const block of content as Array<{ type: string; id?: string; name?: string; input?: unknown }>) {
                    if (block.type === 'tool_use') {
                      evts.push({ type: 'tool_call', toolName: block.name, input: block.input, correlationId: block.id, source: 'manager' });
                    }
                  }
                }
                const evt: SseEvent = { type: 'message', role: 'assistant', content, source: 'manager' };
                if (!isSuppressed(evt, agent.suppressionToken)) evts.push(evt);
              } else if (msg.role === 'tool_result') {
                const blocks = content as Array<{ type: string; tool_use_id: string; content: string }>;
                for (const b of blocks) {
                  evts.push({ type: 'tool_result', correlationId: b.tool_use_id, result: b.content, source: 'manager' });
                }
              }
            }
            setEvents(evts);
          }).catch(console.error); }}
          style={{
            padding: '0.55rem 0.75rem',
            cursor: 'pointer',
            fontSize: '0.78rem',
            borderLeft: `3px solid ${selectedRunId === null ? 'var(--accent)' : 'transparent'}`,
            background: selectedRunId === null ? 'rgba(255,255,255,0.06)' : 'transparent',
            marginBottom: '0.25rem',
          }}
        >
          <div style={{ color: 'var(--text)', fontWeight: 600, opacity: 0.85 }}>💬 Current thread</div>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', margin: '0.25rem 0 0.4rem' }} />
        {runs.map((run) => (
          <div
            key={run.id}
            onClick={() => void loadRunMessages(run.id)}
            style={{
              padding: '0.55rem 0.75rem',
              cursor: 'pointer',
              fontSize: '0.78rem',
              borderLeft: `3px solid ${selectedRunId === run.id ? 'var(--accent)' : 'transparent'}`,
              background: selectedRunId === run.id ? 'rgba(255,255,255,0.06)' : 'transparent',
              transition: 'background 0.1s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginBottom: '0.15rem' }}>
              <span style={{ color: statusColor(run.status), fontSize: '0.7rem' }}>{statusIcon(run.status)}</span>
              <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{new Date(run.createdAt).toLocaleTimeString()}</span>
            </div>
            <div style={{ color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.8 }}>
              {run.trigger === 'autonomous' ? '🟢 autonomous' : run.trigger === 'schedule' ? '⏱ scheduled' : run.input.slice(0, 28)}
            </div>
          </div>
        ))}
      </div>

      {/* Main chat area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Autonomous status banner */}
        {autonomousStatus?.currentTask && (
          <div style={{
            background: autonomousStatus.latestRun?.status === 'running'
              ? 'linear-gradient(90deg, rgba(35,134,54,0.15) 0%, rgba(35,134,54,0.06) 100%)'
              : 'rgba(255,255,255,0.03)',
            borderBottom: '1px solid var(--border)',
            borderLeft: `3px solid ${autonomousStatus.latestRun?.status === 'running' ? '#238636' : 'var(--border)'}`,
            padding: '0.6rem 1rem',
            fontSize: '0.8rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', minWidth: 0 }}>
              <span style={{ fontSize: '0.7rem', marginTop: '0.1rem', flexShrink: 0, opacity: autonomousStatus.latestRun?.status === 'running' ? 1 : 0.5 }}>
                {autonomousStatus.latestRun?.status === 'running' ? '🟢' : '⚪'}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--muted)', fontSize: '0.72rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {autonomousStatus.latestRun?.status === 'running' ? 'Working on' : 'Last task'}
                  </span>
                  <span style={{ color: 'var(--text)', fontWeight: 500 }}>{autonomousStatus.currentTask}</span>
                </div>
                {autonomousStatus.plan && (
                  <div style={{ color: 'var(--muted)', marginTop: '0.25rem', whiteSpace: 'pre-wrap', fontSize: '0.75rem', lineHeight: 1.5 }}>
                    {autonomousStatus.plan}
                  </div>
                )}
                {autonomousStatus.statusUpdatedAt && (
                  <div style={{ color: 'var(--muted)', fontSize: '0.68rem', marginTop: '0.2rem', opacity: 0.7 }}>
                    updated {new Date(autonomousStatus.statusUpdatedAt).toLocaleTimeString()}
                  </div>
                )}
              </div>
            </div>
            {/* Session cost */}
            {(autonomousStatus.latestRun?.costUsd ?? 0) > 0 && (
              <div style={{ textAlign: 'right', flexShrink: 0, background: 'rgba(0,0,0,0.2)', borderRadius: 6, padding: '0.25rem 0.6rem' }}>
                <div style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '0.85rem' }}>
                  ${(autonomousStatus.latestRun!.costUsd!).toFixed(4)}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: '0.68rem' }}>
                  {((autonomousStatus.latestRun!.inputTokens ?? 0) + (autonomousStatus.latestRun!.outputTokens ?? 0)).toLocaleString()} tok
                </div>
              </div>
            )}
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {events.length === 0 && !running && (
            <div style={{ textAlign: 'center', color: 'var(--muted)', marginTop: '5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.75rem', opacity: 0.4 }}>✦</div>
              <p style={{ fontSize: '1rem', marginBottom: '0.35rem', color: 'var(--text)', opacity: 0.6 }}>Ready to run</p>
              <p style={{ fontSize: '0.8rem', opacity: 0.5 }}>Send a message or press Wake Up for autonomous mode</p>
            </div>
          )}
          {events.length === 0 && autonomousRunning && (
            <div style={{ textAlign: 'center', color: 'var(--muted)', marginTop: '5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.75rem', color: '#3fb950', opacity: 0.7 }}>🟢</div>
              <p style={{ fontSize: '1rem', marginBottom: '0.35rem', color: 'var(--text)', opacity: 0.6 }}>Autonomous session in progress</p>
              <p style={{ fontSize: '0.8rem', opacity: 0.5 }}>Reconnected — new events will appear here</p>
            </div>
          )}
          {events.map((event, i) => <MessageBubble key={i} event={event} flowIdByName={flowIdByName} />)}
          {running && (
            <div style={{
              color: 'var(--muted)',
              fontSize: '0.8rem',
              alignSelf: 'flex-start',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.4rem 0.75rem',
              background: 'rgba(255,255,255,0.04)',
              borderRadius: 20,
              border: '1px solid var(--border)',
            }}>
              <span style={{ color: '#3fb950', animation: 'pulse 1.2s ease-in-out infinite', fontSize: '0.6rem' }}>●</span>
              Agent is thinking…
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div style={{
          borderTop: '1px solid var(--border)',
          padding: '1rem',
          display: 'flex',
          gap: '0.75rem',
          background: 'var(--surface)',
        }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleRun();
              }
            }}
            placeholder={autonomousRunning ? 'Send a nudge to steer the agent… (Enter to send)' : 'Enter your message... (Enter to send, Shift+Enter for newline)'}
            rows={2}
            disabled={chatRunning}
            style={{
              flex: 1,
              background: 'var(--bg)',
              border: `1px solid ${autonomousRunning ? '#238636' : 'var(--border)'}`,
              borderRadius: 6,
              color: 'var(--text)',
              padding: '0.5rem 0.75rem',
              fontSize: '0.9rem',
              resize: 'none',
              opacity: chatRunning ? 0.6 : 1,
            }}
          />
          {running ? (
            <>
              <button
                onClick={() => void handleStop()}
                style={btnStyle('#da3633')}
              >
                ■ Stop
              </button>
              {/* During autonomous run, allow nudging without stopping */}
              {autonomousRunning && !chatRunning && (
                <button
                  onClick={() => void handleRun()}
                  disabled={!input.trim()}
                  title="Send a nudge — injected directly into the running autonomous session"
                  style={btnStyle('#1f6feb', !input.trim())}
                >
                  Send
                </button>
              )}
            </>
          ) : (
            <>
              {/* Wake Up group: budget selector fused with button */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.2rem', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <label style={{ fontSize: '0.72rem', color: '#8b949e', whiteSpace: 'nowrap' }}>
                    Hourly spend limit:
                  </label>
                  <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #238636' }}>
                    <select
                      value={String(budgetUsdPerHour)}
                      onChange={(e) => setBudgetUsdPerHour(Number(e.target.value))}
                      title="Hourly spend limit — the agent will pause if it exceeds this amount in an hour. Select 'No limit' to run uncapped."
                      style={{
                        background: '#0d1f0d',
                        color: '#3fb950',
                        border: 'none',
                        borderRight: '1px solid #238636',
                        padding: '0 0.5rem',
                        fontSize: '0.78rem',
                        cursor: 'pointer',
                        outline: 'none',
                        fontWeight: 500,
                      }}
                    >
                      <option value="0">No limit</option>
                      <option value="5">$5 / hr</option>
                      <option value="1">$1 / hr</option>
                      <option value="0.25">$0.25 / hr</option>
                    </select>
                    <button
                      onClick={() => void handleWakeUp()}
                      title="Wake Up — agent autonomously reviews its state, runs flows, creates schedules, and reflects (uses Haiku)"
                      style={{
                        background: '#238636',
                        color: '#fff',
                        border: 'none',
                        padding: '0.5rem 0.9rem',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        whiteSpace: 'nowrap',
                        letterSpacing: '0.01em',
                      }}
                    >
                      🟢 Wake Up
                    </button>
                  </div>
                </div>
                <span style={{ fontSize: '0.68rem', color: '#6e7681' }}>
                  {budgetUsdPerHour > 0
                    ? 'The agent will pause if it exceeds this amount in an hour.'
                    : 'The agent will run uncapped. Set a limit to control spend.'}
                </span>
              </div>
              <button
                onClick={() => void handleRun()}
                disabled={!input.trim()}
                style={btnStyle('#1f6feb', !input.trim())}
              >
                Send
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function isSuppressed(event: SseEvent, token?: string | null): boolean {
  if (!token) return false;
  if (event.type !== 'message' || event.role !== 'assistant') return false;
  const content = event.content;
  if (typeof content === 'string') return content.trim() === token;
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type: 'text'; text: string } => typeof b === 'object' && b !== null && (b as { type: string }).type === 'text')
      .map((b) => b.text)
      .join('');
    return text.trim() === token;
  }
  return false;
}

function statusColor(status: string) {
  switch (status) {
    case 'completed': return 'var(--success)';
    case 'failed': return 'var(--error)';
    case 'running': return 'var(--accent)';
    default: return 'var(--muted)';
  }
}

function statusIcon(status: string) {
  switch (status) {
    case 'completed': return '✓';
    case 'failed': return '✗';
    case 'running': return '●';
    default: return '○';
  }
}

function triggerIcon(trigger: string) {
  switch (trigger) {
    case 'autonomous': return '🟢';
    case 'schedule': return '⏱';
    case 'telegram': return '✈';
    default: return '';
  }
}

function btnStyle(bg: string, disabled?: boolean): React.CSSProperties {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '0.5rem 1.25rem',
    fontSize: '0.9rem',
    fontWeight: 500,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    alignSelf: 'flex-end',
  };
}
