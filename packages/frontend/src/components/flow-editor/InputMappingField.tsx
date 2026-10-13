import type { InputExpression, FlowStep, Tool } from '../../types/index.js';
import { PRIMITIVE_CATEGORIES } from '../../data/primitiveCategories.js';

// ── Known primitive output fields ─────────────────────────────────────────────
export const TOOL_OUTPUTS: Record<string, string[]> = {
  open_tab:         ['tabId'],
  close_tab:        ['closed'],
  navigate:         ['navigated', 'url'],
  wait_for:         ['found', 'elapsed'],
  click:            [],
  type_text:        [],
  scroll:           [],
  get_dom:          ['html', 'length'],
  query_all:        ['items', 'count'],
  screenshot:       ['dataUrl'],
  filter_dom:       ['filtered', 'chars'],
  filter_query_all: ['items', 'count'],
  filter_items:     ['items', 'count'],
  execute_code:     [],
};

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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function defaultLiteralForType(fieldType?: string): unknown {
  if (fieldType === 'boolean') return true;
  if (fieldType === 'number' || fieldType === 'integer') return 0;
  if (fieldType === 'array') return [];
  return '';
}

export function defaultExprForType(fieldType?: string): InputExpression {
  return { type: 'literal', value: defaultLiteralForType(fieldType) };
}

// ── ExprEditor ────────────────────────────────────────────────────────────────
// Handles the type selector (literal / flow_input / step_ref) and all sub-fields.

export interface ExprEditorProps {
  expr: InputExpression;
  fieldName: string;
  fieldType?: string;
  priorSteps: FlowStep[];
  agentTools: Tool[];
  onChange: (e: InputExpression) => void;
}

export function ExprEditor({ expr, fieldName, fieldType, priorSteps, agentTools, onChange }: ExprEditorProps) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flex: 1 }}>
      <select
        value={expr.type}
        onChange={(e) => {
          const t = e.target.value as InputExpression['type'];
          if (t === 'literal') onChange({ type: 'literal', value: defaultLiteralForType(fieldType) });
          else if (t === 'flow_input') onChange({ type: 'flow_input', key: fieldName });
          else onChange({ type: 'step_ref', stepId: priorSteps[0]?.id ?? '', path: '' });
        }}
        style={selectStyle}
      >
        <option value="literal">Literal</option>
        <option value="flow_input">Flow Input</option>
        <option value="step_ref" disabled={priorSteps.length === 0}>Step Ref</option>
      </select>

      {expr.type === 'literal' && fieldType === 'boolean' && (
        <select
          value={String(expr.value)}
          onChange={(e) => onChange({ type: 'literal', value: e.target.value === 'true' })}
          style={selectStyle}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )}

      {expr.type === 'literal' && (fieldType === 'number' || fieldType === 'integer') && (
        <input
          type="number"
          value={String(expr.value ?? 0)}
          onChange={(e) => onChange({ type: 'literal', value: Number(e.target.value) })}
          style={{ ...inputStyle, width: 100 }}
        />
      )}

      {expr.type === 'literal' && fieldType === 'array' && (
        <input
          value={typeof expr.value === 'string' ? expr.value : JSON.stringify(expr.value ?? [])}
          onChange={(e) => {
            try { onChange({ type: 'literal', value: JSON.parse(e.target.value) }); }
            catch { onChange({ type: 'literal', value: e.target.value }); }
          }}
          placeholder='["item1", "item2"]'
          style={inputStyle}
        />
      )}

      {expr.type === 'literal' && fieldType !== 'boolean' && fieldType !== 'number' && fieldType !== 'integer' && fieldType !== 'array' && (
        <input
          value={String(expr.value ?? '')}
          onChange={(e) => onChange({ type: 'literal', value: e.target.value })}
          placeholder="value — use {{key}} to inject flow inputs"
          title="Use {{key}} to interpolate flow input values. E.g. https://x.com/search?q={{query}}"
          style={inputStyle}
        />
      )}

      {expr.type === 'flow_input' && (
        <input
          value={expr.key}
          onChange={(e) => onChange({ type: 'flow_input', key: e.target.value })}
          placeholder="flow input key"
          style={inputStyle}
        />
      )}

      {expr.type === 'step_ref' && (() => {
        const selectedStep = priorSteps.find((s) => s.id === expr.stepId);
        const priorTool = agentTools.find((t) => t.id === selectedStep?.toolId);
        const outputHints = priorTool ? (TOOL_OUTPUTS[priorTool.name] ?? []) : [];
        const listId = `hints-${expr.stepId}`;
        return (
          <>
            <select
              value={expr.stepId}
              onChange={(e) => onChange({ ...expr, stepId: e.target.value, path: '' })}
              style={selectStyle}
            >
              {priorSteps.map((s) => {
                const toolName = agentTools.find((t) => t.id === s.toolId)?.name ?? '';
                return (
                  <option key={s.id} value={s.id}>
                    {s.label}{toolName ? ` (${toolName})` : ''}
                  </option>
                );
              })}
            </select>
            {outputHints.length > 0 ? (
              <select
                value={expr.path}
                onChange={(e) => onChange({ ...expr, path: e.target.value })}
                style={selectStyle}
              >
                <option value="">— pick field —</option>
                {outputHints.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            ) : (
              <>
                <input
                  value={expr.path}
                  onChange={(e) => onChange({ ...expr, path: e.target.value })}
                  placeholder="field path (e.g. result.data)"
                  list={listId}
                  style={{ ...inputStyle, minWidth: 160 }}
                />
                <datalist id={listId} />
              </>
            )}
          </>
        );
      })()}
    </div>
  );
}

// ── InputMappingField ─────────────────────────────────────────────────────────
// Full row: label (field name + type) + ExprEditor + optional hint below.

// Per-field hints for common input names
export const FIELD_HINTS: Record<string, string> = {
  key: 'Common values: "Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp", " " (space). Omit selector to target the currently focused element.',
  selector: 'CSS selector, e.g. button[type="submit"] or [data-testid="send-btn"]. Leave blank to use the active/focused element.',
  tabId: 'Use Step Ref → open_tab step → result to wire the tab opened earlier in the flow.',
  ms: 'Milliseconds to wait. Max 30 000 (30 s).',
  url: 'Full URL including https://, e.g. https://example.com. Use {{key}} to inject a flow input.',
};

export interface InputMappingFieldProps {
  field: string;
  def: { type?: string; description?: string };
  expr: InputExpression;
  priorSteps: FlowStep[];
  agentTools: Tool[];
  onChange: (e: InputExpression) => void;
}

export function InputMappingField({ field, def, expr, priorSteps, agentTools, onChange }: InputMappingFieldProps) {
  const hint = FIELD_HINTS[field];
  return (
    <div style={{ marginBottom: '0.65rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <code
          style={{ fontSize: '0.8rem', color: 'var(--accent)', minWidth: 120, flexShrink: 0 }}
          title={def.description ?? hint}
        >
          {field}
          {def.type && <span style={{ color: 'var(--muted)', fontWeight: 400 }}> ({def.type})</span>}
        </code>
        <ExprEditor
          expr={expr}
          fieldName={field}
          fieldType={def.type}
          priorSteps={priorSteps}
          agentTools={agentTools}
          onChange={onChange}
        />
      </div>
      {(def.description || hint) && (
        <p style={{ margin: '0.2rem 0 0 128px', fontSize: '0.72rem', color: 'var(--muted)', lineHeight: 1.4 }}>
          {def.description || hint}
        </p>
      )}
    </div>
  );
}

// Re-export PRIMITIVE_CATEGORIES for convenience (used by FlowEditor tool picker)
export { PRIMITIVE_CATEGORIES };
