# OPERATION SITUATION ROOM
### One place. All pending decisions. One button to get context.

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

**The situation:** The ReviewsTab already exists and works — it shows pending
`__human_review__` items, lets you approve/reject/edit inline, and polls every 15s.
The problem is the "Open tab →" link is a plain anchor tag. It just opens the URL
in a new tab with no overlay. If you want to review in context you're on your own.

**What this operation adds:**

1. A `POST /reviews/:reviewId/reopen` backend endpoint that re-fires the
   `OPEN_REVIEW_TAB` WebSocket message — the extension opens a fresh tab to the
   stored URL and re-injects the overlay, exactly as if the flow had just paused.
   If no extension is connected, it returns a clear response and the frontend falls
   back to opening the URL as a plain link.

2. Replacing the plain "Open tab →" anchor in `ReviewsTab.tsx` with an
   **"Open in context"** button that calls the reopen endpoint. The flow is already
   paused; the draft is already in the DB. This just re-presents the overlay — no
   re-running, no side effects.

**What does NOT change:**
- The `pendingHumanReviews` schema — no migrations needed
- The inline approve/reject/edit-and-approve flow in ReviewsTab — untouched
- The tone guide section — untouched
- The polling interval — untouched
- The overlay itself and all the REVIEW_STEP_OVERLAY plumbing — untouched

**Key files:**
- `packages/backend/src/routes/reviews.ts` — new `reopen` endpoint (Task 1)
- `packages/frontend/src/pages/agent/ReviewsTab.tsx` — replace anchor with button (Task 2)

---

## Group 1 — Backend: reopen endpoint

### Task 1 — Add `POST /reviews/:reviewId/reopen`

**Files:** `packages/backend/src/routes/reviews.ts`

**Context:**
Add a new route after the existing `GET /reviews/:reviewId` handler:

```
POST /reviews/:reviewId/reopen
```

Logic:
1. Fetch the review row from `pendingHumanReviews` by `reviewId`
2. If not found → 404
3. If `review.status !== 'pending'` → 400 `{ error: 'Review already resolved' }`
4. If `review.tabUrl` is empty or blank → 400 `{ error: 'No tab URL stored for this review' }`
5. Call `sendReviewTab()` (already imported / importable from
   `../websocket/server.js`) with:
   ```typescript
   sendReviewTab({
     sourceType: 'review',
     reviewId: review.id,
     agentId: review.agentId,
     url: review.tabUrl,
     proposedContent: review.draftContent,
     actionType: 'review',
     title: review.contentLabel || `Review: ${review.flowName}`,
     description: `Re-opened for human review.`,
   });
   ```
6. Return `{ queued: true }` if the extension is connected (i.e. `sendReviewTab`
   didn't throw), or `{ queued: false, fallbackUrl: review.tabUrl }` if no
   extension is connected.

To distinguish the two cases: `sendReviewTab` currently silently no-ops when no
socket is connected. Add a thin wrapper or check `isExtensionConnected()` (already
exported from `server.ts`) before calling:

```typescript
const connected = isExtensionConnected();
if (connected) sendReviewTab({ ... });
return { queued: connected, fallbackUrl: review.tabUrl };
```

This lets the frontend know whether to show "Opening in context…" or fall back to
opening the URL directly.

**Done when:**
- `POST /reviews/:reviewId/reopen` is registered in `registerReviewRoutes`
- Returns 404 / 400 for bad states
- Returns `{ queued: true, fallbackUrl }` when extension is connected
- Returns `{ queued: false, fallbackUrl }` when no extension is connected
- TypeScript type-check passes with no errors

**Depends on:** nothing (REVIEW_STEP_OVERLAY tasks already wired `sendReviewTab`
for reviews, but this endpoint works regardless)

**Status:** `[x]`

> Added `POST /reviews/:reviewId/reopen` to `registerReviewRoutes` in `reviews.ts`. Imports `sendReviewTab` and `isExtensionConnected` from `../websocket/server.js`. Returns 404/400 for bad states, `{ queued: true, fallbackUrl }` when extension connected, `{ queued: false, fallbackUrl }` otherwise. TypeScript type-check passes clean.

---

## Group 2 — Frontend: "Open in context" button

### Task 2 — Replace "Open tab →" anchor with "Open in context" button in ReviewsTab

**Files:** `packages/frontend/src/pages/agent/ReviewsTab.tsx`

**Context:**
The existing ReviewsTab (≈ line 148) renders a plain anchor for each pending review:

```tsx
<a href={r.tabUrl} target="_blank" rel="noopener noreferrer" ...>
  Open tab →
</a>
```

Replace this with an **"Open in context"** button that:

1. Calls `POST /reviews/:reviewId/reopen` on the backend
2. If the response is `{ queued: true }` — show brief feedback text "Opening…" next
   to the button for 2 seconds, then reset. The extension handles the rest.
3. If the response is `{ queued: false, fallbackUrl }` — fall back to
   `window.open(fallbackUrl, '_blank')` and show "No extension connected — opened
   plain tab" as a brief inline note. The user can still review in the ReviewsTab.
4. On any network error — show a small inline error message (same style as existing
   `resumeErrors` display in the component).

Add the button state alongside the existing per-review state. A simple
`reopening: string | null` state (holding the reviewId currently being reopened)
is sufficient — no need for a full map.

The button should be styled consistently with the existing `btn` style constant
already defined in the component, but with a distinct colour to stand out from
Approve/Reject:

```tsx
// Suggested: subtle blue, same border treatment as btn
color: '#58a6ff'
```

**Also:** if `r.tabUrl` is blank/empty for a pending review (older flows before
REVIEW_STEP_OVERLAY Task 2 ran), hide the button entirely rather than showing a
broken state — the user can still approve/reject inline.

**Done when:**
- "Open tab →" anchor is replaced with the "Open in context" button on all pending
  review cards
- Calls reopen endpoint, handles both `queued: true` and `queued: false` responses
- Falls back gracefully when no extension is connected
- Hidden when `tabUrl` is empty
- No changes to approve/reject/edit-and-approve flows
- TypeScript type-check passes with no errors

**Depends on:** Task 1

**Status:** `[x]`

> Replaced the `<a href={r.tabUrl}>Open tab →</a>` anchor with an "Open in context" `<button>` in the pending-review card header. Button is hidden when `r.tabUrl` is blank. On click it calls `POST /reviews/:reviewId/reopen`: if `queued: true`, shows "Opening…" inline for 2s; if `queued: false`, calls `window.open(fallbackUrl)` and shows "No extension connected — opened plain tab" for 2s. Network errors are displayed in a dedicated `reopenErrors` block styled identically to the existing `resumeErrors` section. New state: `reopening`, `reopenFeedback`, `reopenErrors`. No changes to approve/reject/edit flows. TypeScript type-check passes with no errors in ReviewsTab.tsx.

---

## Verification

### Task 3 — Smoke test

**No code changes — manual test session only**

1. Trigger a flow with a `__human_review__` step that has `targetUrl` set
2. Confirm the pending review appears in ReviewsTab with an "Open in context" button
3. Click "Open in context" — confirm a browser tab opens to the target URL with the
   overlay injected on top
4. Close that tab. Go back to ReviewsTab. Click "Open in context" again — confirm
   it opens a fresh tab with the overlay (reopen works after close)
5. Approve from the overlay — confirm the review disappears from the pending list
   and appears in the resolved history
6. Trigger another review. This time approve it directly from the ReviewsTab inline
   buttons (not the overlay) — confirm the flow resumes normally
7. Disconnect the extension. Click "Open in context" on a pending review — confirm
   it falls back to opening a plain tab and shows the "No extension connected" note
8. Test a review created before REVIEW_STEP_OVERLAY ran (no `tabUrl`) — confirm
   the "Open in context" button is hidden and inline approve/reject still works

**Depends on:** Tasks 1–2

**Status:** `[>]`

> **Static verification re-confirmed (second session) — extension-dependent steps still need live run.**
>
> **Re-verified programmatically this session:**
> - Backend TS: `tsc --noEmit` still passes with zero errors in `packages/backend` (incl. `reviews.ts`).
> - Frontend TS: still zero errors in `ReviewsTab.tsx`. Pre-existing errors in `FlowEditor.tsx` / `FlowsTab.tsx` remain unrelated.
> - Full re-read of both implementation files confirmed all code paths match spec exactly:
>   - Backend `reopen` route: 404 (not found) / 400 (not pending) / 400 (blank tabUrl) / queued:true / queued:false — all correct ✓
>   - Frontend: button hidden when `r.tabUrl` falsy (line 190) ✓; `queued:true` → "Opening…" 2 s ✓; `queued:false` → `window.open` + "No extension connected" 2 s ✓; network errors → `reopenErrors` red block ✓; approve/reject/edit untouched ✓
>
> **Still needs live manual run (requires extension connected):**
> - Step 3: trigger a flow with `__human_review__` + `targetUrl`, click "Open in context", confirm overlay appears
> - Step 4: close overlay tab, reopen — confirm fresh tab + overlay
> - Step 5: approve from overlay → confirm card leaves pending list
> - Step 6: approve from inline ReviewsTab buttons → confirm flow resumes
> - Step 7: disconnect extension, click "Open in context" → confirm plain tab + inline note
> - Step 8: legacy review with no `tabUrl` → confirm button hidden, inline approve/reject works
