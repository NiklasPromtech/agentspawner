/**
 * Default tools provisioned for every new agent.
 *
 * Browser primitives (type: 'extension') are executed by the Chrome extension
 * via WebSocket — the code field is empty because the extension handles them
 * natively by tool name. Only the name, description, and inputSchema matter.
 */

export interface DefaultToolDef {
  name: string;
  description: string;
  toolType: string;
  inputSchema: object;
  code: string;
}

export const DEFAULT_TOOLS: DefaultToolDef[] = [
  // ── Tab management ──────────────────────────────────────────────────────────
  {
    name: 'open_tab',
    description: 'Open a new browser tab in the background (does NOT steal focus from the current tab) and return its tabId. Always the first step of any flow that needs a browser tab. Pass active: true only if the tab must be foregrounded.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        url:    { type: 'string',  description: 'URL to open' },
        active: { type: 'boolean', description: 'Whether to make the tab active/foreground (default: false — opens in background)' },
      },
      required: ['url'],
    },
    code: '',
  },
  {
    name: 'close_tab',
    description: 'Close a browser tab by its tabId',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'ID of the tab to close' },
      },
      required: ['tabId'],
    },
    code: '',
  },
  {
    name: 'navigate',
    description: 'Navigate a tab to a URL and wait for page load',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to navigate' },
        url:   { type: 'string', description: 'URL to navigate to' },
      },
      required: ['tabId', 'url'],
    },
    code: '',
  },

  // ── DOM interaction ─────────────────────────────────────────────────────────
  {
    name: 'click',
    description: 'Click an element matching a CSS selector',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the element to click' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },
  {
    name: 'type_text',
    description: 'Type text into an input or textarea matching a CSS selector. Works for standard <input> and <textarea> elements. For contenteditable rich-text editors (LinkedIn, Twitter, Reddit comment boxes etc.) use execute_code with document.execCommand("insertText", false, text) after focusing the element first.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the input element' },
        text:     { type: 'string', description: 'Text to type' },
        clear:    { type: 'boolean', description: 'Clear the field before typing (default: true)' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector', 'text'],
    },
    code: '',
  },
  {
    name: 'scroll',
    description: 'Scroll a tab — by pixel amount or scroll an element into view',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of element to scroll into view (optional)' },
        y:        { type: 'number', description: 'Pixels to scroll vertically (positive = down)' },
        x:        { type: 'number', description: 'Pixels to scroll horizontally (positive = right)' },
        timeout:  { type: 'number', description: 'Max ms to wait for selector element to appear (default: 10000, set to 0 to disable — only applies when selector is given)' },
      },
      required: ['tabId'],
    },
    code: '',
  },

  {
    name: 'scroll_load',
    description: 'Scroll a container repeatedly to trigger infinite-scroll / dynamic content loading (LinkedIn feeds, Twitter timelines, search results, etc.). Each cycle scrolls to the current bottom of the container, then waits for new content to render before scrolling again. Use `times` to control how many batches of content to load. Always pass a `selector` targeting the scrollable container — omitting it falls back to the document root which rarely works on SPAs. Returns how many cycles ran and whether the page height grew (new_content_loaded: false means the feed is exhausted).',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the scrollable container (strongly recommended)' },
        times:    { type: 'number', description: 'Number of scroll cycles to perform (default: 3)' },
        wait_ms:  { type: 'number', description: 'Milliseconds to wait between scrolls for content to load (default: 1500)' },
      },
      required: ['tabId'],
    },
    code: '',
  },

  {
    name: 'click_all',
    description: 'Click every element matching a CSS selector, up to a limit. Snapshots all matching elements before clicking so DOM mutations (elements disappearing after click) do not cause skips. Use for bulk expand/dismiss/toggle actions on feed items — e.g. clicking all "see more" / "expand" buttons before extracting text. Silently ignores elements that fail to click (already expanded, gone from DOM, etc.). Returns { clicked, errors, total_found }.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of elements to click' },
        limit:    { type: 'number', description: 'Max elements to click (default: 50). Pass the flow\'s `limit` input here to expand exactly as many posts as you intend to scrape.' },
        timeout:  { type: 'number', description: 'Max ms to wait for at least one element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },

  {
    name: 'click_contains',
    description: 'Find the first element matching a CSS selector whose filtered HTML contains a given string, then click it. Use when targeting a specific item from a list by content rather than a fragile index — e.g. click the nav link whose href contains "/about/", the tab with aria-label="Posts", or the icon button with a specific path/aria-label. The `contains` string is matched against filtered HTML (stripped of classes/styles but retaining href, aria-label, id, type, src, etc.), same convention as get_dom_filtered_all_contains. Returns { success, matched_index } or an error if no match found.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:      { type: 'number', description: 'Tab ID' },
        selector:   { type: 'string', description: 'CSS selector for the candidate elements to search through' },
        contains:   { type: 'string', description: 'Filtered HTML substring the target element must contain — e.g. href="/about/", aria-label="Home", or visible text' },
        scan_limit: { type: 'number', description: 'Max elements to scan (default: 200)' },
        timeout:    { type: 'number', description: 'Max ms to wait for selector to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector', 'contains'],
    },
    code: '',
  },
  {
    name: 'click_all_contains',
    description: 'Find all elements matching a CSS selector whose filtered HTML contains a given string, then click each one. Use for bulk actions on a filtered subset — e.g. click all notification items mentioning a keyword, dismiss all alerts with a specific label, or expand all posts by a certain author. Same filtered HTML matching as get_dom_filtered_all_contains. Returns { clicked, errors, matched, total_scanned }.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector for the candidate elements' },
        contains: { type: 'string', description: 'Filtered HTML substring that matching elements must contain' },
        limit:    { type: 'number', description: 'Max elements to click (default: 50)' },
        timeout:  { type: 'number', description: 'Max ms to wait for selector to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector', 'contains'],
    },
    code: '',
  },

  // ── Waiting ─────────────────────────────────────────────────────────────────
  {
    name: 'wait_for',
    description: 'Wait for a CSS selector to appear in a tab (polls until found or timeout)',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID' },
        selector:  { type: 'string', description: 'CSS selector to wait for' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },
  {
    name: 'wait_for_any',
    description: 'Race multiple CSS selectors — returns the label of whichever appears first, or "timeout"',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID' },
        selectors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label:    { type: 'string', description: 'Human-readable name for this selector' },
              selector: { type: 'string', description: 'CSS selector to watch for' },
            },
            required: ['label', 'selector'],
          },
          description: 'List of {label, selector} pairs to race',
        },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
      },
      required: ['tabId', 'selectors'],
    },
    code: '',
  },

  // ── DOM reading ─────────────────────────────────────────────────────────────
  {
    name: 'get_dom',
    description: 'Return the outer HTML of an element matching a CSS selector, or the full page body if no selector given. Prefer get_dom_filtered for most scraping tasks.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of element to read (omit for full page)' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable — only applies when selector is given)' },
      },
      required: ['tabId'],
    },
    code: '',
  },
  {
    name: 'get_dom_filtered',
    description: 'Fetch the DOM for a CSS selector and return it pre-filtered: strips <head>, <script>, <style>, <svg>, all class/style/data-* attributes, and collapses whitespace. The 50k character cap is applied AFTER filtering, so you get far more useful content than get_dom. The filtering step runs server-side (not blocked by page CSP); the fetch still requires the extension content script. Always use a selector to target the relevant container (e.g. the feed, an article, a results list) — omitting the selector on a large SPA will still hit the cap. Retries automatically until the selector returns content (implicit wait) — set timeout to 0 to disable.',
    toolType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the container to read (strongly recommended)' },
        timeout:  { type: 'number', description: 'Max ms to wait for content to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId'],
    },
    code: 'get_dom_filtered',
  },
  {
    name: 'get_dom_filtered_all',
    description: 'querySelectorAll + applyDomFilter per element. Returns an array of clean filtered HTML strings — one per matched element. Each item is capped at 10k chars (already filtered, so this is plenty). Use when you need to extract structured data from a list of repeated elements (feed posts, search results, table rows, etc.). Always pass a specific selector — e.g. [role="listitem"], .post-card, tr. Use limit to control how many elements to process (default: 20). Retries automatically until at least one element is found (implicit wait) — set timeout to 0 to disable.',
    toolType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector for the repeated elements to extract' },
        limit:    { type: 'number', description: 'Max elements to return (default: 20, max: 200)' },
        timeout:  { type: 'number', description: 'Max ms to wait for elements to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector'],
    },
    code: 'get_dom_filtered_all',
  },

  {
    name: 'get_dom_filtered_all_contains',
    description: 'querySelectorAll + applyDomFilter per element, then filters to only elements whose filtered HTML contains the given string (case-sensitive). Use when you need one specific section/card from a list of identical-looking repeated elements — e.g. the "About" section from a profile where all sections share the same selector. The `contains` value should be the filtered HTML snippet you get from the Contains picker (e.g. "<h2>About</h2>"). Returns { items: string[], count: number }. Retries automatically until at least one element passes BOTH the selector AND the contains check (implicit wait) — set timeout to 0 to disable.',
    toolType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector for the repeated elements to search through' },
        contains: { type: 'string', description: 'Filtered HTML substring to match against — use the Contains picker to get this value' },
        limit:    { type: 'number', description: 'Max elements to scan (default: 20, max: 200)' },
        timeout:  { type: 'number', description: 'Max ms to wait for a matching element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector', 'contains'],
    },
    code: 'get_dom_filtered_all_contains',
  },

  // ── Keyboard & focus ────────────────────────────────────────────────────────
  {
    name: 'press_key',
    description: 'Dispatch a keyboard event on an element or the document. Use to submit forms (Enter), close modals (Escape), move focus (Tab), or trigger keyboard shortcuts. Key names: "Enter", "Tab", "Escape", "Space", "ArrowDown", "ArrowUp", "Backspace", "Delete", etc.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        key:      { type: 'string', description: 'Key name to press (e.g. "Enter", "Escape", "Tab")' },
        selector: { type: 'string', description: 'CSS selector of element to press key on (omit to dispatch on document)' },
        timeout:  { type: 'number', description: 'Max ms to wait for selector element to appear (default: 10000, set to 0 to disable — only applies when selector is given)' },
      },
      required: ['tabId', 'key'],
    },
    code: '',
  },
  {
    name: 'focus',
    description: 'Focus an element — required before typing into contenteditable rich text editors (comment boxes on LinkedIn, Twitter, Reddit, etc.). Always call focus before execute_code insertText on a contenteditable.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of element to focus' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },
  {
    name: 'hover',
    description: 'Dispatch mouseover/mouseenter events on an element to reveal hidden UI (comment buttons, like buttons, tooltips, dropdown menus that only appear on hover). Use before click when buttons are not visible.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of element to hover over' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },
  {
    name: 'get_attribute',
    description: 'Read an attribute or property from an element — e.g. value, checked, href, aria-label, data-* attributes. Use to verify state (is a checkbox checked? what is the current input value?) before or after an action.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID' },
        selector:  { type: 'string', description: 'CSS selector of element to inspect' },
        attribute: { type: 'string', description: 'Attribute name to read (e.g. "value", "checked", "href", "aria-label", "data-id")' },
        timeout:   { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector', 'attribute'],
    },
    code: '',
  },

  // ── Mouse interactions ───────────────────────────────────────────────────────
  {
    name: 'double_click',
    description: 'Double-click an element. Use for opening items in file managers, activating inline editors, or any UI that requires a double-click.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of element to double-click' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },
  {
    name: 'right_click',
    description: 'Right-click an element to trigger a context menu. Use when an action is only accessible via right-click.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of element to right-click' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },

  // ── Form controls ────────────────────────────────────────────────────────────
  {
    name: 'select_option',
    description: 'Select an option in a <select> dropdown by value or visible text. Fires change and input events so React/Vue forms register the change.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the <select> element' },
        value:    { type: 'string', description: 'Option value or visible text to select' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector', 'value'],
    },
    code: '',
  },
  {
    name: 'set_checkbox',
    description: 'Check or uncheck a checkbox or radio button. Pass checked: true to check, false to uncheck, or omit to toggle.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector of the checkbox or radio input' },
        checked:  { type: 'boolean', description: 'true to check, false to uncheck (omit to toggle)' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },

  // ── Reading page state ───────────────────────────────────────────────────────
  {
    name: 'get_text',
    description: 'Get the visible text content of an element. Simpler than get_dom when you only need the text — e.g. reading a post body, a price, a username.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector (omit for full page body text)' },
        timeout:  { type: 'number', description: 'Max ms to wait for element to appear (default: 10000, set to 0 to disable — only applies when selector is given)' },
      },
      required: ['tabId'],
    },
    code: '',
  },
  {
    name: 'get_url',
    description: 'Get the current URL of a tab. Use to verify navigation succeeded, extract IDs from the URL, or check what page you are on.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
      },
      required: ['tabId'],
    },
    code: '',
  },
  {
    name: 'get_title',
    description: 'Get the page title of a tab. Useful for confirming which page loaded or reading document/email subjects.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
      },
      required: ['tabId'],
    },
    code: '',
  },
  {
    name: 'element_exists',
    description: 'Check whether an element matching a CSS selector exists on the page. Returns { exists: true/false }. Use to branch logic — e.g. "is the login button visible?" or "has the success message appeared?"',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector to check for' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },
  {
    name: 'count_elements',
    description: 'Count how many elements match a CSS selector. Use to check how many results, posts, rows, or items are present.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:    { type: 'number', description: 'Tab ID' },
        selector: { type: 'string', description: 'CSS selector to count' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },

  // ── Timing & navigation ──────────────────────────────────────────────────────
  {
    name: 'wait_ms',
    description: '[SERVER-SIDE] Wait a fixed number of milliseconds. Runs on the server — never blocked by page CSP, never requires content script injection. Use sparingly — prefer wait_for or wait_for_any when possible. Useful after open_tab to give the page time to load before the first DOM step (2000–3000ms recommended for SPAs like LinkedIn), or after clicking something that triggers a slow animation. If any DOM step fails with "Could not establish connection", it almost always means the content script has not injected yet — add a wait_ms step immediately after open_tab to fix it.',
    toolType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID (kept for flow compatibility — not used for routing)' },
        ms:    { type: 'number', description: 'Milliseconds to wait (max 30000)' },
      },
      required: ['ms'],
    },
    code: 'wait_ms',
  },
  {
    name: 'wait_for_gone',
    description: 'Wait for an element to disappear from the page — e.g. a loading spinner, a modal, a toast notification. Returns when the selector no longer matches or the timeout is reached.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:     { type: 'number', description: 'Tab ID' },
        selector:  { type: 'string', description: 'CSS selector to wait to disappear' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
      },
      required: ['tabId', 'selector'],
    },
    code: '',
  },
  {
    name: 'go_back',
    description: 'Navigate the browser back one page in history (equivalent to pressing the Back button).',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
      },
      required: ['tabId'],
    },
    code: '',
  },
  {
    name: 'go_forward',
    description: 'Navigate the browser forward one page in history (equivalent to pressing the Forward button).',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
      },
      required: ['tabId'],
    },
    code: '',
  },
  {
    name: 'reload_page',
    description: 'Reload the current page in a tab (hard refresh). Use after actions that require a page reload to take effect.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
      },
      required: ['tabId'],
    },
    code: '',
  },

  {
    name: 'screenshot',
    description: 'Capture a screenshot of the browser tab as a PNG image (base64 data URL). Briefly activates the tab to capture it, then restores the previously active tab. Use as a verification step to confirm the result of an action.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to capture' },
      },
      required: ['tabId'],
    },
    code: '',
  },

  // ── Tab management (background context) ─────────────────────────────────────
  {
    name: 'list_tabs',
    description: 'List all open browser tabs with their tabId, URL, title, and active state. Use when you need to find a specific tab to switch to, or to see what pages are currently open.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    code: '',
  },
  {
    name: 'switch_tab',
    description: 'Switch focus to a specific tab by its tabId (making it the active tab). Use after list_tabs to identify the tabId you want.',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to switch to (make active)' },
      },
      required: ['tabId'],
    },
    code: '',
  },

  // ── Code execution ──────────────────────────────────────────────────────────
  {
    name: 'execute_code',
    description: 'Execute arbitrary JavaScript in a tab and return the result. ⚠️ Uses new Function() internally — can be blocked by strict Content Security Policy (CSP) on sites like LinkedIn. If execute_code fails with a CSP or eval error, switch to purpose-built tools (click, type_text, scroll_load, etc.) which use standard DOM APIs and are not affected by CSP. Especially useful for typing into contenteditable rich-text editors: focus the element first, then call document.execCommand("insertText", false, yourText).',
    toolType: 'extension',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID' },
        code:  { type: 'string', description: 'JavaScript to execute in the tab context' },
      },
      required: ['tabId', 'code'],
    },
    code: '',
  },

  // ── Vision / AI analysis ─────────────────────────────────────────────────────
  {
    name: 'vision_check',
    description: 'Take a screenshot of a browser tab and send it to Claude Vision with a custom question. Returns { passed: boolean, answer: string, reason: string }. Use when visual state cannot be detected from the DOM — e.g. checking if a notification badge is orange/highlighted, verifying a chart rendered correctly, or detecting a UI change that only appears visually.',
    toolType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        tabId:  { type: 'number', description: 'Tab ID to screenshot' },
        prompt: { type: 'string', description: 'Question to ask Claude Vision about the screenshot. Be specific — e.g. "Is the notification bell icon orange or highlighted, indicating unread notifications?"' },
      },
      required: ['tabId', 'prompt'],
    },
    code: 'vision_check',
  },
];
