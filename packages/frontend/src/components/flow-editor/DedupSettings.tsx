import { card, sectionTitle, labelStyle, inputStyle, textareaStyle } from './styles.js';
import type { FlowDraft } from '../../hooks/useFlowEditorState.js';

type DedupProps = Pick<FlowDraft,
  'dedupKeyField' | 'dedupBreakType' | 'dedupIntervalHours' | 'dedupBlockMessage'
>;

interface Props extends DedupProps {
  onUpdate: (patch: Partial<FlowDraft>) => void;
}

export function DedupSettings({ dedupKeyField, dedupBreakType, dedupIntervalHours, dedupBlockMessage, onUpdate }: Props) {
  return (
    <section style={{ ...card, borderColor: 'rgba(248,81,73,0.3)' }}>
      <h4 style={{ ...sectionTitle, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span>Deduplication</span>
        <span style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--muted)', textTransform: 'none', letterSpacing: 0 }}>
          Prevents the agent from running this action twice on the same target
        </span>
      </h4>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <label style={labelStyle}>Key Field</label>
          <input
            value={dedupKeyField}
            onChange={(e) => onUpdate({ dedupKeyField: e.target.value })}
            placeholder="e.g. user_id, post_id"
            style={inputStyle}
          />
          <p style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
            The input field that uniquely identifies the target of this action
          </p>
        </div>
        <div>
          <label style={labelStyle}>Break Type</label>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.1rem' }}>
            {(['hard', 'soft', null] as const).map((bt) => (
              <button
                key={String(bt)}
                type="button"
                onClick={() => onUpdate({ dedupBreakType: bt })}
                style={{
                  flex: 1,
                  padding: '0.4rem',
                  borderRadius: 5,
                  fontSize: '0.78rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  border: `1px solid ${dedupBreakType === bt ? (bt === 'hard' ? '#f85149' : bt === 'soft' ? '#e3b341' : 'var(--border)') : 'var(--border)'}`,
                  background: dedupBreakType === bt ? (bt === 'hard' ? 'rgba(248,81,73,0.12)' : bt === 'soft' ? 'rgba(227,179,65,0.12)' : 'rgba(255,255,255,0.06)') : 'transparent',
                  color: dedupBreakType === bt ? (bt === 'hard' ? '#f85149' : bt === 'soft' ? '#e3b341' : 'var(--text)') : 'var(--muted)',
                }}
              >
                {bt === 'hard' ? '🔒 hard' : bt === 'soft' ? '⏱ soft' : 'none'}
              </button>
            ))}
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
            {dedupBreakType === 'hard' ? 'Never repeat — once done, blocked forever' : dedupBreakType === 'soft' ? 'Repeat allowed after the interval' : 'No deduplication enforced'}
          </p>
        </div>
      </div>

      {dedupBreakType === 'soft' && (
        <div style={{ marginBottom: '1rem' }}>
          <label style={labelStyle}>Interval (hours)</label>
          <input
            type="number"
            min={1}
            value={dedupIntervalHours}
            onChange={(e) => onUpdate({ dedupIntervalHours: e.target.value })}
            placeholder="e.g. 168 (7 days)"
            style={{ ...inputStyle, width: 180 }}
          />
        </div>
      )}

      <div>
        <label style={labelStyle}>Block Message <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional — what the agent receives when blocked)</span></label>
        <textarea
          value={dedupBlockMessage}
          onChange={(e) => onUpdate({ dedupBlockMessage: e.target.value })}
          rows={2}
          placeholder={dedupBreakType === 'hard'
            ? `e.g. Already sent a DM to this user — hard break. Check get_dm_thread(user_id) to see if they replied.`
            : dedupBreakType === 'soft'
            ? `e.g. Already DMed this user in the last 7 days. Check get_dm_thread(user_id) for a reply before messaging again.`
            : 'Describe what the agent should do instead when this action is blocked'}
          style={{ ...textareaStyle, fontSize: '0.85rem' }}
        />
        <p style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
          Tip: route to an alternative action — "check get_dm_thread()" is more useful than just "action blocked"
        </p>
      </div>
    </section>
  );
}
