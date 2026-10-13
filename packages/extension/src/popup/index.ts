// ── Popup script ──────────────────────────────────────────────────────────────

const BACKEND_HTTP = 'http://localhost:3001';

// Tracks the last step run in the Runner tab so "Copy step" can write it to clipboard
let lastStepForCopy: { toolName: string; fields: Record<string, unknown> } | null = null;

document.addEventListener('DOMContentLoaded', () => {
  void init();
});

// ── Step definitions ──────────────────────────────────────────────────────────

interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'number' | 'checkbox';
  placeholder?: string;
  defaultValue?: string | number | boolean;
  optional?: boolean;
  /** If true, pre-fill from lastSelector in storage */
  isSelector?: boolean;
}

interface StepDef {
  name: string;
  fields: FieldDef[];
}

const STEP_DEFS: StepDef[] = [
  // Interaction
  {
    name: 'click',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'button.submit', isSelector: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'double_click',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: '.item', isSelector: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'right_click',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: '.item', isSelector: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'hover',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: '.menu-item', isSelector: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'focus',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'input[name="q"]', isSelector: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'scroll',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'scroll into view…', isSelector: true, optional: true },
      { name: 'y', label: 'Y offset (px)', type: 'number', placeholder: '400', optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'scroll_load',
    fields: [
      { name: 'selector', label: 'Scrollable container selector', type: 'text', placeholder: '[data-testid="lazy-column"]', isSelector: true, optional: true },
      { name: 'times', label: 'Scroll cycles', type: 'number', placeholder: '3', defaultValue: 3, optional: true },
      { name: 'wait_ms', label: 'Wait between scrolls (ms)', type: 'number', placeholder: '1500', defaultValue: 1500, optional: true },
    ],
  },
  {
    name: 'click_all',
    fields: [
      { name: 'selector', label: 'CSS Selector (all matching elements)', type: 'text', placeholder: '[data-testid="expandable-text-button"]', isSelector: true },
      { name: 'limit', label: 'Max elements to click', type: 'number', placeholder: '50', defaultValue: 50, optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'click_contains',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'nav li', isSelector: true },
      { name: 'contains', label: 'Filtered HTML contains', type: 'text', placeholder: 'href="/about/" or aria-label="Posts"' },
      { name: 'scan_limit', label: 'Scan limit', type: 'number', placeholder: '200', defaultValue: 200, optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'click_all_contains',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'nav li', isSelector: true },
      { name: 'contains', label: 'Filtered HTML contains', type: 'text', placeholder: 'href="/about/" or aria-label="Posts"' },
      { name: 'limit', label: 'Max elements to click', type: 'number', placeholder: '50', defaultValue: 50, optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  // Input
  {
    name: 'type_text',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'input, textarea', isSelector: true },
      { name: 'text', label: 'Text to type', type: 'text', placeholder: 'Hello world' },
      { name: 'clear', label: 'Clear existing content first', type: 'checkbox', defaultValue: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'press_key',
    fields: [
      { name: 'key', label: 'Key', type: 'text', placeholder: 'Enter, Tab, Escape, ArrowDown…' },
      { name: 'selector', label: 'Target element', type: 'text', placeholder: 'activeElement if empty', isSelector: true, optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'select_option',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'select#country', isSelector: true },
      { name: 'value', label: 'Option value or text', type: 'text', placeholder: 'us' },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'set_checkbox',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'input[type="checkbox"]', isSelector: true },
      { name: 'checked', label: 'Check (uncheck if unticked)', type: 'checkbox', defaultValue: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  // Wait
  {
    name: 'wait_for',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: '.modal', isSelector: true },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'wait_for_any',
    fields: [
      { name: 'selectors', label: 'Selectors JSON (array of {label, selector})', type: 'text', placeholder: '[{"label":"loaded","selector":".feed"},{"label":"error","selector":".error"}]' },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'wait_for_gone',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: '.spinner', isSelector: true },
      { name: 'timeoutMs', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'wait_ms',
    fields: [
      { name: 'ms', label: 'Wait (ms)', type: 'number', placeholder: '2000', defaultValue: 2000 },
    ],
  },
  // Read
  {
    name: 'get_text',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'h1, .title', isSelector: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'get_url',
    fields: [],
  },
  {
    name: 'get_title',
    fields: [],
  },
  {
    name: 'element_exists',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: '.cookie-banner', isSelector: true },
    ],
  },
  {
    name: 'count_elements',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'li.result', isSelector: true },
    ],
  },
  {
    name: 'get_attribute',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'a.link', isSelector: true },
      { name: 'attribute', label: 'Attribute name', type: 'text', placeholder: 'href, value, checked, innerText…' },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'get_dom',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'body (default)', isSelector: true, optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'get_dom_filtered',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'body (default)', isSelector: true, optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'get_dom_filtered_all',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: '[role="listitem"]', isSelector: true },
      { name: 'limit', label: 'Limit', type: 'number', placeholder: '20', defaultValue: 20, optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  {
    name: 'get_dom_filtered_all_contains',
    fields: [
      { name: 'selector', label: 'CSS Selector', type: 'text', placeholder: 'section[componentkey]', isSelector: true },
      { name: 'contains', label: 'Contains (filtered HTML)', type: 'text', placeholder: '<h2>About</h2>' },
      { name: 'limit', label: 'Limit', type: 'number', placeholder: '20', defaultValue: 20, optional: true },
      { name: 'timeout', label: 'Timeout (ms)', type: 'number', placeholder: '10000', defaultValue: 10000, optional: true },
    ],
  },
  // Navigation
  {
    name: 'go_back',
    fields: [],
  },
  {
    name: 'go_forward',
    fields: [],
  },
  {
    name: 'reload_page',
    fields: [],
  },
];

const STEP_MAP = new Map(STEP_DEFS.map((s) => [s.name, s]));

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const data = await chrome.storage.local.get(['lastSelector', 'lastMode', 'lastRunnerStep', 'pickerDomMode', 'lastContainsValue']);
  const lastSelector = data['lastSelector'] as string | undefined;
  const lastMode = data['lastMode'] as string | undefined;
  const lastRunnerStep = data['lastRunnerStep'] as string | undefined;
  const lastContainsValue = data['lastContainsValue'] as string | undefined;
  let pickerDomMode: 'filtered' | 'raw' | 'stable' = (data['pickerDomMode'] as 'filtered' | 'raw' | 'stable') ?? 'filtered';

  // ── Tab switching ───────────────────────────────────────────────────────────
  document.getElementById('tab-picker')!.addEventListener('click', () => switchTab('picker'));
  document.getElementById('tab-runner')!.addEventListener('click', () => switchTab('runner'));
  document.getElementById('tab-flows')!.addEventListener('click', () => switchTab('flows'));

  // ── Picker panel ───────────────────────────────────────────────────────────
  if (lastSelector) {
    const section = document.getElementById('result-section')!;
    const selectorEl = document.getElementById('last-selector')!;
    const modeBadge = document.getElementById('last-mode-badge')!;
    const copyBtn = document.getElementById('copy-again') as HTMLButtonElement;

    section.style.display = 'block';
    selectorEl.textContent = lastSelector;
    modeBadge.textContent = lastMode ?? 'item';

    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(lastSelector).then(() => {
        copyBtn.textContent = '✓ Copied!';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copy again';
          copyBtn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  // ── Picker DOM mode toggle ─────────────────────────────────────────────────
  const pickerDomFilteredBtn = document.getElementById('picker-dom-filtered')!;
  const pickerDomRawBtn = document.getElementById('picker-dom-raw')!;
  const pickerDomStableBtn = document.getElementById('picker-dom-stable')!;
  const pickerDomHint = document.getElementById('picker-dom-hint')!;

  const PICKER_DOM_HINTS: Record<string, string> = {
    filtered: 'display:contents transparent',
    raw: 'raw DOM — every wrapper visible',
    stable: 'data-* anchors only — no tags or classes',
  };

  function updatePickerDomToggle(): void {
    pickerDomFilteredBtn.classList.toggle('active', pickerDomMode === 'filtered');
    pickerDomRawBtn.classList.toggle('active', pickerDomMode === 'raw');
    pickerDomStableBtn.classList.toggle('active', pickerDomMode === 'stable');
    pickerDomHint.textContent = PICKER_DOM_HINTS[pickerDomMode] ?? '';
  }

  updatePickerDomToggle();

  pickerDomFilteredBtn.addEventListener('click', () => {
    pickerDomMode = 'filtered';
    chrome.storage.local.set({ pickerDomMode }).catch(console.error);
    updatePickerDomToggle();
  });
  pickerDomRawBtn.addEventListener('click', () => {
    pickerDomMode = 'raw';
    chrome.storage.local.set({ pickerDomMode }).catch(console.error);
    updatePickerDomToggle();
  });
  pickerDomStableBtn.addEventListener('click', () => {
    pickerDomMode = 'stable';
    chrome.storage.local.set({ pickerDomMode }).catch(console.error);
    updatePickerDomToggle();
  });

  for (const mode of ['item', 'object'] as const) {
    document.getElementById(`btn-${mode}`)!.addEventListener('click', () => {
      void startPicking(mode);
    });
  }

  // ── Runner panel ────────────────────────────────────────────────────────────
  const stepSelect = document.getElementById('step-select') as HTMLSelectElement;

  // Restore last step selection
  if (lastRunnerStep && STEP_MAP.has(lastRunnerStep)) {
    stepSelect.value = lastRunnerStep;
  }

  renderInputs(stepSelect.value, lastSelector ?? '');

  stepSelect.addEventListener('change', () => {
    void chrome.storage.local.set({ lastRunnerStep: stepSelect.value });
    renderInputs(stepSelect.value, lastSelector ?? '');
    updateDomModeRow(stepSelect.value);
    hideResult();
  });

  // ── DOM mode toggle (filtered / raw) ─────────────────────────────────────
  const domModeRow      = document.getElementById('dom-mode-row')!;
  const domModeFiltered = document.getElementById('dom-mode-filtered')!;
  const domModeRaw      = document.getElementById('dom-mode-raw')!;
  const domModeHint     = document.getElementById('dom-mode-hint')!;

  function updateDomModeRow(stepName: string) {
    const show = stepName === 'get_dom_filtered' || stepName === 'get_dom';
    domModeRow.classList.toggle('visible', show);
  }

  function getActiveDomMode(): 'filtered' | 'raw' {
    return domModeRaw.classList.contains('active') ? 'raw' : 'filtered';
  }

  domModeFiltered.addEventListener('click', () => {
    domModeFiltered.classList.add('active');
    domModeRaw.classList.remove('active');
    domModeHint.textContent = 'scripts/styles/SVG/attrs stripped';
  });

  domModeRaw.addEventListener('click', () => {
    domModeRaw.classList.add('active');
    domModeFiltered.classList.remove('active');
    domModeHint.textContent = 'full HTML, no filtering';
  });

  // Initialise visibility for the default step
  updateDomModeRow(stepSelect.value);

  // Auto-fill contains field if we just returned from a contains pick
  if (lastContainsValue && stepSelect.value === 'get_dom_filtered_all_contains') {
    switchTab('runner');
    const containsInput = document.getElementById('field-contains') as HTMLInputElement | null;
    if (containsInput) containsInput.value = lastContainsValue;
    chrome.storage.local.remove('lastContainsValue').catch(console.error);
  }

  document.getElementById('run-btn')!.addEventListener('click', () => {
    void runStep();
  });

  document.getElementById('copy-step-btn')!.addEventListener('click', () => {
    if (!lastStepForCopy) return;
    const payload = JSON.stringify({ __agentspawner_step__: true, ...lastStepForCopy });
    void navigator.clipboard.writeText(payload).then(() => {
      const btn = document.getElementById('copy-step-btn')!;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = 'Copy step'; }, 1500);
    });
  });

  document.getElementById('result-copy-btn')!.addEventListener('click', () => {
    const pre = document.getElementById('result-pre')!;
    void navigator.clipboard.writeText(pre.textContent ?? '').then(() => {
      const btn = document.getElementById('result-copy-btn')!;
      const orig = btn.textContent;
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    });
  });

  // ── Flows panel ─────────────────────────────────────────────────────────────
  document.getElementById('open-flows-debugger-btn')!.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_FLOWS_DEBUGGER' });
    window.close();
  });
}

function switchTab(tab: 'picker' | 'runner' | 'flows'): void {
  document.getElementById('tab-picker')!.classList.toggle('active', tab === 'picker');
  document.getElementById('tab-runner')!.classList.toggle('active', tab === 'runner');
  document.getElementById('tab-flows')!.classList.toggle('active', tab === 'flows');
  document.getElementById('panel-picker')!.classList.toggle('active', tab === 'picker');
  document.getElementById('panel-runner')!.classList.toggle('active', tab === 'runner');
  document.getElementById('panel-flows')!.classList.toggle('active', tab === 'flows');
}

// ── Picker ────────────────────────────────────────────────────────────────────

async function startPicking(mode: 'item' | 'object' | 'contains'): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const stored = await chrome.storage.local.get('pickerDomMode');
  const domMode = (stored['pickerDomMode'] as 'filtered' | 'raw') ?? 'filtered';
  chrome.runtime.sendMessage({ type: 'PICKER_START', tabId: tab.id, mode, domMode });
  window.close();
}

// ── Runner ────────────────────────────────────────────────────────────────────

function renderInputs(stepName: string, lastSelector: string): void {
  const container = document.getElementById('step-inputs')!;
  const def = STEP_MAP.get(stepName);
  if (!def) { container.innerHTML = ''; return; }

  if (def.fields.length === 0) {
    container.innerHTML = '<div class="no-fields-hint">No inputs needed — just click Run.</div>';
    return;
  }

  container.innerHTML = def.fields.map((f) => {
    if (f.type === 'checkbox') {
      const checked = f.defaultValue === true ? 'checked' : '';
      return `
        <div class="field-group">
          <label class="checkbox-row">
            <input type="checkbox" id="field-${f.name}" ${checked}>
            <span>${f.label}</span>
          </label>
        </div>
      `;
    }

    const labelExtra = f.optional ? '<span class="opt-badge">optional</span>' : '';
    const useLastBtn = f.isSelector && lastSelector
      ? `<button class="use-last-btn" data-field="${f.name}">Use last picked</button>`
      : '';
    const pickContainsBtn = (f.name === 'contains' && stepName === 'get_dom_filtered_all_contains')
      ? `<button class="pick-contains-btn">⊂ pick</button>`
      : '';
    const value = (f.isSelector && lastSelector) ? `value="${escapeAttr(lastSelector)}"` : (f.defaultValue != null ? `value="${escapeAttr(String(f.defaultValue))}"` : '');
    const inputType = f.type === 'number' ? 'number' : 'text';

    return `
      <div class="field-group">
        <div class="field-label">
          ${f.label} ${labelExtra} ${useLastBtn} ${pickContainsBtn}
        </div>
        <input
          type="${inputType}"
          id="field-${f.name}"
          class="field-input"
          placeholder="${escapeAttr(f.placeholder ?? '')}"
          ${value}
          autocomplete="off"
          spellcheck="false"
        >
      </div>
    `;
  }).join('');

  // Wire up "Use last picked" buttons
  container.querySelectorAll('.use-last-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const fieldName = btn.getAttribute('data-field')!;
      const input = document.getElementById(`field-${fieldName}`) as HTMLInputElement;
      if (input && lastSelector) input.value = lastSelector;
    });
  });

  // Wire up "⊂ pick" button for contains field
  const pickContainsBtn = container.querySelector('.pick-contains-btn');
  if (pickContainsBtn) {
    pickContainsBtn.addEventListener('click', () => { void startPicking('contains'); });
  }

  // Allow Enter in text inputs to trigger run (except if there are more fields to fill)
  container.querySelectorAll('input[type="text"], input[type="number"]').forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void runStep();
    });
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function getFieldValues(stepName: string): Record<string, unknown> {
  const def = STEP_MAP.get(stepName);
  if (!def) return {};

  const result: Record<string, unknown> = {};
  for (const f of def.fields) {
    const el = document.getElementById(`field-${f.name}`);
    if (!el) continue;

    if (f.type === 'checkbox') {
      result[f.name] = (el as HTMLInputElement).checked;
    } else if (f.type === 'number') {
      const raw = (el as HTMLInputElement).value.trim();
      if (raw !== '') result[f.name] = Number(raw);
    } else {
      const raw = (el as HTMLInputElement).value.trim();
      if (raw !== '') result[f.name] = raw;
    }
  }
  return result;
}

async function runStep(): Promise<void> {
  const stepSelect = document.getElementById('step-select') as HTMLSelectElement;
  let stepName = stepSelect.value;
  const input = getFieldValues(stepName);

  // DOM mode override — when filtered/raw toggle is visible, honour it
  if (stepName === 'get_dom_filtered' || stepName === 'get_dom') {
    const mode = (document.getElementById('dom-mode-raw') as HTMLButtonElement).classList.contains('active') ? 'raw' : 'filtered';
    stepName = mode === 'raw' ? 'get_dom_raw' : 'get_dom_filtered';
  }

  const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
  runBtn.textContent = '⏳ Running…';
  runBtn.classList.add('running');
  runBtn.disabled = true;
  hideResult();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found');

    const correlationId = `popup-${Date.now()}`;

    const response = await new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
      chrome.tabs.sendMessage(
        tab.id!,
        {
          type: 'EXECUTE_PRIMITIVE',
          correlationId,
          toolName: stepName,
          input,
          code: '',
        },
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message ?? 'Content script not available'));
            return;
          }
          resolve(resp as { result?: unknown; error?: string });
        },
      );
    });

    const resultData = response?.result ?? response;
    const isError = resultData && typeof resultData === 'object' && 'error' in (resultData as Record<string, unknown>);
    if (!isError) lastStepForCopy = { toolName: stepName, fields: input };
    showResult(!isError, resultData);
  } catch (err) {
    showResult(false, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    runBtn.textContent = '▶ Run';
    runBtn.classList.remove('running');
    runBtn.disabled = false;
  }
}

function showResult(success: boolean, data: unknown): void {
  const area = document.getElementById('result-area')!;
  const status = document.getElementById('result-status')!;
  const pre = document.getElementById('result-pre')!;
  const charCount = document.getElementById('result-char-count')!;
  const copyStepBtn = document.getElementById('copy-step-btn') as HTMLButtonElement;

  area.classList.remove('hidden', 'success', 'error');
  area.classList.add(success ? 'success' : 'error');
  status.textContent = success ? '✓ Success' : '✗ Error';
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  pre.textContent = text;

  const len = text.length;
  charCount.textContent = len >= 1000
    ? `${(len / 1000).toFixed(1)}k chars`
    : `${len} chars`;

  // Show "Copy step" only on success so user can paste it into the flow builder
  copyStepBtn.style.display = success ? '' : 'none';
  copyStepBtn.textContent = 'Copy step';
}

function hideResult(): void {
  document.getElementById('result-area')!.classList.add('hidden');
  (document.getElementById('copy-step-btn') as HTMLButtonElement).style.display = 'none';
}

// ── Flows ─────────────────────────────────────────────────────────────────────
// (All flows logic has moved to flows-debugger/index.ts)
