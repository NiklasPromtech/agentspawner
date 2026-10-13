import type { FlowStep, Tool, FlowTestResult } from '../../types/index.js';
import { StepForm } from './StepForm.js';

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '0.35rem 0.6rem',
  fontSize: '0.875rem',
  flex: 1,
};

const selectStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '0.35rem 0.6rem',
  fontSize: '0.875rem',
};

const iconBtn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--muted)',
  padding: '0.2rem 0.5rem',
  fontSize: '0.8rem',
  cursor: 'pointer',
};

// ── StepCard ──────────────────────────────────────────────────────────────────
// Renders a single step's outer container (colored border), the header row
// (step number, label input, tool badge/selector, action buttons), and delegates
// the body content to StepForm.

export interface StepCardProps {
  step: FlowStep;
  idx: number;
  /** Full steps array — needed for disable logic on move buttons and StepForm. */
  steps: FlowStep[];
  agentTools: Tool[];
  returnStepIds: string[];
  testResult: FlowTestResult | null;
  expandedResults: Set<string>;
  onUpdate: (patch: Partial<FlowStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onToggleReturn: () => void;
  onToggleExpanded: (stepId: string) => void;
  onFixStep: (step: FlowStep) => void;
  onFixWithFlowMaster?: (message: string) => void;
}

export function StepCard({
  step,
  idx,
  steps,
  agentTools,
  returnStepIds,
  testResult,
  expandedResults,
  onUpdate,
  onMove,
  onDuplicate,
  onRemove,
  onToggleReturn,
  onToggleExpanded,
  onFixStep,
  onFixWithFlowMaster,
}: StepCardProps) {
  const isEvaluateStep = step.toolId === '__evaluate__';
  const isTransformStep = step.toolId === '__transform__';
  const isReturn = returnStepIds.includes(step.id);

  return (
    <div style={{
      border: `1px solid ${isEvaluateStep ? '#7c3aed55' : isTransformStep ? 'rgba(251,146,60,0.4)' : isReturn ? '#238636' : 'var(--border)'}`,
      borderRadius: 8,
      overflow: 'hidden',
    }}>
      {/* Step header — the "collapsed" view always visible */}
      <div style={{
        background: isEvaluateStep ? '#7c3aed11' : isTransformStep ? 'rgba(251,146,60,0.06)' : 'var(--surface)',
        padding: '0.75rem 1rem',
        display: 'flex',
        gap: '0.75rem',
        alignItems: 'center',
      }}>
        <span style={{ color: 'var(--muted)', fontSize: '0.8rem', fontWeight: 600, minWidth: 20 }}>{idx + 1}</span>
        <input
          value={step.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder="Step label"
          style={{ ...inputStyle, flex: 1 }}
        />
        {isEvaluateStep ? (
          <span style={{ fontSize: '0.8rem', color: '#a78bfa', background: '#7c3aed22', border: '1px solid #7c3aed44', borderRadius: 4, padding: '0.2rem 0.5rem', flexShrink: 0 }}>
            🔍 AI Evaluate
          </span>
        ) : isTransformStep ? (
          <span style={{ fontSize: '0.8rem', color: '#fb923c', background: 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.35)', borderRadius: 4, padding: '0.2rem 0.5rem', flexShrink: 0 }}>
            ⚡ Transform
          </span>
        ) : (
          <select
            value={step.toolId}
            onChange={(e) => onUpdate({ toolId: e.target.value, inputMapping: {}, condition: null })}
            style={{ ...selectStyle, minWidth: 160 }}
          >
            {agentTools.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <button onClick={() => onMove(-1)} disabled={idx === 0} style={iconBtn}>↑</button>
        <button onClick={() => onMove(1)} disabled={idx === steps.length - 1} style={iconBtn}>↓</button>
        <button onClick={onDuplicate} title="Duplicate this step" style={{ ...iconBtn, fontSize: '0.8rem' }}>⧉</button>
        <button
          onClick={onToggleReturn}
          title={isReturn ? "This step's result is returned (click to unset)" : "Return this step's result"}
          style={{
            ...iconBtn,
            background: isReturn ? '#238636' : 'transparent',
            color: isReturn ? '#fff' : 'var(--muted)',
            borderColor: isReturn ? '#238636' : 'var(--border)',
            fontWeight: isReturn ? 700 : 400,
          }}
        >↩</button>
        <button onClick={onRemove} style={{ ...iconBtn, color: 'var(--error)' }}>✕</button>
      </div>

      {/* Step body — the expanded editing view */}
      <StepForm
        step={step}
        idx={idx}
        steps={steps}
        agentTools={agentTools}
        onUpdate={onUpdate}
        testResult={testResult}
        expandedResults={expandedResults}
        onToggleExpanded={onToggleExpanded}
        onFixStep={onFixStep}
        onFixWithFlowMaster={onFixWithFlowMaster}
      />
    </div>
  );
}
