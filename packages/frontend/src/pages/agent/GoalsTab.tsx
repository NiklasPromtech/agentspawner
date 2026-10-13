import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';
import type { Agent, Goal } from '../../types/index.js';
import TabLayout from '../../components/TabLayout.js';

interface Props {
  agent: Agent;
}

const TYPE_ORDER: Goal['type'][] = ['mission', 'objective', 'task'];

const TYPE_STYLE: Record<Goal['type'], { label: string; color: string; bg: string }> = {
  mission:   { label: 'Mission',   color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  objective: { label: 'Objective', color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
  task:      { label: 'Task',      color: '#6b7280', bg: 'rgba(107,114,128,0.10)' },
};

const STATUS_STYLE: Record<Goal['status'], { label: string; color: string; icon: string }> = {
  pending:     { label: 'Pending',     color: '#6b7280', icon: '○' },
  in_progress: { label: 'In Progress', color: '#3b82f6', icon: '◉' },
  completed:   { label: 'Completed',   color: '#22c55e', icon: '✓' },
  blocked:     { label: 'Blocked',     color: '#ef4444', icon: '✗' },
  cancelled:   { label: 'Cancelled',   color: '#9ca3af', icon: '⊘' },
};

const PRIORITY_STYLE: Record<number, { label: string; color: string }> = {
  1: { label: 'Critical', color: '#ef4444' },
  2: { label: 'High',     color: '#f97316' },
  3: { label: 'Normal',   color: '#6b7280' },
  4: { label: 'Low',      color: '#9ca3af' },
};

function blankGoal(): Partial<Goal> & { title: string } {
  return { title: '', type: 'task', description: '', priority: 3, dueDate: null };
}

export default function GoalsTab({ agent }: Props) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Create / Edit form
  const [editing, setEditing] = useState<(Partial<Goal> & { title: string }) | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Expanded notes
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.getGoals(agent.id)
      .then(setGoals)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [agent.id]);

  useEffect(() => { load(); }, [load]);

  const visible = showAll
    ? goals
    : goals.filter((g) => g.status !== 'completed' && g.status !== 'cancelled');

  const byType = TYPE_ORDER.reduce<Record<string, Goal[]>>((acc, t) => {
    acc[t] = visible.filter((g) => g.type === t);
    return acc;
  }, {} as Record<string, Goal[]>);

  const handleSave = async () => {
    if (!editing || !editing.title.trim()) return;
    setSaving(true);
    setFormError('');
    try {
      if (editingId) {
        await api.updateGoal(agent.id, editingId, editing);
      } else {
        await api.createGoal(agent.id, editing as Partial<Goal> & { title: string });
      }
      setEditing(null);
      setEditingId(null);
      load();
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (goalId: string, title: string) => {
    if (!confirm(`Delete goal "${title}"?`)) return;
    try {
      await api.deleteGoal(agent.id, goalId);
      setGoals((prev) => prev.filter((g) => g.id !== goalId));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const handleStatusChange = async (goal: Goal, newStatus: Goal['status']) => {
    try {
      await api.updateGoal(agent.id, goal.id, { status: newStatus });
      setGoals((prev) => prev.map((g) => g.id === goal.id ? { ...g, status: newStatus } : g));
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const openEdit = (goal: Goal) => {
    setEditingId(goal.id);
    setEditing({ title: goal.title, type: goal.type, description: goal.description, priority: goal.priority, dueDate: goal.dueDate ?? null, notes: goal.notes, parentId: goal.parentId ?? null });
    setFormError('');
  };

  const openCreate = (type?: Goal['type']) => {
    setEditingId(null);
    setEditing({ ...blankGoal(), type: type ?? 'task' });
    setFormError('');
  };

  const completedCount = goals.filter((g) => g.status === 'completed').length;
  const activeCount = goals.filter((g) => g.status !== 'completed' && g.status !== 'cancelled').length;

  const parentOptions = goals.filter((g) => g.id !== editingId && (editing?.type === 'task' ? g.type !== 'task' : g.type === 'mission'));

  return (
    <TabLayout
      title="Goals"
      description={goals.length > 0 ? `${activeCount} active · ${completedCount} completed` : 'Define the agent\'s mission, objectives, and tasks.'}
      loading={loading}
      error={error}
      onRetry={load}
      isEmpty={!loading && goals.length === 0 && !editing}
      emptyState={{
        icon: '🎯',
        title: 'No goals set',
        description: 'Goals guide the agent\'s autonomous behavior. Start with a Mission to define its purpose, then add Objectives and Tasks to break it down.',
        actions: TYPE_ORDER.map((t) => ({
          label: `+ ${TYPE_STYLE[t].label}`,
          onClick: () => openCreate(t),
          variant: 'secondary' as const,
        })),
      }}
      maxWidth={860}
      actions={[
        {
          label: showAll ? 'Hide done' : 'Show all',
          onClick: () => setShowAll((v) => !v),
          variant: 'secondary',
        },
        {
          label: '+ New Goal',
          onClick: () => openCreate('task'),
          variant: 'primary',
        },
      ]}
    >
      {/* Create / Edit form */}
      {editing && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '1.25rem', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600, margin: '0 0 1rem' }}>
            {editingId ? 'Edit Goal' : 'Create Goal'}
          </h3>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
            {/* Title */}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={fieldLabel}>Title *</label>
              <input
                value={editing.title ?? ''}
                onChange={(e) => setEditing((prev) => prev ? { ...prev, title: e.target.value } : prev)}
                placeholder="What needs to be done?"
                style={inputStyle}
              />
            </div>

            {/* Type */}
            <div>
              <label style={fieldLabel}>Type</label>
              <select
                value={editing.type ?? 'task'}
                onChange={(e) => setEditing((prev) => prev ? { ...prev, type: e.target.value as Goal['type'] } : prev)}
                style={selectStyle}
              >
                <option value="mission">Mission</option>
                <option value="objective">Objective</option>
                <option value="task">Task</option>
              </select>
            </div>

            {/* Priority */}
            <div>
              <label style={fieldLabel}>Priority</label>
              <select
                value={editing.priority ?? 3}
                onChange={(e) => setEditing((prev) => prev ? { ...prev, priority: parseInt(e.target.value) as Goal['priority'] } : prev)}
                style={selectStyle}
              >
                <option value={1}>1 — Critical</option>
                <option value={2}>2 — High</option>
                <option value={3}>3 — Normal</option>
                <option value={4}>4 — Low</option>
              </select>
            </div>

            {/* Parent */}
            {parentOptions.length > 0 && (
              <div>
                <label style={fieldLabel}>Parent Goal</label>
                <select
                  value={editing.parentId ?? ''}
                  onChange={(e) => setEditing((prev) => prev ? { ...prev, parentId: e.target.value || null } : prev)}
                  style={selectStyle}
                >
                  <option value="">— None —</option>
                  {parentOptions.map((g) => (
                    <option key={g.id} value={g.id}>{g.type}: {g.title}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Due date */}
            <div>
              <label style={fieldLabel}>Due Date</label>
              <input
                type="date"
                value={editing.dueDate ?? ''}
                onChange={(e) => setEditing((prev) => prev ? { ...prev, dueDate: e.target.value || null } : prev)}
                style={{ ...inputStyle, colorScheme: 'dark' }}
              />
            </div>

            {/* Description */}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={fieldLabel}>Description</label>
              <textarea
                value={editing.description ?? ''}
                onChange={(e) => setEditing((prev) => prev ? { ...prev, description: e.target.value } : prev)}
                rows={2}
                placeholder="Optional context, acceptance criteria, etc."
                style={textareaStyle}
              />
            </div>

            {/* Notes (only in edit mode) */}
            {editingId && (
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={fieldLabel}>Progress Notes</label>
                <textarea
                  value={(editing as Goal).notes ?? ''}
                  onChange={(e) => setEditing((prev) => prev ? { ...prev, notes: e.target.value } : prev)}
                  rows={3}
                  placeholder="Progress notes updated by the agent..."
                  style={textareaStyle}
                />
              </div>
            )}
          </div>

          {formError && <p style={{ color: '#ef4444', fontSize: '0.85rem', margin: '0 0 0.75rem' }}>{formError}</p>}

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleSave}
              disabled={saving || !editing.title.trim()}
              style={{ padding: '0.4rem 1.25rem', background: 'var(--accent)', border: 'none', borderRadius: 6, color: '#fff', fontSize: '0.85rem', fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving || !editing.title.trim() ? 0.5 : 1 }}
            >
              {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Goal'}
            </button>
            <button
              onClick={() => { setEditing(null); setEditingId(null); }}
              style={{ padding: '0.4rem 1rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', fontSize: '0.85rem', cursor: 'pointer' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Goal groups */}
      {visible.length === 0 && !editing ? (
        <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--muted)' }}>
          <p style={{ fontSize: '0.875rem' }}>
            {showAll ? 'No goals found.' : 'All goals are completed or cancelled.'}
          </p>
          {!showAll && (
            <button
              onClick={() => setShowAll(true)}
              style={{ marginTop: '0.5rem', fontSize: '0.82rem', padding: '0.3rem 0.75rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--muted)', cursor: 'pointer' }}
            >
              Show completed
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {TYPE_ORDER.map((type) => {
            const group = byType[type]!;
            if (group.length === 0) return null;
            const ts = TYPE_STYLE[type];
            return (
              <div key={type}>
                {/* Section header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: ts.color }}>{ts.label}s</span>
                  <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
                  <button
                    onClick={() => openCreate(type)}
                    style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', background: 'transparent', border: `1px solid ${ts.color}`, borderRadius: 5, color: ts.color, cursor: 'pointer' }}
                  >
                    + Add
                  </button>
                </div>

                {/* Goal cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {group
                    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
                    .map((goal) => {
                      const ss = STATUS_STYLE[goal.status];
                      const ps = PRIORITY_STYLE[goal.priority] ?? PRIORITY_STYLE[3]!;
                      const hasNotes = goal.notes && goal.notes.trim().length > 0;
                      const isExpanded = expanded[goal.id];

                      return (
                        <div
                          key={goal.id}
                          style={{
                            background: 'var(--surface)',
                            border: `1px solid var(--border)`,
                            borderLeft: `3px solid ${ss.color}`,
                            borderRadius: 8,
                            padding: '0.75rem 1rem',
                            opacity: goal.status === 'cancelled' ? 0.5 : 1,
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                            {/* Status toggle */}
                            <div style={{ position: 'relative', paddingTop: 2 }}>
                              <select
                                value={goal.status}
                                onChange={(e) => handleStatusChange(goal, e.target.value as Goal['status'])}
                                style={{
                                  appearance: 'none',
                                  background: 'transparent',
                                  border: 'none',
                                  color: ss.color,
                                  fontSize: '1.1rem',
                                  cursor: 'pointer',
                                  padding: 0,
                                  width: 20,
                                }}
                                title="Change status"
                              >
                                {Object.entries(STATUS_STYLE).map(([s, sv]) => (
                                  <option key={s} value={s}>{sv.icon} {sv.label}</option>
                                ))}
                              </select>
                            </div>

                            {/* Content */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <span style={{
                                  fontSize: '0.9rem',
                                  fontWeight: 600,
                                  textDecoration: goal.status === 'completed' || goal.status === 'cancelled' ? 'line-through' : 'none',
                                  color: goal.status === 'completed' || goal.status === 'cancelled' ? 'var(--muted)' : 'var(--text)',
                                }}>
                                  {goal.title}
                                </span>
                                {goal.priority <= 2 && (
                                  <span style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', borderRadius: 4, background: `${ps.color}22`, color: ps.color, fontWeight: 600 }}>
                                    {ps.label}
                                  </span>
                                )}
                                {goal.dueDate && (
                                  <span style={{ fontSize: '0.72rem', color: new Date(goal.dueDate) < new Date() && goal.status !== 'completed' ? '#ef4444' : 'var(--muted)' }}>
                                    📅 {goal.dueDate}
                                  </span>
                                )}
                              </div>

                              {goal.description && (
                                <p style={{ fontSize: '0.82rem', color: 'var(--muted)', margin: '0.25rem 0 0', lineHeight: 1.4 }}>
                                  {goal.description}
                                </p>
                              )}

                              {hasNotes && (
                                <div style={{ marginTop: '0.4rem' }}>
                                  <button
                                    onClick={() => setExpanded((prev) => ({ ...prev, [goal.id]: !prev[goal.id] }))}
                                    style={{ fontSize: '0.75rem', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                                  >
                                    {isExpanded ? '▾ Hide notes' : '▸ Agent notes'}
                                  </button>
                                  {isExpanded && (
                                    <pre style={{
                                      marginTop: '0.4rem',
                                      fontSize: '0.8rem',
                                      color: 'var(--muted)',
                                      background: 'var(--bg)',
                                      border: '1px solid var(--border)',
                                      borderRadius: 5,
                                      padding: '0.5rem 0.75rem',
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                      lineHeight: 1.5,
                                    }}>
                                      {goal.notes}
                                    </pre>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
                              <button
                                onClick={() => openEdit(goal)}
                                title="Edit"
                                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '0.85rem', padding: '0.2rem 0.4rem' }}
                              >
                                ✎
                              </button>
                              <button
                                onClick={() => handleDelete(goal.id, goal.title)}
                                title="Delete"
                                style={{ background: 'transparent', border: 'none', color: '#ef444480', cursor: 'pointer', fontSize: '0.85rem', padding: '0.2rem 0.4rem' }}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </TabLayout>
  );
}

const fieldLabel: React.CSSProperties = { fontSize: '0.78rem', color: 'var(--muted)', display: 'block', marginBottom: 4 };
const inputStyle: React.CSSProperties = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.5rem 0.75rem', color: 'var(--text)', fontSize: '0.9rem', boxSizing: 'border-box' };
const selectStyle: React.CSSProperties = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.5rem 0.75rem', color: 'var(--text)', fontSize: '0.9rem' };
const textareaStyle: React.CSSProperties = { width: '100%', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.5rem 0.75rem', color: 'var(--text)', fontSize: '0.9rem', resize: 'vertical', boxSizing: 'border-box' };
