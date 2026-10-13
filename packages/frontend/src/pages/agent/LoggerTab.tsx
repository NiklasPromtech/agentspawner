import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Run, Message } from '../../types/index.js';

interface Props {
  agent: Agent;
}

export default function LoggerTab({ agent }: Props) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [msgLoading, setMsgLoading] = useState(false);

  useEffect(() => {
    api.getRuns(agent.id).then(setRuns).catch(console.error).finally(() => setLoading(false));
  }, [agent.id]);

  const loadMessages = useCallback(async (run: Run) => {
    setSelectedRun(run);
    setMsgLoading(true);
    try {
      const msgs = await api.getMessages(run.id);
      setMessages(msgs);
    } catch (err) {
      console.error(err);
    } finally {
      setMsgLoading(false);
    }
  }, []);

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 100px)' }}>
      {/* Run list */}
      <div style={{ width: 260, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '0.75rem 0' }}>
        <div style={{ padding: '0 0.75rem', marginBottom: '0.5rem', fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase' }}>
          All Runs
        </div>
        {loading ? (
          <p style={{ padding: '0 0.75rem', color: 'var(--muted)', fontSize: '0.85rem' }}>Loading...</p>
        ) : runs.length === 0 ? (
          <p style={{ padding: '0 0.75rem', color: 'var(--muted)', fontSize: '0.85rem' }}>No runs yet</p>
        ) : runs.map((run) => (
          <div
            key={run.id}
            onClick={() => void loadMessages(run)}
            style={{
              padding: '0.6rem 0.75rem',
              cursor: 'pointer',
              borderLeft: `3px solid ${selectedRun?.id === run.id ? 'var(--accent)' : 'transparent'}`,
              background: selectedRun?.id === run.id ? 'var(--surface)' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem' }}>
              <span style={{ fontSize: '0.8rem', color: statusColor(run.status), fontWeight: 600 }}>
                {statusIcon(run.status)} {run.status}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{run.trigger}</span>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
              {new Date(run.createdAt).toLocaleString()}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text)', marginTop: '0.2rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {run.input.slice(0, 40)}
            </div>
            {run.error && (
              <div style={{ fontSize: '0.75rem', color: 'var(--error)', marginTop: '0.2rem' }}>
                {run.error.slice(0, 60)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Message detail */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
        {!selectedRun ? (
          <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--muted)' }}>
            <p>Select a run to view its messages</p>
          </div>
        ) : msgLoading ? (
          <p style={{ color: 'var(--muted)' }}>Loading messages...</p>
        ) : (
          <>
            <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border)', fontSize: '0.85rem' }}>
              <div><strong>Run ID:</strong> <code style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{selectedRun.id}</code></div>
              <div><strong>Status:</strong> <span style={{ color: statusColor(selectedRun.status) }}>{selectedRun.status}</span></div>
              <div><strong>Trigger:</strong> {selectedRun.trigger}</div>
              <div><strong>Created:</strong> {new Date(selectedRun.createdAt).toLocaleString()}</div>
              {selectedRun.error && <div style={{ color: 'var(--error)' }}><strong>Error:</strong> {selectedRun.error}</div>}
            </div>

            {messages.length === 0 ? (
              <p style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>No messages</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {messages.map((msg) => {
                  let content: unknown;
                  try { content = JSON.parse(msg.content); } catch { content = msg.content; }
                  return (
                    <div key={msg.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                      <div style={{ padding: '0.4rem 0.75rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                        <span style={{ fontWeight: 600, color: roleColor(msg.role) }}>{msg.role}</span>
                        <span style={{ color: 'var(--muted)' }}>{new Date(msg.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <pre style={{ padding: '0.75rem', margin: 0, fontSize: '0.8rem', color: 'var(--muted)', overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {JSON.stringify(content, null, 2)}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
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
  switch (status) { case 'completed': return '✓'; case 'failed': return '✗'; case 'running': return '●'; default: return '○'; }
}
function roleColor(role: string) {
  switch (role) { case 'user': return 'var(--accent)'; case 'assistant': return 'var(--success)'; default: return 'var(--warning)'; }
}
