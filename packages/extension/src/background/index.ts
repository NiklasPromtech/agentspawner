import type { OffscreenMessage } from '../protocol.js';

const BACKEND_HTTP = 'http://localhost:3001';

// ── Recording state ───────────────────────────────────────────────────────────

let recordingTabId: number | null = null;
let recordingPrevUrl: string | null = null;

// ── Flows Debugger window state ────────────────────────────────────────────────

let flowsDebuggerWindowId: number | null = null;

async function startRecording(url: string): Promise<void> {
  const normalized = /^https?:\/\//i.test(url) ? url : 'https://' + url;
  const tab = await chrome.tabs.create({ url: normalized, active: true });
  if (!tab.id) return;

  recordingTabId = tab.id;
  recordingPrevUrl = normalized;

  // Log the initial navigate event
  await fetch(`${BACKEND_HTTP}/recording/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'navigate', url: normalized }),
  });

  // Wait for load then inject the recorder badge
  await waitForTabLoad(tab.id);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injectedRecorderFn,
  });
}

// ── Macro recorder injected function ─────────────────────────────────────────

// This function is serialized and injected into the target page. Must be self-contained.
function injectedRecorderFn(): void {
  const BADGE_ID = '__agsp_recorder_badge__';
  if (document.getElementById(BADGE_ID)) return;

  let eventCount = 0;

  const badge = document.createElement('div');
  badge.id = BADGE_ID;
  const bs = badge.style;
  bs.position = 'fixed';
  bs.top = '12px';
  bs.right = '12px';
  bs.background = '#991b1b';
  bs.color = 'white';
  bs.padding = '6px 12px';
  bs.borderRadius = '6px';
  bs.fontSize = '13px';
  bs.fontFamily = 'monospace';
  bs.fontWeight = 'bold';
  bs.zIndex = '2147483647';
  bs.boxShadow = '0 2px 10px rgba(0,0,0,0.5)';
  bs.display = 'flex';
  bs.gap = '10px';
  bs.alignItems = 'center';
  bs.userSelect = 'none';

  const label = document.createElement('span');
  label.textContent = '● REC 0';
  badge.appendChild(label);

  const stopBtn = document.createElement('button');
  stopBtn.textContent = '■ Stop';
  const sbs = stopBtn.style;
  sbs.background = 'rgba(0,0,0,0.35)';
  sbs.color = 'white';
  sbs.border = '1px solid rgba(255,255,255,0.35)';
  sbs.borderRadius = '4px';
  sbs.padding = '2px 8px';
  sbs.fontSize = '12px';
  sbs.cursor = 'pointer';
  sbs.fontFamily = 'monospace';
  badge.appendChild(stopBtn);

  document.documentElement.appendChild(badge);

  stopBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    cleanup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome as any).runtime.sendMessage({ type: 'RECORDER_STOP' });
  });

  // --- Selector utilities (self-contained) ---
  function isDynamic(str: string): boolean {
    if (/^\d+$/.test(str)) return true;
    if (/[a-f0-9]{8,}/i.test(str)) return true;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(str)) return true;
    if (/\d{5,}/.test(str)) return true;
    if (/__[a-zA-Z0-9]*\d[a-zA-Z0-9]*$/.test(str)) return true;
    if (/^[a-z]{1,4}-[a-z0-9]{5,}$/i.test(str) && /\d/.test(str)) return true;
    // Framework-generated IDs: ember75, ember-view-33, ng-model-42, etc.
    if (/^ember[\d-]/i.test(str)) return true;
    if (/^ng-[a-z]+-\d+$/i.test(str)) return true;
    return false;
  }

  function stableClasses(el: Element): string[] {
    return Array.from(el.classList).filter((c) => !isDynamic(c));
  }

  function buildAtomicSelector(el: Element): string | null {
    if (el.id && !isDynamic(el.id)) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-id', 'data-urn', 'data-view-id']) {
      const v = el.getAttribute(attr);
      if (v) return '[' + attr + "='" + v + "']";
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return el.tagName.toLowerCase() + "[aria-label='" + ariaLabel + "']";
    const name = el.getAttribute('name');
    if (name && !isDynamic(name)) return el.tagName.toLowerCase() + "[name='" + CSS.escape(name) + "']";
    return null;
  }

  function buildPathSegment(el: Element): string {
    const atomic = buildAtomicSelector(el);
    if (atomic) return atomic;
    const tag = el.tagName.toLowerCase();
    const cls = stableClasses(el);
    if (cls.length > 0) {
      const candidate = tag + cls.slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    if (el.parentElement) {
      const siblings = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
      if (siblings.length > 1) return tag + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
    }
    return tag;
  }

  function buildSelector(el: Element): string {
    const atomic = buildAtomicSelector(el);
    if (atomic && document.querySelectorAll(atomic).length === 1) return atomic;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      parts.unshift(buildPathSegment(cur));
      const joined = parts.join(' > ');
      if (document.querySelectorAll(joined).length === 1) return joined;
      cur = cur.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // --- Event capture ---
  function sendEvent(event: Record<string, unknown>): void {
    eventCount++;
    label.textContent = '● REC ' + eventCount;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome as any).runtime.sendMessage({ type: 'RECORD_EVENT', event });
  }

  function onClick(e: Event): void {
    const target = e.target as Element;
    if (badge.contains(target)) return;
    const tag = target.tagName.toLowerCase();
    const isEditable = ['input', 'textarea', 'select'].includes(tag) || (target as HTMLElement).isContentEditable;
    if (isEditable) return;
    const selector = buildSelector(target);
    const text = (target as HTMLElement).textContent?.trim().slice(0, 80) ?? '';
    sendEvent({ type: 'click', selector, text });
  }

  function onBlur(e: Event): void {
    const target = e.target as HTMLInputElement;
    if (badge.contains(target)) return;
    const tag = target.tagName.toLowerCase();
    if (!['input', 'textarea'].includes(tag) && !(target as HTMLElement).isContentEditable) return;
    if (tag === 'input' && target.type === 'password') return;
    const value = target.value ?? target.textContent ?? '';
    if (!value.trim()) return;
    const selector = buildSelector(target);
    sendEvent({ type: 'type', selector, value });
  }

  function cleanup(): void {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('blur', onBlur, true);
    badge.remove();
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('blur', onBlur, true);
}

// ── Selector picker ───────────────────────────────────────────────────────────

// This function is serialized and injected into the target page by executeScript.
// It must be entirely self-contained (no external references).
function injectedPickerFn(mode: string, domMode: string): void {
  const OVERLAY_ID = '__agsp_picker_overlay__';
  if (document.getElementById(OVERLAY_ID)) return; // prevent double injection

  // --- Green overlay: the specific element being hovered ---
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  const ols = overlay.style;
  ols.position = 'absolute';
  ols.pointerEvents = 'none';
  ols.border = '2px solid #2ea043';
  ols.background = 'rgba(46,160,67,0.1)';
  ols.borderRadius = '3px';
  ols.zIndex = '2147483647';
  ols.display = 'none';
  ols.boxSizing = 'border-box';
  document.documentElement.appendChild(overlay);

  // --- Mode label badge (two lines: static header + live selector/count) ---
  const badge = document.createElement('div');
  const bs = badge.style;
  bs.position = 'fixed';
  bs.top = '10px';
  bs.right = '10px';
  bs.background = '#1a73e8';
  bs.color = 'white';
  bs.padding = '6px 12px';
  bs.borderRadius = '4px';
  bs.fontSize = '12px';
  bs.fontFamily = 'monospace';
  bs.fontWeight = 'bold';
  bs.zIndex = '2147483647';
  bs.pointerEvents = 'none';
  bs.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
  bs.maxWidth = '480px';
  bs.lineHeight = '1.5';

  const badgeLine1 = document.createElement('div');
  badgeLine1.textContent = 'AgentSpawner · ' + mode.toUpperCase() + ' [' + domMode + '] · Esc to cancel';

  const badgeLine2 = document.createElement('div');
  badgeLine2.style.fontSize = '10px';
  badgeLine2.style.fontWeight = 'normal';
  badgeLine2.style.opacity = '0.85';
  badgeLine2.style.marginTop = '2px';
  badgeLine2.style.whiteSpace = 'nowrap';
  badgeLine2.style.overflow = 'hidden';
  badgeLine2.style.textOverflow = 'ellipsis';
  badgeLine2.textContent = 'hover to preview selector…';

  badge.appendChild(badgeLine1);
  badge.appendChild(badgeLine2);
  document.documentElement.appendChild(badge);

  // Compute candidate selector + querySelectorAll count for the badge preview.
  // Wrapped in try/catch because partially-built selectors can be invalid mid-walk.
  function updateBadgePreview(target: Element): void {
    try {
      const sel = domMode === 'stable'
        ? buildStableSelector(target)
        : buildSelector(target);

      // How many elements match this selector on the page
      const matchCount = document.querySelectorAll(sel).length;

      // How many logical siblings look the same (the blue "siblings" picture)
      const siblingCount = countLogicalSiblings(target);

      const display = sel.length > 50 ? '…' + sel.slice(sel.length - 49) : sel;

      // Show: selector  ×1 · 8 similar
      // "×1" = how many this selector matches (green story)
      // "8 similar" = how many look like this in the same container (blue story)
      badgeLine2.textContent = display + '  ×' + matchCount
        + (siblingCount > 1 ? '  ·  ' + siblingCount + ' similar' : '');
    } catch {
      badgeLine2.textContent = '—';
    }
  }

  let currentTarget: Element | null = null;
  // Blue sibling overlay pool
  let childOverlays: HTMLElement[] = [];

  // --- display:contents helpers ---
  // LinkedIn (and similar) wraps real list items in <div data-display-contents="true"> which
  // is invisible to layout (like display:contents in CSS). The picker must treat these as
  // transparent — skipping them when walking up and when collecting siblings.

  function isDisplayContents(el: Element): boolean {
    // In raw mode we treat everything as opaque — no transparency logic.
    if (domMode === 'raw') return false;
    return (
      el.getAttribute('data-display-contents') === 'true' ||
      (el as HTMLElement).style?.display === 'contents'
    );
  }

  // Walk up, ignoring display:contents wrappers
  function logicalParentOf(el: Element): Element | null {
    let p = el.parentElement;
    while (p && isDisplayContents(p) && p.parentElement) p = p.parentElement;
    return p;
  }

  // Direct children of container, flattening any display:contents children one level deep
  function logicalChildrenOf(container: Element): Element[] {
    const result: Element[] = [];
    for (const child of Array.from(container.children)) {
      if (isDisplayContents(child)) {
        for (const grandchild of Array.from(child.children)) result.push(grandchild);
      } else {
        result.push(child);
      }
    }
    return result;
  }

  // --- Selector utilities ---

  function isDynamic(str: string): boolean {
    if (/^\d+$/.test(str)) return true;
    if (/[a-f0-9]{8,}/i.test(str)) return true;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(str)) return true;
    if (/\d{5,}/.test(str)) return true;
    if (/__[a-zA-Z0-9]*\d[a-zA-Z0-9]*$/.test(str)) return true; // CSS modules hash suffix (must contain a digit, e.g. __xK9Qd, not BEM __content)
    // Framework-generated utility classes: short prefix + 5+ alphanumeric chars containing digits
    // Catches: css-175oi2r (styled-components), r-1f2l425 (Twitter/X), sc-abc123, etc.
    if (/^[a-z]{1,4}-[a-z0-9]{5,}$/i.test(str) && /\d/.test(str)) return true;
    // Framework-generated IDs: ember75, ember-view-33, ng-model-42, etc.
    if (/^ember[\d-]/i.test(str)) return true;
    if (/^ng-[a-z]+-\d+$/i.test(str)) return true;
    return false;
  }

  function stableClasses(el: Element): string[] {
    return Array.from(el.classList).filter((c) => !isDynamic(c));
  }

  function buildAtomicSelector(el: Element): string | null {
    if (el.id && !isDynamic(el.id)) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-id', 'data-urn', 'data-view-id']) {
      const v = el.getAttribute(attr);
      // Use single quotes inside the selector so it pastes safely into JS console double-quoted strings
      if (v) return '[' + attr + "='" + v + "']";
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return el.tagName.toLowerCase() + "[aria-label='" + ariaLabel + "']";
    const name = el.getAttribute('name');
    if (name && !isDynamic(name)) return el.tagName.toLowerCase() + "[name='" + CSS.escape(name) + "']";
    return null;
  }

  // Semantic tags worth including in the stable path even without a data attribute.
  const SEMANTIC_TAGS = new Set([
    'section', 'article', 'aside', 'nav', 'main', 'header', 'footer',
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'button', 'a', 'form', 'table', 'tr', 'td', 'th',
    'figure', 'figcaption', 'details', 'summary', 'dialog',
  ]);

  // Attributes too noisy to use as stable anchors.
  const SKIP_ATTRS = new Set([
    'class', 'style', 'id', 'tabindex', 'contenteditable', 'hidden',
    'draggable', 'spellcheck', 'translate', 'dir', 'lang', 'title',
    'role', 'slot', 'part',
  ]);

  // Extended segment for buildStableSelector walk-up.
  // Falls back to custom attributes and semantic tags when buildAtomicSelector returns null.
  function buildStableSegment(el: Element): string | null {
    const atomic = buildAtomicSelector(el);
    if (atomic) return atomic;

    const tag = el.tagName.toLowerCase();

    // Non-standard / custom attributes (e.g. componentKey, data-sdui-screen) — always
    // presence selectors, never equality. Values for these are often hashes, namespaced
    // IDs, or user-specific refs. Only buildAtomicSelector (data-testid, id, aria-label)
    // ever includes values — everything here is structural signal only.
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name;
      if (SKIP_ATTRS.has(n)) continue;
      if (n.startsWith('aria-')) continue;
      if (n.startsWith('on')) continue;
      const v = attr.value;
      if (n.startsWith('data-')) {
        if (v) return '[' + n + ']'; // presence only
        continue; // empty value — skip
      }
      // Fully custom attribute (componentKey, etc.) — presence on the tag
      return tag + '[' + n + ']';
    }

    // Semantic tag with no special attributes — bare tag name.
    // Specificity comes from the surrounding path anchors.
    if (SEMANTIC_TAGS.has(tag)) return tag;

    return null; // plain div/span, no signal — skip
  }

  function buildPathSegment(el: Element): string {
    const atomic = buildAtomicSelector(el);
    if (atomic) return atomic;
    const tag = el.tagName.toLowerCase();
    const cls = stableClasses(el);
    if (cls.length > 0) {
      const candidate = tag + cls.slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
    }
    // positional fallback
    if (el.parentElement) {
      const siblings = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(el) + 1;
        return tag + ':nth-of-type(' + idx + ')';
      }
    }
    return tag;
  }

  function buildSelector(el: Element): string {
    const atomic = buildAtomicSelector(el);
    if (atomic && document.querySelectorAll(atomic).length === 1) return atomic;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      parts.unshift(buildPathSegment(cur));
      const joined = parts.join(' > ');
      if (document.querySelectorAll(joined).length === 1) return joined;
      cur = cur.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // Build a selector that matches the repeating item (and its siblings).
  // item = one representative element from the list (not the container).
  function buildArrayItemSelector(item: Element): string {
    const itemTag = item.tagName.toLowerCase();

    // 1. Stable data attribute on the item itself — shared by all siblings
    const atomic = buildAtomicSelector(item);
    if (atomic && document.querySelectorAll(atomic).length >= 2) return atomic;

    // 2. Stable class on the item shared by 2+ elements on the page
    for (const cls of stableClasses(item)) {
      const candidate = itemTag + '.' + CSS.escape(cls);
      if (document.querySelectorAll(candidate).length >= 2) return candidate;
    }

    // 3. Use the logical parent (skipping display:contents wrappers) so the selector
    //    references a real stable ancestor rather than an invisible wrapper div.
    const logicalPar = logicalParentOf(item);
    const realParent = item.parentElement;

    if (logicalPar) {
      // Only use the short atomic form if it uniquely identifies THIS container.
      // If multiple containers share the same data-testid (e.g. two carousels on the page),
      // the atomic selector would match items in ALL of them — fall through to buildSelector
      // which walks up until the path is unique.
      const lpAtomic = buildAtomicSelector(logicalPar);
      const lpIsUnique = lpAtomic !== null && document.querySelectorAll(lpAtomic).length === 1;
      const lpSel = lpIsUnique ? lpAtomic : buildSelector(logicalPar);

      if (realParent && isDisplayContents(realParent)) {
        // There is a display:contents wrapper between logicalPar and item.
        // Produce: logical-parent > wrapper-tag > item-tag
        // e.g. [data-testid='carousel-children-container'] > div > div
        return lpSel + ' > ' + realParent.tagName.toLowerCase() + ' > ' + itemTag;
      }

      return lpSel + ' > ' + itemTag;
    }

    return buildSelector(item);
  }

  // --- Mode: walk to container / list ---

  function getPickTarget(el: Element): Element {
    if (mode === 'object') return walkToObject(el);
    return el; // item mode
  }

  function walkToObject(el: Element): Element {
    let cur: Element = el;
    while (cur.parentElement && cur.parentElement !== document.body) {
      if (isMeaningfulObject(cur)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }

  function isMeaningfulObject(el: Element): boolean {
    const tag = el.tagName.toLowerCase();
    if (['article', 'section', 'li', 'tr', 'td'].includes(tag)) return true;
    if (el.id && !isDynamic(el.id)) return true;
    for (const attr of ['data-testid', 'data-cy', 'data-id', 'data-qa']) {
      if (el.getAttribute(attr)) return true;
    }
    const role = el.getAttribute('role') ?? '';
    if (['listitem', 'article', 'row', 'gridcell', 'option'].includes(role)) return true;
    if (stableClasses(el).length > 0 && el.children.length >= 2) return true;
    return false;
  }

  // Walk up from the hovered element to find ONE representative list item
  // (not the container — the item itself). Returns `cur` when it detects `cur`
  // is a repeating sibling among its parent's children.
  // display:contents wrappers are treated as transparent: we use the logical parent
  // (skipping them) so that e.g. LinkedIn's <div data-display-contents> doesn't confuse
  // the walk and we return the real listitem, not its invisible wrapper.
  function walkToArray(el: Element): Element {
    let cur: Element = el;
    while (cur.parentElement && cur.parentElement !== document.documentElement) {
      // Use the logical parent — skip any display:contents wrappers between cur and the container
      const logicalPar = logicalParentOf(cur);
      if (!logicalPar || logicalPar === document.documentElement) break;

      // 1. Semantic list/table: the item is cur (a direct child of ul/ol/tbody)
      const lpTag = logicalPar.tagName.toLowerCase();
      if (['ul', 'ol', 'tbody'].includes(lpTag)) return cur;

      // 2. ARIA feed/list on the logical parent: cur is an item inside it
      const lpRole = logicalPar.getAttribute('role') ?? '';
      if (['feed', 'list', 'listbox', 'grid'].includes(lpRole)) return cur;

      // 3. cur itself has a data-testid shared by 3+ logical siblings → cur is the item
      const curTestId = cur.getAttribute('data-testid');
      if (curTestId) {
        const matching = logicalChildrenOf(logicalPar).filter(
          (c) => c.getAttribute('data-testid') === curTestId,
        ).length;
        if (matching >= 3) return cur;
      }

      // 4. cur has 5+ same-tag logical siblings AND they're tall enough to be real list items
      //    (not buttons, nav items, icons, etc.)
      const sameTag = logicalChildrenOf(logicalPar).filter((c) => c.tagName === cur.tagName);
      if (sameTag.length >= 5) {
        // Sample a few to check average height — skip if they look like small UI elements
        const sample = sameTag.slice(0, 5);
        const avgH = sample.reduce((s, c) => s + c.getBoundingClientRect().height, 0) / sample.length;
        if (avgH >= 100) return cur;
      }

      cur = cur.parentElement!;
    }
    return el;
  }

  // --- Array mode multi-highlight (highlights siblings of the representative item) ---

  function clearChildOverlays(): void {
    for (const co of childOverlays) co.remove();
    childOverlays = [];
  }

  // Returns how many logical siblings look like this element (including itself)
  function countLogicalSiblings(item: Element): number {
    const logicalPar = logicalParentOf(item);
    if (!logicalPar) return 1;
    const itemTestId = item.getAttribute('data-testid');
    return logicalChildrenOf(logicalPar).filter((c) =>
      itemTestId ? c.getAttribute('data-testid') === itemTestId : c.tagName === item.tagName,
    ).length;
  }

  // Draw blue highlight boxes for all logical siblings of item (excluding item itself,
  // which gets the green overlay).
  function showSiblingHighlights(item: Element): void {
    clearChildOverlays();

    // Use the logical parent so we collect siblings across display:contents wrappers
    const logicalPar = logicalParentOf(item);
    if (!logicalPar) return;

    // Collect all logical siblings that look like the same item
    const itemTestId = item.getAttribute('data-testid');
    const siblings = logicalChildrenOf(logicalPar).filter((c) =>
      c !== item &&   // skip the hovered element — it gets the green overlay
      (itemTestId
        ? c.getAttribute('data-testid') === itemTestId
        : c.tagName === item.tagName),
    );

    for (const sibling of siblings) {
      const rect = sibling.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      if (rect.width === 0 && rect.height === 0) continue;
      const co = document.createElement('div');
      const cs = co.style;
      cs.position = 'absolute';
      cs.pointerEvents = 'none';
      cs.border = '1px solid rgba(26,115,232,0.7)';
      cs.background = 'rgba(26,115,232,0.06)';
      cs.borderRadius = '3px';
      cs.zIndex = '2147483647';
      cs.boxSizing = 'border-box';
      cs.left = (rect.left + window.scrollX) + 'px';
      cs.top = (rect.top + window.scrollY) + 'px';
      cs.width = rect.width + 'px';
      cs.height = rect.height + 'px';
      document.documentElement.appendChild(co);
      childOverlays.push(co);
    }
  }

  // --- Stable selector builders (data-* anchors only, no tags or classes) ---
  // Walks up the DOM collecting every element that has a stable data attribute or id,
  // then joins them with a space (descendant combinator). The result is resilient to
  // layout changes because it never references tag positions or class names.
  // e.g. [data-testid='feed'] [data-testid='carousel'] [data-testid='carousel-children-container']

  function buildStableSelector(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const seg = buildStableSegment(cur);
      if (seg) parts.unshift(seg);
      cur = cur.parentElement;
    }
    // If nothing stable found at all, fall back to the full path selector
    return parts.length > 0 ? parts.join(' ') : buildSelector(el);
  }

  function buildStableArraySelector(item: Element): string {
    // walkToArray returns the list-item boundary element (e.g. div[role='listitem']).
    // That element may not itself carry a stable data attribute — the stable anchor
    // can be one level inside it (e.g. div[data-testid='carousel-child-container']).
    // Pattern:  ul[data-testid='carousel-children-container']
    //             └─ div[data-display-contents]         ← transparent wrapper
    //                  └─ div[role='listitem']           ← what walkToArray returns, no testid
    //                       └─ div[data-testid='carousel-child-container']  ← stable anchor
    //
    // Strategy: use the item's own stable attr if it has one; otherwise look one level
    // into its direct children for the first one that does.

    let stableItem: Element = item;
    let itemAtomic = buildAtomicSelector(item);

    if (!itemAtomic) {
      for (const child of Array.from(item.children)) {
        const a = buildAtomicSelector(child as Element);
        if (a) {
          stableItem = child as Element;
          itemAtomic = a;
          break;
        }
      }
    }

    // Walk up from stableItem's parent collecting stable anchors
    const parts: string[] = [];
    let cur: Element | null = stableItem.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const seg = buildStableSegment(cur);
      if (seg) parts.unshift(seg);
      cur = cur.parentElement;
    }

    const prefix = parts.join(' ');

    if (itemAtomic) {
      return prefix ? prefix + ' ' + itemAtomic : itemAtomic;
    }

    // Nothing stable anywhere — fall back to tag name on the container
    return prefix ? prefix + ' ' + item.tagName.toLowerCase() : item.tagName.toLowerCase();
  }

  // Strips all attributes except the semantic keep-set, returns cleaned outerHTML.
  // Used by the 'contains' picker to produce <parentTag><filteredChild></parentTag>.
  const CONTAINS_KEEP = new Set(['href','src','alt','aria-label','aria-hidden','id','type','name','value','placeholder','title']);
  function stripToFilteredHtml(el: Element): string {
    const clone = el.cloneNode(true) as Element;
    function cleanNode(node: Element): void {
      const drop: string[] = [];
      for (const attr of Array.from(node.attributes)) {
        if (!CONTAINS_KEEP.has(attr.name)) drop.push(attr.name);
      }
      for (const a of drop) node.removeAttribute(a);
      for (const child of Array.from(node.children)) cleanNode(child as Element);
    }
    cleanNode(clone);
    return clone.outerHTML;
  }

  // --- Event handlers ---

  function onMouseOver(e: Event): void {
    const target = getPickTarget((e as MouseEvent).target as Element);
    currentTarget = target;

    // Green overlay: the specific hovered element
    const rect = target.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + window.scrollX + 'px';
    overlay.style.top = rect.top + window.scrollY + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';

    // Blue overlays: all similar siblings in the same logical container
    showSiblingHighlights(target);

    // Live badge preview (selector + counts)
    updateBadgePreview(target);
  }

  function onClick(e: Event): void {
    e.preventDefault();
    (e as MouseEvent).stopImmediatePropagation();
    if (!currentTarget) return;

    let result: string;
    if (mode === 'contains') {
      // Returns just the filtered outerHTML of the clicked element — always a
      // reliable substring of the parent's filtered HTML regardless of sibling position.
      result = stripToFilteredHtml(currentTarget);
    } else {
      result = domMode === 'stable'
        ? buildStableSelector(currentTarget)
        : buildSelector(currentTarget);
    }

    cleanup();
    void (navigator.clipboard
      ? navigator.clipboard.writeText(result)
      : Promise.resolve(legacyCopy(result))
    ).then(() => {
      showToast(result, mode);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome as any).runtime.sendMessage({ type: 'PICKER_DONE', selector: result, mode });
    });
  }

  function legacyCopy(text: string): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  function onKeyDown(e: Event): void {
    if ((e as KeyboardEvent).key === 'Escape') {
      cleanup();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome as any).runtime.sendMessage({ type: 'PICKER_CANCEL' });
    }
  }

  function cleanup(): void {
    clearChildOverlays();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    badge.remove();
  }

  function showToast(selector: string, m: string): void {
    const toast = document.createElement('div');
    const ts = toast.style;
    ts.position = 'fixed';
    ts.bottom = '20px';
    ts.right = '20px';
    ts.background = '#161b22';
    ts.border = '1px solid #30363d';
    ts.color = '#e6edf3';
    ts.padding = '12px 16px';
    ts.borderRadius = '8px';
    ts.fontSize = '12px';
    ts.fontFamily = 'monospace';
    ts.maxWidth = '380px';
    ts.zIndex = '2147483647';
    ts.wordBreak = 'break-all';
    ts.lineHeight = '1.5';
    ts.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
    toast.innerHTML =
      '<div style="color:#58a6ff;font-weight:700;margin-bottom:5px;font-family:sans-serif">' +
      m.toUpperCase() + ' selector copied ✓</div>' +
      '<div style="color:#79c0ff">' + selector + '</div>';
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  // --- Start ---
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
}

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');
let offscreenCreated = false;

async function ensureOffscreen(): Promise<void> {
  if (offscreenCreated) return;
  try {
    const existing = await chrome.offscreen.hasDocument();
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WEB_RTC],
        justification: 'Maintain persistent WebSocket connection to AgentSpawner backend',
      });
    }
    offscreenCreated = true;
  } catch (err) {
    console.error('[Background] Failed to create offscreen doc:', err);
  }
}

// ── Tab load helper ───────────────────────────────────────────────────────────

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout after 30s'));
    }, 30_000);

    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
          return;
        }
        chrome.tabs.onUpdated.addListener(listener);
      })
      .catch((err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

    function listener(changedId: number, info: chrome.tabs.TabChangeInfo) {
      if (changedId === tabId && info.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
  });
}

// ── Content script readiness check ────────────────────────────────────────────
// Polls the tab with a PING until the content script responds, or times out.
// The manifest auto-injects at document_idle but there can be a small gap
// between the tab reporting status:'complete' and Chrome finishing injection.

function waitForContentScript(tabId: number, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function attempt(): void {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, () => {
        if (!chrome.runtime.lastError) {
          resolve();
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new Error(`Content script not ready after ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, Math.min(100, remaining));
      });
    }

    attempt();
  });
}

// ── Handle tab operations from offscreen (proxied from sandbox) ───────────────

async function handleTabOp(
  method: string,
  payload: Record<string, unknown>,
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    switch (method) {
      case 'open': {
        let url = payload['url'] as string;
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        const t = await chrome.tabs.create({
          url,
          // Default to background (active: false) so automation tabs don't steal focus.
          // Pass active: true explicitly only when the tab must be visible.
          active: (payload['active'] as boolean) ?? false,
        });
        // Wait for the page to finish loading, then confirm the content script
        // is injected and ready before returning tabId to the flow.
        await waitForTabLoad(t.id!);
        await waitForContentScript(t.id!);
        sendResponse({ result: { tabId: t.id } });
        break;
      }
      case 'close': {
        const closeTabId = Number(payload['tabId']);
        if (!Number.isInteger(closeTabId) || closeTabId <= 0) {
          sendResponse({ error: `close_tab requires a valid tabId, got: ${JSON.stringify(payload['tabId'])}` });
          break;
        }
        await chrome.tabs.remove(closeTabId);
        sendResponse({ result: null });
        break;
      }
      case 'navigate': {
        let navUrl = payload['url'] as string;
        if (!/^https?:\/\//i.test(navUrl)) navUrl = 'https://' + navUrl;
        await chrome.tabs.update(payload['tabId'] as number, { url: navUrl });
        sendResponse({ result: null });
        break;
      }
      case 'waitForLoad': {
        await waitForTabLoad(payload['tabId'] as number);
        sendResponse({ result: null });
        break;
      }
      case 'sleep': {
        await new Promise<void>((r) => setTimeout(r, payload['ms'] as number));
        sendResponse({ result: null });
        break;
      }
      case 'exec': {
        const tabId = payload['tabId'] as number;
        const scrapeCode = payload['code'] as string;
        // Use world: 'MAIN' so the page's CSP applies (not the extension's).
        // Wrap code in async IIFE so that `return` statements work correctly.
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN' as chrome.scripting.ExecutionWorld,
          func: (c: string) => {
            // eslint-disable-next-line no-eval
            return eval('(async function(){' + c + '})()') as unknown;
          },
          args: [scrapeCode],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scriptErr = (results[0] as any)?.error;
        if (scriptErr) {
          const msg = scriptErr instanceof Error ? scriptErr.message : String(scriptErr);
          sendResponse({ error: `exec error: ${msg}` });
          return;
        }
        sendResponse({ result: results[0]?.result ?? null });
        break;
      }
      // ── Pre-compiled DOM operations (no eval — work on all pages) ──────────
      case 'domGet': {
        const tabId = payload['tabId'] as number;
        const selector = (payload['selector'] as string | null) || null;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string | null) => {
            const el = sel ? document.querySelector(sel) : document.documentElement;
            return el ? (el as HTMLElement).outerHTML.slice(0, 50000) : null;
          },
          args: [selector],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const domGetErr = (results[0] as any)?.error;
        if (domGetErr) { sendResponse({ error: domGetErr instanceof Error ? domGetErr.message : String(domGetErr) }); return; }
        sendResponse({ result: results[0]?.result ?? null });
        break;
      }
      case 'domQueryAll': {
        const tabId = payload['tabId'] as number;
        const selector = payload['selector'] as string;
        const limit = (payload['limit'] as number) || 100;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string, lim: number) =>
            Array.from(document.querySelectorAll(sel)).slice(0, lim).map((el) => ({
              text: el.textContent?.trim().slice(0, 200) ?? '',
              tag: el.tagName.toLowerCase(),
              href: el.getAttribute('href') ?? undefined,
              src: el.getAttribute('src') ?? undefined,
              value: (el as HTMLInputElement).value || undefined,
            })),
          args: [selector, limit],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dqaErr = (results[0] as any)?.error;
        if (dqaErr) { sendResponse({ error: dqaErr instanceof Error ? dqaErr.message : String(dqaErr) }); return; }
        sendResponse({ result: results[0]?.result ?? [] });
        break;
      }
      case 'domClick': {
        const tabId = payload['tabId'] as number;
        const selector = payload['selector'] as string;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) throw new Error('Element not found: ' + sel);
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { clicked: true, tag: el.tagName, text: el.textContent?.trim().slice(0, 100) };
          },
          args: [selector],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dcErr = (results[0] as any)?.error;
        if (dcErr) { sendResponse({ error: dcErr instanceof Error ? dcErr.message : String(dcErr) }); return; }
        sendResponse({ result: results[0]?.result ?? null });
        break;
      }
      case 'domType': {
        const tabId = payload['tabId'] as number;
        const selector = payload['selector'] as string;
        const text = payload['text'] as string;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string, txt: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | null;
            if (!el) throw new Error('Element not found: ' + sel);
            el.focus();
            el.value = txt;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { typed: true };
          },
          args: [selector, text],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dtErr = (results[0] as any)?.error;
        if (dtErr) { sendResponse({ error: dtErr instanceof Error ? dtErr.message : String(dtErr) }); return; }
        sendResponse({ result: results[0]?.result ?? null });
        break;
      }
      case 'domCheck': {
        const tabId = payload['tabId'] as number;
        const selector = payload['selector'] as string;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string) => !!document.querySelector(sel),
          args: [selector],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dchkErr = (results[0] as any)?.error;
        if (dchkErr) { sendResponse({ error: dchkErr instanceof Error ? dchkErr.message : String(dchkErr) }); return; }
        sendResponse({ result: results[0]?.result ?? false });
        break;
      }
      case 'domScroll': {
        const tabId = payload['tabId'] as number;
        const selector = (payload['selector'] as string | null) || null;
        const x = (payload['x'] as number) || 0;
        const y = (payload['y'] as number) || 300;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string | null, px: number, py: number) => {
            if (sel) {
              const el = document.querySelector(sel) as HTMLElement | null;
              if (!el) throw new Error('Element not found: ' + sel);
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return { scrolled: true };
            }
            window.scrollBy(px, py);
            return { scrolled: true };
          },
          args: [selector, x, y],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dsErr = (results[0] as any)?.error;
        if (dsErr) { sendResponse({ error: dsErr instanceof Error ? dsErr.message : String(dsErr) }); return; }
        sendResponse({ result: results[0]?.result ?? null });
        break;
      }
      case 'domGetAll': {
        const tabId = payload['tabId'] as number;
        const selector = payload['selector'] as string;
        const limit = (payload['limit'] as number) || 50;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: (sel: string, lim: number) =>
            Array.from(document.querySelectorAll(sel)).slice(0, lim).map(
              (el) => (el as HTMLElement).outerHTML,
            ),
          args: [selector, limit],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dgaErr = (results[0] as any)?.error;
        if (dgaErr) { sendResponse({ error: dgaErr instanceof Error ? dgaErr.message : String(dgaErr) }); return; }
        sendResponse({ result: results[0]?.result ?? [] });
        break;
      }
      // ────────────────────────────────────────────────────────────────────────
      case 'screenshot': {
        const tabId = payload['tabId'] as number;
        const tabInfo = await chrome.tabs.get(tabId);
        const windowId = tabInfo.windowId;
        const [prevActive] = await chrome.tabs.query({ active: true, windowId });
        await chrome.tabs.update(tabId, { active: true });
        await new Promise<void>((r) => setTimeout(r, 300));
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        if (prevActive?.id) await chrome.tabs.update(prevActive.id, { active: true });
        sendResponse({ result: dataUrl });
        break;
      }
      case 'domWaitForAny': {
        const tabId = payload['tabId'] as number;
        const selectors = payload['selectors'] as { selector: string; label: string }[];
        const timeoutMs = (payload['timeoutMs'] as number) || 15_000;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN' as chrome.scripting.ExecutionWorld,
          func: (sels: { selector: string; label: string }[], tMs: number) => {
            return new Promise<{ label: string; selector: string }>((resolve) => {
              function check(): { found: boolean; label: string; selector: string } {
                for (const { selector, label } of sels) {
                  if (document.querySelector(selector)) return { found: true, label, selector };
                }
                return { found: false, label: '', selector: '' };
              }
              const immediate = check();
              if (immediate.found) { resolve({ label: immediate.label, selector: immediate.selector }); return; }
              const start = Date.now();
              const timer = setInterval(() => {
                const r = check();
                if (r.found) { clearInterval(timer); resolve({ label: r.label, selector: r.selector }); return; }
                if (Date.now() - start >= tMs) { clearInterval(timer); resolve({ label: 'timeout', selector: '' }); }
              }, 250);
            });
          },
          args: [selectors, timeoutMs],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wfaErr = (results[0] as any)?.error;
        if (wfaErr) { sendResponse({ error: wfaErr instanceof Error ? wfaErr.message : String(wfaErr) }); return; }
        sendResponse({ result: results[0]?.result ?? { label: 'timeout', selector: '' } });
        break;
      }
      case 'listTabs': {
        const tabs = await chrome.tabs.query({});
        sendResponse({
          result: tabs.map((t) => ({
            tabId: t.id,
            url: t.url,
            title: t.title,
            active: t.active,
            windowId: t.windowId,
          })),
        });
        break;
      }
      case 'switchTab': {
        const tabId = payload['tabId'] as number;
        await chrome.tabs.update(tabId, { active: true });
        const tab = await chrome.tabs.get(tabId);
        await chrome.windows.update(tab.windowId, { focused: true });
        sendResponse({ result: { tabId, active: true } });
        break;
      }
      case 'reloadTab': {
        const tabId = payload['tabId'] as number;
        await chrome.tabs.reload(tabId);
        sendResponse({ result: { tabId, reloaded: true } });
        break;
      }
      default:
        sendResponse({ error: `Unknown tab op: ${method}` });
    }
  } catch (err) {
    sendResponse({ error: (err as Error).message });
  }
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (msg: OffscreenMessage | { type: string; [key: string]: unknown }, sender, sendResponse) => {
    if (msg.type === 'WS_CONNECTED') {
      console.log('[Background] WS connected');
      return false;
    }
    if (msg.type === 'WS_DISCONNECTED') {
      console.log('[Background] WS disconnected');
      return false;
    }

    // Extension primitive dispatch: offscreen → background → content script
    if (msg.type === 'PRIMITIVE_OP') {
      const { toolName, input } = msg as unknown as { toolName: string; input: Record<string, unknown> };
      (async () => {
        try {
          // Background-context primitives: route through handleTabOp instead of content script
          // These tools need Chrome APIs that only exist in the service worker.
          const BG_METHODS: Record<string, string> = {
            open_tab:    'open',
            close_tab:   'close',
            screenshot:  'screenshot',
            list_tabs:   'listTabs',
            switch_tab:  'switchTab',
            reload_page: 'reloadTab',
          };
          if (toolName in BG_METHODS) {
            handleTabOp(BG_METHODS[toolName]!, input, (r: unknown) => {
              const resp = r as { result?: unknown; error?: string } | undefined;
              if (resp?.error) sendResponse({ error: resp.error });
              else sendResponse({ result: resp?.result ?? null });
            }).catch((err: Error) => sendResponse({ error: err.message }));
            return;
          }

          // Use tabId from input if provided, otherwise fall back to the active tab.
          // Importantly: skip extension pages (chrome-extension://, chrome://) — the flows
          // debugger opens in its own window so "lastFocusedWindow" can resolve to the debugger
          // page itself, which cannot be scripted.
          let tabId = typeof input['tabId'] === 'number' ? (input['tabId'] as number) : null;
          if (tabId === null) {
            const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            const isScriptableUrl = (url?: string) =>
              !!url && !url.startsWith('chrome-extension://') && !url.startsWith('chrome://') && !url.startsWith('about:');
            if (isScriptableUrl(activeTab?.url)) {
              tabId = activeTab?.id ?? null;
            } else {
              // Focused window is an extension page — find the most recently active real tab
              const allActive = await chrome.tabs.query({ active: true });
              const realTab = allActive.find(t => isScriptableUrl(t.url));
              tabId = realTab?.id ?? null;
            }
          }
          if (tabId === null) {
            sendResponse({ error: 'No active tab available for primitive execution' });
            return;
          }
          const correlationId = `prim_${Date.now()}_${Math.random()}`;
          type PrimResp = { type?: string; correlationId?: string; result?: unknown; error?: string } | undefined;
          const doSend = (tid: number, onResult: (r: PrimResp) => void) => {
            chrome.tabs.sendMessage(
              tid,
              { type: 'EXECUTE_PRIMITIVE', correlationId, toolName, input, code: '' },
              (resp: PrimResp) => {
                if (chrome.runtime.lastError) {
                  const errMsg = chrome.runtime.lastError.message ?? '';
                  // Content script not injected yet — inject it and retry once
                  if (errMsg.includes('Receiving end does not exist') || errMsg.includes('Could not establish connection')) {
                    chrome.scripting.executeScript(
                      { target: { tabId: tid }, files: ['content/index.js'] },
                      () => {
                        if (chrome.runtime.lastError) {
                          onResult({ error: `Inject failed: ${chrome.runtime.lastError.message}` });
                          return;
                        }
                        setTimeout(() => {
                          chrome.tabs.sendMessage(
                            tid,
                            { type: 'EXECUTE_PRIMITIVE', correlationId, toolName, input, code: '' },
                            (resp2: PrimResp) => {
                              if (chrome.runtime.lastError) {
                                onResult({ error: chrome.runtime.lastError.message });
                              } else {
                                onResult(resp2 ?? { error: 'No response after inject' });
                              }
                            },
                          );
                        }, 150);
                      },
                    );
                  } else {
                    onResult({ error: errMsg });
                  }
                  return;
                }
                onResult(resp ?? { error: 'No response' });
              },
            );
          };
          doSend(tabId, (resp) => {
            if (resp?.error) {
              sendResponse({ error: resp.error });
            } else {
              sendResponse({ result: resp?.result ?? null });
            }
          });
        } catch (err) {
          sendResponse({ error: (err as Error).message });
        }
      })();
      return true; // keep channel open for async response
    }

    // Tab operation from offscreen (proxied from sandbox iframe via postMessage)
    if (msg.type === 'TAB_OP') {
      const { method, payload } = msg as unknown as { method: string; payload: Record<string, unknown> };
      handleTabOp(method, payload, sendResponse).catch((err: Error) =>
        sendResponse({ error: err.message }),
      );
      return true; // keep channel open for async sendResponse
    }

    // ── Selector picker messages ───────────────────────────────────────────────

    if (msg.type === 'PICKER_START') {
      const { tabId, mode, domMode } = msg as unknown as { tabId: number; mode: string; domMode?: string };
      chrome.scripting.executeScript({
        target: { tabId },
        func: injectedPickerFn,
        args: [mode, domMode ?? 'filtered'],
      }).catch((err: Error) => console.error('[Background] Picker inject failed:', err.message));
      return false;
    }

    if (msg.type === 'PICKER_DONE') {
      const { selector, mode } = msg as unknown as { selector: string; mode: string };
      if (mode === 'contains') {
        // Contains picks go to their own key so they don't overwrite the CSS selector
        chrome.storage.local.set({ lastContainsValue: selector }).catch(console.error);
      } else {
        chrome.storage.local.set({ lastSelector: selector, lastMode: mode }).catch(console.error);
      }
      return false;
    }

    if (msg.type === 'PICKER_CANCEL') {
      return false;
    }

    // ── Macro recorder messages ────────────────────────────────────────────────

    if (msg.type === 'START_RECORDING') {
      const url = (msg as { type: string; url: string }).url;
      startRecording(url).catch((err: Error) => console.error('[Background] startRecording failed:', err.message));
      return false;
    }

    if (msg.type === 'RECORD_EVENT') {
      const event = msg['event'] as Record<string, unknown>;
      fetch(`${BACKEND_HTTP}/recording/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      }).catch(console.error);
      return false;
    }

    if (msg.type === 'RECORDER_STOP') {
      recordingTabId = null;
      recordingPrevUrl = null;
      fetch(`${BACKEND_HTTP}/recording/stop`, { method: 'POST' }).catch(console.error);
      return false;
    }

    // ── Flows Debugger window ──────────────────────────────────────────────────

    if (msg.type === 'OPEN_FLOWS_DEBUGGER') {
      (async () => {
        if (flowsDebuggerWindowId !== null) {
          // Window may have been closed without firing onRemoved — verify it still exists
          try {
            await chrome.windows.get(flowsDebuggerWindowId);
            // Window exists: just focus it
            await chrome.windows.update(flowsDebuggerWindowId, { focused: true });
          } catch {
            // Window is gone — fall through to create a new one
            flowsDebuggerWindowId = null;
          }
        }

        if (flowsDebuggerWindowId === null) {
          const win = await chrome.windows.create({
            url: chrome.runtime.getURL('flows-debugger/index.html'),
            type: 'popup',
            width: 500,
            height: 720,
          });
          flowsDebuggerWindowId = win.id ?? null;
        }
      })().catch((err: Error) =>
        console.error('[Background] OPEN_FLOWS_DEBUGGER failed:', err.message),
      );
      return false;
    }

    return false;
  },
);

// ── Re-inject recorder on tab navigation + inject review overlay on load ──────

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // Recording: re-inject badge whenever the tab navigates to a new URL
  if (recordingTabId !== null && tabId === recordingTabId) {
    if (info.status === 'complete' && tab.url && tab.url !== recordingPrevUrl) {
      recordingPrevUrl = tab.url;
      fetch(`${BACKEND_HTTP}/recording/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'navigate', url: tab.url }),
      }).catch(console.error);
      chrome.scripting.executeScript({
        target: { tabId },
        func: injectedRecorderFn,
      }).catch((err: Error) => console.error('[Background] Re-inject recorder failed:', err.message));
    }
  }

});

// ── Flows Debugger window removal tracking ────────────────────────────────────

chrome.windows.onRemoved.addListener((removedWindowId: number) => {
  if (removedWindowId === flowsDebuggerWindowId) {
    flowsDebuggerWindowId = null;
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Background] AgentSpawner extension installed');
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen();
});

ensureOffscreen().catch(console.error);

