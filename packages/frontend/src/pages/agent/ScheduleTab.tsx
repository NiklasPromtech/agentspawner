import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Schedule, Flow } from '../../types/index.js';
import CronEditor from '../../components/CronEditor.js';
import TabLayout from '../../components/TabLayout.js';
import { formatFlowName } from '../../utils/formatFlowName.js';

interface Props {
  agent: Agent;
}

export default function ScheduleTab({ agent }: Props) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ cron: string; input: string; enabled: boolean; timezone: string; flowId: string | null }>({
    cron: '0 9 * * *', input: '', enabled: true, timezone: 'Europe/Stockholm', flowId: null,
  });

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getSchedules(agent.id),
      api.getFlows(agent.id),
    ])
      .then(([s, f]) => { setSchedules(s); setFlows(f); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [agent.id]);

  const handleCreate = async () => {
    try {
      const s = await api.createSchedule(agent.id, form);
      setSchedules((prev) => [...prev, s]);
      setCreating(false);
      setForm({ cron: '0 9 * * *', input: '', enabled: true, timezone: 'Europe/Stockholm', flowId: null });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create schedule');
    }
  };

  const handleToggle = async (schedule: Schedule) => {
    try {
      const updated = await api.updateSchedule(agent.id, schedule.id, { enabled: !schedule.enabled });
      setSchedules((prev) => prev.map((s) => s.id === schedule.id ? updated : s));
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (scheduleId: string) => {
    if (!confirm('Delete this schedule?')) return;
    await api.deleteSchedule(agent.id, scheduleId);
    setSchedules((prev) => prev.filter((s) => s.id !== scheduleId));
  };

  return (
    <TabLayout
      title="Schedules"
      description="Run flows or send messages to the agent automatically on a recurring timer."
      loading={loading}
      error={error}
      onRetry={load}
      isEmpty={!loading && schedules.length === 0 && !creating}
      emptyState={{
        icon: '🕐',
        title: 'No schedules configured',
        description: 'Create a schedule to run flows automatically on a timer — daily posts, weekly reports, recurring tasks, and more.',
        actions: [{ label: '+ Add Schedule', onClick: () => setCreating(true), variant: 'primary' }],
      }}
      actions={[{ label: creating ? 'Cancel' : '+ Add Schedule', onClick: () => setCreating(!creating), variant: creating ? 'secondary' : 'primary' }]}
    >
      {creating && (
        <div style={card}>
          <h4 style={{ marginBottom: '1rem', fontSize: '0.9rem', fontWeight: 600, margin: '0 0 1rem' }}>New Schedule</h4>
          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>Cron Expression</label>
            <CronEditor value={form.cron} onChange={(v) => setForm((f) => ({ ...f, cron: v }))} />
          </div>
          {flows.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Trigger</label>
              <select
                value={form.flowId ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, flowId: e.target.value || null }))}
                style={selectStyle}
              >
                <option value="">Agent Chat (send message)</option>
                {flows.map((fl) => (
                  <option key={fl.id} value={fl.id}>Flow: {formatFlowName(fl.name)}</option>
                ))}
              </select>
            </div>
          )}
          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>{form.flowId ? 'Flow Input (JSON)' : 'Input Message'}</label>
            <textarea
              value={form.input}
              onChange={(e) => setForm((f) => ({ ...f, input: e.target.value }))}
              rows={3}
              placeholder={form.flowId ? '{"key": "value"}' : 'Message to send to the agent...'}
              style={textarea}
            />
            {form.flowId && (
              <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
                JSON object passed as flow-level input at fire time.
              </p>
            )}
          </div>
          <button onClick={() => void handleCreate()} style={primaryBtn}>Create Schedule</button>
        </div>
      )}

      {schedules.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {schedules.map((s) => (
            <div key={s.id} style={{ ...card, opacity: s.enabled ? 1 : 0.6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <code style={{ fontSize: '0.9rem', color: 'var(--accent)', display: 'block', marginBottom: '0.25rem' }}>{s.cron}</code>
                  <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.25rem' }}>{s.timezone}</p>
                  {s.flowId && (
                    <p style={{ fontSize: '0.8rem', color: '#58a6ff', marginBottom: '0.25rem' }}>
                      Flow: {formatFlowName(flows.find((f) => f.id === s.flowId)?.name ?? s.flowId)}
                    </p>
                  )}
                  {s.input && <p style={{ fontSize: '0.85rem', color: 'var(--text)' }}>"{s.input.slice(0, 80)}"</p>}
                  {s.lastRunAt && (
                    <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
                      Last run: {new Date(s.lastRunAt).toLocaleString()}
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0, marginLeft: '1rem' }}>
                  <button onClick={() => void handleToggle(s)} style={actionBtn}>
                    {s.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button onClick={() => void handleDelete(s.id)} style={{ ...actionBtn, color: 'var(--error)' }}>
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </TabLayout>
  );
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.25rem', marginBottom: '1rem' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.4rem' };
const textarea: React.CSSProperties = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.9rem', resize: 'vertical' };
const selectStyle: React.CSSProperties = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '0.5rem 0.75rem', fontSize: '0.9rem', width: '100%' };
const primaryBtn: React.CSSProperties = { background: '#238636', color: '#fff', border: 'none', borderRadius: 6, padding: '0.5rem 1rem', fontSize: '0.875rem', cursor: 'pointer' };
const actionBtn: React.CSSProperties = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', padding: '0.3rem 0.75rem', fontSize: '0.8rem', cursor: 'pointer' };
