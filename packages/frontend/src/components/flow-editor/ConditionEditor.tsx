import type { FlowStep, StepCondition, Tool } from '../../types/index.js';

// ── Shared styles (mirrored from FlowEditor) ───────────────────────────────────

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

// ── ConditionEditor ────────────────────────────────────────────────────────────
// Renders the condition/branch section for a single non-evaluate, non-human-review,
// non-wait_for_any step. Includes:
//   - Simplified branch UI when the tool is `element_exists`
//   - Generic condition checkbox + full condition form for all other tools

export interface ConditionEditorProps {
  step: FlowStep;
  steps: FlowStep[];
  idx: number;
  agentTools: Tool[];
  onUpdate: (patch: Partial<FlowStep>) => void;
}

export function ConditionEditor({ step, steps, idx, agentTools, onUpdate }: ConditionEditorProps) {
  const isElementExists = agentTools.find((t) => t.id === step.toolId)?.name === 'element_exists';

  return (
    <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border)', background: 'var(--bg)' }}>
      {isElementExists ? (
        // ── Simplified branch UI for element_exists ────────────────────────────
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--muted)' }}>BRANCH</span>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.82rem', flexShrink: 0, minWidth: 140 }}>✅ Element exists →</span>
            <select
              value={step.condition?.skipToStepIdOnNoMatch ?? ''}
              onChange={(e) =>
                onUpdate({
                  condition: {
                    check: 'has_error',
                    failMessage: 'Element not found.',
                    skipToStepId: step.condition?.skipToStepId ?? null,
                    skipToStepIdOnNoMatch: e.target.value || null,
                  },
                })
              }
              style={{ ...selectStyle, flex: 1 }}
            >
              <option value="">(continue to next step)</option>
              {steps.filter((_, si) => si !== idx).map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span style={{ fontSize: '0.82rem', flexShrink: 0, minWidth: 140 }}>❌ Not found →</span>
            <select
              value={step.condition?.skipToStepId ?? ''}
              onChange={(e) =>
                onUpdate({
                  condition: {
                    check: 'has_error',
                    failMessage: 'Element not found.',
                    skipToStepId: e.target.value || null,
                    skipToStepIdOnNoMatch: step.condition?.skipToStepIdOnNoMatch ?? null,
                  },
                })
              }
              style={{ ...selectStyle, flex: 1 }}
            >
              <option value="">(stop flow)</option>
              {steps.filter((_, si) => si !== idx).map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
      ) : (
        // ── Generic condition form for all other tools ─────────────────────────
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              id={`cond-${step.id}`}
              checked={!!step.condition}
              onChange={(e) =>
                onUpdate({
                  condition: e.target.checked
                    ? { check: 'has_error', failMessage: 'Step failed with an error. Please try a different approach.' }
                    : null,
                })
              }
            />
            <label
              htmlFor={`cond-${step.id}`}
              style={{ fontSize: '0.8rem', color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}
            >
              Add condition — short-circuit if result doesn&apos;t match
            </label>
          </div>

          {step.condition && (
            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {/* Condition type + optional value/minLength */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <select
                  value={step.condition.check}
                  onChange={(e) =>
                    onUpdate({ condition: { ...step.condition!, check: e.target.value as StepCondition['check'] } })
                  }
                  style={selectStyle}
                >
                  <option value="has_error">Result has error (element not found, timeout, etc.)</option>
                  <option value="no_error">Result has NO error (step succeeded)</option>
                  <option value="result_equals">Result label equals</option>
                  <option value="result_not_equals">Result label does NOT equal</option>
                  <option value="min_array_length">Result array has fewer than N items</option>
                  <option value="non_empty">Result is empty</option>
                </select>
                {(step.condition.check === 'result_equals' || step.condition.check === 'result_not_equals') && (
                  <input
                    value={step.condition.value ?? ''}
                    onChange={(e) => onUpdate({ condition: { ...step.condition!, value: e.target.value } })}
                    placeholder="e.g. false, true, timeout, no_results"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                )}
                {step.condition.check === 'min_array_length' && (
                  <input
                    type="number"
                    min={1}
                    value={step.condition.minLength ?? 1}
                    onChange={(e) =>
                      onUpdate({ condition: { ...step.condition!, minLength: Number(e.target.value) } })
                    }
                    style={{ ...inputStyle, width: 60 }}
                    title="Minimum number of items required"
                  />
                )}
              </div>

              {/* Fail message */}
              <input
                value={step.condition.failMessage}
                onChange={(e) => onUpdate({ condition: { ...step.condition!, failMessage: e.target.value } })}
                placeholder="Message returned to the AI when condition fires"
                style={inputStyle}
              />

              {/* skipToStepId — what happens when condition FIRES */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--muted)', flexShrink: 0 }}>
                  {step.condition.check === 'has_error'        ? 'If NOT found / error:'        :
                   step.condition.check === 'no_error'         ? 'If found / success:'          :
                   step.condition.check === 'result_equals'    ? 'If result matches:'           :
                   step.condition.check === 'result_not_equals'? 'If result does NOT match:'    :
                   step.condition.check === 'min_array_length' ? 'If fewer than N results:'     :
                   step.condition.check === 'non_empty'        ? 'If result is empty:'          :
                                                                 'If condition fires:'}
                </span>
                <select
                  value={step.condition.skipToStepId ?? ''}
                  onChange={(e) =>
                    onUpdate({ condition: { ...step.condition!, skipToStepId: e.target.value || null } })
                  }
                  style={{ ...selectStyle, flex: 1 }}
                >
                  <option value="">(stop immediately)</option>
                  {steps.slice(idx + 1).map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>

              {/* skipToStepIdOnNoMatch — what happens when condition does NOT fire */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--muted)', flexShrink: 0 }}>
                  {step.condition.check === 'has_error'        ? 'If found / success:'          :
                   step.condition.check === 'no_error'         ? 'If NOT found / error:'        :
                   step.condition.check === 'result_equals'    ? 'If result does NOT match:'    :
                   step.condition.check === 'result_not_equals'? 'If result matches:'           :
                   step.condition.check === 'min_array_length' ? 'If N+ results:'               :
                   step.condition.check === 'non_empty'        ? 'If result has content:'       :
                                                                 'If condition does NOT fire:'}
                </span>
                <select
                  value={step.condition.skipToStepIdOnNoMatch ?? ''}
                  onChange={(e) =>
                    onUpdate({ condition: { ...step.condition!, skipToStepIdOnNoMatch: e.target.value || null } })
                  }
                  style={{ ...selectStyle, flex: 1 }}
                >
                  <option value="">(continue to next step)</option>
                  {steps.slice(idx + 1).map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>

              {/* Suggest tool */}
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ fontSize: '0.78rem', color: 'var(--muted)', flexShrink: 0 }}>Suggest tool:</span>
                <select
                  value={step.condition.suggestTool ?? ''}
                  onChange={(e) =>
                    onUpdate({ condition: { ...step.condition!, suggestTool: e.target.value || undefined } })
                  }
                  style={{ ...selectStyle, flex: 1 }}
                >
                  <option value="">(none)</option>
                  {agentTools.map((t) => (
                    <option key={t.id} value={t.name}>{t.name}</option>
                  ))}
                </select>
              </div>

              <p style={{ fontSize: '0.75rem', color: 'var(--muted)', margin: 0 }}>
                Set both dropdowns to control where each path goes. Leave as &quot;(stop immediately)&quot; to bail out, or pick a step to jump to.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
