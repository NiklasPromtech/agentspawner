import { useState } from 'react';

interface Props {
  onTool: () => void;
  onEvaluate: () => void;
  disabled: boolean;
  onPaste?: () => void;
}

export function InsertStepBar({ onTool, onEvaluate, disabled, onPaste }: Props) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ position: 'relative', height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '2px 0' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, background: hover ? 'var(--border)' : 'transparent', transition: 'background 0.15s' }} />
      {hover && (
        <div style={{ position: 'relative', display: 'flex', gap: '0.3rem', zIndex: 1 }}>
          <button onClick={onTool} disabled={disabled} style={{ fontSize: '0.7rem', padding: '0.15rem 0.6rem', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--accent)', cursor: 'pointer', fontWeight: 600, lineHeight: 1.4 }}>+ step</button>
          <button onClick={onEvaluate} style={{ fontSize: '0.7rem', padding: '0.15rem 0.6rem', borderRadius: 12, border: '1px solid #7c3aed44', background: 'var(--surface)', color: '#a78bfa', cursor: 'pointer', fontWeight: 600, lineHeight: 1.4 }}>+ evaluate</button>
          {onPaste && (
            <button onClick={onPaste} style={{ fontSize: '0.7rem', padding: '0.15rem 0.6rem', borderRadius: 12, border: '1px solid #0d6efd44', background: 'var(--surface)', color: '#58a6ff', cursor: 'pointer', fontWeight: 600, lineHeight: 1.4 }}>+ paste from extension</button>
          )}
        </div>
      )}
    </div>
  );
}
