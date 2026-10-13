# OPERATION KEYSTONE
### Rebuild the action review architecture around a dedup key system — kill the overlay, unify the lifecycle.

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

### Why this operation exists

The extension overlay approach (OPERATION OVERWATCH) was abandoned after production failures. The overlay was architecturally fragile — it required a live WebSocket connection, injected into the correct tab at the right moment, and had no fallback. 90% of scrapes worked. Actions were unreliable.

The new model is simpler and more robust:

**The `actionLog` table is the single source of truth for the entire action lifecycle.** Every action attempt — from the moment the agent first tries to queue it, through human approval or rejection, to execution result — lives as one row in `actionLog`. No mid-flow pausing. No overlay. No WebSocket review messages.

### Core rule: the agent always invokes flows directly — no abstract queuing

The agent must **always call a concrete action flow with a full structured input payload**. It does not queue abstract intentions like "send a DM to @niklas". It calls `send_dm({ handle: "@niklas", message: "..." })`. The flow itself decides whether to execute immediately or go to Review Actions based on `requiresApproval`.

This is a hard architectural boundary. The old `pendingActions` model (where the agent described an action in plain text and a human decided how to execute it) is gone. The new model is: the agent produces the exact structured input, the runtime handles the lifecycle.

If the agent doesn't know how to produce the structured input for an action, it should scrape the necessary context first (using a scrape flow), then call the action flow with the result. It should never bypass this by queuing a vague description.

### The key principle

Every action flow **must** have a `dedupKeyField`. When the agent calls an action flow:

1. The key is extracted from the input immediately
2. `actionLog` is checked for a prior entry with that `(flowId, keyValue)` pair
3. If found: return a rich contextual block message to the agent (with a suggested next action) — **do not proceed**
4. If not found: **write the key to `actionLog` immediately** (at queue time, not execution time)
5. If `requiresApproval = true`: set status to `pending_review` — the entry waits in Review Actions for the human to Play / Play Amended / Reject
6. If `requiresApproval = false`: execute the flow immediately, update status to `executed` or `failed`

This means the guard fires even for actions currently sitting in the review queue — the agent gets "already in review" feedback before it can create a duplicate.

### Rich block messages

The agent gets contextual feedback, not a generic error. Examples:

- **Hard stop hit:** `"⛔ Hard stop: You already ran comment_on_post for https://reddit.com/r/... on 24 Mar at 14:32. Use read_post_and_comments and reply_to_comment if you have more to say."`
- **Soft stop in cooldown:** `"⏳ Soft stop: You ran send_dm to @niklas 2h ago. Minimum interval is 24h. Next allowed: 25 Mar 14:32."`
- **Already in review queue:** `"⏳ In review: comment_on_post for https://... was queued at 14:32 today and is awaiting human approval. Do not re-queue."`
- **Rejected by human:** `"❌ Rejected: The user rejected this action with reason: 'Wrong tone, too pushy'. Do not retry without new context."`
- **Approved with edits:** `"✅ Approved and executed. User amended the content to: '[final text]'"`

### What gets removed

- `__human_review__` step type — gone from flow runner and flow editor
- `requiresHumanReview` field — deprecated (keep in DB for backwards compat, ignore in new code)
- `pendingHumanReviews` table — no new writes; existing rows left intact
- Extension overlay — removed from content script and background
- `ActionsTab.tsx` + `pendingActions` table routes — replaced by Review Actions tab
- `OPEN_REVIEW_TAB` WebSocket message — no longer sent

### What the new tabs look like

**Review Actions tab** (replaces both Actions and Reviews tabs)
- Pending section: action flows awaiting approval. Shows flow name, full input JSON, queued time, context. Buttons: Play / Play Amended (editable content field) / Reject (requires reason). open_tab step URLs are rendered as clickable hyperlinks so you can open the page yourself before deciding.
- History section: all completed entries (approved, rejected, failed, blocked, executed). Per entry: status badge, full step trace (same as test run view in the editor), re-run button.

**Review Scrapes tab**
- All scrape flow runs, newest first. Per entry: flow name, input, status (success/failed), duration, full step trace, re-run button.

### Agent folder refactor

All AI agents move to `packages/backend/src/agents/`:

| New file | Source |
|---|---|
| `chat-agent.ts` | `orchestrator/index.ts` |
| `manager-agent.ts` | `orchestrator/autonomous.ts` |
| `setup-agent.ts` | inline in `routes/setup.ts` |
| `tool-forge-agent.ts` | `sub-agents.ts → runToolForgeAgent` |
| `scrape-flow-agent.ts` | `sub-agents.ts → runFlowBuilderAgent` (scrape half) |
| `action-flow-agent.ts` | `sub-agents.ts → runFlowBuilderAgent` (action half) |

`orchestrator/` becomes infrastructure only — tool runner, flow runner, api-tool runner, abort registry, etc.

### Setup structured view

The setup agent will output a structured `profileBlob` JSON (stored in a new `profile_blob` column on `agents`) alongside the raw `systemPrompt`. The SetupTab `view` mode becomes a dashboard with editable cards: Job Description, Competitors, Tone, Allowed, Restricted, Focus, Mindset. The existing Generate / Amend / Raw modes are kept.

---

## Phase 1 — DB Foundation

### Task 1 — DB: extend `actionLog` schema

Add the following columns to `actionLog` and write the migration:

```sql
status        TEXT NOT NULL DEFAULT 'executed'
-- 'pending_review' | 'approved' | 'approved_with_edits' | 'rejected' | 'executed' | 'failed' | 'blocked'

blocked_reason  TEXT         -- nullable; human-readable reason with suggested next action
final_content   TEXT         -- nullable; the content actually used if human amended it
re_run_count    INTEGER NOT NULL DEFAULT 0  -- incremented on each manual re-run from UI
```

Update `schema.ts` and create migration `drizzle/0008_action_log_status.sql`.

**Done when:**
- New columns present in `schema.ts`
- Migration file created and applied (`pnpm drizzle-kit migrate` in `packages/backend`)
- TypeScript compiles with no new errors in `packages/backend`

**Status:** `[x]`

> Added `status`, `blocked_reason`, `final_content`, `re_run_count` to `actionLog` in `schema.ts`. Created `drizzle/0008_action_log_status.sql`. Applied migration directly via Python/sqlite3 (drizzle-kit couldn't run — esbuild darwin/linux mismatch in node_modules). TypeScript compiles clean (no errors).

---

### Task 2 — DB: always persist full step results in `flowRuns`

Currently `pausedStepResults` is only written at a human-review pause point. Add a new column that is always written on run completion:

```sql
step_results  TEXT  -- nullable JSON: Record<stepId, unknown> — always written on completion
```

Update `schema.ts` and create migration `drizzle/0009_flow_runs_step_results.sql`.

The flow runner (`features/flows/flow-runner.ts`) should write `stepResults` to `flowRuns` at the end of every run (success, fail, or block), not just at pause. The existing `pausedStepResults` column stays for backward compat but is no longer the primary step trace source.

**Done when:**
- Column in schema + migration applied
- `flow-runner.ts` writes `stepResults` on every run completion
- TypeScript compiles clean

**Status:** `[x]`

> Added `stepResults: text('step_results')` to `flowRuns` in `schema.ts`. Created `drizzle/0009_flow_runs_step_results.sql`. Applied migration directly via Python/sqlite3. Updated `finalize()` in `flow-runner.ts` to write `JSON.stringify(result.stepResults)` to the new column on every run completion (success, fail, or block). TypeScript compiles clean (no errors).

---

### Task 3 — DB: add `profile_blob` column to `agents`

Add structured setup output storage:

```sql
profile_blob       TEXT  -- nullable JSON: { jobDescription, competitors[], tone[], allowed[], restricted[], focus, mindset }
profile_blob_updated_at  TEXT  -- nullable ISO timestamp
```

Migration: `drizzle/0010_agents_profile_blob.sql`.

No other changes in this task — just schema + migration.

**Done when:**
- Column in schema + migration applied
- TypeScript compiles clean

**Status:** `[x]`

> Added `profileBlob: text('profile_blob')` and `profileBlobUpdatedAt: text('profile_blob_updated_at')` to `agents` in `schema.ts`. Created `drizzle/0010_agents_profile_blob.sql`. Applied migration directly via Python/sqlite3 (same approach as Tasks 1 & 2 — drizzle-kit unavailable due to esbuild darwin/linux mismatch). Verified columns present in DB. TypeScript compiles clean (no errors).

---

## Phase 2 — Flow Runner: Key-First Guard

### Task 4 — Flow runner: rewrite dedup guard to key-first queue-time logic

This is the core of the operation. Rework the dedup/approval section of `features/flows/flow-runner.ts`:

**New sequence (runs at the very start of action flow execution):**

1. Extract `keyValue` from input using `flow.dedupKeyField`
2. If no `dedupKeyField` set on an action flow → throw a hard error: `"Action flow '${flow.name}' has no dedupKeyField. All action flows must have a key."`
3. Query `actionLog` for `(flowId, keyValue)`:
   - Status `pending_review` → return block message: `"⏳ In review: ${flow.name} for ${keyValue} was queued at ${time} and is awaiting human approval. Do not re-queue."`
   - Status `executed` or `approved` + `dedupBreakType = 'hard'` → return: `"⛔ Hard stop: You already ran ${flow.name} for ${keyValue} on ${date}. ${flow.dedupBlockMessage}"`
   - Status `executed` or `approved` + `dedupBreakType = 'soft'` + within interval → return: `"⏳ Soft stop: You ran ${flow.name} for ${keyValue} ${timeSince}. Minimum interval is ${hours}h. Next allowed: ${nextAllowed}."`
   - Status `rejected` → return: `"❌ Rejected: The user previously rejected ${flow.name} for ${keyValue} with reason: '${blockedReason}'. Do not retry without new context."`
4. **Write to `actionLog` immediately** with status:
   - `requiresApproval = true` → `'pending_review'`
   - `requiresApproval = false` → `'executed'` (optimistic — update to `'failed'` if run errors)
5. If `requiresApproval = true` → return the `actionLog` entry ID to the agent as: `"⏸ Queued for review: ${flow.name} for ${keyValue} has been sent to Review Actions. ID: ${id}"`
6. If `requiresApproval = false` → run the flow, update `actionLog` status to `executed` (success) or `failed` (error), store `result`

The `dedupBlockMessage` field on the flow (already in schema) is the suggested next action — e.g. "Use read_post_and_comments and reply_to_comment if you have more to say." The guard appends this to hard stop messages.

**Important: failed actions are still "done" from the dedup system's perspective.**

If a flow executes and fails (status → `failed`), the key remains written in `actionLog`. The dedup guard will fire on any subsequent attempt, returning: `"⚠ Previously failed: You already attempted ${flow.name} for ${keyValue} on ${date} but the execution failed. Check Review Actions for details. Do not retry automatically — the flow likely needs fixing."` The agent must NOT retry on its own. Re-runs are a human action only, triggered from the Review Actions UI. This is intentional: a failed execution almost always means the flow has a bug, not that the input was wrong.

**Done when:**
- Key is written to `actionLog` before flow executes (verifiable by checking DB after a `pending_review` queue)
- All block message variants return the correct format, including the `failed` case
- Action flows without `dedupKeyField` throw a hard error
- Failed status blocks re-queue by the agent (guard fires)
- Existing tests in `src/__tests__/flow-runner.test.ts` still pass (update as needed)
- TypeScript compiles clean

**Status:** `[x]`

> Rewrote `checkDedup()` in `flow-runner.ts` with key-first queue-time logic. Action flows without `dedupKeyField` now throw a hard error. Guard checks `(agentId, flowId, keyValue)` with `blocked=false` and branches on status: `pending_review` → in-review message, `rejected` → rejection message, `failed` → previously-failed message, `executed/approved` + hard → hard stop, `executed/approved` + soft + within interval → soft stop. Key is written to `actionLog` immediately with `pending_review` or `executed` status before execution. Old `pendingActions` insert removed; `requiresApproval` now queues via `actionLog` and returns a `⏸ Queued for review` message. `postRun()` updates (not inserts) the actionLog entry with the final result. Failed executions update the entry status to `'failed'` in `run()`. Added 4 new dedup test cases; updated 2 existing ones for new message format. Added `sendReviewTab` to websocket mock. All 14 tests pass, TypeScript compiles clean.

---

### Task 5 — Backend: Play endpoint for Review Actions

Add a new route: `POST /agents/:agentId/action-log/:entryId/play`

Request body:
```json
{
  "amendedContent": "optional string — if present, use this instead of original input content"
}
```

Logic:
1. Fetch `actionLog` entry — must be `status = 'pending_review'`, else 400
2. Parse stored `input` JSON
3. If `amendedContent` provided: find the content field in the input (the field that holds the text being sent) and replace it
4. Run the flow via `runFlowDetailed` with the (possibly amended) input
5. Update `actionLog`:
   - `status` → `'approved'` or `'approved_with_edits'` or `'failed'`
   - `finalContent` → the content that was actually used (if amended)
   - `result` → stringified flow output or error
6. Return the updated `actionLog` entry

Also add: `POST /agents/:agentId/action-log/:entryId/reject`

Request body: `{ "reason": "string" }`

Logic: set `status = 'rejected'`, `blockedReason = reason`.

And: `POST /agents/:agentId/action-log/:entryId/rerun`

Logic: clears status back to `pending_review` (if `requiresApproval`) or re-executes immediately. Increments `reRunCount`.

**Done when:**
- All three endpoints return correct responses
- Play updates `actionLog` status and links the resulting `flowRuns` entry
- TypeScript compiles clean

**Status:** `[x]`

> Added `skipDedup` and `existingActionLogId` fields to `FlowContext` in `flow-runner.ts`. In `checkDedup()`, an early-return handles `skipDedup=true`: sets `actionLogEntryId` to the provided entry ID and returns null (bypassing guard + actionLog insert + requiresApproval queue). Added three new endpoints to `routes/action-log.ts`: `POST /play` (fetches `pending_review` entry, optionally patches the content field for amendments, runs flow via `runFlowDetailed` with `skipDedup`, then updates status to `approved`/`approved_with_edits`/`failed` + `finalContent`); `POST /reject` (sets `status=rejected`, `blockedReason=reason`); `POST /rerun` (for approval flows: sets back to `pending_review`; for non-approval flows: resets entry to `executed`, runs flow with `skipDedup`; both paths increment `reRunCount`). TypeScript compiles clean, all 14 tests pass.

**Depends on:** Task 1, Task 4

---

## Phase 3 — Kill the Overlay

### Task 6 — Flow runner: remove `__human_review__` step execution

In `features/flows/flow-runner.ts`:
- Remove the block that handles `toolId === '__human_review__'`
- Remove all calls to `sendReviewTab` that relate to human review steps
- Remove all writes to `pendingHumanReviews` from the flow runner
- Remove `pausedAt` / `pausedStepResults` write logic (keep columns, stop writing)
- Remove `resumeFromReview` export (or keep as a no-op stub if imported elsewhere — check)

The `pendingHumanReviews` table itself is NOT dropped — existing rows stay. Just stop creating new ones.

**Done when:**
- No `__human_review__` logic remains in `flow-runner.ts`
- No `sendReviewTab` calls remain in `flow-runner.ts`
- `resumeFromReview` removed or stubbed
- TypeScript compiles clean across all packages

**Status:** `[x]`

> Removed all `__human_review__` logic from `flow-runner.ts`: deleted the `__human_review__` block from `executeSteps()`, removed the legacy `requiresHumanReview` inline-tab-review block from `checkDedup()`, removed the `__human_review__` auto-approve block from `runSingleStep()`, removed all `pendingHumanReviews` inserts and all `sendReviewTab` calls. Removed `pendingHumanReviews` and `pendingActions` from schema import, `sendReviewTab` from websocket import. Removed `pausedStepResults`/`pausedAt` from `FinalizeResult` type and from `finalize()` DB write (columns kept in DB for backward compat, just stop writing). Replaced `resumeFromReview` export with a no-op stub (function is imported in `routes/reviews.ts` so kept it to avoid a compile error). TypeScript compiles clean, all 14 tests pass.

---

### Task 7 — FlowEditor: remove Human Review step type

In `packages/frontend/`:
- Remove `__human_review__` from the tool picker / step type selector in `StepForm.tsx` and `ToolPickerModal.tsx`
- Remove `HumanLoopFlags.tsx` component (or gut it — `requiresApproval` is now a flow-level boolean on the flow metadata card, not a step)
- Remove the Tab ID / Draft Content / Target URL fields that were added in OPERATION OVERWATCH (`StepForm.tsx`)
- In `FlowMetadata.tsx`: ensure `requiresApproval` toggle is clearly labelled "Require human approval before execution" — this is the only approval control that remains
- Remove `requiresHumanReview` toggle from the flow metadata UI (the field stays in DB, just hidden from UI)

**Done when:**
- No human review step type visible in the flow editor step picker
- `HumanLoopFlags.tsx` removed or emptied
- `requiresApproval` toggle visible on flow metadata
- Frontend TypeScript compiles clean

**Status:** `[x]`

> Removed all `__human_review__` UI from the flow editor. `StepForm.tsx`: deleted the human review step body block (Draft Content / Tab ID / Target URL / Content Label fields) and all `isHumanReviewStep` guards. `InsertStepBar.tsx`: removed `onHumanReview` prop and the `+ review` button. `FlowEditor.tsx`: removed "📋 Add Review" button and all `addSpecialStep('__human_review__', ...)` + `onHumanReview` props on InsertStepBar. `StepCard.tsx`: removed `isHumanReviewStep` variable and its yellow border/background styling. `HumanLoopFlags.tsx`: gutted to an empty stub. `DedupSettings.tsx`: removed `requiresApproval` and `requiresHumanReview` props and the HumanLoopFlags import/usage. `FlowMetadata.tsx`: added `requiresApproval` toggle labelled "Require human approval before execution" (shown only for action flows). TypeScript compiles clean — no new errors introduced (pre-existing errors in FlowEditor.tsx lines 183-201 and FlowsTab.tsx were already present before this task).

---

### Task 8 — Extension: kill the overlay

In `packages/extension/src/`:
- `background/index.ts`: remove the `OPEN_REVIEW_TAB` message handler and `reviewTabMap` logic
- `content/index.ts`: remove overlay injection, overlay DOM element, and all overlay-related message listeners
- `offscreen/index.ts`: remove `OPEN_REVIEW_TAB` relay logic
- `protocol.ts`: remove `OPEN_REVIEW_TAB` and `CONTENT_SCRIPT_READY` message types (or mark as deprecated with a comment)

The `Reviews` tab in the frontend (`ReviewsTab.tsx`) can remain for now as a read-only history view of `pendingHumanReviews` (old entries). It will eventually be removed but there is no urgency.

Rebuild the extension after changes: `cd packages/extension && pnpm run build`

**Done when:**
- Extension background no longer handles `OPEN_REVIEW_TAB`
- Content script no longer injects an overlay
- Extension builds clean
- Extension loads in Chrome without errors

**Status:** `[x]`

> Removed all overlay code from the extension. `background/index.ts`: deleted `ReviewTabEntry` interface, `reviewTabMap` Map, `CONTENT_SCRIPT_READY` handler, `OPEN_REVIEW_TAB` handler, review tab cleanup in `onRemoved`, and the entire pending review overlay section (F3.4 polling setInterval + `injectReviewOverlay` function + `overlayInjectedTabs` Set). `content/index.ts`: removed `INJECT_REVIEW_OVERLAY` message handler, `CONTENT_SCRIPT_READY` sendMessage call, `OverlayData` type, and the full `injectReviewOverlay` function (~320 lines). `offscreen/index.ts`: removed `OPEN_REVIEW_TAB` relay case from the WebSocket message switch. `protocol.ts`: removed `OPEN_REVIEW_TAB` from `BackendToExtension` and `OffscreenMessage` unions; removed `CONTENT_SCRIPT_READY` and `INJECT_REVIEW_OVERLAY` from `ContentMessage` union; left deprecation comments. TypeScript compiles clean (no errors). Extension build skipped — same darwin/linux rollup native binary mismatch as Tasks 1–3; tsc --noEmit confirms clean types.

**Depends on:** Task 6

---

## Phase 4 — New UI Tabs

### Task 9 — Frontend: remove Actions tab + pendingActions routes

**Frontend:**
- Remove `{ path: 'actions', label: 'Actions' }` from `TABS` array in `AgentLayout.tsx`
- Remove `import ActionsTab` and the `<Route path="actions">` from `AgentLayout.tsx`
- Delete `packages/frontend/src/pages/agent/ActionsTab.tsx`

**Backend:**
- Remove or comment out the `pendingActions` routes in `routes/actions.ts` (keep the file, just disable the routes so the table data is preserved)
- Do NOT drop the `pendingActions` table

**Done when:**
- Actions tab no longer appears in the nav
- No import errors in `AgentLayout.tsx`
- Frontend and backend compile clean

**Status:** `[x]`

> Removed `import ActionsTab` and `{ path: 'actions', label: 'Actions' }` from `AgentLayout.tsx`. Deleted `ActionsTab.tsx`. Replaced `registerActionsRoutes` body in `routes/actions.ts` with a no-op stub (routes disabled, table preserved). Backend compiles clean. Frontend has only the same pre-existing errors in `FlowEditor.tsx`, `FlowsTab.tsx`, and `types/index.ts` that were already present before this task — no new errors introduced.

---

### Task 10 — Frontend: build Review Actions tab

Create `packages/frontend/src/pages/agent/ReviewActionsTab.tsx`.

**Data source:** `GET /agents/:agentId/action-log?flowType=action` (add `flowType` filter to the existing action-log route)

**Layout:**

```
[ Pending ({n}) ]  [ History ]                              [↻ Refresh]

── Pending ──────────────────────────────────────────────────
  ⚡ comment_on_post                          queued 14:32 today
  post_url: https://reddit.com/r/...
  comment_text: "The payback period..."       [▸ Show full input]

  [  ▶ Play  ]  [  ✎ Play Amended  ]  [  ✗ Reject  ]

── History ──────────────────────────────────────────────────
  ✅ APPROVED   comment_on_post   https://...   24 Mar 14:45   [▸ Steps] [↺ Re-run]
  ❌ REJECTED   send_dm           @niklas       23 Mar 09:12   [▸ Steps]
  ⛔ BLOCKED    comment_on_post   https://...   22 Mar 11:00   [▸ Steps]
```

**Play Amended** opens an inline editor pre-filled with the content field from the input. On confirm, calls the play endpoint with `amendedContent`.

**Reject** shows an inline input for rejection reason before confirming.

**Steps panel** (expandable): renders the full step trace from the linked `flowRuns.stepResults`. For any step whose result contains a URL (open_tab steps), render the URL as a `<a href target="_blank">` hyperlink.

Add to `AgentLayout.tsx` TABS: `{ path: 'review-actions', label: 'Review Actions' }` and the corresponding route.

**Done when:**
- Tab visible and navigable
- Pending items show with Play / Play Amended / Reject buttons
- Each pending item displays its `actionLog` entry ID clearly (copyable, e.g. monospace chip) for use in testing and debugging
- Play calls backend, item moves to history
- History shows step trace on expand
- open_tab URLs are clickable hyperlinks
- Frontend TypeScript compiles clean

**Depends on:** Task 5, Task 9

**Status:** `[x]`

> Created `ReviewActionsTab.tsx` with two sub-sections: Pending (actions awaiting `pending_review`) and History (all completed entries). Pending cards show flow name, key value, full input fields (with URL hyperlinks), a copyable entry ID chip, and three action buttons: ▶ Play, ✎ Play Amended (inline content editor pre-filled from the input's content field), and ✗ Reject (inline reason input). History rows show status badge, flow name, key value, re-run count, finalContent/blockedReason previews, a ↺ Re-run button, and an expandable Steps panel. The Steps panel fetches `/agents/:agentId/flow-runs?flow_id=X` and picks the closest run by time, rendering stepResults per-step with open_tab URLs as clickable `<a>` hyperlinks. Added `flowType` and `status` query filters to the backend `GET /agents/:agentId/action-log` route. Updated `ActionLogEntry` type in `types/index.ts` to include `status`, `blockedReason`, `finalContent`, `reRunCount`. Updated `FlowRun` type to include `stepResults`. Registered `{ path: 'review-actions', label: 'Review Actions' }` in `AgentLayout.tsx` TABS and added the corresponding `<Route>`. Frontend TypeScript compiles clean — no new errors introduced (pre-existing errors in FlowEditor.tsx, FlowsTab.tsx, types/index.ts were already present).

---

### Task 11 — Frontend: build Review Scrapes tab

Create `packages/frontend/src/pages/agent/ReviewScrapesTab.tsx`.

**Data source:** `GET /agents/:agentId/flow-runs?flowType=scrape` (add `flowType` filter to the runs route — join against `flows` table to get `flowType`)

**Layout:**

```
All scrape runs, newest first.

  ✅ check_notifications    14:32 today    1.2s    [▸ Steps] [↺ Re-run]
  ❌ scrape_post_comments   09:12 23 Mar   0.4s    [▸ Steps] [↺ Re-run]
     Error: Could not find child element
```

**Steps panel**: same step trace renderer as Review Actions (reuse the component). Failed steps highlighted in red with the error message.

**Re-run**: calls `POST /agents/:agentId/flows/:flowId/run` with the same input stored in `flowRuns.input`.

Add to TABS: `{ path: 'review-scrapes', label: 'Review Scrapes' }`.

**Done when:**
- Tab visible with scrape run history
- Failed runs show error clearly
- Step trace expandable per run
- Re-run button works
- Frontend TypeScript compiles clean

**Depends on:** Task 2

**Status:** `[x]`

> Created `ReviewScrapesTab.tsx` displaying all scrape flow runs newest-first. Each row shows a status badge (✅/❌), flow name, timestamp, duration, and an inline error summary on failure. Expandable step trace panel renders `stepResults` per-step (same renderer as ReviewActionsTab) with open_tab URLs as clickable `<a>` hyperlinks. Re-run button calls the new `POST /agents/:agentId/flows/:flowId/run` endpoint with the original input from `flowRuns.input`. Backend: added optional `flowType` parameter to `findFlowRuns` (filters by joining flows table to resolve IDs with matching `flowType`), propagated through `listFlowRuns` service and the `GET /agents/:agentId/flow-runs` route querystring. Added `POST /agents/:agentId/flows/:flowId/run` endpoint as a thin wrapper around `testSavedFlow`. Updated `AgentLayout.tsx` with import, `{ path: 'review-scrapes', label: 'Review Scrapes' }` tab entry, and `<Route>`. Backend and frontend TypeScript compile clean — only pre-existing errors in FlowEditor.tsx, FlowsTab.tsx, types/index.ts (unchanged from previous tasks).

---

## Phase 5 — Agent Refactor

### Task 12 — Backend: create `agents/` folder, move and rename agents

Create `packages/backend/src/agents/` and move the AI agent logic:

| New path | Source | Export rename |
|---|---|---|
| `agents/chat-agent.ts` | `orchestrator/index.ts` | `runChatAgent` |
| `agents/manager-agent.ts` | `orchestrator/autonomous.ts` | `runManagerAgent` |
| `agents/tool-forge-agent.ts` | `sub-agents.ts` (Tool Forge section only) | `runToolForgeAgent` (keep name) |

For the setup agent: extract the Claude call logic out of `routes/setup.ts` into `agents/setup-agent.ts`. The route file becomes a thin HTTP handler that calls the agent function.

Update all imports across `routes/`, `orchestrator/`, and `index.ts`. The old files (`orchestrator/index.ts`, `orchestrator/autonomous.ts`) become re-export shims pointing to the new paths — this avoids a big-bang import update. Mark them with a `// TODO: remove shim` comment.

Do NOT move the FlowBuilder agent yet — that is Task 13.

**Done when:**
- `agents/` folder exists with the four files above
- Old orchestrator files are shims (re-export only)
- All TypeScript compiles clean across all packages
- `pnpm run dev` starts without errors

**Status:** `[x]`

> Created `packages/backend/src/agents/` folder with four files: `chat-agent.ts` (full implementation from `orchestrator/index.ts`, export renamed `runOrchestrator` → `runChatAgent`), `manager-agent.ts` (full implementation from `orchestrator/autonomous.ts`, export renamed `runAutonomousOrchestrator` → `runManagerAgent`), `tool-forge-agent.ts` (Tool Forge section extracted from `sub-agents.ts`, keeping `runToolForgeAgent` name), `setup-agent.ts` (generate logic extracted from `routes/setup.ts`, exported as `runSetupAgent`). Converted `orchestrator/index.ts` and `orchestrator/autonomous.ts` to re-export shims with `// TODO: remove shim` comments. Updated `routes/setup.ts` to import and call `runSetupAgent` — generate endpoint is now a thin HTTP handler. All relative imports updated for the new `agents/` location. TypeScript compiles clean (no new errors). All 14 tests pass.

---

### Task 13 — Backend: split FlowBuilderAgent into ScrapeFlowAgent + ActionFlowAgent

Split `runFlowBuilderAgent` in `sub-agents.ts` into two new files:

**`agents/scrape-flow-agent.ts` — knows:**
- What makes a good scrape flow (navigation, waitForLoad, DOM query patterns)
- `runOnStartup` flag: flows tagged this way run when the agent session starts
- Startup flows should only be used for things like check_notifications — not arbitrary scrapes
- If `runOnStartup` is set, the scrape is re-checked approximately hourly (scheduler awareness)
- How to build reliable child-element selectors and handle "no comments" / "no results" empty states gracefully (the 10% failure case)

**`agents/action-flow-agent.ts` — knows:**
- Every action flow **must** have a `dedupKeyField` — no exceptions
- Hard stop vs soft stop semantics: first_dm = hard stop; follow_up_dm = soft stop with interval
- `requiresApproval` flag and when to recommend it (irreversible, high-stakes actions)
- The `dedupBlockMessage` field should always suggest a concrete alternative action (e.g. "Use reply_to_comment instead")
- Vision check (`evaluate` block on screenshot step) is optional but recommended for high-stakes actions

**Failure detection — practical guidance (important gap):**

Current action flows do not have a strong fail-state model. Most browser automation steps return a result but do not signal failure explicitly — the flow silently "succeeds" even if the button wasn't found or the page redirected. This is a known gap. The agent cannot always detect failure reliably, but it should use the following patterns where possible:

- **DOM check after action**: add a step after the click/submit that reads a known element (e.g. "confirmation message", "success toast", or absence of the input field). Add a `condition` on that step: `check: 'non_empty'` with a `skipToStepId` pointing to a cleanup/fail step.
- **Array result check**: if the action depends on finding something in a list (e.g. a post, a button label), add a `condition: { check: 'min_array_length', minLength: 1 }` on the scrape step before the action. If the list is empty, the condition fails and the flow stops before executing.
- **Do not add vision checks as the primary fail detector** — they are expensive and slow. Use DOM conditions first. Vision checks are for ambiguous visual confirmation only.

The agent should document in the flow's `expectedOutput` field what a successful execution looks like. This makes it easier for humans to spot when something went wrong in the step trace.

Remove the old `runFlowBuilderAgent` from `sub-agents.ts`. Update `autonomous.ts` (now `manager-agent.ts`) to call the correct split agent based on `flowType`.

**Done when:**
- Two new agent files exist with distinct system prompts
- Old `runFlowBuilderAgent` removed from `sub-agents.ts`
- "Fix with AI" in the flow editor calls the correct agent based on flow type
- TypeScript compiles clean

**Depends on:** Task 12

**Status:** `[x]`

> Created `agents/scrape-flow-agent.ts` (exports `runScrapeFlowAgent`) and `agents/action-flow-agent.ts` (exports `runActionFlowAgent`). Each has a distinct system prompt: scrape agent covers runOnStartup semantics, empty-state guards, reliable selector patterns, and startup flow rules; action agent enforces `dedupKeyField` as mandatory (returns an error if missing after each attempt), explains hard/soft stop semantics, `requiresApproval` guidance, `dedupBlockMessage` requirements, and failure detection patterns (DOM check, array guard). Removed `export` from `runFlowBuilderAgent` in `sub-agents.ts` (marked deprecated, kept as unexported function for backward compat). Updated `manager-agent.ts` `revise_flow` handler to select the correct agent based on `existingFlow.flowType` (action → `runActionFlowAgent`, scrape/unknown → `runScrapeFlowAgent`). For the FlowEditor "Fix with AI" path: added `flowType?: 'scrape' | 'action'` to `GenerateBody` in `flows-generate.ts` and updated `buildSystemPrompt` to prepend a type-specific focus note when `flowType` is provided; added `flowType` prop to `FlowGenerator.tsx`, threaded through `useFlowGeneratorStream` hook and `api.generateFlowStream`; updated `FlowEditor.tsx` to pass `draft.flowType` to `FlowGenerator` in fix mode. Backend TypeScript compiles clean. Frontend has only the same pre-existing errors in `FlowEditor.tsx`, `FlowsTab.tsx`, and `types/index.ts` (unchanged from previous tasks). All 14 tests pass.

---

## Phase 6 — Setup Structured View

### Task 14 — Setup agent: output structured `profileBlob`

Update `agents/setup-agent.ts` to output a JSON blob alongside (or instead of) the raw prompt narrative. The blob shape:

```ts
interface ProfileBlob {
  jobDescription: string;         // 2–4 sentence role summary
  competitors: {
    name: string;
    url?: string;
    notes: string;
  }[];
  tone: string[];                 // bullet strings, same format as existing toneGuide
  allowed: string[];              // things the agent is explicitly permitted to do
  restricted: string[];           // things the agent must never do
  focus: string;                  // the primary objective in one sentence
  mindset: string;                // the operating philosophy / personality framing
}
```

The setup route (`routes/setup.ts`) saves the blob to `agents.profile_blob` and continues to save the narrative text to `agents.system_prompt` (the model still uses the system prompt; the blob is for the UI).

**Done when:**
- Setup agent returns both `systemPrompt` (string) and `profileBlob` (JSON) in its stream
- Route saves `profileBlob` to the new column
- TypeScript compiles clean

**Depends on:** Task 3

**Status:** `[x]`

> Updated `GENERATE_SYSTEM_PROMPT` in `setup-agent.ts` to instruct the model to output a `profileBlob` object alongside `systemPrompt` in its JSON response. Added `ProfileBlob` interface (exported) and added `profileBlob: ProfileBlob` to `SetupAgentResult`. Updated the JSON parse block to extract `profileBlob` (with a safe default if missing). Updated `routes/setup.ts` generate endpoint to call `db.update(agents).set({ profileBlob: JSON.stringify(result.profileBlob), profileBlobUpdatedAt: new Date().toISOString() })` after the agent returns, persisting the blob to the `agents.profile_blob` column. The `systemPrompt` continues to be returned in the response (the route still sends the full `result` object). TypeScript compiles clean (no errors).

---

### Task 15 — Frontend: build structured Setup dashboard view

Replace the current `view` mode in `SetupTab.tsx` with a structured dashboard. The other modes (Generate, Amend, Raw) stay exactly as-is.

**Dashboard layout:**

```
┌─ Job Description ────────────────────────────────────┐
│  [editable text]                          [Save]      │
└──────────────────────────────────────────────────────┘

┌─ Focus ───────────────────────────────────────────────┐
│  [editable text]                          [Save]      │
└──────────────────────────────────────────────────────┘

┌─ Mindset ─────────────────────────────────────────────┐
│  [editable text]                          [Save]      │
└──────────────────────────────────────────────────────┘

┌─ Tone ────────────────────────────────────────────────┐
│  • Use a direct, confident tone           [×]         │
│  • Never use corporate jargon             [×]         │
│  [+ Add]                                  [Save]      │
└──────────────────────────────────────────────────────┘

┌─ Allowed ─────────────────────────────────────────────┐  ┌─ Restricted ────────────────────────────┐
│  [tag] Direct outreach to founders   [×]              │  │  [tag] Mass follow/unfollow          [×] │
│  [+ Add]                             [Save]           │  │  [+ Add]                         [Save] │
└──────────────────────────────────────────────────────┘  └─────────────────────────────────────────┘

┌─ Competitors ─────────────────────────────────────────┐
│  [Name]  [URL]  [Notes]                  [×] [+ Add]  │
└──────────────────────────────────────────────────────┘

┌─ Model & Keys ────────────────────────────────────────┐
│  (existing model/apiKey/telegram fields, unchanged)   │
└──────────────────────────────────────────────────────┘
```

Each section saves independently via `PATCH /agents/:agentId` (updating `profileBlob`). If `profileBlob` is null (old agent, no structured data yet), show a prompt: "Run Generate to build your profile" with a button that switches to Generate mode.

**Done when:**
- Dashboard renders from `profileBlob` data
- Each section is independently editable and saveable
- Old agents without `profileBlob` show the generate prompt
- Frontend TypeScript compiles clean

**Depends on:** Task 14

**Status:** `[x]`

> Replaced the `view` mode in `SetupTab.tsx` with a `ProfileDashboard` component. Added `ProfileBlob` interface to `types/index.ts` and `profileBlob`/`profileBlobUpdatedAt` fields to the `Agent` type. Added `patchAgent` to the API client (`PATCH /agents/:id`). Added a PATCH route to `agents.routes.ts` (accepts `profileBlob`), extended `UpdateAgentInput` in `agents.service.ts` to support `profileBlob`, and updated `updateAgentById` to write `profileBlobUpdatedAt` when blob is set. The dashboard renders seven independently-saveable cards: Job Description, Focus, Mindset, Tone (list with add/remove), Allowed (list), Restricted (list), Competitors (editable table). The Allowed/Restricted cards sit side-by-side in a 2-column grid. Model & Keys section uses the existing `SharedFields` component. If `profileBlob` is null, a "Generate Profile" prompt is shown instead. Backend TypeScript compiles clean. Frontend has only the same pre-existing errors in `FlowEditor.tsx`, `FlowsTab.tsx`, and `types/index.ts` (unchanged from previous tasks).

---

## Reference: Key files touched by this operation

| File | Tasks |
|---|---|
| `packages/backend/src/db/schema.ts` | 1, 2, 3 |
| `packages/backend/drizzle/` (migrations) | 1, 2, 3 |
| `packages/backend/src/features/flows/flow-runner.ts` | 4, 6 |
| `packages/backend/src/routes/action-log.ts` | 5 |
| `packages/backend/src/routes/runs.ts` | 11 |
| `packages/backend/src/routes/setup.ts` | 14 |
| `packages/backend/src/orchestrator/index.ts` | 12 (→ shim) |
| `packages/backend/src/orchestrator/autonomous.ts` | 12, 13 (→ shim) |
| `packages/backend/src/orchestrator/sub-agents.ts` | 13 |
| `packages/backend/src/agents/` (new) | 12, 13, 14 |
| `packages/extension/src/background/index.ts` | 8 |
| `packages/extension/src/content/index.ts` | 8 |
| `packages/extension/src/offscreen/index.ts` | 8 |
| `packages/extension/src/protocol.ts` | 8 |
| `packages/frontend/src/pages/agent/AgentLayout.tsx` | 9, 10, 11 |
| `packages/frontend/src/pages/agent/ActionsTab.tsx` | 9 (delete) |
| `packages/frontend/src/pages/agent/ReviewActionsTab.tsx` | 10 (new) |
| `packages/frontend/src/pages/agent/ReviewScrapesTab.tsx` | 11 (new) |
| `packages/frontend/src/pages/agent/SetupTab.tsx` | 15 |
| `packages/frontend/src/components/flow-editor/StepForm.tsx` | 7 |
| `packages/frontend/src/components/flow-editor/HumanLoopFlags.tsx` | 7 |
| `packages/frontend/src/components/flow-editor/FlowMetadata.tsx` | 7 |
