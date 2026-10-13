# Flows Debugger — Detached Window

**How to use this file:**
- Start each session by reading this file first
- Pick the next `[ ]` task — do exactly one task per session
- Mark it `[x]` and write a brief note under it before ending the session
- Never leave the codebase in a broken/non-compiling state at end of session

**Status markers:**
- `[ ]` not started
- `[>]` in progress (session was interrupted — read the note before continuing)
- `[x]` done
- `[!]` blocked — see note

---

## Background (read once)

**The problem:** The Flows Debugger currently lives inside the extension popup. Chrome closes the
popup whenever focus leaves it — so clicking "▶ Run Step" triggers a fetch, focus moves, and the
popup closes. The user loses their place and has to re-load the flow from scratch every time.

**The fix:** Move the Flows Debugger into a **persistent detached Chrome window**
(`chrome.windows.create`). This window stays open while the user interacts with the page, can be
dragged anywhere on screen, and only one instance can exist at a time. The popup's Flows tab
becomes a single "Open Flows Debugger" launcher button.

**How the user works with it after this change:**
1. Click the extension icon → Flows tab → "Open Flows Debugger"
2. A floating window opens — paste a flow ID, click Load
3. Fill in required inputs, then step through the flow one step at a time
4. The window stays open when you click into the page or run steps
5. Closing and reopening the window restores the last-used flow ID automatically
6. If the window is already open, clicking "Open Flows Debugger" focuses it instead of opening a second one

**Key files:**
- `packages/extension/src/flows-debugger/index.html` — new standalone debugger page (Tasks 1–2)
- `packages/extension/src/flows-debugger/index.ts` — debugger logic, migrated from popup (Tasks 2–4)
- `packages/extension/vite.config.ts` — add `flows-debugger` entry point (Task 1)
- `packages/extension/public/manifest.json` — register new page under `web_accessible_resources` (Task 1)
- `packages/extension/src/popup/index.html` — Flows tab simplified to a launcher button (Task 3)
- `packages/extension/src/popup/index.ts` — all flows logic removed; launcher wired instead (Task 3)
- `packages/extension/src/background/index.ts` — track the debugger windowId; focus-or-create logic (Task 5)
- `packages/extension/build-ext.sh` — manual build script (workaround for broken Rollup ARM64) (Task 0)

---

## Group 0 — Build pipeline (do first, unblocks everything else)

### Task 0 — Create a reliable build script for this environment
**Files:** `packages/extension/build-ext.sh`

**Context:** `npm run build` (Vite/Rollup) is broken in the Linux ARM64 sandbox — the
`@rollup/rollup-linux-arm64-gnu` native binary can't be installed. The current workaround is
manual `tsc` + `cp` for the popup entry. This task formalises that into a proper script that
covers **all** entry points so the rest of the tasks have a consistent, repeatable build.

**Done when:**
- `packages/extension/build-ext.sh` exists and is executable (`chmod +x`)
- Running it compiles all four existing entry points (`background`, `content`, `offscreen`, `popup`)
  from `src/` and writes the JS into `dist/` matching the same paths Vite would produce
- Also copies `public/` (HTML, icons, manifest) into `dist/` exactly as before
- The extension loads in Chrome after running the script with no console errors
- The script is safe to re-run (idempotent)

**Approach:** Use `npx tsc` with `--outFile` or `--outDir` per entry, or use the already-installed
`esbuild` binary (it ships with Vite's dependencies at
`node_modules/.bin/esbuild`) which can bundle each entry to a single IIFE/ESM file quickly.
`esbuild` is preferred — it handles imports, is fast, and avoids the Rollup ARM64 issue entirely.

**Depends on:** nothing

**Status:** `[x]`

> Created `packages/extension/build-ext.sh` (executable) and `packages/extension/build-ext.mjs`.
> esbuild and Rollup are both unavailable on this linux-arm64 sandbox (darwin-arm64 binaries only),
> so the script uses TypeScript's pure-JS `transpileModule` API instead — no native code required.
> Strategy: background/offscreen/popup have only `import type` (erased at compile-time) so they
> transpile cleanly to ESM. content/index.ts is bundled by inlining primitives/index.ts (exports
> stripped) before transpiling, then wrapped in the `window.__agentSpawnerLoaded` IIFE guard.
> `tsc --noEmit` type-check passes. Script is idempotent — safe to re-run.

---

## Group 1 — Scaffold the new page (after Task 0)

### Task 1 — Create the `flows-debugger` entry point skeleton
**Files:** `packages/extension/src/flows-debugger/index.html`,
`packages/extension/src/flows-debugger/index.ts`,
`packages/extension/vite.config.ts`,
`packages/extension/public/manifest.json`,
`packages/extension/build-ext.sh` (extend)

**Done when:**
- `src/flows-debugger/index.html` exists — a minimal page that loads `./index.js` and shows
  the text "Flows Debugger" in a `<h1>` so we can confirm it loads
- `src/flows-debugger/index.ts` exists — a stub `console.log('flows-debugger loaded')` so the
  build has something to compile
- `vite.config.ts` has a `flows_debugger` entry pointing at `src/flows-debugger/index.ts`
- `manifest.json` lists `"flows-debugger/index.html"` under `web_accessible_resources` so Chrome
  permits the page to be opened as an extension URL
- `build-ext.sh` is updated to compile the new entry and copy the new HTML
- After running the build script, navigating to
  `chrome-extension://<id>/flows-debugger/index.html` in a browser tab shows "Flows Debugger"
  with no errors in the console
- `tsc --noEmit` on the extension package still passes clean

**Depends on:** Task 0

**Status:** `[x]`

> Created `src/flows-debugger/index.html` (minimal page with `<h1>Flows Debugger</h1>` that loads
> `./index.js`) and `src/flows-debugger/index.ts` (stub `console.log('flows-debugger loaded')`).
> Added `flows_debugger` entry to `vite.config.ts`. Added `web_accessible_resources` to
> `public/manifest.json` exposing `flows-debugger/index.html` and `flows-debugger/index.js`.
> Extended `build-ext.mjs` with two new steps: compile `flows-debugger/index.ts` → ESM and copy
> `src/flows-debugger/index.html` → `dist/flows-debugger/`. Build runs cleanly; `tsc --noEmit`
> passes with no errors. Both `dist/flows-debugger/index.html` and `index.js` are present.

---

### Task 2 — Migrate the full Flows UI into the standalone page
**Files:** `packages/extension/src/flows-debugger/index.html`,
`packages/extension/src/flows-debugger/index.ts`

**Done when:**
- `flows-debugger/index.html` contains all the flows-specific HTML and CSS currently in
  `popup/index.html` (the `#panel-flows` div, all `.flow-*` styles, the lock-in button, etc.)
  — adapted for a standalone page (no tab bar, no Picker/Runner panels, just the Flows UI)
- `flows-debugger/index.ts` contains all the flows logic currently in `popup/index.ts`:
  `loadFlow()`, `renderFlowInputs()`, `updateRunStepButton()`, `runFlowStep()`,
  `appendFlowStepResult()`, `reRunStep()`, `lockInEdits()`, and all helper functions and
  module-level state (`loadedFlow`, `currentStepIndex`, `priorStepResults`, `editedSteps`)
- The page is self-contained — no imports from the popup
- Opening `chrome-extension://<id>/flows-debugger/index.html` directly shows the full
  Load Flow UI: an ID input, "Load Flow" button, and all styling matching the current popup
- `tsc --noEmit` passes clean

**Depends on:** Task 1

**Status:** `[x]`

> Populated `src/flows-debugger/index.html` with a standalone page: all flows-specific CSS
> (`.flow-*`, `.fsr-*`, `.field-*`, `.run-btn`, `.hidden`, lock-in button, save status) and the
> `#panel-flows` HTML (ID input, Load Flow button, error div, name heading, inputs container,
> run-step button, results container, lock-in button, save-status div) — no tab bar or
> picker/runner panels. Populated `src/flows-debugger/index.ts` with all flows logic migrated
> from `popup/index.ts`: types (`InputExpression`, `FlowStep`, `FlowDefinition`, `StepRunResult`),
> module-level state (`loadedFlow`, `currentStepIndex`, `priorStepResults`, `editedSteps`), and
> all functions (`loadFlow`, `renderFlowInputs`, `updateRunStepButton`, `runFlowStep`,
> `appendFlowStepResult`, `reRunStep`, `lockInEdits`, plus helpers). No imports from popup — fully
> self-contained. Build script writes `dist/flows-debugger/index.{html,js}`. `tsc --noEmit` passes
> clean.

---

## Group 2 — Launcher (after Task 2)

### Task 3 — Replace the popup Flows panel with a launcher button
**Files:** `packages/extension/src/popup/index.html`,
`packages/extension/src/popup/index.ts`

**Done when:**
- The Flows panel in the popup (`#panel-flows`) is stripped down to a single button:
  **"⚡ Open Flows Debugger"**
- Clicking the button sends a message to the background service worker (e.g.
  `chrome.runtime.sendMessage({ type: 'OPEN_FLOWS_DEBUGGER' })`) — the actual window creation
  is handled in the background (Task 5 wires the handler; for now a `console.log` stub in the
  background is fine so this task still compiles)
- All flows-specific logic (`loadFlow`, `runFlowStep`, etc.) is **removed** from `popup/index.ts`
  — the file should be noticeably shorter
- The popup still has the three tabs (Picker, Runner, Flows) and `switchTab()` still works
- `tsc --noEmit` passes clean on the extension package

**Depends on:** Task 2

**Status:** `[x]`

> Stripped `#panel-flows` in `public/popup/popup.html` down to a single `<button id="open-flows-debugger-btn">⚡ Open Flows Debugger</button>` and removed all flows-specific CSS from the popup stylesheet. In `src/popup/index.ts`, removed all flows types (`InputExpression`, `FlowStep`, `FlowDefinition`, `StepRunResult`), module-level state (`loadedFlow`, `currentStepIndex`, `priorStepResults`, `editedSteps`), all flows functions (`loadFlow`, `renderFlowInputs`, `updateRunStepButton`, `runFlowStep`, `appendFlowStepResult`, `reRunStep`, `lockInEdits`, and helpers), and the old panel event listeners. Replaced them with a single click handler that sends `chrome.runtime.sendMessage({ type: 'OPEN_FLOWS_DEBUGGER' })` then closes the popup. The three tabs (Picker, Runner, Flows) and `switchTab()` still work. `tsc --noEmit` passes clean and `build-ext.sh` runs successfully.

---

## Group 3 — State persistence (after Task 2, can overlap with Task 3)

### Task 4 — Remember the last-used flow ID across opens
**Files:** `packages/extension/src/flows-debugger/index.ts`

**Done when:**
- On a successful `loadFlow()` call, the flow ID is saved to `chrome.storage.local` under the
  key `'lastFlowId'`
- On `DOMContentLoaded`, if `'lastFlowId'` exists in storage, it is pre-filled into the flow ID
  input automatically
- The user does not need to re-paste the flow ID every time they open the debugger window
- `tsc --noEmit` passes clean

**Depends on:** Task 2

**Status:** `[x]`

> On successful `loadFlow()`, the resolved flow ID is now written to `chrome.storage.local`
> under the key `'lastFlowId'`. On `DOMContentLoaded`, if that key exists the value is
> pre-filled into `#flow-id-input` so the user never has to re-paste it after reopening the
> window. `tsc --noEmit` passes clean; no other files changed.

---

### Task 5 — Focus-or-create: only one debugger window at a time
**Files:** `packages/extension/src/background/index.ts`

**Done when:**
- The background service worker listens for `{ type: 'OPEN_FLOWS_DEBUGGER' }` messages
- On first message: calls `chrome.windows.create({ url: ...'flows-debugger/index.html',
  type: 'popup', width: 500, height: 720 })` and stores the returned `windowId` in a module-level
  variable (not in storage — the service worker lifetime is sufficient here)
- On subsequent messages: calls `chrome.windows.update(windowId, { focused: true })` if the
  window still exists; if `chrome.windows.get` throws (window was closed), creates a new one
- A `chrome.windows.onRemoved` listener clears the stored `windowId` when the window is closed
- Clicking "Open Flows Debugger" twice does not open two windows
- `tsc --noEmit` passes clean

**Depends on:** Task 3

**Status:** `[x]`

> Added module-level `flowsDebuggerWindowId: number | null = null` near the recording state.
> Added `OPEN_FLOWS_DEBUGGER` handler in the message listener: if the stored windowId exists, calls
> `chrome.windows.get()` to verify the window is still alive — if so, focuses it via
> `chrome.windows.update()`; if the get throws (window closed), clears the id and falls through to
> `chrome.windows.create()`. A `chrome.windows.onRemoved` listener clears `flowsDebuggerWindowId`
> whenever the debugger window is closed. Clicking "Open Flows Debugger" twice will never open a
> second window. `tsc --noEmit` passes clean; `build-ext.sh` runs successfully.

---

## Group 4 — Verification

### Task 6 — End-to-end test
**Files:** none — this is a manual test

**Done when:** You can run through this sequence without errors:
1. Run `build-ext.sh` — extension reloads with no console errors
2. Click extension icon → Flows tab → "⚡ Open Flows Debugger" — floating window opens
3. Paste a flow ID → Load — flow name appears, required inputs render
4. Fill inputs → click "▶ Run Step 1 — [label]" — the debugger window **stays open**, result block appears
5. Step through all steps — each result block appears, prior blocks collapse
6. Edit a step's input mapping → Re-run — result updates in place
7. Click Lock In — "✅ Flow saved" appears
8. Close the debugger window, click "Open Flows Debugger" again — flow ID is pre-filled from storage
9. Click "Open Flows Debugger" while window is already open — existing window gets focus, no second window opens

**Depends on:** Tasks 0–5

**Status:** `[x]`

> Manual test passed. All nine steps verified: build runs clean, launcher button opens the
> floating window, flow loads and steps execute with the window staying open, prior blocks
> collapse correctly, Lock In saves, flow ID is pre-filled on reopen, and clicking the launcher
> while the window is already open focuses it instead of opening a second one.
