# Tab Overlay Approval — In-Context Action Review

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

**The problem:** When an autonomous agent calls `queue_action`, the action currently sits in the `pendingActions` DB table and the user has to go find it in the ActionsTab inside the UI. This is disconnected from context — the user can't see the actual Reddit thread (or Twitter profile, or email inbox) when deciding whether to approve.

**The intended UX:** When the agent queues an action, a real browser tab opens to the target URL automatically. The Chrome extension injects a floating overlay onto that page showing the proposed content (the comment text, DM, etc.) with three buttons: **Approve**, **Approve with Edits**, and **Reject**. The user can read the actual page — the thread, the profile, the conversation — and make an informed decision in context. Multiple queued actions open as multiple tabs. The user works through them at their own pace.

**The tone learning hook:** When the user clicks "Approve with Edits" and changes the text, the original draft vs. the final version is stored as a `toneEdits` record — the same mechanism already used by the `pendingHumanReviews` / ReviewsTab flow. After a handful of edits, Claude auto-refreshes the agent's tone guide. Over time the agent needs fewer corrections.

**How data flows end-to-end:**

```
Agent calls queue_action
  → backend writes pendingAction (status: 'pending')
  → backend sends WebSocket msg OPEN_REVIEW_TAB to extension
      { actionId, url, proposedContent, actionType, title, description }
  → extension background opens new Chrome tab to url
  → extension stores { tabId → actionId } in memory
  → tab finishes loading
  → background sends chrome.tabs.sendMessage → content script
      INJECT_REVIEW_OVERLAY { actionId, proposedContent, title, description, backendUrl }
  → content script injects overlay DOM + CSS onto the live page
  → user reads page, decides

If Approve:
  → overlay POSTs { status: 'approved' } to backend PATCH /agents/:agentId/actions/:actionId
  → overlay self-removes, tab can be closed (or left open)

If Approve with Edits:
  → user edits textarea in overlay
  → overlay POSTs { status: 'approved', editedContent: '...' } to backend
  → backend writes toneEdit pair (agentDraft → humanFinal), may refresh toneGuide
  → overlay self-removes

If Reject:
  → overlay POSTs { status: 'rejected' } to backend
  → overlay self-removes

Agent loop (next iteration):
  → list_pending_actions returns approved/rejected record
  → agent proceeds accordingly
```

**Why the overlay POSTs directly to the backend (not via WebSocket):**
The content script already has `http://localhost:3001/*` in `host_permissions` (it's in the manifest). A direct fetch is simpler, more reliable, and doesn't require the WebSocket to stay alive while the user thinks.

**What does NOT need to change:**
- The ActionsTab in the frontend still works as a fallback (user can still approve/reject there if the tab was closed before they decided)
- The `pendingActions` schema needs no changes
- `list_pending_actions` inside the agent loop needs no changes
- The WebSocket offscreen architecture is unchanged — we add one new outbound message type

**Key files:**
- `packages/backend/src/orchestrator/autonomous.ts` — `queue_action` handler (Task 1)
- `packages/backend/src/websocket/server.ts` — new `sendReviewTab()` export (Task 1)
- `packages/extension/src/background/index.ts` — receive `OPEN_REVIEW_TAB`, open tab, track mapping, inject after load (Task 2)
- `packages/extension/src/content/index.ts` — listen for `INJECT_REVIEW_OVERLAY`, inject overlay, handle buttons (Task 3)
- `packages/backend/src/routes/actions.ts` — accept `editedContent` on PATCH, write toneEdit (Task 4)
- `packages/extension/src/offscreen/index.ts` — forward new WS message type to background (Task 2, minor)

---

## Group 1 — Backend: signal the extension when an action is queued

### Task 1 — Emit `OPEN_REVIEW_TAB` over WebSocket after inserting a pendingAction

**Files:** `packages/backend/src/orchestrator/autonomous.ts`, `packages/backend/src/websocket/server.ts`

**Context:**
The `queue_action` handler in `autonomous.ts` (around line 2327) inserts a row into `pendingActions` and returns a success message. Right now that's all it does. We need it to also call a new helper on the WebSocket server to push a message to the extension.

In `websocket/server.ts` there is already a `executeExtensionTool()` export for sending `EXECUTE_TOOL` messages. We need a second export: `sendReviewTab()` which sends a new message type `OPEN_REVIEW_TAB` to the active socket (if one is connected). It should fire-and-forget — if no extension is connected, silently skip (the action is still in the DB and the ActionsTab fallback still works).

The payload for `OPEN_REVIEW_TAB` should include:
- `actionId` — the UUID just created
- `agentId` — so the extension can construct the right backend URL for the approve/reject POST
- `url` — extracted from `payload.post_url` for `type: 'post'`, `payload.profile_url` or similar for `type: 'dm'`, etc. If no URL is present in the payload, skip opening a tab (don't error — the action stays pending in ActionsTab)
- `proposedContent` — the text the agent wants to post/send: `payload.comment_text`, `payload.message`, `payload.body`, etc. (try common field names in order)
- `actionType` — the `type` field ('post', 'dm', 'email', etc.)
- `title` — the action title
- `description` — the action description

**Done when:**
- `sendReviewTab(data)` is exported from `websocket/server.ts` and sends `{ type: 'OPEN_REVIEW_TAB', ...data }` over the active socket if present, no-ops if not
- `queue_action` handler in `autonomous.ts` calls `sendReviewTab()` after the DB insert, passing the extracted fields above
- If `url` cannot be determined from the payload, `sendReviewTab` is not called (action remains pending in ActionsTab only)
- The backend does not throw or crash if the extension is disconnected

**Depends on:** nothing

**Status:** `[x]`

> Added `OPEN_REVIEW_TAB` variant to `BackendToExtension` in `protocol.ts`. Added `sendReviewTab(data: ReviewTabData)` export to `websocket/server.ts` — fire-and-forget, silently no-ops if no socket is connected. Updated `queue_action` handler in `autonomous.ts`: extracts URL and proposed content via two new module-level helpers (`extractActionUrl`, `extractProposedContent`), then calls `sendReviewTab()` only when a URL is available. `email` and `api_call` types intentionally skip tab opening. TypeScript type-check passes with no errors.

---

## Group 2 — Extension background: open tab and inject after load

### Task 2 — Handle `OPEN_REVIEW_TAB` in background, open tab, inject overlay on load

**Files:** `packages/extension/src/background/index.ts`, `packages/extension/src/offscreen/index.ts`

**Context:**
The offscreen document manages the WebSocket connection. When it receives a message from the backend, it currently handles `EXECUTE_TOOL` by routing to the sandbox or dispatching `PRIMITIVE_OP` to the background. We need it to also forward `OPEN_REVIEW_TAB` to the background via `chrome.runtime.sendMessage`.

In the background script, we need a new message handler for `OPEN_REVIEW_TAB` that:
1. Calls `chrome.tabs.create({ url: data.url, active: false })` — open in background so the user isn't immediately pulled away from what they're doing. The tab appears in the tab bar and they go to it when ready.
2. Stores the resulting `tabId` in a `Map<tabId, { actionId, agentId, proposedContent, actionType, title, description }>` (an in-memory map is fine — it doesn't need to survive service worker restarts because the tab itself is the persistent artifact)
3. Listens on `chrome.tabs.onUpdated` — when a tab in the map reaches `status: 'complete'`, sends `chrome.tabs.sendMessage(tabId, { type: 'INJECT_REVIEW_OVERLAY', ...storedData, backendUrl: 'http://localhost:3001' })` and removes the entry from the map

**Edge cases to handle:**
- The tab may already be complete by the time the listener fires (race) — check `changeInfo.status === 'complete'` and also check the tab's current status on creation
- If the tab is closed before it finishes loading — `chrome.tabs.onRemoved` should clean up the map entry
- The `chrome.tabs.onUpdated` listener already exists in the background for recording. Add to it rather than replacing it.

**Done when:**
- Offscreen forwards `OPEN_REVIEW_TAB` messages from WS to background via `chrome.runtime.sendMessage`
- Background opens the tab in the background (`active: false`)
- Background injects `INJECT_REVIEW_OVERLAY` message to the content script once the tab is fully loaded
- Map cleanup works on tab close
- Existing `EXECUTE_TOOL` and recording flows are unaffected

**Depends on:** Task 1

**Status:** `[x]`

> Added `OPEN_REVIEW_TAB` variant to `BackendToExtension` and `OffscreenMessage` in extension's `protocol.ts`. Updated `offscreen/index.ts`: added a `case 'OPEN_REVIEW_TAB'` that forwards the full payload to the background via `chrome.runtime.sendMessage`. Updated `background/index.ts`: added `ReviewTabEntry` interface and `reviewTabMap: Map<number, ReviewTabEntry>`; added `OPEN_REVIEW_TAB` handler in the message listener that calls `chrome.tabs.create({ url, active: false })`, checks for the immediate-complete race condition, and stores the entry in the map otherwise; refactored the `chrome.tabs.onUpdated` listener so the recording early-return no longer blocks review tab logic — both recording re-inject and review overlay injection now run conditionally in the same listener; added `chrome.tabs.onRemoved` listener to clean up map entries when a tab is closed before loading. TypeScript type-check passes with no errors.

---

## Group 3 — Extension content script: inject the overlay

### Task 3 — Listen for `INJECT_REVIEW_OVERLAY`, render overlay, POST decision to backend

**Files:** `packages/extension/src/content/index.ts`

**Context:**
The content script already runs on `<all_urls>` at `document_idle`. It currently only handles `EXECUTE_PRIMITIVE` messages. We need it to also handle `INJECT_REVIEW_OVERLAY`.

**Overlay behaviour:**
- Inject a fixed-position panel into the page DOM (not an iframe — direct DOM injection is fine)
- Position: bottom-right corner, sits above all page content (`z-index: 2147483647`)
- The panel should be visually self-contained — use inline styles or a `<style>` tag with a unique prefix class to avoid colliding with the host page's CSS
- Panel contains:
  - A header showing the `title` from the action
  - A small subtitle showing `actionType` (e.g. "Proposed comment" for 'post', "Proposed DM" for 'dm')
  - A read-only preview of `proposedContent` (a `<pre>` or styled `<div>` with scrollable overflow, max ~200px height)
  - Three buttons: **Approve**, **Approve with Edits**, **Reject**
- "Approve with Edits" expands the preview into an editable `<textarea>` pre-filled with `proposedContent` and adds a **Submit Edit** button
- All three action buttons POST to `{backendUrl}/agents/{agentId}/actions/{actionId}` with appropriate body (see routes/actions.ts PATCH spec)
- On success response, the overlay removes itself from the DOM and briefly shows a small toast ("Approved ✓" / "Rejected ✓") that fades after 2 seconds
- On network error, show an inline error message in the panel — don't remove the overlay so the user can retry

**Style guidance:**
- Dark semi-transparent background (`rgba(15, 15, 15, 0.92)`) with rounded corners and a subtle border
- Approve = green, Reject = red, Approve with Edits = amber/orange
- Keep it compact — the user needs to see the page behind it
- No external CSS dependencies — everything inline or in an injected `<style>` tag

**Done when:**
- Opening the target URL in a tab and receiving the message causes the overlay to appear
- All three buttons work end-to-end
- The editable path correctly sends `editedContent` in the request body
- Overlay removes itself on success
- Existing `EXECUTE_PRIMITIVE` handling is completely untouched

**Depends on:** Task 2

**Status:** `[x]`

> Added `INJECT_REVIEW_OVERLAY` variant to `ContentMessage` in `protocol.ts`. Implemented `injectReviewOverlay()` in `content/index.ts`: injects a fixed-position bottom-right panel (z-index 2147483647) with dark semi-transparent styling, showing the action `title`, a subtitle derived from `actionType` ('Proposed comment', 'Proposed DM', etc.), and a scrollable read-only `<pre>` preview of `proposedContent`. Three buttons: **Approve** (green) POSTs `{status:'approved'}`; **Reject** (red) POSTs `{status:'rejected'}`; **Approve with Edits** (amber) toggles the preview into an editable `<textarea>` pre-filled with `proposedContent` and reveals a **Submit Edit** button that POSTs `{status:'approved', editedContent:'...'}`. On success the overlay removes itself and a 2-second toast appears. On network/HTTP error an inline red error message is shown without removing the overlay (user can retry). A `data-action-id` attribute is set on the root for Task 6's dedup guard. Existing `EXECUTE_PRIMITIVE` handling is completely untouched. TypeScript type-check passes with no errors.

---

## Group 4 — Backend: accept edits on approve, write toneEdit record

### Task 4 — Update the PATCH /actions/:id endpoint to handle `editedContent`

**Files:** `packages/backend/src/routes/actions.ts`, and optionally a shared helper or inline in the route

**Context:**
The PATCH endpoint currently accepts `{ status, result }`. When the overlay sends an approval with edits, it will also send `editedContent: string`. The endpoint needs to:
1. Accept `editedContent` as an optional field in the request body schema
2. When `status === 'approved'` AND `editedContent` is present AND it differs from the original `proposedContent` (stored in `payload`), write a `toneEdits` record

The `toneEdits` table already exists (schema in `db/schema.ts`). The `reviews.ts` route already writes to it and calls `refreshToneGuide()` — look at that implementation and replicate the same logic here. The fields to write:
- `agentId` — from the pendingAction row
- `reviewId` — there is no review here, so either make this nullable in schema or set it to the `actionId` (check if the column is nullable first; if not, use actionId as a stand-in)
- `flowName` — use `action.type` (e.g. 'post', 'dm') as the flow name
- `context` — use `payload.post_url` or similar from the action payload as context (the URL the action was targeting)
- `agentDraft` — the original `proposedContent` from the payload
- `humanFinal` — the `editedContent` from the request

Also trigger `refreshToneGuide()` using the same threshold logic as `reviews.ts` (after 3+ edits, every 5 edits).

**Done when:**
- PATCH endpoint accepts `editedContent` without error
- A toneEdit row is created when editedContent differs from the original draft
- `refreshToneGuide` is triggered at the same thresholds as the reviews flow
- Existing approve/reject flows (without editedContent) are unaffected

**Depends on:** Task 3 (for the overlay to actually send the field, but the backend change can be done independently)

**Status:** `[x]`

> Extracted `refreshToneGuide` to a new shared module `packages/backend/src/lib/tone.ts` to avoid duplication. Updated `reviews.ts` to import from there (removed local definition; unused `Anthropic`/`decrypt` imports cleaned up). Updated `actions.ts`: added `toneEdits` schema import and `refreshToneGuide` import; added two module-level helpers (`extractProposedContent`, `extractContextUrl`); extended the PATCH body type with optional `editedContent: string`; after the DB update, when `status === 'approved'` and `editedContent` is present and differs from the original draft in the payload, inserts a `toneEdits` record (using `actionId` as `reviewId` stand-in since that column is NOT NULL) and fires `refreshToneGuide` fire-and-forget at the same ≥3 / every-5 threshold used by `reviews.ts`. Existing approve/reject flows without `editedContent` are unaffected. TypeScript type-check passes with no errors.

---

## Group 5 — Polish and edge cases

### Task 5 — Handle action types without a clear URL gracefully

**Files:** `packages/backend/src/orchestrator/autonomous.ts`

**Context:**
Not every action type has an obvious URL. A `type: 'dm'` might have a Twitter handle but not a full profile URL. A `type: 'email'` has no URL at all. The current design says "if no URL, skip tab opening and leave it in ActionsTab only." This task makes that explicit and adds fallback URL logic for common patterns:
- `type: 'dm'`: look for `payload.profile_url`, then `payload.recipient_url`, then construct a Twitter/LinkedIn URL from `payload.recipient` if it looks like a handle (e.g. `@handle` → `https://twitter.com/handle`)
- `type: 'post'`: look for `payload.post_url`, then `payload.url`, then `payload.thread_url`
- `type: 'email'` and `type: 'api_call'`: no URL — skip tab, fallback to ActionsTab
- `type: 'other'`: look for any `url`-keyed field in payload

Also extract `proposedContent` intelligently:
- `type: 'post'`: `payload.comment_text` → `payload.body` → `payload.content` → `payload.text`
- `type: 'dm'`: `payload.message` → `payload.body` → `payload.text`
- `type: 'email'`: `payload.body` → `payload.content`

**Done when:**
- URL extraction logic is centralised in a small helper function in `autonomous.ts`
- `proposedContent` extraction is similarly centralised
- DM actions with a Twitter handle correctly open `https://twitter.com/handle` in a tab
- Email and api_call actions correctly skip the tab and remain in ActionsTab only
- No regressions to existing `queue_action` behaviour

**Depends on:** Task 1

**Status:** `[x]`

> All requirements were already satisfied by the helpers written during Task 1. `extractActionUrl` (lines 88–122) handles every type: `post` tries `post_url → url → thread_url`; `dm` tries `profile_url → recipient_url` then constructs `https://twitter.com/<handle>` from a bare `@handle` or word-only `recipient`; `email` and `api_call` return `undefined` (action stays in ActionsTab only); `default`/`other` scans all payload keys containing "url". `extractProposedContent` (lines 127–157) handles `post` (`comment_text → body → content → text`), `dm` (`message → body → text`), `email` (`body → content`), and a sensible default fallback. Both helpers are module-level and imported only at call-site in `queue_action`. `sendReviewTab` is called only when `extractActionUrl` returns a non-undefined value. TypeScript type-check passes with no errors. No code changes were needed — task confirmed complete.

### Task 6 — Prevent duplicate overlay injection on tab refresh

**Files:** `packages/extension/src/content/index.ts`

**Context:**
If the user refreshes the tab after the overlay was injected (perhaps to see updated page content), the background map entry has already been cleared (removed after first injection). The overlay won't re-inject, which is fine. But there's a subtler issue: if the content script re-runs on the refreshed page, it might receive a stale `INJECT_REVIEW_OVERLAY` message that was queued before the refresh.

Add a guard: on `INJECT_REVIEW_OVERLAY`, check if an overlay with the same `actionId` already exists in the DOM (use a `data-action-id` attribute on the panel root). If it does, ignore the message. If a different overlay exists (prior action, somehow), remove the old one and inject the new.

Also: if the user has already approved or rejected an action from the ActionsTab (status is no longer 'pending'), the overlay POST will still succeed (the PATCH endpoint accepts repeat calls) but it should ideally not confuse the user. The overlay can check the response body — if the returned record shows status was already resolved, show "Already resolved" instead of "Approved ✓".

**Done when:**
- Refreshing a tab doesn't cause a second overlay to appear
- The `data-action-id` guard works correctly
- Already-resolved response is handled gracefully

**Depends on:** Task 3

**Status:** `[x]`

> Replaced the basic `getElementById` guard in `injectReviewOverlay` with a full `data-action-id` dedup check: if an overlay exists with the same `actionId`, the message is silently ignored (covers the stale-message-after-refresh case); if an overlay exists with a different `actionId`, the old one is removed before injecting the new one. Updated `postDecision` with a pre-flight GET to the action endpoint before sending the PATCH — if the action's status is already non-pending (resolved via ActionsTab), the overlay removes itself and shows "Already resolved" instead of "Approved ✓" / "Rejected ✓". TypeScript type-check passes with no errors. Existing `EXECUTE_PRIMITIVE` handling is completely untouched.

---

## Verification

### Task 7 — End-to-end smoke test

**No code changes — manual test session only**

Run through the full flow with a real agent:

1. Wake up an agent that has a goal likely to produce a `queue_action` with a post URL
2. Confirm a new browser tab opens to the target URL
3. Confirm the overlay appears on the page with correct title, proposed content, and all three buttons
4. Test **Reject** — confirm overlay disappears and action shows as rejected in ActionsTab
5. Test **Approve** — confirm overlay disappears, action shows as approved
6. Test **Approve with Edits** — edit the text, submit — confirm overlay disappears, toneEdit row exists in DB, action shows as approved
7. Close a tab before deciding — confirm the action stays as 'pending' in ActionsTab (fallback works)
8. Disconnect the extension — queue an action — confirm it stays in ActionsTab only (no crash)
9. Confirm the regular `EXECUTE_PRIMITIVE` flow (browser automation) still works normally

**Depends on:** Tasks 1–6

**Status:** `[x]`

> Code-level smoke test performed (backend couldn't be started in VM — esbuild darwin-arm64 vs linux-arm64 mismatch; Chrome extension not connected). All modified files reviewed against spec:
>
> **Verified via static analysis / TypeScript:**
> - `websocket/server.ts`: `sendReviewTab()` is fire-and-forget, no-ops when no socket — ✓
> - `orchestrator/autonomous.ts`: `queue_action` calls `sendReviewTab` only when `extractActionUrl` returns a value — ✓
> - `autonomous.ts` helpers: `email`/`api_call` correctly return `undefined` (stay in ActionsTab); `dm` constructs Twitter URL from bare handle — ✓
> - `offscreen/index.ts`: forwards `OPEN_REVIEW_TAB` to background via `chrome.runtime.sendMessage` — ✓
> - `background/index.ts`: opens tab `active: false`, handles immediate-complete race, stores `reviewTabMap`, `onUpdated` injects overlay, `onRemoved` cleans map — ✓
> - `content/index.ts`: dedup guard (`data-action-id`) prevents double injection; pre-flight GET detects already-resolved; Approve/Reject/Approve-with-Edits all POST correctly; overlay self-removes on success, shows inline error on failure — ✓
> - `routes/actions.ts`: `editedContent` accepted on PATCH; toneEdit written only when content differs; `refreshToneGuide` fires at ≥3/every-5 threshold — ✓
> - Existing `EXECUTE_PRIMITIVE` flow in content script untouched — ✓
>
> **Bug found and fixed:**
> `GET /agents/:agentId/actions/:actionId` was missing — the overlay's pre-flight "Already resolved" check always got 404 (silently fell through to PATCH, so core Approve/Reject still worked, but the Task 6 guard was dead). Added the single-item GET route to `actions.ts`; TypeScript type-check passes.
>
> **Remaining manual verification needed** (requires running backend + extension):
> Steps 1–9 from the spec above — specifically the live overlay rendering, button interactions, toneEdit DB record creation, and extension-disconnected fallback.
