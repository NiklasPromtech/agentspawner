// ── Flows Debugger — standalone page ──────────────────────────────────────────

const BACKEND_HTTP = 'http://localhost:3001';

// ── Types ─────────────────────────────────────────────────────────────────────

type InputExpression =
  | { type: 'literal'; value: unknown }
  | { type: 'flow_input'; key: string }
  | { type: 'step_ref'; stepId: string; path: string };

interface FlowStep {
  id: string;
  label?: string;
  toolName?: string;
  toolId?: string;
  inputMapping?: Record<string, InputExpression>;
  [key: string]: unknown;
}

interface FlowDefinition {
  id: string;
  name: string;
  steps: FlowStep[];
  inputSchema?: string | null;
  [key: string]: unknown;
}

interface StepRunResult {
  stepId: string;
  result: unknown;
  ok: boolean;
  error?: string;
}

// ── Tool presets for the "Add step" form ─────────────────────────────────────
// Maps tool name → default input fields (key + placeholder)
const INSERT_TOOL_PRESETS: Record<string, Array<{ key: string; placeholder: string }>> = {
  // tabId is optional on browser-interaction tools — leave blank to target the active tab
  click:         [{ key: 'selector', placeholder: 'button.submit' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  double_click:  [{ key: 'selector', placeholder: '.item' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  right_click:   [{ key: 'selector', placeholder: '.item' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  hover:         [{ key: 'selector', placeholder: '.element' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  type_text:     [{ key: 'selector', placeholder: 'input, textarea' }, { key: 'text', placeholder: 'Hello world' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  press_key:     [{ key: 'key', placeholder: 'Enter, Tab, Escape, ArrowDown' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  select_option: [{ key: 'selector', placeholder: 'select' }, { key: 'value', placeholder: 'option value or text' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  set_checkbox:  [{ key: 'selector', placeholder: 'input[type="checkbox"]' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  wait_for:      [{ key: 'selector', placeholder: '.modal' }, { key: 'timeoutMs', placeholder: '10000' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  wait_for_gone: [{ key: 'selector', placeholder: '.spinner' }, { key: 'timeoutMs', placeholder: '10000' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  wait_ms:       [{ key: 'ms', placeholder: '2000' }],
  scroll:        [{ key: 'selector', placeholder: '.element' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  navigate:      [{ key: 'url', placeholder: 'https://example.com' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  get_text:      [{ key: 'selector', placeholder: 'h1' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  get_url:       [{ key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  element_exists:[{ key: 'selector', placeholder: '.element' }, { key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
  screenshot:    [{ key: 'tabId', placeholder: '{{stepLabel.tabId}} or leave blank' }],
};

// ── Module-level state ────────────────────────────────────────────────────────

let loadedFlow: FlowDefinition | null = null;
let currentStepIndex = 0;
let priorStepResults: Record<string, unknown> = {};
// Stores in-memory edits to step inputMappings (stepId → override)
const editedSteps = new Map<string, Record<string, InputExpression>>();
// Tracks IDs of steps inserted by the user (not yet saved to DB)
const insertedStepIds = new Set<string>();

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('flow-load-btn')!.addEventListener('click', () => {
    void loadFlow();
  });
  (document.getElementById('flow-id-input') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void loadFlow();
  });
  document.getElementById('action-load-btn')!.addEventListener('click', () => {
    void loadFromAction();
  });
  (document.getElementById('action-id-input') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void loadFromAction();
  });
  document.getElementById('flow-run-step-btn')!.addEventListener('click', () => {
    void runFlowStep();
  });
  document.getElementById('flow-lock-in-btn')!.addEventListener('click', () => {
    void lockInEdits();
  });

  // Restore the last-used flow ID so the user doesn't have to re-paste it
  chrome.storage.local.get('lastFlowId', (result) => {
    const saved = result['lastFlowId'];
    if (typeof saved === 'string' && saved) {
      (document.getElementById('flow-id-input') as HTMLInputElement).value = saved;
    }
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showFlowError(msg: string): void {
  const el = document.getElementById('flow-error')!;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function showFlowComplete(): void {
  const container = document.getElementById('flow-results')!;
  const el = document.createElement('div');
  el.className = 'flow-complete-msg';
  el.textContent = '✅ Flow complete';
  container.appendChild(el);
}

function showFlowSaveStatus(type: 'success' | 'error', msg: string): void {
  const el = document.getElementById('flow-save-status')!;
  el.className = type === 'success' ? 'flow-save-success' : 'flow-save-error';
  el.textContent = msg;
}

function updateLockInVisibility(): void {
  const btn = document.getElementById('flow-lock-in-btn')!;
  btn.classList.toggle('hidden', editedSteps.size === 0);
}

export function getFlowInputValues(): Record<string, string> {
  const result: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>('.flow-required-input').forEach((el) => {
    const field = el.getAttribute('data-field');
    if (field) result[field] = el.value.trim();
  });
  return result;
}

// ── Load from Action ──────────────────────────────────────────────────────────
// Fetches an action log entry by ID, extracts flowId + stored input values,
// then delegates to loadFlow() and pre-populates the input fields.

interface ActionLogEntry {
  id: string;
  flowId: string;
  agentId: string;
  input: string; // JSON string
  flowName?: string;
  [key: string]: unknown;
}

async function loadFromAction(): Promise<void> {
  const actionInput = document.getElementById('action-id-input') as HTMLInputElement;
  const loadBtn = document.getElementById('action-load-btn') as HTMLButtonElement;
  const errorEl = document.getElementById('flow-error')!;

  const actionId = actionInput.value.trim();
  if (!actionId) {
    showFlowError('Please enter an action ID.');
    return;
  }

  loadBtn.textContent = '⏳ Loading…';
  loadBtn.disabled = true;
  errorEl.classList.add('hidden');

  try {
    // 1. Fetch the action log entry
    const res = await fetch(`${BACKEND_HTTP}/action-log/${encodeURIComponent(actionId)}`);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Action not found (${res.status}): ${text}`);
    }
    const entry = await res.json() as ActionLogEntry;

    if (!entry.flowId) {
      throw new Error('Action log entry has no associated flow ID.');
    }

    // 2. Set the flow ID input and load the flow
    (document.getElementById('flow-id-input') as HTMLInputElement).value = entry.flowId;
    await loadFlow();

    // 3. Parse stored input JSON and pre-fill the rendered input fields
    if (entry.input) {
      let storedInput: Record<string, unknown> = {};
      try {
        storedInput = JSON.parse(entry.input) as Record<string, unknown>;
      } catch {
        // Malformed input — skip pre-filling
      }

      Object.entries(storedInput).forEach(([key, val]) => {
        const el = document.getElementById(`flow-input-${key}`) as HTMLInputElement | null;
        if (el) {
          el.value = typeof val === 'string' ? val : JSON.stringify(val);
        }
      });

      // Re-check whether the run button should be shown (inputs may now be filled)
      updateRunStepButton();
    }
  } catch (err) {
    showFlowError(err instanceof Error ? err.message : String(err));
  } finally {
    loadBtn.textContent = 'Load Action';
    loadBtn.disabled = false;
  }
}

// ── Load Flow ─────────────────────────────────────────────────────────────────

async function loadFlow(): Promise<void> {
  const idInput = document.getElementById('flow-id-input') as HTMLInputElement;
  const loadBtn = document.getElementById('flow-load-btn') as HTMLButtonElement;
  const errorEl = document.getElementById('flow-error')!;
  const nameEl = document.getElementById('flow-name-heading')!;

  const flowId = idInput.value.trim();
  if (!flowId) {
    showFlowError('Please enter a flow ID.');
    return;
  }

  loadBtn.textContent = '⏳ Loading…';
  loadBtn.disabled = true;
  errorEl.classList.add('hidden');
  nameEl.classList.add('hidden');
  document.getElementById('flow-inputs')!.innerHTML = '';
  document.getElementById('flow-run-step-btn')!.classList.add('hidden');
  document.getElementById('flow-results')!.innerHTML = '';
  document.getElementById('flow-lock-in-btn')!.classList.add('hidden');
  const saveStatusEl = document.getElementById('flow-save-status')!;
  saveStatusEl.className = 'hidden';
  saveStatusEl.textContent = '';
  loadedFlow = null;
  currentStepIndex = 0;
  priorStepResults = {};
  editedSteps.clear();
  insertedStepIds.clear();

  try {
    const res = await fetch(`${BACKEND_HTTP}/flows/${encodeURIComponent(flowId)}`);
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Server returned ${res.status}: ${text}`);
    }
    const flow = await res.json() as FlowDefinition;
    if (!flow.steps || !Array.isArray(flow.steps)) {
      throw new Error('Flow definition is missing a steps array.');
    }
    loadedFlow = flow;
    // Persist the flow ID so it is pre-filled next time the debugger opens
    chrome.storage.local.set({ lastFlowId: flowId });
    nameEl.textContent = flow.name ?? flow.id;
    nameEl.classList.remove('hidden');
    renderFlowInputs();
  } catch (err) {
    showFlowError(err instanceof Error ? err.message : String(err));
  } finally {
    loadBtn.textContent = 'Load Flow';
    loadBtn.disabled = false;
  }
}

// ── Render Inputs ─────────────────────────────────────────────────────────────

function renderFlowInputs(): void {
  const container = document.getElementById('flow-inputs')!;
  container.innerHTML = '';

  if (!loadedFlow) return;

  // Parse the JSON Schema string to find required fields
  let requiredFields: string[] = [];
  let properties: Record<string, { title?: string; description?: string }> = {};

  if (loadedFlow.inputSchema) {
    try {
      const schema = JSON.parse(loadedFlow.inputSchema as string) as {
        required?: string[];
        properties?: Record<string, { title?: string; description?: string }>;
      };
      requiredFields = schema.required ?? [];
      properties = schema.properties ?? {};
    } catch {
      // Malformed schema — treat as no required inputs
    }
  }

  if (requiredFields.length === 0) {
    // No required inputs — show the run button immediately
    updateRunStepButton(true);
    return;
  }

  // Render a labelled text input for each required field
  container.innerHTML = requiredFields.map((fieldName) => {
    const prop = properties[fieldName] ?? {};
    const label = prop.title ?? fieldName;
    const placeholder = prop.description ?? '';
    return `
      <div class="field-group">
        <div class="field-label">${escapeAttr(label)}</div>
        <input
          type="text"
          id="flow-input-${escapeAttr(fieldName)}"
          class="field-input flow-required-input"
          data-field="${escapeAttr(fieldName)}"
          placeholder="${escapeAttr(placeholder)}"
          autocomplete="off"
          spellcheck="false"
        >
      </div>
    `;
  }).join('');

  // Re-evaluate button visibility on every keystroke
  container.querySelectorAll('.flow-required-input').forEach((el) => {
    el.addEventListener('input', () => updateRunStepButton());
  });

  // Initial check (all fields empty → button hidden)
  updateRunStepButton();
}

function updateRunStepButton(forceShow = false): void {
  const runBtn = document.getElementById('flow-run-step-btn') as HTMLButtonElement;

  if (!loadedFlow) {
    runBtn.classList.add('hidden');
    return;
  }

  const allFilled = forceShow ||
    Array.from(document.querySelectorAll<HTMLInputElement>('.flow-required-input'))
      .every((el) => el.value.trim() !== '');

  const stepNum = currentStepIndex + 1;
  const currentStep = loadedFlow.steps[currentStepIndex];
  const stepLabel = currentStep?.label ?? currentStep?.id ?? `Step ${stepNum}`;
  runBtn.textContent = `▶ Run Step ${stepNum} — ${stepLabel}`;
  runBtn.classList.toggle('hidden', !allFilled);
  // Always clear disabled when showing — a previous run may have left it disabled
  if (allFilled) runBtn.disabled = false;
}

// ── Flow step runner ──────────────────────────────────────────────────────────

async function runFlowStep(): Promise<void> {
  if (!loadedFlow) return;

  const step = loadedFlow.steps[currentStepIndex];
  if (!step) return;

  const runBtn = document.getElementById('flow-run-step-btn') as HTMLButtonElement;
  runBtn.disabled = true;
  runBtn.textContent = '⏳ Running…';

  const flowInput = getFlowInputValues();

  // If this step was newly inserted (not yet saved to DB), pass its full definition
  // so the backend doesn't fail trying to look it up by ID.
  const stepDefForBackend = insertedStepIds.has(step.id) ? step : undefined;

  try {
    const res = await fetch(
      `${BACKEND_HTTP}/flows/${encodeURIComponent(loadedFlow.id)}/run-step`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepId: step.id, flowInput, priorStepResults, stepDef: stepDefForBackend }),
      },
    );

    const data = await res.json() as StepRunResult;
    appendFlowStepResult(currentStepIndex + 1, step, data);

    if (!data.ok) {
      runBtn.classList.add('hidden');
      return;
    }

    // Accumulate result for subsequent steps
    priorStepResults[step.id] = data.result;
    currentStepIndex++;

    if (currentStepIndex >= loadedFlow.steps.length) {
      runBtn.classList.add('hidden');
      showFlowComplete();
    } else {
      const nextStep = loadedFlow.steps[currentStepIndex];
      const nextLabel = nextStep?.label ?? nextStep?.id ?? `Step ${currentStepIndex + 1}`;
      runBtn.textContent = `▶ Run Step ${currentStepIndex + 1} — ${nextLabel}`;
      runBtn.disabled = false;
    }
  } catch (err) {
    appendFlowStepResult(currentStepIndex + 1, step, {
      stepId: step.id,
      result: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    runBtn.classList.add('hidden');
  }
}

// ── Insert step ───────────────────────────────────────────────────────────────

function insertStepAt(afterIndex: number, newStep: FlowStep): void {
  if (!loadedFlow) return;
  const insertIdx = afterIndex + 1;
  // Snapshot whether the flow was already complete BEFORE we mutate the array,
  // because the splice changes steps.length and the check would be wrong after.
  const wasComplete = currentStepIndex >= loadedFlow.steps.length;
  loadedFlow.steps.splice(insertIdx, 0, newStep);
  if (wasComplete) {
    // All steps had already run — point directly at the new step so it can be run.
    currentStepIndex = insertIdx;
  } else if (insertIdx < currentStepIndex) {
    // Inserted before the still-pending step — shift the pointer forward to keep
    // it pointing at the same (now-shifted) original pending step.
    currentStepIndex++;
  }
  // Track it as a newly inserted step (not yet in DB) and mark as edited so Lock In includes it
  insertedStepIds.add(newStep.id);
  editedSteps.set(newStep.id, newStep.inputMapping ?? {});
  updateLockInVisibility();
  // Show / update the run button — it now points to the newly inserted step
  updateRunStepButton(true);
  const runBtn = document.getElementById('flow-run-step-btn') as HTMLButtonElement;
  runBtn.disabled = false;
}

function renderAddStepDivider(afterIndex: number): HTMLElement {
  const divider = document.createElement('div');
  divider.className = 'fsr-insert-divider';

  // Build the tool <select> options
  const toolOptions = Object.keys(INSERT_TOOL_PRESETS)
    .map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`)
    .join('');

  divider.innerHTML = `
    <button class="fsr-insert-btn">＋ Add step here</button>
    <div class="fsr-insert-form hidden">
      <div class="field-group">
        <div class="field-label">Tool</div>
        <select class="field-input fsr-new-tool">
          ${toolOptions}
        </select>
      </div>
      <div class="field-group">
        <div class="field-label">Label</div>
        <input type="text" class="field-input fsr-new-label" placeholder="e.g. Select post flair" autocomplete="off" spellcheck="false">
      </div>
      <div class="fsr-new-mapping-rows"></div>
      <button class="fsr-add-row-btn">＋ Add input</button>
      <div class="fsr-insert-actions">
        <button class="fsr-confirm-btn">Add Step</button>
        <button class="fsr-cancel-btn">Cancel</button>
      </div>
    </div>
  `;

  const insertBtn = divider.querySelector<HTMLButtonElement>('.fsr-insert-btn')!;
  const form = divider.querySelector<HTMLElement>('.fsr-insert-form')!;
  const toolSelect = divider.querySelector<HTMLSelectElement>('.fsr-new-tool')!;
  const mappingRows = divider.querySelector<HTMLElement>('.fsr-new-mapping-rows')!;
  const addRowBtn = divider.querySelector<HTMLButtonElement>('.fsr-add-row-btn')!;
  const confirmBtn = divider.querySelector<HTMLButtonElement>('.fsr-confirm-btn')!;
  const cancelBtn = divider.querySelector<HTMLButtonElement>('.fsr-cancel-btn')!;

  function populateDefaultFields(toolName: string): void {
    const presets = INSERT_TOOL_PRESETS[toolName] ?? [];
    mappingRows.innerHTML = presets.map((p) => `
      <div class="fsr-insert-row">
        <input type="text" class="field-input fsr-insert-key" value="${escapeAttr(p.key)}" placeholder="key" autocomplete="off" spellcheck="false">
        <input type="text" class="field-input fsr-insert-val" placeholder="${escapeAttr(p.placeholder)}" autocomplete="off" spellcheck="false">
        <button class="fsr-remove-row-btn">✕</button>
      </div>
    `).join('');
    wireRemoveButtons();
  }

  function wireRemoveButtons(): void {
    mappingRows.querySelectorAll<HTMLButtonElement>('.fsr-remove-row-btn').forEach((btn) => {
      btn.addEventListener('click', () => btn.closest('.fsr-insert-row')?.remove());
    });
  }

  // Populate defaults for the initially selected tool
  populateDefaultFields(toolSelect.value);

  toolSelect.addEventListener('change', () => populateDefaultFields(toolSelect.value));

  addRowBtn.addEventListener('click', () => {
    const row = document.createElement('div');
    row.className = 'fsr-insert-row';
    row.innerHTML = `
      <input type="text" class="field-input fsr-insert-key" placeholder="key" autocomplete="off" spellcheck="false">
      <input type="text" class="field-input fsr-insert-val" placeholder="value" autocomplete="off" spellcheck="false">
      <button class="fsr-remove-row-btn">✕</button>
    `;
    row.querySelector<HTMLButtonElement>('.fsr-remove-row-btn')!
      .addEventListener('click', () => row.remove());
    mappingRows.appendChild(row);
  });

  insertBtn.addEventListener('click', () => {
    form.classList.toggle('hidden');
    insertBtn.textContent = form.classList.contains('hidden') ? '＋ Add step here' : '✕ Cancel add';
  });

  cancelBtn.addEventListener('click', () => {
    form.classList.add('hidden');
    insertBtn.textContent = '＋ Add step here';
  });

  confirmBtn.addEventListener('click', () => {
    const toolName = toolSelect.value;
    const label = (divider.querySelector<HTMLInputElement>('.fsr-new-label')!).value.trim()
      || toolName;

    // Parse a value string into an InputExpression.
    // Supports {{flow_input.key}}, {{stepLabel.path}}, and plain literals.
    // Returns null for empty strings so optional fields (e.g. tabId) are omitted.
    function parseExpr(val: string): InputExpression | null {
      if (val === '') return null;
      const tmpl = val.match(/^\{\{(.+?)\}\}$/);
      if (tmpl) {
        const inner = tmpl[1].trim();
        if (inner === 'flow_input' || inner.startsWith('flow_input.')) {
          const dot = inner.indexOf('.');
          return { type: 'flow_input', key: dot >= 0 ? inner.slice(dot + 1) : '' };
        }
        // Step reference: {{stepLabel}} or {{stepLabel.path}}
        const dot = inner.indexOf('.');
        const labelPart = dot >= 0 ? inner.slice(0, dot) : inner;
        const pathPart  = dot >= 0 ? inner.slice(dot + 1) : '';
        // Resolve label → stepId (fall back to using the label text as-is if not found)
        const refStep = loadedFlow?.steps.find(s => s.label === labelPart);
        const stepId  = refStep?.id ?? labelPart;
        return { type: 'step_ref', stepId, path: pathPart };
      }
      let parsed: unknown = val;
      try { parsed = JSON.parse(val); } catch { /* keep as plain string */ }
      return { type: 'literal', value: parsed };
    }

    // Build inputMapping from rows — skip rows with empty key or empty value
    const inputMapping: Record<string, InputExpression> = {};
    mappingRows.querySelectorAll<HTMLElement>('.fsr-insert-row').forEach((row) => {
      const key  = row.querySelector<HTMLInputElement>('.fsr-insert-key')!.value.trim();
      const val  = row.querySelector<HTMLInputElement>('.fsr-insert-val')!.value.trim();
      if (!key) return;
      const expr = parseExpr(val);
      if (expr) inputMapping[key] = expr;
    });

    const newStep: FlowStep = {
      id: crypto.randomUUID(),
      label,
      toolName,
      inputMapping,
    };

    form.classList.add('hidden');
    insertBtn.textContent = '＋ Add step here';
    insertStepAt(afterIndex, newStep);
  });

  return divider;
}

// ── Append step result block ──────────────────────────────────────────────────

function appendFlowStepResult(stepNum: number, step: FlowStep, data: StepRunResult): void {
  const container = document.getElementById('flow-results')!;

  // Collapse all previously expanded result blocks
  container.querySelectorAll<HTMLElement>('.flow-step-result:not(.fsr-collapsed)').forEach((el) => {
    el.classList.add('fsr-collapsed');
    const chevron = el.querySelector('.fsr-toggle');
    if (chevron) chevron.textContent = '▶';
  });

  const block = document.createElement('div');
  // New block starts expanded (no fsr-collapsed)
  block.className = `flow-step-result ${data.ok ? 'fsr-ok' : 'fsr-fail'}`;

  const label = step.label ?? step.id ?? `Step ${stepNum}`;
  const toolName = step.toolName ?? step.toolId ?? '';
  const payload = data.ok ? data.result : (data.error ?? data.result);
  const toolChip = toolName
    ? `<span class="fsr-tool">${escapeHtml(String(toolName))}</span>`
    : '';

  // Build editor rows from the step's inputMapping (or any in-memory override)
  const inputMapping = editedSteps.get(step.id) ?? step.inputMapping ?? {};
  const editorRows = Object.entries(inputMapping).map(([key, expr]) => {
    const exprType = expr.type;
    let exprVal = '';
    if (expr.type === 'literal') {
      exprVal = typeof expr.value === 'string' ? expr.value : JSON.stringify(expr.value);
    } else if (expr.type === 'flow_input') {
      exprVal = expr.key;
    } else if (expr.type === 'step_ref') {
      exprVal = `${expr.stepId}.${expr.path}`;
    }
    return `
      <div class="fsr-editor-row">
        <span class="fsr-editor-key">${escapeHtml(key)}</span>
        <span class="fsr-editor-type fsr-type-${escapeAttr(exprType)}">${escapeHtml(exprType)}</span>
        <input
          type="text"
          class="fsr-editor-val field-input"
          data-key="${escapeAttr(key)}"
          data-type="${escapeAttr(exprType)}"
          value="${escapeAttr(exprVal)}"
          autocomplete="off"
          spellcheck="false"
        >
      </div>
    `;
  }).join('');

  const hasMapping = Object.keys(inputMapping).length > 0;

  block.innerHTML = `
    <div class="fsr-header">
      <span class="fsr-toggle">▼</span>
      <span class="fsr-num">Step ${stepNum}</span>
      <span class="fsr-label">${escapeHtml(String(label))}</span>
      ${toolChip}
      <span class="fsr-badge ${data.ok ? 'fsr-pass' : 'fsr-fail-badge'}">${data.ok ? '✓ Pass' : '✗ Fail'}</span>
      <button class="fsr-edit-btn">Edit</button>
    </div>
    <pre class="fsr-pre">${escapeHtml(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2))}</pre>
    <div class="fsr-editor hidden">
      ${hasMapping ? editorRows : '<div class="fsr-editor-empty">No input mapping to edit</div>'}
      <button class="fsr-rerun-btn">↩ Re-run this step</button>
    </div>
  `;

  // Toggle collapse/expand when the header is clicked
  const header = block.querySelector<HTMLElement>('.fsr-header')!;
  const editorEl = block.querySelector<HTMLElement>('.fsr-editor')!;
  const editBtn = block.querySelector<HTMLButtonElement>('.fsr-edit-btn')!;

  header.addEventListener('click', (e) => {
    // Don't collapse/expand when the Edit button itself is clicked
    if ((e.target as HTMLElement).classList.contains('fsr-edit-btn')) return;
    const collapsed = block.classList.toggle('fsr-collapsed');
    const chevron = header.querySelector('.fsr-toggle')!;
    chevron.textContent = collapsed ? '▶' : '▼';
  });

  // Edit button toggles the inline editor panel
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !editorEl.classList.contains('hidden');
    editorEl.classList.toggle('hidden', isOpen);
    editBtn.textContent = isOpen ? 'Edit' : 'Close';
    // Expanding the editor also expands the block
    if (!isOpen) {
      block.classList.remove('fsr-collapsed');
      const chevron = header.querySelector('.fsr-toggle')!;
      chevron.textContent = '▼';
    }
  });

  // Re-run button submits edits to the endpoint and replaces the result
  const rerunBtn = block.querySelector<HTMLButtonElement>('.fsr-rerun-btn')!;
  rerunBtn.addEventListener('click', () => {
    void reRunStep(block, step, editorEl);
  });

  container.appendChild(block);

  // Add an "＋ Add step here" divider after every completed block.
  // Capture currentStepIndex now (before runFlowStep increments it) — that's
  // the 0-based index of the step that just ran, which is the "afterIndex" for
  // any step inserted via this divider.
  container.appendChild(renderAddStepDivider(currentStepIndex));

  // Scroll the new block into view
  block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Inline step re-runner ─────────────────────────────────────────────────────

async function reRunStep(
  block: HTMLElement,
  step: FlowStep,
  editorEl: HTMLElement,
): Promise<void> {
  if (!loadedFlow) return;

  const rerunBtn = block.querySelector<HTMLButtonElement>('.fsr-rerun-btn')!;
  rerunBtn.disabled = true;
  rerunBtn.textContent = '⏳ Re-running…';

  // Collect edited inputMapping from the editor rows
  const inputMappingOverride: Record<string, InputExpression> = {};
  editorEl.querySelectorAll<HTMLInputElement>('.fsr-editor-val').forEach((input) => {
    const key = input.dataset['key']!;
    const exprType = input.dataset['type'] as InputExpression['type'];
    const val = input.value;

    if (exprType === 'literal') {
      let parsedVal: unknown = val;
      try { parsedVal = JSON.parse(val); } catch { /* keep as plain string */ }
      inputMappingOverride[key] = { type: 'literal', value: parsedVal };
    } else if (exprType === 'flow_input') {
      inputMappingOverride[key] = { type: 'flow_input', key: val };
    } else if (exprType === 'step_ref') {
      const dotIdx = val.indexOf('.');
      const refStepId = dotIdx >= 0 ? val.slice(0, dotIdx) : val;
      const path = dotIdx >= 0 ? val.slice(dotIdx + 1) : '';
      inputMappingOverride[key] = { type: 'step_ref', stepId: refStepId, path };
    }
  });

  // Persist edits in memory so subsequent re-runs start from the edited values
  editedSteps.set(step.id, inputMappingOverride);
  updateLockInVisibility();

  try {
    const flowInput = getFlowInputValues();
    // For newly inserted steps, pass the full step definition + override merged
    const rerunStepDef = insertedStepIds.has(step.id)
      ? { ...step, inputMapping: inputMappingOverride }
      : undefined;
    const res = await fetch(
      `${BACKEND_HTTP}/flows/${encodeURIComponent(loadedFlow.id)}/run-step`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stepId: step.id,
          flowInput,
          priorStepResults,
          inputMappingOverride: insertedStepIds.has(step.id) ? undefined : inputMappingOverride,
          stepDef: rerunStepDef,
        }),
      },
    );

    const data = await res.json() as StepRunResult;

    // Update priorStepResults so subsequent steps pick up the new value
    if (data.ok) {
      priorStepResults[step.id] = data.result;

      // If this step was where the runner stopped (it previously failed and hid the run button),
      // advance currentStepIndex and show the next-step button so the user can continue.
      if (loadedFlow) {
        const stepIdx = loadedFlow.steps.findIndex((s) => s.id === step.id);
        if (stepIdx === currentStepIndex) {
          currentStepIndex++;
          if (currentStepIndex < loadedFlow.steps.length) {
            const runBtn = document.getElementById('flow-run-step-btn') as HTMLButtonElement;
            updateRunStepButton(true);
            runBtn.disabled = false;
          } else {
            showFlowComplete();
          }
        }
      }
    }

    // Replace the result payload in the pre element
    const pre = block.querySelector<HTMLElement>('.fsr-pre')!;
    const payload = data.ok ? data.result : (data.error ?? data.result);
    pre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);

    // Update block ok/fail visual state
    block.classList.toggle('fsr-ok', data.ok);
    block.classList.toggle('fsr-fail', !data.ok);

    // Update the pass/fail badge
    const badge = block.querySelector<HTMLElement>('.fsr-badge')!;
    badge.className = `fsr-badge ${data.ok ? 'fsr-pass' : 'fsr-fail-badge'}`;
    badge.textContent = data.ok ? '✓ Pass' : '✗ Fail';

    // Close the editor and expand to show the fresh result
    editorEl.classList.add('hidden');
    const editBtn = block.querySelector<HTMLButtonElement>('.fsr-edit-btn')!;
    editBtn.textContent = 'Edit';
    block.classList.remove('fsr-collapsed');
    const chevron = block.querySelector<HTMLElement>('.fsr-toggle')!;
    if (chevron) chevron.textContent = '▼';

  } catch (err) {
    const pre = block.querySelector<HTMLElement>('.fsr-pre')!;
    pre.textContent = `Network error: ${err instanceof Error ? err.message : String(err)}`;
    block.classList.remove('fsr-ok');
    block.classList.add('fsr-fail');
  } finally {
    rerunBtn.disabled = false;
    rerunBtn.textContent = '↩ Re-run this step';
  }
}

// ── Lock In ───────────────────────────────────────────────────────────────────

async function lockInEdits(): Promise<void> {
  if (!loadedFlow) return;

  const agentId = loadedFlow['agentId'] as string | undefined;
  if (!agentId) {
    showFlowSaveStatus('error', 'Cannot save: flow has no agentId.');
    return;
  }

  const lockBtn = document.getElementById('flow-lock-in-btn') as HTMLButtonElement;
  lockBtn.disabled = true;
  lockBtn.textContent = '⏳ Saving…';

  // Build the full steps array, applying any in-memory inputMapping edits
  const mergedSteps = loadedFlow.steps.map((step) => {
    const override = editedSteps.get(step.id);
    if (!override) return step;
    return { ...step, inputMapping: override };
  });

  try {
    const res = await fetch(
      `${BACKEND_HTTP}/agents/${encodeURIComponent(agentId)}/flows/${encodeURIComponent(loadedFlow.id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: mergedSteps }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Server returned ${res.status}: ${text}`);
    }

    showFlowSaveStatus('success', '✅ Flow saved');
    // Clear edits — they are now persisted
    editedSteps.clear();
    updateLockInVisibility();
  } catch (err) {
    showFlowSaveStatus('error', err instanceof Error ? err.message : String(err));
  } finally {
    lockBtn.disabled = false;
    lockBtn.textContent = '🔒 Lock In';
  }
}
