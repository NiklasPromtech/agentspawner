import { useState } from 'react';
import type { FlowStep, Tool, InputExpression, FlowTestResult } from '../../types/index.js';
import { InputMappingField, ExprEditor, defaultExprForType } from './InputMappingField.js';
import { ConditionEditor } from './ConditionEditor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Very-lightweight JS prettifier for transform scripts.
 * Handles: brace-based indentation, semicolon line-breaks,
 * comma line-breaks inside object/array literals, and string literals.
 * No dependencies — good enough for the compact scripts generated here.
 */
function prettifyJs(raw: string): string {
  const src = raw.replace(/\s+/g, ' ').trim();
  let out = '';
  let braceDepth = 0;
  let i = 0;
  const pad = () => '  '.repeat(braceDepth);

  while (i < src.length) {
    const ch = src[i];

    // Pass string / template literals through verbatim (preserve regex strings too)
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch; i++;
      while (i < src.length) {
        const c = src[i]; out += c;
        if (c === '\\') { out += src[++i] ?? ''; i++; continue; }
        if (c === ch) { i++; break; }
        i++;
      }
      continue;
    }

    if (ch === '{') {
      braceDepth++;
      out += '{\n' + pad();
    } else if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      out = out.trimEnd() + '\n' + pad() + '}';
    } else if (ch === ';') {
      out += ';\n' + pad();
      if (src[i + 1] === ' ') i++; // eat trailing space
    } else if (ch === ',' && braceDepth > 0) {
      // Newline after commas inside object/array literals only
      out += ',\n' + pad();
      if (src[i + 1] === ' ') i++;
    } else {
      out += ch;
    }
    i++;
  }
  return out.trim();
}

function parseSchema(json: string): Record<string, { type?: string; description?: string }> {
  try {
    const s = JSON.parse(json) as { properties?: Record<string, { type?: string; description?: string }> };
    return s.properties ?? {};
  } catch {
    return {};
  }
}

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

const textareaStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text)',
  padding: '0.5rem 0.75rem',
  fontSize: '0.9rem',
  resize: 'vertical',
};

// ── TransformInputInspector ───────────────────────────────────────────────────

function resolveValue(expr: InputExpression, testResult: FlowTestResult): unknown {
  if (expr.type === 'literal') return expr.value;
  if (expr.type === 'step_ref') {
    const base = testResult.stepResults[expr.stepId];
    if (base === undefined) return undefined;
    const parts = expr.path.split('.');
    let cur: unknown = base;
    for (const part of parts) {
      if (cur !== null && typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }
    return cur;
  }
  if (expr.type === 'flow_input') return `<flow_input: ${expr.key}>`;
  return undefined;
}

/** Short preview for the in-panel display — truncated, arrays show count badge. */
function previewValue(value: unknown): string {
  if (value === undefined) return '(not yet available)';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > 150 ? s.slice(0, 150) + '…' : s;
}

/** Full expansion for clipboard — no truncation, arrays split item-by-item. */
function clipboardSection(fieldName: string, value: unknown): string {
  if (value === undefined) return `input.${fieldName} = (not yet available)`;
  if (Array.isArray(value)) {
    const count = value.length;
    const items = value
      .map((item, i) => `--- item[${i}] ---\n${typeof item === 'string' ? item : JSON.stringify(item, null, 2)}`)
      .join('\n\n');
    return `input.${fieldName} (${count} item${count !== 1 ? 's' : ''}):\n${items}`;
  }
  const s = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `input.${fieldName}:\n${s}`;
}

function TransformInputInspector({ step, testResult }: { step: FlowStep; testResult: FlowTestResult }) {
  const [copied, setCopied] = useState(false);
  const entries = Object.entries(step.inputMapping);
  if (entries.length === 0) return null;

  const resolved = entries.map(([field, expr]) => ({
    field,
    value: resolveValue(expr, testResult),
  }));

  const copyForAssistant = () => {
    const sections = resolved.map(({ field, value }) => clipboardSection(field, value));
    const hasArrays = resolved.some(({ value }) => Array.isArray(value));
    const script = step.transform?.script ?? '';
    const robustnessNote = hasArrays
      ? '\n⚠️ Focus on patterns and structure that are consistent across ALL items — not brittle per-item text or dynamic IDs — so the script is robust when run on different data.\n'
      : '';
    const text = [
      "I'm writing a JavaScript transform script and need your help. Here are the resolved inputs:",
      '',
      sections.join('\n\n'),
      robustnessNote,
      'Current script:',
      script,
    ].join('\n');
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={{ background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.5rem 0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
        <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Resolved inputs</span>
        <button
          onClick={copyForAssistant}
          style={{ fontSize: '0.72rem', padding: '0.15rem 0.5rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: copied ? '#3fb950' : 'var(--accent)', cursor: 'pointer', transition: 'color 0.15s' }}
        >
          {copied ? '✓ copied' : 'Copy for assistant'}
        </button>
      </div>
      {resolved.map(({ field, value }) => (
        <div key={field} style={{ fontFamily: 'monospace', fontSize: '0.78rem', marginBottom: '0.25rem', lineHeight: 1.4, wordBreak: 'break-all' }}>
          <span style={{ color: 'var(--accent)' }}>input.{field}</span>
          {Array.isArray(value) && (
            <span style={{ color: 'var(--muted)', fontSize: '0.7rem' }}> [{value.length}]</span>
          )}
          <span style={{ color: 'var(--muted)' }}> = </span>
          <span style={{ color: 'var(--text)', opacity: 0.85 }}>{previewValue(value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── WaitForAnyStepCard ────────────────────────────────────────────────────────
// Moved from FlowEditor.tsx — only used by StepForm for wait_for_any steps.

function WaitForAnyStepCard({
  step,
  priorSteps,
  agentTools,
  onUpdate,
}: {
  step: FlowStep;
  priorSteps: FlowStep[];
  agentTools: Tool[];
  onUpdate: (patch: Partial<FlowStep>) => void;
}) {
  const sels = (step.inputMapping.selectors?.type === 'literal' && Array.isArray(step.inputMapping.selectors.value)
    ? step.inputMapping.selectors.value as { selector: string; label: string }[]
    : []);
  const optASelector = sels.find((s) => s.label === 'option_a')?.selector ?? '';
  const optBSelector = sels.find((s) => s.label === 'option_b')?.selector ?? '';
  const tabIdExpr: InputExpression = step.inputMapping.tabId ?? { type: 'literal', value: 0 };
  const timeoutSec = step.inputMapping.timeoutMs?.type === 'literal' && typeof step.inputMapping.timeoutMs.value === 'number'
    ? (step.inputMapping.timeoutMs.value as number) / 1000
    : 15;
  const stopMessage = step.condition?.failMessage ?? 'No results found. Please try a different approach.';
  const suggestTool = step.condition?.suggestTool ?? '';

  const rebuild = (a: string, b: string, tSec: number, msg: string, suggest: string, tabId: InputExpression) => {
    onUpdate({
      inputMapping: {
        tabId,
        selectors: { type: 'literal', value: [{ selector: a, label: 'option_a' }, { selector: b, label: 'option_b' }] },
        timeoutMs: { type: 'literal', value: tSec * 1000 },
      },
      condition: { check: 'result_not_equals', value: 'option_a', failMessage: msg, suggestTool: suggest || undefined },
    });
  };

  const rowStyle: React.CSSProperties = { display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem' };
  const labelStyle2: React.CSSProperties = { fontSize: '0.8rem', color: 'var(--accent)', minWidth: 100, flexShrink: 0 };

  return (
    <div style={{ background: 'var(--bg)', padding: '0.75rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* tabId */}
      <div style={rowStyle}>
        <code style={labelStyle2}>tabId <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(number)</span></code>
        <ExprEditor expr={tabIdExpr} fieldName="tabId" fieldType="number" priorSteps={priorSteps} agentTools={agentTools}
          onChange={(e) => rebuild(optASelector, optBSelector, timeoutSec, stopMessage, suggestTool, e)} />
      </div>
      {/* timeout */}
      <div style={rowStyle}>
        <code style={labelStyle2}>timeout <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(seconds)</span></code>
        <input type="number" min={1} max={60} value={timeoutSec}
          onChange={(e) => rebuild(optASelector, optBSelector, Number(e.target.value), stopMessage, suggestTool, tabIdExpr)}
          style={{ ...inputStyle, width: 80 }} />
      </div>

      {/* Option A */}
      <div style={{ border: '1px solid #238636', borderRadius: 6, padding: '0.75rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#3fb950', marginBottom: '0.5rem' }}>
          Option A — if this selector appears, continue to next step
        </div>
        <input value={optASelector}
          onChange={(e) => rebuild(e.target.value, optBSelector, timeoutSec, stopMessage, suggestTool, tabIdExpr)}
          placeholder="CSS selector (e.g. [data-testid='cellInnerDiv'])"
          style={inputStyle} />
      </div>

      {/* Option B */}
      <div style={{ border: '1px solid #f8514933', borderRadius: 6, padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--error)', marginBottom: '0.25rem' }}>
          Option B — if this selector appears (or timeout), stop and tell the AI:
        </div>
        <input value={optBSelector}
          onChange={(e) => rebuild(optASelector, e.target.value, timeoutSec, stopMessage, suggestTool, tabIdExpr)}
          placeholder="CSS selector (e.g. [data-testid='emptyState'])"
          style={inputStyle} />
        <input value={stopMessage}
          onChange={(e) => rebuild(optASelector, optBSelector, timeoutSec, e.target.value, suggestTool, tabIdExpr)}
          placeholder="Message returned to the AI when this fires"
          style={inputStyle} />
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--muted)', flexShrink: 0 }}>Suggest tool:</span>
          <select value={suggestTool}
            onChange={(e) => rebuild(optASelector, optBSelector, timeoutSec, stopMessage, e.target.value, tabIdExpr)}
            style={{ ...selectStyle, flex: 1 }}>
            <option value="">(none)</option>
            {agentTools.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

// ── StepForm ──────────────────────────────────────────────────────────────────
// Renders the expandable body content of a step: evaluate prompt,
// wait_for_any card, generic input mapping, inline test result, and the
// condition editor. Used by StepCard.

export interface StepFormProps {
  step: FlowStep;
  idx: number;
  steps: FlowStep[];
  agentTools: Tool[];
  /** Callback to apply a partial patch to the step (replaces updateStep in FlowEditor). */
  onUpdate: (patch: Partial<FlowStep>) => void;
  testResult: FlowTestResult | null;
  expandedResults: Set<string>;
  onToggleExpanded: (stepId: string) => void;
  onFixStep: (step: FlowStep) => void;
  onFixWithFlowMaster?: (message: string) => void;
}

export function StepForm({
  step,
  idx,
  steps,
  agentTools,
  onUpdate,
  testResult,
  expandedResults,
  onToggleExpanded,
  onFixStep,
  onFixWithFlowMaster,
}: StepFormProps) {
  const isEvaluateStep = step.toolId === '__evaluate__';
  const isTransformStep = step.toolId === '__transform__';
  const tool = (isEvaluateStep || isTransformStep) ? null : agentTools.find((t) => t.id === step.toolId);
  const toolSchema = tool ? parseSchema(tool.inputSchema) : {};
  const priorSteps = steps.slice(0, idx);
  const isWaitForAny = tool?.name === 'wait_for_any';

  return (
    <>
      {/* Evaluate step body */}
      {isEvaluateStep && (
        <div style={{ padding: '0.75rem 1rem', background: 'var(--bg)' }}>
          <p style={{ fontSize: '0.75rem', color: '#a78bfa', marginBottom: '0.5rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Vision Prompt
          </p>
          <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>
            Claude Haiku takes a screenshot and answers your question. Flow fails if the answer is "no".
          </p>
          <textarea
            value={step.evaluate?.prompt ?? ''}
            onChange={(e) => onUpdate({ evaluate: { ...step.evaluate, prompt: e.target.value } })}
            placeholder="e.g. Did the comment get posted successfully? Is a success message visible?"
            rows={3}
            style={{ ...textareaStyle, fontFamily: 'inherit', fontSize: '0.85rem', width: '100%', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
            <span style={{ fontSize: '0.78rem', color: 'var(--muted)', flexShrink: 0 }}>Use screenshot from:</span>
            <select
              value={step.evaluate?.screenshotStepId ?? ''}
              onChange={(e) => onUpdate({ evaluate: { ...step.evaluate, prompt: step.evaluate?.prompt ?? '', screenshotStepId: e.target.value || undefined } })}
              style={{ ...selectStyle, flex: 1 }}
            >
              <option value="">(take a fresh screenshot)</option>
              {priorSteps.filter((s) => {
                const t = agentTools.find((a) => a.id === s.toolId);
                return t?.name === 'screenshot' || t?.name === 'take_screenshot';
              }).map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Transform step body */}
      {isTransformStep && (
        <div style={{ padding: '0.75rem 1rem', background: 'var(--bg)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <p style={{ fontSize: '0.75rem', color: '#fb923c', margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Transform Script
          </p>
          <p style={{ fontSize: '0.78rem', color: 'var(--muted)', margin: 0 }}>
            JavaScript executed in a secure sandbox (2s timeout). Access named inputs via the <code style={{ background: 'var(--surface)', padding: '0 3px', borderRadius: 3 }}>input</code> object — e.g. <code style={{ background: 'var(--surface)', padding: '0 3px', borderRadius: 3 }}>input.url</code>. Return the value to pass to the next step.
          </p>

          {/* Named inputs */}
          {Object.keys(step.inputMapping).length > 0 && (
            <>
              <p style={{ fontSize: '0.72rem', color: 'var(--muted)', margin: 0, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Inputs</p>
              {Object.entries(step.inputMapping).map(([field, expr]) => (
                <div key={field} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <InputMappingField
                      field={field}
                      def={{ type: 'string', description: `input.${field}` }}
                      expr={expr}
                      priorSteps={priorSteps}
                      agentTools={agentTools}
                      onChange={(e) => onUpdate({ inputMapping: { ...step.inputMapping, [field]: e } })}
                    />
                  </div>
                  <button
                    onClick={() => {
                      const updated = { ...step.inputMapping };
                      delete updated[field];
                      onUpdate({ inputMapping: updated });
                    }}
                    style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--error)', padding: '0.2rem 0.5rem', fontSize: '0.8rem', cursor: 'pointer', flexShrink: 0, marginTop: 2 }}
                  >✕</button>
                </div>
              ))}
            </>
          )}

          <button
            onClick={() => {
              const name = window.prompt('Input field name (snake_case, e.g. url, raw_text, items):');
              if (name && /^[a-z_][a-z0-9_]*$/.test(name) && !(name in step.inputMapping)) {
                onUpdate({ inputMapping: { ...step.inputMapping, [name]: { type: 'literal', value: '' } } });
              } else if (name) {
                alert('Invalid name or already exists. Use snake_case (letters, digits, underscores).');
              }
            }}
            style={{ alignSelf: 'flex-start', fontSize: '0.78rem', padding: '0.25rem 0.65rem', borderRadius: 4, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}
          >
            + Add input
          </button>

          {testResult && <TransformInputInspector step={step} testResult={testResult} />}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={() => {
                const formatted = prettifyJs(step.transform?.script ?? '');
                if (formatted) onUpdate({ transform: { script: formatted } });
              }}
              title="Auto-format the script"
              style={{ fontSize: '0.72rem', padding: '0.2rem 0.55rem', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}
            >
              ✦ Format
            </button>
          </div>
          <textarea
            value={step.transform?.script ?? ''}
            onChange={(e) => onUpdate({ transform: { script: e.target.value } })}
            placeholder={'// Access your inputs via the input object\n// e.g. return input.url.replace("www.", "");\nreturn input;'}
            rows={6}
            style={{ ...textareaStyle, fontFamily: 'monospace', fontSize: '0.82rem', boxSizing: 'border-box' }}
          />
        </div>
      )}

      {/* wait_for_any gets its own custom UI */}
      {!isEvaluateStep && !isTransformStep && isWaitForAny && (
        <WaitForAnyStepCard
          step={step}
          priorSteps={priorSteps}
          agentTools={agentTools}
          onUpdate={onUpdate}
        />
      )}

      {/* Generic input mapping for all other tools */}
      {!isEvaluateStep && !isTransformStep && !isWaitForAny && Object.keys(toolSchema).length > 0 && (
        <div style={{ padding: '0.75rem 1rem', background: 'var(--bg)' }}>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '0.5rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Input Mapping
          </p>
          {Object.entries(toolSchema).map(([field, def]) => (
            <InputMappingField
              key={field}
              field={field}
              def={def}
              expr={step.inputMapping[field] ?? defaultExprForType(def.type)}
              priorSteps={priorSteps}
              agentTools={agentTools}
              onChange={(e) => onUpdate({ inputMapping: { ...step.inputMapping, [field]: e } })}
            />
          ))}
        </div>
      )}

      {!isEvaluateStep && !isTransformStep && !isWaitForAny && Object.keys(toolSchema).length === 0 && tool && (
        <div style={{ padding: '0.5rem 1rem', background: 'var(--bg)', fontSize: '0.8rem', color: 'var(--muted)' }}>
          No inputs required for this tool.
        </div>
      )}

      {/* Inline step result — shown after a test run */}
      {testResult && testResult.stepResults[step.id] !== undefined && (() => {
        const res = testResult.stepResults[step.id];
        const isNull = res === null;
        const isTransformError = isTransformStep
          && typeof res === 'object' && res !== null
          && 'error' in (res as Record<string, unknown>);
        const isError = isNull || isTransformError;
        const isExpanded = expandedResults.has(step.id);

        const errorMsg = isTransformError
          ? String((res as Record<string, unknown>).error ?? 'Unknown error')
          : null;

        const summary = isNull
          ? 'null'
          : isTransformError
            ? errorMsg!.slice(0, 80)
            : typeof res === 'string'
              ? `"${res.slice(0, 60)}${res.length > 60 ? '…' : ''}"`
              : typeof res === 'object' && res !== null && 'label' in res
                ? `label: ${JSON.stringify((res as { label: unknown }).label)}`
                : typeof res === 'object' && res !== null && 'count' in res
                  ? `${(res as { count: number }).count} items`
                  : typeof res === 'object' && res !== null && 'tabId' in res
                    ? `tabId: ${(res as { tabId: unknown }).tabId}`
                    : JSON.stringify(res).slice(0, 60);

        const buildFixMessage = () => {
          const sections = Object.entries(step.inputMapping).map(([field, expr]) =>
            clipboardSection(field, resolveValue(expr, testResult)),
          );
          const hasArrays = Object.values(step.inputMapping).some((expr) =>
            Array.isArray(resolveValue(expr, testResult)),
          );
          const robustnessNote = hasArrays
            ? '\n⚠️ Focus on patterns and structure that are consistent across ALL items — not brittle per-item text or dynamic IDs — so the script is robust when run on different data.\n'
            : '';
          const script = step.transform?.script ?? '';
          return [
            `The transform script returned an error: "${errorMsg}"`,
            '',
            'Please fix the script. Here are the resolved inputs and the current (broken) script:',
            '',
            sections.join('\n\n'),
            robustnessNote,
            'Current script:',
            script,
          ].join('\n');
        };

        return (
          <div style={{ borderTop: '1px solid var(--border)', background: isError ? '#f8514911' : '#23863611' }}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 1rem', cursor: 'pointer' }}
              onClick={() => onToggleExpanded(step.id)}
            >
              <span style={{ fontSize: '0.72rem', color: isError ? '#f85149' : '#3fb950', fontWeight: 600 }}>
                {isError ? '⚠' : '✓'}
              </span>
              <code style={{ fontSize: '0.75rem', color: isError ? '#f85149' : 'var(--muted)', flex: 1 }}>{summary}</code>
              {isNull && (
                <button
                  onClick={(e) => { e.stopPropagation(); onFixStep(step); }}
                  style={{ fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: 4, border: '1px solid #58a6ff55', background: 'transparent', color: '#58a6ff', cursor: 'pointer', flexShrink: 0 }}
                >
                  ✦ Fix
                </button>
              )}
              {isTransformError && onFixWithFlowMaster && (
                <button
                  onClick={(e) => { e.stopPropagation(); onFixWithFlowMaster(buildFixMessage()); }}
                  style={{ fontSize: '0.7rem', padding: '0.1rem 0.45rem', borderRadius: 4, border: '1px solid #fb923c55', background: 'transparent', color: '#fb923c', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}
                >
                  ✦ Fix with FlowMaster
                </button>
              )}
              <span style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>{isExpanded ? '▲' : '▼'}</span>
            </div>
            {isExpanded && (
              <pre style={{ margin: 0, padding: '0.5rem 1rem', fontSize: '0.78rem', fontFamily: 'monospace', color: 'var(--text)', overflowX: 'auto', maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderTop: '1px solid var(--border)' }}>
                {JSON.stringify(res, null, 2)}
              </pre>
            )}
          </div>
        );
      })()}

      {/* Condition check — hidden for wait_for_any (conditions are built into its card) */}
      {!isEvaluateStep && !isWaitForAny && (
        <ConditionEditor
          step={step}
          steps={steps}
          idx={idx}
          agentTools={agentTools}
          onUpdate={onUpdate}
        />
      )}
    </>
  );
}
