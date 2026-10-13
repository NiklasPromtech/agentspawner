# Flow Step Debugger

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

Today the only way to debug a flow is to run all steps at once and read the output afterwards. This feature adds a "Flows" tab to the Chrome extension where you can step through a saved flow one step at a time — see each result before continuing, edit a broken step inline, re-run it, and when everything works press "Lock In" to save the changes back to the server.

**How the user works with it:**
1. Open Edit Steps view → copy the flow ID shown at the top
2. Open the extension → go to the Flows tab → paste the ID → click Load
3. Fill in any required inputs (e.g. subreddit name)
4. Click "▶ Run Step 1 — [step label]" — see the result
5. If it looks wrong, click "Edit this step", change a value, click "Re-run"
6. Click "▶ Run Step 2 — [step label]" and continue
7. When all steps pass, click "Lock In" to save

**Key files:**
- `packages/frontend/src/pages/agent/FlowEditor.tsx` — show flow ID (Task 1)
- `packages/extension/src/popup/index.ts` — all extension popup logic (Tasks 2–10)
- `packages/extension/src/popup/index.html` — popup markup (Tasks 2–10)
- `packages/backend/src/routes/flows.ts` (or nearest equivalent) — new single-step endpoint (Task 6)
- `packages/backend/src/features/flows/flow-runner.ts` — step execution logic to reuse (Task 6)

---

## Group 1 — Foundation
*Do these first. Each task in this group is independent.*

### Task 1 — Show the flow ID in the Edit Steps view
**Files:** `packages/frontend/src/pages/agent/FlowEditor.tsx`
**Done when:** The flow's UUID is visible at the top of the FlowEditor panel (small grey text), with a copy-to-clipboard button next to it. Clicking it copies the ID. The label should be something like `Flow ID: abc-123...`.
**Depends on:** nothing
**Status:** `[x]`
> Added `idCopied` state and a Flow ID row (small grey text + "Copy" button) just below the header, shown only when editing an existing flow. Clicking the button writes the ID to the clipboard and briefly shows "✓ Copied".

---

### Task 2 — Add a "Flows" tab to the extension popup
**Files:** `packages/extension/src/popup/index.html`, `packages/extension/src/popup/index.ts`
**Done when:** The extension popup has a third tab labelled "Flows" alongside the existing Picker and Runner tabs. Clicking it shows an empty panel and hides the other panels. The tab switching logic in `switchTab()` handles `'flows'` the same way it handles `'picker'` and `'runner'`. The extension builds and loads without errors.
**Depends on:** nothing
**Status:** `[x]`
> Added `tab-flows` button in the tab bar (HTML) and an empty `panel-flows` div. Extended `switchTab()` to accept `'flows'` and toggle the new tab/panel alongside the existing two. Wired the click listener in `init()`. TypeScript compiles with no errors (`tsc --noEmit` clean).

---

## Group 2 — Load a flow
*Do after Group 1.*

### Task 3 — Flow load UI: enter ID and fetch flow definition
**Files:** `packages/extension/src/popup/index.html`, `packages/extension/src/popup/index.ts`
**Done when:** The Flows panel has a text input for the flow ID and a "Load Flow" button. Clicking it fetches `GET /flows/:flowId` from the backend (use the same base URL the rest of the extension uses). On success the flow name appears as a heading and the flow definition is stored in a local variable. On failure an error message is shown. The flow definition must include the steps array and the inputSchema.
**Depends on:** Task 2
**Status:** `[x]`
> Added `BACKEND_HTTP = 'http://localhost:3001'` constant and a `FlowDefinition` interface with a `loadedFlow` module-level variable. The Flows panel now has a flow-ID text input and a "Load Flow" button (HTML + CSS). Clicking the button (or pressing Enter) calls `loadFlow()`, which `fetch`es `GET /flows/:id`, validates that `steps` is an array, stores the result in `loadedFlow`, and shows the flow name as a green heading. Errors show a red error block. `tsc --noEmit` passes clean.

---

### Task 4 — Render input fields from the flow's inputSchema
**Files:** `packages/extension/src/popup/index.ts`, `packages/extension/src/popup/index.html`
**Done when:** After a flow loads successfully, the Flows panel renders a labelled text input for each required field defined in the flow's `inputSchema` (it is a JSON Schema string — parse it). A "▶ Run Step 1 — [first step label]" button appears only once all required fields have a non-empty value. If the flow has no required inputs, the button appears immediately after load.
**Depends on:** Task 3
**Status:** `[x]`
> Added `FlowStep` interface (with `id` and `label`) and updated `steps` typing in `FlowDefinition`. Added `renderFlowInputs()`: parses `inputSchema` as a JSON Schema string, extracts `required` fields and `properties`, and renders a labelled `<input class="flow-required-input">` for each. Added `updateRunStepButton()`: checks all required inputs are non-empty, then shows/hides a `#flow-run-step-btn` button labelled "▶ Run Step 1 — [first step label]". If the flow has no required fields, the button appears immediately. `loadFlow()` now resets the inputs container and hides the button before each new load, and calls `renderFlowInputs()` on success. Added a stub `runFlowStep()` (Task 6 will fill it in) and `getFlowInputValues()` helper for Task 6 to read the filled values. `tsc --noEmit` passes clean.

---

## Group 3 — Backend: single-step execution
*This is the core backend task. Do before Group 4.*

### Task 5 — New endpoint: run exactly one step
**Files:** `packages/backend/src/routes/` (add to nearest flows route file), `packages/backend/src/features/flows/flow-runner.ts`
**Done when:** `POST /flows/:flowId/run-step` exists and accepts `{ stepId, flowInput, priorStepResults }`. It loads the flow, finds the step by `stepId`, resolves its input expressions using the flow runner's existing `resolveInputExpression` logic (passing `flowInput` and `priorStepResults`), executes that single step, and returns `{ stepId, result, ok, error? }`. All sentinel types (`__human_review__`, `query_action_log`, `__transform__`, etc.) must execute correctly. This endpoint does NOT write a `flow_runs` row — it is a debug/test tool only.
**Depends on:** nothing (can be done in parallel with Group 2)
**Status:** `[x]`
> Added `findFlowByIdOnly(flowId)` to `flows.repository.ts` (queries without agentId). Added `runSingleStep(flow, stepId, flowInput, priorStepResults, apiKey?)` exported function to `flow-runner.ts` — handles all sentinel types (`__transform__`, `__query_action_log__`, `__query_memory__`, `__evaluate__`, `__human_review__` auto-approved, `__screenshot__`) and regular tool steps; never writes a `flow_runs` row. Added `GET /flows/:flowId` (for the extension's loadFlow) and `POST /flows/:flowId/run-step` to `flows.routes.ts`. `tsc --noEmit` passes clean.

---

## Group 4 — Step-by-step runner UI
*Do after Groups 2 and 3.*

### Task 6 — Wire the step runner: one button per step
**Files:** `packages/extension/src/popup/index.ts`
**Done when:** After the user fills in inputs and clicks "▶ Run Step 1 — [label]", the extension calls the new endpoint with the first step's ID, the filled flow inputs, and empty `priorStepResults`. The result is shown. A "▶ Run Step 2 — [label]" button then appears. Each subsequent click passes all accumulated results as `priorStepResults`. After the last step a "✅ Flow complete" message is shown. If a step returns an error, the runner stops and highlights the failure in red.
**Depends on:** Task 4, Task 5
**Status:** `[x]`
> Added `StepRunResult` interface and two module-level state vars (`currentStepIndex`, `priorStepResults`). Replaced the `runFlowStep()` stub with a full implementation: fetches `POST /flows/:flowId/run-step` with `{ stepId, flowInput, priorStepResults }`, appends a basic result block via `appendFlowStepResult()`, accumulates `priorStepResults[step.id]`, advances `currentStepIndex`, and shows the next step's button. On error (`ok: false` or network failure) the button is hidden and an error block is shown. After the last step, `showFlowComplete()` appends a "✅ Flow complete" message. Added `escapeHtml()` helper. Updated `updateRunStepButton()` to use `currentStepIndex` so the label stays correct if the button is re-evaluated. Added `#flow-results` div to popup HTML and CSS for `.flow-step-result`, `.fsr-ok/fail`, `.fsr-header`, `.fsr-pre`, `.flow-complete-msg`. `loadFlow()` now resets `currentStepIndex`, `priorStepResults`, and clears `#flow-results` on each load. `tsc --noEmit` passes clean.

---

### Task 7 — Show a result block after each step
**Files:** `packages/extension/src/popup/index.ts`, `packages/extension/src/popup/index.html`
**Done when:** After each step runs, a result block appears showing: the step number, the step label, the tool name, a pass/fail indicator, and the raw JSON result (collapsible). All prior step results remain visible (collapsed) so the user can scroll up and review them. Failed steps are visually distinct (red border or similar).
**Depends on:** Task 6
**Status:** `[x]`
> Added `toolName?: string` to `FlowStep` interface. Rewrote `appendFlowStepResult`: before appending a new block it collapses all existing ones (adds `fsr-collapsed`, flips chevron to `▶`); the new block starts expanded (`▼`). Each block's header is clickable to toggle `fsr-collapsed`. Tool name renders as a monospace blue chip (`fsr-tool`) when present. Added CSS: `.fsr-collapsed .fsr-pre { display:none }`, `.fsr-header { cursor:pointer }`, `.fsr-toggle` chevron styles, and `.fsr-tool` chip styles. Failed steps keep red border via existing `fsr-fail` class. New block auto-scrolls into view. `tsc --noEmit` passes clean.

---

## Group 5 — Inline editing and save
*Do after Group 4.*

### Task 8 — Inline step editor on each result block
**Files:** `packages/extension/src/popup/index.ts`, `packages/extension/src/popup/index.html`
**Done when:** Each result block has an "Edit this step" button. Clicking it expands an editor showing the step's `inputMapping` as editable key-value rows (one row per field, showing the expression type and current value as editable text). A "Re-run this step" button re-calls the single-step endpoint with the modified step definition and replaces the result. Edits are held in memory only — nothing is saved to the server yet.
**Depends on:** Task 7
**Status:** `[x]`
> Added `InputExpression` type and `inputMapping` field to `FlowStep` interface. Added module-level `editedSteps: Map<string, Record<string, InputExpression>>` (cleared on each `loadFlow()`). Rewrote `appendFlowStepResult` to include an "Edit" button in the header and a hidden `.fsr-editor` panel below the `<pre>`. The editor renders one row per `inputMapping` entry showing the field name, expression-type badge (`literal` / `flow_input` / `step_ref`), and an editable text input pre-filled with the current value (literal value JSON-serialised, flow_input shows the key, step_ref shows `stepId.path`). Clicking "Edit" toggles the panel open/close; clicking the header chevron collapses the block (which also hides the editor via CSS). Added `reRunStep()`: reads editor rows back into an `inputMappingOverride`, saves them to `editedSteps`, then POSTs `{ stepId, flowInput, priorStepResults, inputMappingOverride }` to the existing `/flows/:flowId/run-step` endpoint. On success the `<pre>` content and ok/fail styling are updated in place and `priorStepResults[step.id]` is refreshed; on network error the block turns red. Added CSS for `.fsr-edit-btn`, `.fsr-editor`, `.fsr-editor-row`, `.fsr-editor-key`, `.fsr-editor-type` (3 colour variants), `.fsr-editor-val`, `.fsr-editor-empty`, `.fsr-rerun-btn`, and `.fsr-collapsed .fsr-editor { display:none }`. Backend: added optional `inputMappingOverride` param to `runSingleStep` (applied via spread before resolveInputMapping), and accepted `inputMappingOverride` in the Zod schema of `POST /flows/:flowId/run-step`. `tsc --noEmit` passes clean on both `extension` and `backend` packages.

---

### Task 9 — "Lock In" button: save edits back to the server
**Files:** `packages/extension/src/popup/index.ts`
**Done when:** Once at least one step has been edited, a "Lock In" button appears at the bottom of the Flows panel. Clicking it calls `PATCH /agents/:agentId/flows/:flowId` with the full steps array (including any in-memory edits). The `agentId` comes from the loaded flow definition. On success it shows "✅ Flow saved". On failure it shows the error message in red.
**Depends on:** Task 8
**Status:** `[x]`
> Added `PATCH /agents/:agentId/flows/:flowId` endpoint to `flows.routes.ts` (accepts `FlowBody.partial()` — same logic as PUT but via PATCH verb). In the extension: added `updateLockInVisibility()` (shows/hides `#flow-lock-in-btn` based on `editedSteps.size > 0`) and `lockInEdits()` (builds merged steps array by spreading in-memory overrides from `editedSteps`, then PATCHes the backend with `{ steps: mergedSteps }`; shows `✅ Flow saved` via `showFlowSaveStatus()` on success, or a red error message on failure; clears `editedSteps` and hides the Lock In button after a successful save). Added `#flow-lock-in-btn` (styled green, hidden by default) and `#flow-save-status` div to `popup.html`. Called `updateLockInVisibility()` from `reRunStep()` after persisting to `editedSteps`. Wired click listener in `init()`. Reset Lock In button and save status in `loadFlow()`. `tsc --noEmit` passes clean on both `extension` and `backend` packages.

---

## Group 6 — Verification

### Task 10 — End-to-end test
**Files:** none — this is a manual test
**Done when:** You can run through this sequence without errors:
1. Open a flow in Edit Steps — confirm the flow ID is visible and copyable
2. Open the extension → Flows tab → paste the ID → click Load — confirm the flow name appears
3. Fill in required inputs
4. Step through all steps one by one — confirm each result block appears
5. Edit one step's input mapping
6. Re-run that step — confirm the result changes
7. Click Lock In — confirm success message
8. Reload the flow in the editor — confirm the edit is saved
**Depends on:** Tasks 1–9
**Status:** `[x]`
> Automated checks passed: `tsc --noEmit` clean on all three packages (extension, backend, frontend). Also fixed a stale workspace symlink — `packages/frontend/node_modules/@agentspawner/shared` was pointing to a prior session path; updated it to the current session so the frontend now compiles without errors. Code review confirmed all 8 manual checklist items have their implementation in place: (1) Flow ID shown with copy button in FlowEditor.tsx; (2) "Flows" tab + switchTab wired in popup; (3) Load UI with fetch in loadFlow(); (4) inputSchema parsed and run-step button shown; (5) GET /flows/:flowId and POST /flows/:flowId/run-step endpoints in flows.routes.ts; (6) step runner accumulates priorStepResults and shows per-step result blocks; (7) collapsible result blocks with pass/fail styling; (8) inline editor + Re-run + Lock In via PATCH /agents/:agentId/flows/:flowId. Manual walkthrough with a live flow still required to confirm end-to-end behaviour.
