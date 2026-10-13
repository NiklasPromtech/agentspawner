import type { FlowStep } from '../../types/index.js';
import { inputStyle } from './styles.js';

interface Props {
  steps: FlowStep[];
  returnStepIds: string[];
  returnStepKeys: Record<string, string>;
  onToggle: (stepId: string) => void;
  onKeyChange: (stepId: string, key: string) => void;
}

export function ReturnStepSelector({ steps, returnStepIds, returnStepKeys, onToggle, onKeyChange }: Props) {
  return (
    <>
      {steps.length > 0 && (
        <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.75rem' }}>
          ↩ marks which step(s) return data to the AI.{' '}
          {returnStepIds.length === 0
            ? <>Unset = last step (<code style={{ color: 'var(--accent)' }}>{steps[steps.length - 1]?.label ?? '—'}</code>).</>
            : returnStepIds.length === 1
              ? <>Returns: <code style={{ color: 'var(--accent)' }}>{steps.find((s) => s.id === returnStepIds[0])?.label ?? '—'}</code></>
              : <>Returns merged object from {returnStepIds.length} selected steps.</>}
        </p>
      )}

      {returnStepIds.length > 1 && (
        <div style={{ background: '#23863611', border: '1px solid #23863633', borderRadius: 6, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
          <p style={{ fontSize: '0.78rem', color: '#3fb950', fontWeight: 600, marginBottom: '0.5rem' }}>
            Multi-step return — the AI receives a merged object with these keys:
          </p>
          {returnStepIds.map((id) => {
            const s = steps.find((st) => st.id === id);
            if (!s) return null;
            const autoKey = s.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || id.slice(0, 8);
            return (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.4rem' }}>
                <code style={{ fontSize: '0.8rem', color: 'var(--accent)', minWidth: 180, flexShrink: 0 }}>{s.label}</code>
                <span style={{ fontSize: '0.78rem', color: 'var(--muted)', flexShrink: 0 }}>→ key:</span>
                <input
                  value={returnStepKeys[id] ?? autoKey}
                  onChange={(e) => onKeyChange(id, e.target.value)}
                  placeholder={autoKey}
                  style={{ ...inputStyle, maxWidth: 200 }}
                />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
