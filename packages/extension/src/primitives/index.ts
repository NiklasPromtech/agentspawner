// All browser primitives — run in content script context

export interface PrimitiveInput {
  url?: string;
  tabId?: number;
  selector?: string;
  text?: string;
  value?: string;   // for select_option
  checked?: boolean; // for set_checkbox
  ms?: number;       // for wait_ms
  x?: number;
  y?: number;
  scrollY?: number;
  timeout?: number;
  timeoutMs?: number;
  code?: string;
  key?: string;
  attribute?: string;
  clear?: boolean;
  selectors?: Array<{ label: string; selector: string }>;
  items?: string[];
  html?: string;
  limit?: number;
  [key: string]: unknown; // allow arbitrary extension fields
}

export async function open_tab(input: PrimitiveInput): Promise<unknown> {
  // Runs in background, not content script
  return { error: 'open_tab must be called from background' };
}

export async function close_tab(input: PrimitiveInput): Promise<unknown> {
  return { error: 'close_tab must be called from background' };
}

export async function navigate(input: PrimitiveInput): Promise<unknown> {
  if (input.url) {
    window.location.href = input.url;
    return { success: true };
  }
  return { error: 'url required' };
}

export async function wait_for(input: PrimitiveInput): Promise<unknown> {
  const selector = input.selector ?? 'body';
  const timeout = input.timeoutMs ?? input.timeout ?? 10000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (document.querySelector(selector)) return { found: true, selector };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { found: false, selector, timedOut: true };
}

export async function wait_for_any(input: PrimitiveInput): Promise<unknown> {
  const pairs = input.selectors ?? [];
  const timeout = input.timeoutMs ?? input.timeout ?? 10000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const { label, selector } of pairs) {
      if (document.querySelector(selector)) return { found: label, selector };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { found: 'timeout', timedOut: true };
}

// ── Implicit wait helper ──────────────────────────────────────────────────────
// Polls document.querySelector every 200 ms up to timeoutMs.
// Pass timeout=0 to skip polling and do a single immediate lookup.
async function waitForElement(selector: string, timeoutMs: number): Promise<Element | null> {
  if (timeoutMs === 0) return document.querySelector(selector);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const el = document.querySelector(selector);
    if (el) return el;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

export async function click(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? await waitForElement(input.selector, input.timeout ?? 10000) : null;
  if (!el) return { error: `Element not found: ${input.selector}` };
  (el as HTMLElement).click();
  return { success: true, selector: input.selector };
}

export async function type_text(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector
    ? await waitForElement(input.selector, input.timeout ?? 10000)
    : document.activeElement;
  if (!el) return { error: `Element not found: ${input.selector}` };

  const htmlEl = el as HTMLElement;
  const isContentEditable =
    htmlEl.isContentEditable ||
    htmlEl.getAttribute('contenteditable') === 'true' ||
    htmlEl.getAttribute('contenteditable') === '';

  htmlEl.focus();
  const text = input.text ?? '';
  const shouldClear = input.clear !== false;

  if (isContentEditable) {
    // Rich text editors (LinkedIn, Twitter, Reddit comment boxes, etc.)
    // Standard .value assignment is dead on contenteditable — use execCommand
    if (shouldClear) {
      // Select all and delete existing content
      document.execCommand('selectAll', false, undefined);
      document.execCommand('delete', false, undefined);
    }
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      // execCommand may be disabled in some sandboxed contexts — fall back to
      // dispatching an InputEvent which most React/Vue apps listen to
      const event = new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: 'insertText',
      });
      htmlEl.dispatchEvent(event);
    }
    htmlEl.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, method: 'contenteditable' };
  } else {
    // Standard <input> / <textarea>
    const inputEl = el as HTMLInputElement;
    if (shouldClear) inputEl.value = '';
    for (const char of text) {
      inputEl.value += char;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: char, inputType: 'insertText' }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, method: 'input' };
  }
}

export async function scroll(input: PrimitiveInput): Promise<unknown> {
  // Scroll a specific element into view if selector given
  if (input.selector) {
    const el = await waitForElement(input.selector, input.timeout ?? 10000);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return { success: true, scrolledTo: input.selector };
    }
    return { error: `Element not found: ${input.selector}` };
  }
  // Otherwise scroll the window by x/y offsets (y takes precedence; scrollY is legacy alias)
  const yDelta = input.y ?? input.scrollY ?? 0;
  const xDelta = input.x ?? 0;
  window.scrollBy({ top: yDelta, left: xDelta, behavior: 'smooth' });
  return { success: true, scrolled: { x: xDelta, y: yDelta } };
}

export async function scroll_load(input: PrimitiveInput): Promise<unknown> {
  const times  = Math.min(typeof input.times  === 'number' ? input.times  : 3,  20);
  const waitMs = Math.min(typeof input.wait_ms === 'number' ? input.wait_ms : 1_500, 10_000);

  // If a selector is given, scroll the PAGE to the bottom of that element using
  // scrollIntoView — this matches how the scroll primitive works and correctly
  // triggers IntersectionObservers on feeds where the container itself is not
  // internally scrollable (overflow:hidden). As new content loads the container
  // grows, so each subsequent scrollIntoView reaches further down the page.
  // Without a selector, use window.scrollTo — more reliable on SPAs where
  // <html> has overflow:hidden and documentElement.scrollHeight is just the viewport.
  const containerEl: HTMLElement | null = input.selector
    ? document.querySelector<HTMLElement>(input.selector)
    : null;

  if (input.selector && !containerEl) {
    return { error: `Element not found: ${input.selector}` };
  }

  function getHeight(): number {
    // When targeting a container, measure its scrollHeight — it grows as new
    // content is appended regardless of whether the container has overflow:hidden.
    // For window scroll, fall back to body/documentElement.
    if (containerEl) return containerEl.scrollHeight;
    return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  }

  function scrollToBottom(): void {
    if (containerEl) {
      containerEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
    } else {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    }
  }

  const heightStart = getHeight();
  let heightPrev = heightStart;
  let cycles = 0;
  let noChangeCycles = 0;

  for (let i = 0; i < times; i++) {
    scrollToBottom();
    await new Promise<void>((r) => setTimeout(r, waitMs));
    cycles++;
    const heightNow = getHeight();
    if (heightNow === heightPrev) {
      noChangeCycles++;
      if (noChangeCycles >= 2) break; // two consecutive no-change cycles = feed exhausted
    } else {
      noChangeCycles = 0;
    }
    heightPrev = heightNow;
  }

  const heightEnd = getHeight();
  return {
    cycles_completed: cycles,
    height_start: heightStart,
    height_end: heightEnd,
    new_content_loaded: heightEnd > heightStart,
  };
}

export async function get_dom(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector
    ? await waitForElement(input.selector, input.timeout ?? 10000)
    : document.documentElement;
  if (!el) return { error: `Element not found: ${input.selector}` };
  const html = (el as HTMLElement).outerHTML;
  return { html: html.slice(0, 50_000) }; // capped — server applies light filter on top
}

export async function click_all(input: PrimitiveInput): Promise<unknown> {
  const selector = input.selector as string;
  if (!selector) return { error: 'selector is required' };
  const limit = typeof input.limit === 'number' ? Math.min(input.limit, 200) : 50;

  // Wait for at least one element to appear before snapshotting
  const first = await waitForElement(selector, input.timeout ?? 10000);
  if (!first) return { error: `Element not found: ${selector}` };

  // Snapshot the matching elements upfront — clicking one may remove it from
  // the live NodeList (e.g. a "dismiss" button), which would shift indices and
  // cause the loop to skip elements. Array.from freezes the set at query time.
  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).slice(0, limit);

  let clicked = 0;
  let errors = 0;
  for (const el of elements) {
    try {
      el.click();
      clicked++;
    } catch {
      errors++;
    }
  }

  return { clicked, errors, total_found: elements.length };
}

export async function click_contains(input: PrimitiveInput): Promise<unknown> {
  if (!input.selector) return { error: 'selector is required' };
  if (!input.contains) return { error: 'contains is required' };
  const contains = input.contains as string;
  const scanLimit = typeof input.scan_limit === 'number' ? Math.min(input.scan_limit, 500) : 200;

  const first = await waitForElement(input.selector, input.timeout ?? 10000);
  if (!first) return { error: `Element not found: ${input.selector}` };

  const all = Array.from(document.querySelectorAll<HTMLElement>(input.selector)).slice(0, scanLimit);
  for (let i = 0; i < all.length; i++) {
    if (_applyDomFilter(all[i].outerHTML).includes(contains)) {
      all[i].click();
      return { success: true, matched_index: i, selector: input.selector, contains };
    }
  }
  return { error: `No element matching contains "${contains}" found among ${all.length} candidates` };
}

export async function click_all_contains(input: PrimitiveInput): Promise<unknown> {
  if (!input.selector) return { error: 'selector is required' };
  if (!input.contains) return { error: 'contains is required' };
  const contains = input.contains as string;
  const limit = typeof input.limit === 'number' ? Math.min(input.limit, 200) : 50;

  const first = await waitForElement(input.selector, input.timeout ?? 10000);
  if (!first) return { error: `Element not found: ${input.selector}` };

  const all = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const matched: HTMLElement[] = [];
  for (const el of all) {
    if (matched.length >= limit) break;
    if (_applyDomFilter(el.outerHTML).includes(contains)) matched.push(el);
  }

  let clicked = 0;
  let errors = 0;
  for (const el of matched) {
    try { el.click(); clicked++; } catch { errors++; }
  }
  return { clicked, errors, matched: matched.length, total_scanned: all.length };
}

export async function get_dom_raw(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector
    ? await waitForElement(input.selector, input.timeout ?? 10000)
    : document.documentElement;
  if (!el) return { error: `Element not found: ${input.selector}` };
  const html = (el as HTMLElement).outerHTML;
  return { html }; // no cap — applyDomFilter/get_dom_filtered applies the 50k cap after stripping attributes
}

export async function get_dom_raw_all(input: PrimitiveInput): Promise<unknown> {
  if (!input.selector) return { error: 'selector is required' };
  const limit = typeof input.limit === 'number' ? Math.min(input.limit, 200) : 50;
  const first = await waitForElement(input.selector, input.timeout ?? 10000);
  if (!first) return { error: `Element not found: ${input.selector}` };
  const els = Array.from(document.querySelectorAll<HTMLElement>(input.selector)).slice(0, limit);
  const items = els.map((el) => el.outerHTML);
  return { items, count: els.length };
}

const _DOM_KEEP_ATTRS = new Set([
  'href', 'src', 'alt', 'aria-label', 'aria-hidden',
  'id', 'type', 'name', 'value', 'placeholder', 'title',
]);

function _applyDomFilter(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<([a-zA-Z][a-zA-Z0-9-]*)(\s[^>]*)?>/g, (_match: string, tagName: string, attrStr = '') => {
      let kept = '';
      for (const attr of _DOM_KEEP_ATTRS) {
        const m = (attrStr as string).match(new RegExp(`\\s${attr}=["']([^"']*)["']`, 'i'));
        if (m) kept += ` ${attr}="${m[1]}"`;
      }
      return `<${tagName}${kept}>`;
    })
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 50_000);
}

export async function get_dom_filtered(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector
    ? await waitForElement(input.selector, input.timeout ?? 10000)
    : document.documentElement;
  if (!el) return { error: `Element not found: ${input.selector}` };
  const raw = (el as HTMLElement).outerHTML;
  return { html: _applyDomFilter(raw) };
}

export async function get_dom_filtered_all(input: PrimitiveInput): Promise<unknown> {
  if (!input.selector) return { error: 'selector is required' };
  const limit = typeof input.limit === 'number' ? Math.min(input.limit, 200) : 20;
  const first = await waitForElement(input.selector, input.timeout ?? 10000);
  if (!first) return { error: `Element not found: ${input.selector}` };
  const els = Array.from(document.querySelectorAll<HTMLElement>(input.selector)).slice(0, limit);
  const items = els.map((el) => _applyDomFilter(el.outerHTML).slice(0, 10_000));
  return { items, count: els.length };
}

export async function get_dom_filtered_all_contains(input: PrimitiveInput): Promise<unknown> {
  if (!input.selector) return { error: 'selector is required' };
  if (!input.contains) return { error: 'contains is required' };
  const contains = input.contains as string;
  const limit = typeof input.limit === 'number' ? Math.min(input.limit, 200) : 20;
  const first = await waitForElement(input.selector, input.timeout ?? 10000);
  if (!first) return { error: `Element not found: ${input.selector}` };
  const all = Array.from(document.querySelectorAll<HTMLElement>(input.selector));
  const items: string[] = [];
  for (const el of all) {
    if (items.length >= limit) break;
    const filtered = _applyDomFilter(el.outerHTML).slice(0, 10_000);
    if (filtered.includes(contains)) items.push(filtered);
  }
  return { items, count: items.length };
}

export async function screenshot(_input: PrimitiveInput): Promise<unknown> {
  // Screenshots require background script with chrome.tabs.captureVisibleTab
  return { error: 'screenshot requires background context' };
}

export async function execute_code(input: PrimitiveInput): Promise<unknown> {
  if (!input.code) return { error: 'code required' };
  const fn = new Function('input', `"use strict"; return (async () => { ${input.code} })()`);
  return fn(input);
}

// ── New primitives ───────────────────────────────────────────────────────────

export async function press_key(input: PrimitiveInput): Promise<unknown> {
  const key = input.key;
  if (!key) return { error: 'key required' };

  let target: EventTarget;
  if (input.selector) {
    const el = await waitForElement(input.selector, input.timeout ?? 10000);
    if (!el) return { error: `Element not found: ${input.selector}` };
    target = el;
  } else {
    target = document.activeElement ?? document;
  }

  const opts: KeyboardEventInit = { key, bubbles: true, cancelable: true };
  (target as EventTarget).dispatchEvent(new KeyboardEvent('keydown', opts));
  (target as EventTarget).dispatchEvent(new KeyboardEvent('keypress', opts));
  (target as EventTarget).dispatchEvent(new KeyboardEvent('keyup', opts));

  // For Enter on a form/contenteditable also dispatch as submit/input event
  if (key === 'Enter') {
    const el = target as HTMLElement;
    if (el.tagName === 'FORM') {
      el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    } else {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertParagraph' }));
    }
  }

  return { success: true, key, target: input.selector ?? 'activeElement' };
}

export async function focus(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? await waitForElement(input.selector, input.timeout ?? 10000) : null;
  if (!el) return { error: `Element not found: ${input.selector}` };
  (el as HTMLElement).focus();
  el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  return { success: true, selector: input.selector };
}

export async function hover(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? await waitForElement(input.selector, input.timeout ?? 10000) : null;
  if (!el) return { error: `Element not found: ${input.selector}` };
  const htmlEl = el as HTMLElement;
  htmlEl.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true, cancelable: true }));
  htmlEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true }));
  htmlEl.dispatchEvent(new MouseEvent('mousemove',  { bubbles: true, cancelable: true }));
  return { success: true, selector: input.selector };
}

export async function get_attribute(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? await waitForElement(input.selector, input.timeout ?? 10000) : null;
  if (!el) return { error: `Element not found: ${input.selector}` };
  if (!input.attribute) return { error: 'attribute required' };

  const htmlEl = el as HTMLElement & Record<string, unknown>;
  // Try as a JS property first (value, checked, innerText, etc.), then as HTML attribute
  const propValue = htmlEl[input.attribute];
  const attrValue = el.getAttribute(input.attribute);

  return {
    attribute: input.attribute,
    value: propValue !== undefined ? propValue : attrValue,
    propertyValue: propValue !== undefined ? propValue : undefined,
    attributeValue: attrValue,
  };
}

// ── Additional interaction primitives ────────────────────────────────────────

export async function double_click(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? await waitForElement(input.selector, input.timeout ?? 10000) : null;
  if (!el) return { error: `Element not found: ${input.selector}` };
  const htmlEl = el as HTMLElement;
  htmlEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 2 }));
  htmlEl.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, detail: 2 }));
  htmlEl.dispatchEvent(new MouseEvent('dblclick',  { bubbles: true, cancelable: true, detail: 2 }));
  return { success: true, selector: input.selector };
}

export async function right_click(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? await waitForElement(input.selector, input.timeout ?? 10000) : null;
  if (!el) return { error: `Element not found: ${input.selector}` };
  (el as HTMLElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  return { success: true, selector: input.selector };
}

export async function select_option(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? await waitForElement(input.selector, input.timeout ?? 10000) : null;
  if (!el) return { error: `Element not found: ${input.selector}` };
  const selectEl = el as HTMLSelectElement;
  if (!input.value && !input.text) return { error: 'value or text required' };

  // Match by value first, then by visible text
  let matched = false;
  for (const opt of Array.from(selectEl.options)) {
    if (opt.value === input.value || opt.text === input.text || opt.text === input.value) {
      selectEl.value = opt.value;
      matched = true;
      break;
    }
  }
  if (!matched) return { error: `Option not found: ${input.value ?? input.text}` };

  selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  selectEl.dispatchEvent(new Event('input', { bubbles: true }));
  return { success: true, selectedValue: selectEl.value };
}

export async function set_checkbox(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? await waitForElement(input.selector, input.timeout ?? 10000) : null;
  if (!el) return { error: `Element not found: ${input.selector}` };
  const checkEl = el as HTMLInputElement;

  // If `checked` is not provided, toggle; otherwise set to specified value
  const desired = input.checked !== undefined ? input.checked : !checkEl.checked;
  if (checkEl.checked !== desired) {
    checkEl.click(); // click() handles both check & uncheck + fires events naturally
  }
  return { success: true, checked: checkEl.checked };
}

export async function get_text(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector
    ? await waitForElement(input.selector, input.timeout ?? 10000)
    : document.body;
  if (!el) return { error: `Element not found: ${input.selector}` };
  return { text: (el as HTMLElement).innerText?.trim() ?? '' };
}

export async function get_url(_input: PrimitiveInput): Promise<unknown> {
  return { url: window.location.href, origin: window.location.origin, pathname: window.location.pathname };
}

export async function get_title(_input: PrimitiveInput): Promise<unknown> {
  return { title: document.title };
}

export async function element_exists(input: PrimitiveInput): Promise<unknown> {
  const el = input.selector ? document.querySelector(input.selector) : null;
  const exists = !!el;
  // label field allows "Result label equals false" conditions to detect missing elements
  return { exists, label: String(exists), selector: input.selector };
}

export async function count_elements(input: PrimitiveInput): Promise<unknown> {
  if (!input.selector) return { error: 'selector required' };
  const count = document.querySelectorAll(input.selector).length;
  return { count, selector: input.selector };
}

export async function wait_for_gone(input: PrimitiveInput): Promise<unknown> {
  const selector = input.selector ?? 'body';
  const timeout = input.timeoutMs ?? input.timeout ?? 10000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!document.querySelector(selector)) return { gone: true, selector };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { gone: false, selector, timedOut: true };
}

export async function wait_ms(input: PrimitiveInput): Promise<unknown> {
  const ms = input.ms ?? 1000;
  await new Promise((r) => setTimeout(r, Math.min(ms, 30_000))); // cap at 30s for sanity
  return { waited: ms };
}

export async function go_back(_input: PrimitiveInput): Promise<unknown> {
  window.history.back();
  return { success: true };
}

export async function go_forward(_input: PrimitiveInput): Promise<unknown> {
  window.history.forward();
  return { success: true };
}

export async function reload_page(_input: PrimitiveInput): Promise<unknown> {
  window.location.reload();
  return { success: true };
}

// ─── Background-context stubs ─────────────────────────────────────────────────
// list_tabs / switch_tab are handled via TAB_OP in background/index.ts.
// When called as a primitive (content script), we return a guidance error.

export async function list_tabs(_input: PrimitiveInput): Promise<unknown> {
  return { error: 'list_tabs requires background context — use it from flow code via TAB_OP' };
}

export async function switch_tab(_input: PrimitiveInput): Promise<unknown> {
  return { error: 'switch_tab requires background context — use it from flow code via TAB_OP' };
}

export const PRIMITIVES: Record<string, (input: PrimitiveInput) => Promise<unknown>> = {
  open_tab,
  close_tab,
  navigate,
  wait_for,
  wait_for_any,
  click,
  click_contains,
  click_all_contains,
  double_click,
  right_click,
  type_text,
  select_option,
  set_checkbox,
  scroll,
  scroll_load,
  click_all,
  press_key,
  focus,
  hover,
  get_dom,
  get_dom_raw,
  get_dom_raw_all,
  get_dom_filtered,
  get_dom_filtered_all,
  get_dom_filtered_all_contains,
  get_text,
  get_url,
  get_title,
  get_attribute,
  element_exists,
  count_elements,
  wait_for_gone,
  wait_ms,
  go_back,
  go_forward,
  reload_page,
  screenshot,
  execute_code,
  list_tabs,
  switch_tab,
};
