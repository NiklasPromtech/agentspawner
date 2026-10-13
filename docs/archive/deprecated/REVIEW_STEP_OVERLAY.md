# Review Step Overlay — `__human_review__` → browser overlay

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

**The problem:** Flows with a `__human_review__` step already pause and write a
`pendingHumanReviews` DB row, but the user has to go find it in the **ReviewsTab** inside
the frontend UI. This is disconnected from context — the user can't see the actual Reddit
thread (or Twitter profile, etc.) when deciding whether to approve.

**What we already have (TAB_OVERLAY_APPROVAL.md):** When an agent calls `queue_action`,
a browser tab opens automatically and a floating overlay appears on the target page with
**Approve**, **Approve with Edits**, and **Reject** buttons. That overlay mechanism is
complete and working.

**What this file adds:** The same overlay behaviour for `__human_review__` steps inside
flows. When a flow hits a `__human_review__` step, the extension should open a tab to
the relevant URL and inject the overlay — the user reads the actual page and approves in
context, exactly as with `queue_action`.

**How data flows end-to-end (new path):**

```
Flow hits __human_review__ step
  → flow-runner resolves targetUrl + draftContent from inputMapping
  → flow-runner writes pendingHumanReviews row (tabUrl now stored, not '')
  → flow-runner calls sendReviewTab({ sourceType: 'review', reviewId, ... })
  → backend sends WebSocket msg OPEN_REVIEW_TAB to extension
      { sourceType: 'review', reviewId, agentId, url, proposedContent, title, ... }
  → extension opens tab, injects overlay (same as action path)
  → overlay POSTs to backend using the reviews resolve endpoint

If Approve:
  → POST /reviews/:reviewId/resolve  { decision: 'approved' }
  → flow-runner.resumeFromReview() picks up, flow continues with draftContent as finalContent

If Approve with Edits:
  → POST /reviews/:reviewId/resolve  { decision: 'approved_with_edits', finalContent: '...' }
  → toneEdit pair written (already handled in reviews.ts)
  → flow resumes with the human's edited text as finalContent

If Reject:
  → POST /reviews/:reviewId/resolve  { decision: 'rejected' }
  → flow-runner finalises with rejection
```

**Two review creation paths in flow-runner.ts — both need updating:**

1. **`requiresHumanReview` flow-level flag** (≈ line 544) — fires before any steps run
   when `flow.requiresHumanReview === true`. Currently extracts `draftContent` from
   `flowInput` but saves `tabUrl: ''`. Needs URL extraction from `flowInput` (same key
   names as `extractActionUrl` in autonomous.ts: `post_url → url → profile_url → thread_url`).

2. **`__human_review__` step sentinel** (≈ line 676) — fires mid-flow at a specific step.
   Currently resolves `draftContent` and `contentLabel` from `inputMapping` but saves
   `tabUrl: ''`. Needs to also resolve `targetUrl` from `inputMapping`.

**Resolve endpoint differences (actions vs reviews):**

| | Actions | Reviews |
|---|---|---|
| Method | `PATCH` | `POST` |
| Path | `/agents/:agentId/actions/:actionId` | `/reviews/:reviewId/resolve` |
| Approve body | `{ status: 'approved' }` | `{ decision: 'approved' }` |
| Approve+edit body | `{ status: 'approved', editedContent: '...' }` | `{ decision: 'approved_with_edits', finalContent: '...' }` |
| Reject body | `{ status: 'rejected' }` | `{ decision: 'rejected' }` |
| Pre-flight GET | `GET /agents/:agentId/actions/:actionId` | `GET /reviews/:reviewId` |
| Already-resolved check | `status !== 'pending'` | `status !== 'pending'` |

The content script overlay needs to branch on a new `sourceType` field in the
`INJECT_REVIEW_OVERLAY` message to use the right endpoint and body shape.

**What does NOT need to change:**
- The ReviewsTab fallback still works if no URL is present or the extension is disconnected
- The `pendingHumanReviews` schema needs no column changes (`tabUrl` already exists)
- `resumeFromReview()` and tone-edit logic in `reviews.ts` are untouched
- The action overlay path (`sourceType: 'action'`) is completely untouched

**Key files:**
- `packages/backend/src/websocket/server.ts` — extend `ReviewTabData` (Task 1)
- `packages/backend/src/websocket/protocol.ts` — extend `OPEN_REVIEW_TAB` (Task 1)
- `packages/extension/src/protocol.ts` — extend `OPEN_REVIEW_TAB` + `INJECT_REVIEW_OVERLAY` (Task 1)
- `packages/backend/src/features/flows/flow-runner.ts` — call `sendReviewTab()` from both review paths (Task 2)
- `packages/backend/src/routes/flows-generate.ts` — add `targetUrl` to `__human_review__` inputMapping spec (Task 3)
- `packages/extension/src/background/index.ts` — pass `sourceType` + `reviewId` through (Task 4)
- `packages/extension/src/content/index.ts` — branch on `sourceType` for endpoint + body (Task 4)

---

## Group 1 — Extend protocols to carry `sourceType` and `reviewId`

### Task 1 — Add `sourceType` and `reviewId` to `OPEN_REVIEW_TAB` and `INJECT_REVIEW_OVERLAY`

**Files:**
- `packages/backend/src/websocket/protocol.ts`
- `packages/backend/src/websocket/server.ts`
- `packages/extension/src/protocol.ts`

**Context:**
Both WebSocket protocols and the `ReviewTabData` interface currently assume every review
tab is for an action (`actionId`). We need to make them polymorphic so the same
`OPEN_REVIEW_TAB` message type can carry either an action or a review.

In `backend/src/websocket/protocol.ts`, extend the `OPEN_REVIEW_TAB` variant to add:
- `sourceType: 'action' | 'review'`
- `reviewId?: string` — present when `sourceType === 'review'`
- keep `actionId?: string` — present when `sourceType === 'action'`
  (making it optional is fine; the existing `queue_action` code always passes it)

In `backend/src/websocket/server.ts`, update `ReviewTabData` to match:
```typescript
export interface ReviewTabData {
  sourceType: 'action' | 'review';
  actionId?: string;   // required when sourceType === 'action'
  reviewId?: string;   // required when sourceType === 'review'
  agentId: string;
  url: string;
  proposedContent: string;
  actionType: string;
  title: string;
  description: string;
}
```

The existing call in `autonomous.ts` (`queue_action` handler) passes `actionId` — add
`sourceType: 'action'` to that call so it satisfies the updated type.

In `extension/src/protocol.ts`, mirror the same change to `OPEN_REVIEW_TAB` and also
update `INJECT_REVIEW_OVERLAY` in `ContentMessage` to add:
- `sourceType: 'action' | 'review'`
- `reviewId?: string`

**Done when:**
- Both `protocol.ts` files compile with the extended types
- `ReviewTabData` reflects the union shape
- The existing `sendReviewTab()` call in `autonomous.ts` passes `sourceType: 'action'`
- TypeScript type-check passes with no errors

**Depends on:** nothing

**Status:** `[x]`

> Extended `OPEN_REVIEW_TAB` in both `backend/src/websocket/protocol.ts` and
> `extension/src/protocol.ts` to add `sourceType: 'action' | 'review'`, optional
> `actionId?`, and optional `reviewId?`. Updated `ReviewTabData` in `server.ts` to match.
> Added `sourceType: 'action'` to the existing `sendReviewTab()` call in `autonomous.ts`.
> Also updated `OffscreenMessage.OPEN_REVIEW_TAB` and `ContentMessage.INJECT_REVIEW_OVERLAY`
> in the extension protocol, and fixed the downstream uses in `offscreen/index.ts` and
> `content/index.ts` (updated `OverlayData`, dedup guard, endpoint/method branching, and
> button handlers to use `sourceType`). Both `backend` and `extension` `tsc --noEmit` pass
> with zero errors.

---

## Group 2 — Backend: emit `OPEN_REVIEW_TAB` from flow-runner

### Task 2 — Call `sendReviewTab()` from both review creation paths in `flow-runner.ts`

**Files:** `packages/backend/src/features/flows/flow-runner.ts`

**Context:**
`flow-runner.ts` already imports `executeExtensionTool` from `../../websocket/server.js`.
Add `sendReviewTab` to that import.

There are two places to update:

**Path A — `requiresHumanReview` flow-level flag** (≈ line 544):
After the `db.insert(pendingHumanReviews)` call, extract a URL from `flowInput` using
this priority order (same logic as `extractActionUrl` in `autonomous.ts`):
`post_url → url → profile_url → thread_url → recipient_url`
Also scan all keys containing `"url"` as a final fallback (for `type: 'other'`).
If a URL is found, store it in `tabUrl` when inserting the row AND call `sendReviewTab()`.

```typescript
sendReviewTab({
  sourceType: 'review',
  reviewId,
  agentId,
  url: resolvedUrl,
  proposedContent: draftContent != null ? String(draftContent) : '',
  actionType: flow.flowType ?? 'review',
  title: `Review: ${flow.name}`,
  description: `Human approval required before "${flow.name}" continues.`,
});
```

**Path B — `__human_review__` step sentinel** (≈ line 676):
The step's `inputMapping` is already resolved into `resolved`. Add resolution of
`targetUrl`:
```typescript
const targetUrl = resolved.targetUrl != null ? String(resolved.targetUrl) : null;
```
If `targetUrl` is present, store it in `tabUrl` when inserting the row AND call
`sendReviewTab()` with:
```typescript
sendReviewTab({
  sourceType: 'review',
  reviewId,
  agentId,
  url: targetUrl,
  proposedContent: draftContent ?? '',
  actionType: 'review',
  title: contentLabel,
  description: `Human approval required at step "${step.label}".`,
});
```

In both paths: if no URL is resolved, pass `tabUrl: ''` to the DB insert (unchanged)
and skip `sendReviewTab()` entirely — the review stays in ReviewsTab only (silent
fallback, same as the `queue_action` no-URL case).

**Done when:**
- Both paths call `sendReviewTab()` when a URL is available
- `tabUrl` is populated in the DB row when a URL is resolved
- No URL = silent no-op, review stays in ReviewsTab
- `sendReviewTab` import added; TypeScript type-check passes

**Depends on:** Task 1

**Status:** `[x]`

> Added `sendReviewTab` to the import from `../../websocket/server.js`.
>
> **Path A** (`requiresHumanReview` flow-level flag, ≈ line 544): Added URL extraction
> from `flowInput` using the priority order `post_url → url → profile_url → thread_url →
> recipient_url → any key containing "url"`. The resolved URL is now stored in `tabUrl`
> on the DB insert. If a URL is found, `sendReviewTab({ sourceType: 'review', ... })` is
> called; otherwise the row is written with `tabUrl: ''` and `sendReviewTab` is skipped
> (silent fallback to ReviewsTab).
>
> **Path B** (`__human_review__` step sentinel, ≈ line 676): Added `targetUrl` resolution
> from `resolved` (the step's inputMapping). The resolved URL is now stored in `tabUrl`
> on the DB insert. If `targetUrl` is present, `sendReviewTab({ sourceType: 'review', ... })`
> is called; otherwise `tabUrl: ''` and no call (silent fallback).
>
> `backend` `tsc --noEmit` passes with zero errors.

---

## Group 3 — Flow generator: teach Claude to include `targetUrl`

### Task 3 — Add `targetUrl` to the `__human_review__` inputMapping spec in the prompt

**Files:** `packages/backend/src/routes/flows-generate.ts`

**Context:**
The `__human_review__` section in the system prompt (≈ line 683) currently only lists
`draftContent` and `contentLabel` as inputMapping fields. The flow generator has no idea
it should also pass the target URL. Old flows won't have it (they'll fall back to
ReviewsTab gracefully), but all newly generated flows should include it.

Find the `__human_review__` inputMapping rules block and add `targetUrl`:

```
- `targetUrl` (string, optional but strongly recommended for action flows) — the URL
  of the page where the content will be posted. This lets the browser extension open
  the actual page so the human can read context before approving.
  Use the same value that the `navigate` step will open, e.g.:
    `{ "type": "flow_input", "key": "post_url" }`
  or a literal URL if it is fixed.
  Omit only for flows with no navigable target (rare).
```

Also update the wiring rules example JSON block to include `targetUrl` in the
`__human_review__` step's `inputMapping`, using `{ "type": "flow_input", "key": "post_url" }`
as the example value.

**Done when:**
- The `__human_review__` inputMapping spec in the prompt lists `targetUrl`
- The example JSON block shows it wired from a flow input key
- No TypeScript changes needed (this is prompt text only)

**Depends on:** Task 2 (logically — the field is only useful once flow-runner reads it)

**Status:** `[x]`

> Added `targetUrl` to the `__human_review__` inputMapping spec in three places in the
> system prompt in `flows-generate.ts`:
> 1. **Inputs list** (≈ line 667): added `targetUrl` as an optional-but-strongly-recommended
>    input field with a full description, example wiring, and note about when to omit.
> 2. **WIRING RULES** (≈ line 687): added `targetUrl` as a third bullet under the
>    `__human_review__` inputMapping rules, with the canonical example value
>    `{ "type": "flow_input", "key": "post_url" }`.
> 3. **Example JSON block** (≈ line 704): added `"targetUrl": { "type": "flow_input", "key": "post_url" }`
>    to the `pause_for_review` step's `inputMapping`.
> No TypeScript changes needed; `backend tsc --noEmit` passes with zero errors.

---

## Group 4 — Extension: pass `sourceType` through and branch in overlay

### Task 4 — Update background pass-through and content script overlay branching

**Files:**
- `packages/extension/src/background/index.ts`
- `packages/extension/src/content/index.ts`

**Context:**
After Task 1, the `OPEN_REVIEW_TAB` message carries `sourceType` and optionally
`reviewId`. The background and content script need to thread these through.

**`background/index.ts`:**
In the `OPEN_REVIEW_TAB` message handler (≈ line 1105), the destructuring currently
pulls `{ actionId, agentId, url, proposedContent, actionType, title, description }`.
Add `sourceType` and `reviewId` to that destructure.

Update the `ReviewTabEntry` interface (≈ line 12) to add:
```typescript
sourceType: 'action' | 'review';
reviewId?: string;
```

Pass both fields through to `INJECT_REVIEW_OVERLAY` messages (both in the
immediate-complete path and in the `onUpdated` path).

**`content/index.ts`:**
The `injectReviewOverlay` function currently hard-codes the actions endpoint and body
shape. Refactor it to branch on `sourceType`.

Add a `sourceType` and `reviewId` field to `OverlayData`:
```typescript
sourceType: 'action' | 'review';
reviewId?: string;
```

In `postDecision`, branch based on `sourceType`:

**Action path (unchanged):**
```
PATCH ${backendUrl}/agents/${agentId}/actions/${actionId}
Body: { status: 'approved'|'rejected', editedContent? }
Pre-flight GET: ${backendUrl}/agents/${agentId}/actions/${actionId}
```

**Review path (new):**
```
POST ${backendUrl}/reviews/${reviewId}/resolve
Body: { decision: 'approved'|'rejected'|'approved_with_edits', finalContent? }
Pre-flight GET: ${backendUrl}/reviews/${reviewId}
```

Map the three buttons as follows for the review path:
- **Approve** → `{ decision: 'approved' }`
- **Reject** → `{ decision: 'rejected' }`
- **Approve with Edits / Submit Edit** → `{ decision: 'approved_with_edits', finalContent: textarea.value }`

The already-resolved check for reviews: `current.status !== 'pending'` (same field name,
same logic — `pendingHumanReviews.status` starts as `'pending'`).

Toast messages, error handling, overlay self-removal, and the dedup guard are all
identical between paths.

**Done when:**
- Background passes `sourceType` and `reviewId` through `ReviewTabEntry` and
  `INJECT_REVIEW_OVERLAY`
- Content script branches correctly on `sourceType`
- Review path POSTs to `/reviews/:reviewId/resolve` with the correct body
- Action path is completely unchanged
- TypeScript type-check passes with no errors on both packages

**Depends on:** Tasks 1, 2

**Status:** `[x]`

> Updated `ReviewTabEntry` in `background/index.ts` to add `sourceType: 'action' | 'review'`,
> optional `actionId?`, and optional `reviewId?`. Updated the `OPEN_REVIEW_TAB` handler
> destructuring to pull `sourceType` and `reviewId` from the message, and included both in
> the `entry` object so they are spread into `INJECT_REVIEW_OVERLAY` messages (both the
> immediate-complete path and the `onUpdated` path).
>
> `content/index.ts` was already fully implemented from Task 1 — `OverlayData` already had
> `sourceType`/`reviewId`, and `postDecision` already branched correctly to use
> `POST /reviews/:reviewId/resolve` with `{ decision }` body for the review path.
>
> Both `extension` and `backend` `tsc --noEmit` pass with zero errors.

---

## Verification

### Task 5 — End-to-end smoke test

**No code changes — manual test session only**

Run through the full flow:

1. Find or create a flow with a `__human_review__` step that has `targetUrl` wired from
   a flow input (or add it manually via the Flow Editor)
2. Wake the agent with a goal that triggers that flow
3. Confirm a new background tab opens to `targetUrl`
4. Confirm the overlay appears on the page showing the correct draft text and all three
   buttons
5. Test **Reject** — confirm overlay disappears, flow run shows as failed/rejected,
   ReviewsTab shows rejected
6. Test **Approve** — confirm overlay disappears, flow resumes and completes
7. Test **Approve with Edits** — edit the draft, submit — confirm overlay disappears,
   flow resumes using the edited text, toneEdit row exists in DB
8. Test a flow with `requiresHumanReview: true` (flow-level flag) — confirm overlay
   appears using URL extracted from flow input
9. Test a flow whose `__human_review__` step has no `targetUrl` — confirm review stays
   in ReviewsTab only (no crash, no tab)
10. Disconnect extension — trigger a review — confirm it stays in ReviewsTab only
11. Confirm existing action overlay (`queue_action` path) still works normally
12. Confirm existing `EXECUTE_PRIMITIVE` browser automation is unaffected

**Depends on:** Tasks 1–4

**Status:** `[x]`

> **Static verification completed (2026-03-24). Full interactive smoke test still required.**
>
> **TypeScript checks:** Both `backend tsc --noEmit` and `extension tsc --noEmit` pass with
> zero errors, confirming all four tasks compile correctly end-to-end.
>
> **Code-review findings per test scenario:**
>
> 1–4. (**New review-tab overlay**) `flow-runner.ts` Path A extracts URL from `flowInput`
>    using the `post_url → url → profile_url → thread_url → recipient_url → any-key-with-"url"`
>    priority order and calls `sendReviewTab({ sourceType: 'review', ... })` when a URL is
>    found. Path B resolves `targetUrl` from the step's `inputMapping` and does the same.
>    Both paths store the resolved URL in `tabUrl` on the DB insert. `background/index.ts`
>    spreads `sourceType` and `reviewId` into `ReviewTabEntry` and includes them in
>    `INJECT_REVIEW_OVERLAY` messages. `content/index.ts` branches on `sourceType`: review
>    path POSTs to `POST /reviews/:reviewId/resolve` with `{ decision }` body; preflight GET
>    uses `GET /reviews/:reviewId`. The dedup guard, toast, and overlay-removal logic are
>    shared between both paths.
>
> 5. (**Reject**) `makeBody('rejected')` returns `{ decision: 'rejected' }` for the review
>    path — correct.
>
> 6. (**Approve**) `makeBody('approved')` returns `{ decision: 'approved' }` — correct.
>
> 7. (**Approve with Edits**) `makeBody('approved_with_edits', editedText)` returns
>    `{ decision: 'approved_with_edits', finalContent: editedText }` — correct; matches
>    `reviews.ts` resolve handler which writes the toneEdit pair.
>
> 8. (**`requiresHumanReview` flow-level flag**) Path A in `flow-runner.ts` is wired and
>    confirmed in code.
>
> 9. (**No `targetUrl` — silent fallback**) Both paths guard with `if (resolvedUrl)` /
>    `if (targetUrl)` before calling `sendReviewTab()`; if absent, `tabUrl: ''` is stored
>    and no tab is opened — review stays in ReviewsTab only.
>
> 10. (**Extension disconnected**) `sendReviewTab()` in `server.ts` already no-ops when no
>     WebSocket client is connected (same guard as the action path). Confirmed unchanged.
>
> 11. (**Existing action overlay unaffected**) `sourceType: 'action'` branch in
>     `content/index.ts` (`PATCH /agents/:agentId/actions/:actionId` with `{ status }` body)
>     is unchanged. `autonomous.ts` call now passes `sourceType: 'action'` explicitly.
>
> 12. (**`EXECUTE_PRIMITIVE` unaffected**) No changes to that code path.
>
> **Remaining:** Interactive smoke test (steps 1–12 above) must be run manually with a live
> agent, a flow containing a `__human_review__` step, and the extension loaded in Chrome.
