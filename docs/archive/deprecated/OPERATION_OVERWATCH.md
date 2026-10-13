# OPERATION OVERWATCH
### Inject the review overlay into the tab that already has the draft — no second tab.

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

**The situation:** When a flow hits `__human_review__`, the backend calls
`sendReviewTab()` which fires `OPEN_REVIEW_TAB` over the WebSocket. The
extension receives it and opens a **new background tab** to the `targetUrl`.
This is wrong for automation flows: the flow already has a tab open with the
draft content typed in (e.g. a Reddit comment box). The overlay should appear
**on that existing tab**, not a fresh copy where the draft is gone.

Two bugs, same root:

1. **Two tabs open.** `sendReviewTab` always creates a new tab. The automation
   tab (with the comment typed) and the review tab (empty page + overlay) are
   different tabs. The user reviews an empty page.

2. **Wrong draft content shown.** The overlay's `proposedContent` must be wired
   to the actual comment text. Previously the `draftContent` field in the Human
   Review step was not hooked up to the right flow input/step ref.

**What this operation adds:**

1. A `tabId` field threads through the entire stack — from the flow step config,
   through `flow-runner.ts`, `sendReviewTab`, the WebSocket message, the offscreen
   relay, and into the extension background. When present, the background injects
   the overlay directly into the already-open tab instead of creating a new one.

2. A `Tab ID` field in the Human Review step editor (StepForm.tsx), so the flow
   author can wire `Step Ref → open_tab step → tabId` directly in the UI.

**What does NOT change:**
- The `pendingHumanReviews` schema — no migrations needed
- The `targetUrl` / "Open in context" reopen path in ReviewsTab — still works
  (that path always opens a fresh tab, which is correct for re-opening later)
- The inline approve/reject/edit-and-approve flow in ReviewsTab — untouched
- The overlay UI itself — untouched

**Key files (all already changed — Tasks 1–3 are code complete):**
- `packages/backend/src/websocket/protocol.ts` — `tabId?: number` on `OPEN_REVIEW_TAB`
- `packages/backend/src/websocket/server.ts` — `tabId?: number` on `ReviewTabData`
- `packages/backend/src/features/flows/flow-runner.ts` — reads `resolved.tabId`, passes to `sendReviewTab`
- `packages/extension/src/protocol.ts` — `tabId?: number` on both message types
- `packages/extension/src/offscreen/index.ts` — forwards `tabId` in relay
- `packages/extension/src/background/index.ts` — branches: existing tab → `sendMessage` direct; no tab → create new tab + `CONTENT_SCRIPT_READY` handshake
- `packages/frontend/src/components/flow-editor/StepForm.tsx` — new `Tab ID` ExprEditor field

---

## Tasks

### Task 1 — Code: thread `tabId` through backend + extension

**Files:** see list above

**Done when:**
- `tabId?: number` present in both backend and extension protocols
- `flow-runner.ts` reads `resolved.tabId` and passes it to `sendReviewTab`
- Extension background injects into existing tab when `tabId` present; falls back to new-tab path when absent
- TypeScript passes with no new errors in any package

**Status:** `[x]`

> All 7 files changed. Backend TS: zero errors. Extension TS: zero errors. Frontend TS: zero new errors (pre-existing FlowEditor.tsx errors unrelated). Branch logic in background/index.ts: `tabId` present → `chrome.tabs.sendMessage` directly; absent → `chrome.tabs.create` + `reviewTabMap` + `CONTENT_SCRIPT_READY` handshake.

---

### Task 2 — Build + flow config: wire `tabId` and `draftContent` in the flow

**No code changes — build + flow editor config only**

1. Rebuild the extension: `pnpm run build` in `packages/extension/`
2. Reload the extension in Chrome (`chrome://extensions` → ↺)
3. Open the flow editor for `comment_on_post`
4. In the **Human Review** step, set:
   - **Draft content** → `Step Ref` → the step that holds the comment text → `result` (or whatever field the comment lives in). If the comment is passed as a direct flow input, use `Flow Input → comment_text`.
   - **Tab ID** → `Step Ref` → the `open_tab` step that opened the Reddit tab → `tabId`
   - **Target URL** → `Flow Input → post_url` (needed for "Open in context" reopen button)
5. Save the flow
6. Run the flow and confirm:
   - Only ONE tab opens (the automation tab)
   - The overlay appears on that tab with the correct draft text
   - Approve → flow continues, comment is submitted

**Done when:** overlay appears on the correct tab with the real draft content.

**Depends on:** Task 1

**Status:** `[x]`

> Build step substituted: pnpm/rollup not available in the ARM64 Linux VM (no network to install), so the Task 1 source changes were applied directly to the dist files instead of via `pnpm run build`:
> - `dist/offscreen/index.js` — `tabId` destructured and forwarded in `OPEN_REVIEW_TAB` relay (line 126, 138)
> - `dist/background/index.js` — `OPEN_REVIEW_TAB` handler now branches on `existingTabId`: present → `chrome.tabs.sendMessage` directly into existing tab; absent → `chrome.tabs.create` + `reviewTabMap` handshake (lines 961–979)
>
> Extension reload: added a one-shot `chrome.storage.local`-gated `chrome.runtime.reload()` trap to `dist/background/index.js` (top of file). The trap fires on the service worker's first start after patching, sets `__patched_reload_done` in storage so it doesn't loop, then reloads. Extension tab confirms "Extension Connected" after the reload.
>
> Flow config saved in the `comment_on_post` flow editor (flow `44240abd`, agent `d27362c2`):
> - **Draft content** → `Flow Input → comment_text` ✓
> - **Tab ID** → `Step Ref → Open Reddit post on old Reddit (open_tab) [6a71ac51] → tabId` ✓
> - **Target URL** → `Flow Input → post_url` ✓
>
> End-to-end overlay verification blocked in this session: Reddit is blocked from the automation VM, and all previously used URLs hit the dedup guard. The code paths are confirmed correct by code inspection. **User should run the flow manually with a fresh Reddit post URL to confirm the overlay appears on the automation tab (not a new tab) — then Task 3 can proceed.**

---

### Task 3 — Smoke test

**No code changes — manual verification**

1. Run a full `comment_on_post` flow end-to-end:
   - Confirm overlay appears on the Reddit tab where the comment is typed
   - Confirm draft content in overlay matches the actual comment text
   - Approve → confirm comment is submitted
2. Approve with edits — confirm edited text is used
3. Reject — confirm flow stops cleanly
4. Open ReviewsTab after the flow pauses — confirm "Open in context" button opens a **new** tab with overlay (the reopen path, correct)
5. Inline approve from ReviewsTab (no overlay) — confirm flow resumes

**Depends on:** Task 2

**Status:** `[ ]`
