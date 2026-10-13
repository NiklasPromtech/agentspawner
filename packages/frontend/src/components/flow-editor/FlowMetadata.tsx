import { card, sectionTitle, labelStyle, inputFull, inputStyle } from './styles.js';
import type { FlowDraft } from '../../hooks/useFlowEditorState.js';

type MetadataProps = Pick<FlowDraft,
  'name' | 'description' | 'flowType' | 'readsFrom' | 'writesTo' | 'updatesFields' | 'requiresApproval'
>;

interface Props extends MetadataProps {
  onUpdate: (patch: Partial<FlowDraft>) => void;
}

export function FlowMetadata({ name, description, flowType, readsFrom, writesTo, updatesFields, requiresApproval, onUpdate }: Props) {
  return (
    <>
      {/* Metadata */}
      <section style={card}>
        <h4 style={sectionTitle}>Metadata</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
          <div>
            <label style={labelStyle}>Name (snake_case)</label>
            <input value={name} onChange={(e) => onUpdate({ name: e.target.value })} placeholder="my_flow" style={inputFull} />
          </div>
          <div>
            <label style={labelStyle}>Description</label>
            <input value={description} onChange={(e) => onUpdate({ description: e.target.value })} placeholder="What this flow does" style={inputFull} />
          </div>
        </div>
        <div style={{ marginBottom: '1rem' }}>
          <label style={labelStyle}>Flow Type</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {(['scrape', 'action', null] as const).map((t) => (
              <button
                key={String(t)}
                type="button"
                onClick={() => {
                  const patch: Partial<FlowDraft> = { flowType: t };
                  if (t !== 'action') {
                    patch.dedupKeyField = '';
                    patch.dedupBreakType = null;
                    patch.dedupIntervalHours = '';
                    patch.dedupBlockMessage = '';
                  }
                  onUpdate(patch);
                }}
                style={{
                  padding: '0.3rem 0.75rem',
                  borderRadius: 5,
                  fontSize: '0.8rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  border: `1px solid ${flowType === t ? (t === 'action' ? '#f85149' : t === 'scrape' ? 'var(--accent)' : 'var(--border)') : 'var(--border)'}`,
                  background: flowType === t ? (t === 'action' ? 'rgba(248,81,73,0.12)' : t === 'scrape' ? 'rgba(88,166,255,0.12)' : 'rgba(255,255,255,0.06)') : 'transparent',
                  color: flowType === t ? (t === 'action' ? '#f85149' : t === 'scrape' ? 'var(--accent)' : 'var(--text)') : 'var(--muted)',
                }}
              >
                {t === 'action' ? '⚡ action' : t === 'scrape' ? '🔍 scrape' : 'unset'}
              </button>
            ))}
          </div>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.4rem' }}>
            {flowType === 'action' ? 'Action flows have side effects (DM, post, follow). They must have a guard step and support deduplication.' : flowType === 'scrape' ? 'Scrape flows are read-only. Safe to repeat — no deduplication needed.' : 'Set the type so the agent knows how to use this flow safely.'}
          </p>
        </div>

        {/* Human approval toggle — action flows only */}
        {flowType === 'action' && (
          <div style={{ paddingTop: '0.75rem', borderTop: '1px solid rgba(248,81,73,0.2)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={requiresApproval}
                onChange={(e) => onUpdate({ requiresApproval: e.target.checked })}
                style={{ width: 16, height: 16, accentColor: '#f85149', cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Require human approval before execution</span>
            </label>
            <p style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.3rem', marginLeft: '1.5rem' }}>
              When enabled, calling this flow queues a pending entry in Review Actions instead of executing immediately. A human must approve it before it runs. Use for high-risk irreversible actions (send DM, post, delete).
            </p>
          </div>
        )}
      </section>

      {/* Table Metadata */}
      <section style={card}>
        <h4 style={sectionTitle}>Table Metadata <span style={{ fontWeight: 400, textTransform: 'none', fontSize: '0.8rem' }}>(optional)</span></h4>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1rem' }}>
          Declare which tables this flow reads from and writes to. Used by the agent to understand data flow and auto-generate DB schema.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <div>
            <label style={labelStyle}>Reads From <span style={{ fontWeight: 400 }}>(table name)</span></label>
            <input value={readsFrom} onChange={(e) => onUpdate({ readsFrom: e.target.value })} placeholder="e.g. contacts" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Writes To <span style={{ fontWeight: 400 }}>(table name)</span></label>
            <input value={writesTo} onChange={(e) => onUpdate({ writesTo: e.target.value })} placeholder="e.g. contacts, action_log" style={inputStyle} />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Updates Fields <span style={{ fontWeight: 400 }}>(comma-separated)</span></label>
          <input
            value={updatesFields}
            onChange={(e) => onUpdate({ updatesFields: e.target.value })}
            placeholder="e.g. status, last_action, last_action_at"
            style={inputStyle}
          />
          <p style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
            Which fields does this flow write? Helps the agent understand what changes after running it.
          </p>
        </div>
      </section>
    </>
  );
}
