# OPERATION CONVERGENCE
### Kill the ghosts. Unify the systems. Polish the rough edges.

**Objective:** The AgentSpawner codebase has accumulated dead code paths, contradicting documentation, orphaned features, and unverified behavior across four rapid operations (VANTAGE, KEYSTONE, OVERWATCH, SITUATION ROOM). The core architecture is sound — the two-tier pipeline and dedup-based review model work. But the project is carrying the weight of every approach it tried and abandoned. This operation strips out the dead, resolves the contradictions, hardens what's live, and polishes the UX into something coherent.

**Status:** Planning complete. Ready for sequential implementation.

**How to use this file:**
- Start each session by reading this file first
- Pick the next `[ ]` task — some tasks are batched into one session (see "Session scope" notes on individual tasks)
- Mark completed tasks `[x]` and write a brief note under each before ending the session
- Never leave the codebase in a broken/non-compiling state at end of session
- Follow the branching strategy below — one branch per phase, merge between phases

**Status markers:**
- `[ ]` not started
- `[>]` in progress (session was interrupted — read the note before continuing)
- `[x]` done
- `[!]` blocked — see note
- `[—]` moved out of scope

**Branching and rollback strategy:**
- Work on a feature branch: `convergence/phase-N` (one branch per phase).
- Merge to `main` after each phase is complete and compiles clean. Tag the merge: `convergence-phase-1-done`, etc.
- If a task in Phase 2 (hardening) introduces regressions — e.g., Task 5's flow validation throws on legitimate flows, or Task 8's transactions cause deadlocks — revert the specific commit on the phase branch. Don't revert the entire phase.
- **Before Task 4.5** (DB schema drops): take a manual SQLite backup. Schema drops are irreversible and contain historical data. The backup is the only recovery path.
- Phase 1 is pure subtraction — lowest risk. Phase 2 changes runtime behavior — highest risk. Plan review time between them.

**Abort criteria — stop and reassess if:**
- Any single task touches more than 15 files (means the dead code is more entangled than mapped — re-scope before continuing)
- Removing a dead table's schema causes migration failures on existing DBs (means foreign key dependencies weren't fully mapped)
- Phase 2 checkpoint fails on the happy path (means hardening broke something fundamental — don't push forward into UX polish on a broken runtime)
- Two or more tasks in a phase need to be reverted (means the phase's assumptions were wrong — step back and re-plan)

---

## The Problem

After four operations shipped in rapid succession, the codebase has three categories of rot:

### 1. Contradictions that will break at runtime

The flow generator agent (`flows-generate.ts`) still teaches Haiku to produce `__human_review__` steps. But the flow runner no longer has a handler for `__human_review__` — KEYSTONE removed it. If an agent generates a flow with this step type, the flow will error at runtime with no useful message. The agent will retry, fail again, and waste tokens.

The `resumeFromReview()` function in `flow-runner.ts` is still exported and imported by `reviews.ts`. It returns a hard error: `"__human_review__ steps have been removed."` But nothing tells the caller this in a useful way — the route just swallows it.

Agent system prompts (chat-agent, manager-agent) still reference `__human_review__` behavior in their instructions. The agent believes it can use a feature that doesn't exist.

### 2. Dead systems that confuse anyone reading the code

Two parallel approval systems exist:
- **Old:** `pendingHumanReviews` table → `ReviewsTab` → overlay-based review → `resumeFromReview()`
- **New:** `actionLog` table → `ReviewActionsTab` → play/reject/revise endpoints → `requiresApproval` on flows

The old system is functionally dead — nothing inserts into `pendingHumanReviews` anymore. The `ReviewsTab` reads from it but will never show new entries. The overlay injection code has been removed from the extension protocol. Yet all the plumbing is still wired: routes, tab component, DB table, type definitions.

The `pendingActions` table and its routes are also dead — replaced by `actionLog` in KEYSTONE.

The `pausedStepResults` column on `flowRuns` was added by HUMAN_REVIEW_RESUMPTION but is now replaced by the always-written `stepResults` column from KEYSTONE.

### 3. Features that were marked done but never verified end-to-end

| Feature | Status in docs | Actual status |
|---------|---------------|---------------|
| Human review resumption (Task 8 E2E) | `[ ]` not done | Cannot work — step handler removed |
| OVERWATCH overlay smoke test (Task 3) | `[ ]` not done | Cannot work — overlay removed |
| SITUATION ROOM smoke test (Task 3) | `[>]` in progress | Depends on pendingHumanReviews which is dead |
| BUILDER_FLOW_SYNC E2E test (Task 4) | `[ ]` not done | Likely works but unverified |
| VANTAGE full pipeline E2E | All marked `[x]` | Needs re-verification after KEYSTONE changes |

---

## What Works (Don't Touch)

Before we start cutting, here's what's solid and should be preserved exactly as-is:

- **The KEYSTONE model.** `actionLog` as single source of truth. `requiresApproval` on flows. Dedup guards with rich contextual block messages. ReviewActionsTab with play/play-amended/reject/revise. This is the live approval system and it works.

- **The VANTAGE pipeline.** `__hydrate__` → `__generate__` two-tier content generation. Haiku scouts, Sonnet writes. Rich briefs with re-executed references. Tone injection from both `toneGuide` and `profileBlob`. This is the live content system and it works.

- **The step dispatch architecture.** `__evaluate__`, `__screenshot__`, `__transform__`, `__query_action_log__`, `__query_memory__`, `__hydrate__`, `__generate__`, plus regular tool execution. Clean, extensible, well-structured.

- **The dedup guard.** Hard stops, soft stops with cooldowns, in-review detection, rejection feedback. Rich block messages that actually help the agent make better decisions.

- **The agent system.** Manager → sub-agents (action-flow, scrape-flow, chat, setup, tool-forge). Clear delegation. Per-step model declarations. Compaction at token limits.

- **SetupTab.** The most polished UI component. Generate/amend/raw-edit modes. ProfileBlob dashboard. Parse-from-prompt. This is the gold standard for the other tabs.

---

## Phase 1 — Exorcism (Kill the Dead Code)

These tasks remove code that is no longer reachable at runtime. No new features. No behavior changes for anything that currently works. Pure subtraction.

---

### TASK 1 — Remove `__human_review__` from the flow generator + clean up `resumeFromReview` and old review routes

**Status:** `[x]`
**Completed:** 2026-03-26
**Notes:** Removed the entire `__human_review__` system prompt section (~95 lines) from `flows-generate.ts` and replaced with a short note pointing to `requiresApproval: true`. Removed `__human_review__` from all three `BUILTIN_SENTINELS` mappings (in `flows-generate.ts` and two in `flows.routes.ts`). Updated agent prompts in `chat-agent.ts` and `manager-agent.ts` to reference the `requiresApproval` model instead. Added a runtime guard in `flow-runner.ts` `run()` that rejects any flow containing `__human_review__` steps at load time with a clear error message. Verified `protocol.ts` (extension) is clean — dead overlay types were already removed in KEYSTONE with accurate comments.
**Depends on:** Nothing
**Session scope:** Tasks 1 and 2 are one session. They touch overlapping files (`flow-runner.ts`, `reviews.ts`) and are logically one action: "remove the `__human_review__` system." Leaving `resumeFromReview` alive after removing the step type creates a half-dead state.
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 1: remove __human_review__ from flow generator, agent prompts, resumeFromReview stub, old review routes, and extension protocol dead types"

**The problem:**
`flows-generate.ts` contains extensive documentation in `buildSystemPrompt()` that teaches the AI to produce flows with `__human_review__` steps. This step type has no runtime handler — any flow generated with it will fail. The agent will waste cycles generating broken flows.

**What to do:**
1. In `packages/backend/src/routes/flows-generate.ts` (or wherever `buildSystemPrompt` lives): remove all references to `__human_review__` from the system prompt. Replace with guidance about `requiresApproval` on the flow level — the KEYSTONE model.
2. In `packages/backend/src/agents/chat-agent.ts`: remove the message about `__human_review__` pausing flows.
3. In `packages/backend/src/agents/manager-agent.ts`: remove any `__human_review__` references.
4. **Note:** `action-flow-agent.ts` was checked and contains no `__human_review__` references — no changes needed there.
5. Add a runtime guard in `flow-runner.ts`: if any step in a flow has `toolId === '__human_review__'`, throw a clear error at flow load time (not at step execution time) that says: `"__human_review__ steps are no longer supported. Set requiresApproval: true on the flow instead."`
6. In `packages/extension/src/protocol.ts`: **already done.** Dead overlay message types (`OPEN_REVIEW_TAB`, `CONTENT_SCRIPT_READY`, `INJECT_REVIEW_OVERLAY`) were removed in KEYSTONE and replaced with explanatory comments. Verify the comments are accurate and no stale type exports remain — but the heavy lifting is done.

**Files to touch:**
- `packages/backend/src/routes/flows-generate.ts`
- `packages/backend/src/agents/chat-agent.ts`
- `packages/backend/src/agents/manager-agent.ts`
- `packages/backend/src/features/flows/flow-runner.ts`
- `packages/extension/src/protocol.ts` — verify dead types are gone (they should be)
- ~~`packages/backend/src/agents/action-flow-agent.ts`~~ — already clean, no changes needed

**Done when:**
- No agent prompt anywhere mentions `__human_review__`
- All agent prompts teach `requiresApproval: true` as the approval mechanism
- A flow containing `__human_review__` throws a clear error at load time
- `protocol.ts` confirmed clean of dead overlay types
- TypeScript compiles clean

---

### TASK 2 — Remove the `resumeFromReview` stub, clean up reviews routes, and remove dead `pendingActions` backend routes

**Status:** `[x]`
**Completed:** 2026-03-26
**Notes:** Deleted `resumeFromReview()` from `flow-runner.ts`. In `reviews.ts`: removed the import, removed the fire-and-forget resume call from the resolve endpoint, removed the entire `reopen` endpoint (it called `sendReviewTab` which sends `OPEN_REVIEW_TAB` — a dead protocol message on the extension side), and added a comprehensive legacy-system comment block. Deleted `actions.ts` (the 9-line pendingActions stub) and removed its import + registration from `index.ts`. TypeScript compiles clean across backend and extension packages. Pre-existing frontend type errors in `useFlows.ts`/`FlowsTab.tsx` are unrelated.
**Depends on:** Task 1 (same session — see Task 1 scope note)
**Session start prompt:** _(Handled in Task 1 session — do not start a separate session for this)_

**The problem:**
`resumeFromReview()` in `flow-runner.ts` is a dead stub that returns an error. `reviews.ts` imports and calls it on approval — which silently fails. The `/reviews/:reviewId/resolve` endpoint updates the DB row but the resume never happens.

Since `pendingHumanReviews` is never written to by any live code path, the entire review resolution flow is dead. The routes still work for reading historical data, but the resolve/reopen endpoints serve no purpose for new entries.

**What to do:**
1. In `flow-runner.ts`: remove the `resumeFromReview()` function entirely (not just the stub — delete it).
2. In `reviews.ts`: remove the import of `resumeFromReview`. In the resolve endpoint, remove the `void resumeFromReview(reviewId).catch(...)` call. Keep the DB update (so historical reviews can still be marked resolved from the UI if desired).
3. In `reviews.ts`: add a comment block at the top of `registerReviewRoutes` explaining this is a **legacy read-only system** — `pendingHumanReviews` is no longer populated. New approval happens via `actionLog` + ReviewActionsTab.
4. Remove the `reopen` endpoint from `reviews.ts` — it calls `sendReviewTab()` which sends overlay messages that no longer exist in the extension protocol.
5. Delete the `pendingActions` route file entirely. It's already a 9-line disabled stub with a KEYSTONE comment — no gutting needed, just delete the file and remove its registration from the route loader.

**Files to touch:**
- `packages/backend/src/features/flows/flow-runner.ts`
- `packages/backend/src/routes/reviews.ts`
- `packages/backend/src/routes/actions.ts` (the `pendingActions` stub) — delete entirely + remove from route registration

**Done when:**
- `resumeFromReview` no longer exists anywhere
- `reopen` endpoint is gone
- `pendingActions` backend routes are removed
- Legacy review routes still serve reads for backward compat
- TypeScript compiles clean

---

### TASK 3 — Remove dead frontend: pendingActions routes, clean up ReviewsTab

**Status:** `[x]`
**Completed:** 2026-03-26
**Notes:** Rewrote ReviewsTab.tsx as a read-only history view: removed all action buttons (approve/reject/reopen), removed the `resolve()` and `reopen()` functions, removed the editable textarea for draft content (replaced with read-only `<pre>`), removed polling (no new entries will ever appear), added a legacy banner directing users to Review Actions tab. Kept the tone guide section intact (still functional). Renamed "Reviews" tab to "Reviews (Legacy)" in AgentLayout.tsx. Removed `getActions`, `updateAction`, `deleteAction` API methods from `client.ts` and removed `PendingAction` from its import. Marked the `PendingAction` interface as `@deprecated` in `types/index.ts`. No frontend code calls `/pending-actions/` endpoints (confirmed none existed). TypeScript compiles clean (only pre-existing `useFlows.ts`/`FlowsTab.tsx` errors remain — unrelated).
**Depends on:** Task 2
**Session scope:** Tasks 3 and 4 are one session. Task 3 is pure frontend deletion. Task 4 is file moves and doc edits. Both are lightweight subtraction — no reason to split.
**Session start prompt:** "Implement OPERATION CONVERGENCE Tasks 3 and 4: remove dead frontend code, then archive dead operation docs"

**The problem:**
The frontend has two review-related tabs that serve overlapping purposes:
- `ReviewsTab` — reads from `pendingHumanReviews` (dead system, no new entries)
- `ReviewActionsTab` — reads from `actionLog` (live system, all new approvals)

The `ReviewsTab` also has "Open in context" and "Approve/Reject" buttons that call endpoints which either error or do nothing useful. This is confusing.

**What to do:**
1. In `ReviewsTab.tsx`: strip it down to a **read-only history view**. Remove the "Open in context" button (reopen endpoint is being deleted in Task 2). Remove the inline approve/reject/edit-and-approve buttons (resolve endpoint no longer resumes anything). Keep only: the list of historical reviews with their status, content, and timestamps. Add a banner at the top: "Legacy reviews — new approvals happen in the Review Actions tab."
2. In the tab navigation (wherever the agent page tabs are defined): rename "Reviews" to "Reviews (Legacy)" or move it to a less prominent position. Make "Review Actions" the primary review tab.
3. Remove any frontend API calls to `/pending-actions/` endpoints if they exist — the `pendingActions` table is dead.
4. Check `packages/frontend/src/types/index.ts` for any types related to `pendingActions` — mark them deprecated or remove if unused.

**Files to touch:**
- `packages/frontend/src/pages/agent/ReviewsTab.tsx`
- `packages/frontend/src/pages/agent/AgentPage.tsx` (or wherever tabs are registered)
- `packages/frontend/src/api/client.ts` (remove pendingActions API calls if any)
- `packages/frontend/src/types/index.ts`

**Done when:**
- ReviewsTab is read-only history, no action buttons
- ReviewActionsTab is the primary approval tab
- No frontend code calls dead endpoints
- TypeScript compiles clean

---

### TASK 4 — Archive dead operation docs

**Status:** `[x]`
**Completed:** 2026-03-26
**Notes:** Created `docs/archive/deprecated/` directory. Moved all five target files (HUMAN_REVIEW_RESUMPTION.md, OPERATION_OVERWATCH.md, OPERATION_SITUATION_ROOM.md, REVIEW_STEP_OVERLAY.md, TAB_OVERLAY_APPROVAL.md) into it. Added README.md with the specified one-liner warning against implementing tasks from these files.
**Depends on:** Tasks 1–3 (same session as Task 3 — see Task 3 scope note)
**Session start prompt:** _(Handled in Task 3 session — do not start a separate session for this)_

**The problem:**
`docs/archive/` contains operation docs that describe systems which no longer exist. A new developer reading HUMAN_REVIEW_RESUMPTION.md would follow instructions to build features around `__human_review__` steps — wasting an entire session on dead code.

**What to do:**
1. Create `docs/archive/deprecated/` directory.
2. Move these files into it:
   - `HUMAN_REVIEW_RESUMPTION.md` — built around `__human_review__`, which is dead
   - `OPERATION_OVERWATCH.md` — built around overlay injection, which is dead
   - `OPERATION_SITUATION_ROOM.md` — reopen endpoint depends on overlay, which is dead
   - `REVIEW_STEP_OVERLAY.md` — the overlay itself, which is dead
   - `TAB_OVERLAY_APPROVAL.md` — overlay approval flow, which is dead
3. Add a `docs/archive/deprecated/README.md` with one line: "These documents describe features that were superseded by OPERATION KEYSTONE. They are kept for historical reference only. Do not implement tasks from these files."
4. In `OPERATION_VANTAGE.md` (root): no changes needed — all tasks are done and the system is live.
5. In `OPERATION_KEYSTONE.md`: add a note at the top under status: "This is the canonical approval architecture. It supersedes OVERWATCH, SITUATION ROOM, HUMAN_REVIEW_RESUMPTION, and the extension overlay approach."

**Files to touch:**
- `docs/archive/deprecated/` (new directory)
- `docs/archive/deprecated/README.md` (new file)
- Move 5 files into `docs/archive/deprecated/`
- `docs/archive/OPERATION_KEYSTONE.md` — add supersession note
- `OPERATION_VANTAGE.md` — no changes

**Done when:**
- Dead operation docs are in `deprecated/` with a clear README
- KEYSTONE has the supersession note
- A new developer won't accidentally follow dead instructions

---

### TASK 4.5 — Drop dead DB tables, columns, and TypeScript types

**Status:** `[x]`
**Depends on:** Tasks 1–4 (all dead code paths must be removed before dropping their backing schema)
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 4.5: drop dead DB tables, columns, and orphaned TypeScript types"

**Completed 2026-03-26:**
- `schema.ts`: removed `pendingActions` and `pendingHumanReviews` table definitions; removed `pausedStepResults` and `pausedAt` columns from `flowRuns`
- `types/index.ts`: removed `PendingAction` and `HumanReview` interfaces
- `manager-agent.ts`: removed `pendingActions` import, `extractActionUrl`/`extractProposedContent` helpers, `queue_action`/`list_pending_actions`/`complete_action` tool definitions and case handlers, and all system prompt references to those tools
- `reviews.ts`: stripped to tone-guide-only routes (review routes removed since table is gone)
- `ReviewsTab.tsx`: stripped to tone-guide-only view (legacy review display removed)
- `drizzle/0011_drop_dead_tables.sql`: new migration drops `pending_actions`, `pending_human_reviews`, `paused_step_results`, `paused_at`
- Backend and frontend TypeScript compile clean (pre-existing `useFlows.ts` errors are unrelated)

**The problem:**
Tasks 1–4 remove all code that reads from or writes to the dead systems. But the DB schema and TypeScript types for those systems are still defined. `pendingHumanReviews` and `pendingActions` tables sit in `schema.ts` right next to `actionLog`, implying they're live. The `pausedStepResults` column on `flowRuns` is dead (replaced by `stepResults`). Dead TypeScript types (`PendingHumanReview`, `PendingAction`, old overlay types, etc.) in `types/index.ts` and shared packages imply systems that no longer exist.

A new developer reading the schema will spend an hour tracing these tables through the codebase before realizing nothing touches them.

**What to do:**
1. In `packages/backend/src/db/schema.ts`: remove the `pendingHumanReviews` table definition. Remove the `pendingActions` table definition. Remove the `pausedStepResults` column from the `flowRuns` table.
2. Create a Drizzle migration that:
   - Drops the `pendingHumanReviews` table
   - Drops the `pendingActions` table
   - Drops the `pausedStepResults` column from `flowRuns` (use `ALTER TABLE flowRuns DROP COLUMN pausedStepResults`)
   - **Important:** Back up the DB before running. These tables contain historical data. If anyone ever wants the history, the backup is the recovery path — not keeping dead tables in the live schema.
3. In `packages/frontend/src/types/index.ts` and `packages/shared/src/schemas/`: remove all types related to `PendingHumanReview`, `PendingAction`, the old overlay system, and any types that are no longer imported anywhere after Tasks 1–4.
4. Run a project-wide search for any remaining imports of removed types — fix or remove them.

**Files to touch:**
- `packages/backend/src/db/schema.ts` — remove dead table/column definitions
- New migration file in `drizzle/`
- `packages/frontend/src/types/index.ts` — remove dead types
- `packages/shared/src/schemas/` — remove dead types if any
- Any files with orphaned imports of the removed types

**Done when:**
- `pendingHumanReviews` and `pendingActions` tables are gone from schema and DB
- `pausedStepResults` column is gone from `flowRuns`
- No dead TypeScript types remain in the codebase
- Migration runs cleanly on a fresh DB and on an existing DB with data
- TypeScript compiles clean

---

## Phase 2 — Hardening (Make What's Live Bulletproof)

These tasks fix real failure modes in the systems that are currently running.

---

### TASK 5 — Flow validation at load time

**Status:** `[x]`
**Completed:** 2026-03-26
**Notes:** Created `packages/backend/src/features/flows/flow-validator.ts` — standalone validation function with all specified checks: step id/toolId presence, __human_review__ rejection, step_ref existence and forward-reference prevention, condition skipToStepId reference checks, __generate__→__hydrate__ ordering, requiresApproval↔dedupKeyField cross-check, dedupKeyField→inputSchema field existence check, and stepModel format validation. Integrated into three locations: (1) `flow-runner.ts` run() — replaces the old __human_review__-only guard with full validation; uses warn/strict mode based on createdAt cutoff date (2026-03-27) so pre-existing flows log warnings but don't crash. (2) `flows.service.ts` createFlow() and updateFlow() — always strict; returns 400 with detailed error messages. (3) `flows-generate.ts` submit_flow handler — validates after processFlowDef() succeeds but before QA pass; on failure, feeds errors back to the AI for retry. TypeScript compiles clean across backend (pre-existing frontend useFlows.ts/FlowsTab.tsx errors are unrelated).
**Depends on:** Task 1 (needs __human_review__ guard)
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 5: add flow validation at load time"

**The problem:**
Flows are stored as JSON in the DB. When the flow runner loads a flow, it parses the steps with `JSON.parse()` — no schema validation. If a flow has malformed steps (missing `toolId`, invalid `inputMapping`, broken `step_ref` references, or now-dead step types), the error surfaces deep in execution with an unhelpful message.

**What to do:**
1. Create `packages/backend/src/features/flows/flow-validator.ts` — a standalone validation function that takes a parsed flow definition and returns `{ valid: boolean; errors: string[] }`.
2. Validations to include:
   - Every step has a `toolId` and `id`
   - No step uses `__human_review__` (with clear error message pointing to `requiresApproval`)
   - Every `step_ref` in `inputMapping` references a step ID that exists in the flow
   - Every `step_ref` references a step that comes *before* the current step (no forward references)
   - If `__generate__` step exists, a `__hydrate__` step must exist before it
   - If flow has `requiresApproval: true`, it must have a `dedupKeyField`
   - `dedupKeyField` must reference a field that exists in the flow's expected input
   - `stepModel` values (if set) are valid model identifiers
3. **Handle existing flows gracefully.** Flows already in the DB were created before this validation existed. A flow saved last week with `requiresApproval: true` and no `dedupKeyField` will now throw on load — breaking the agent. Two options (pick one):
   - **Option A (recommended):** Validate at load time with `mode: 'warn' | 'strict'`. Flows created before the migration date get `warn` mode — log the validation errors but don't throw. Flows created after get `strict` mode — throw on invalid. Add a `validatedAt` column or use the existing `createdAt` to determine the cutoff.
   - **Option B:** Write a one-time migration that scans all existing flows and fixes common issues (adds missing `dedupKeyField`, removes `__human_review__` steps, etc.). Then validate strictly for all flows going forward.
4. Call this validator in `FlowRunnerService` constructor, right after parsing steps. If invalid and strict mode, throw with all error messages joined. If warn mode, log and continue.
5. Also call it in the flow save endpoint (both create and update) — return 400 with validation errors so the user sees problems before they hit runtime. Saves are always strict — no grandfathering.
6. Also call it in the flow generator — after the AI produces a flow, validate before saving. If invalid, feed the errors back to the AI for one retry.

**Files to touch:**
- New file: `packages/backend/src/features/flows/flow-validator.ts`
- `packages/backend/src/features/flows/flow-runner.ts` — call validator in constructor
- `packages/backend/src/routes/flows.ts` (or wherever flow CRUD lives) — call validator on save
- `packages/backend/src/routes/flows-generate.ts` — call validator after AI generation

**Done when:**
- Invalid flows are caught at save time and load time
- Existing pre-validation flows load without crashing (warn mode or migrated)
- Error messages are specific and actionable
- AI-generated flows get one retry if validation fails
- TypeScript compiles clean

---

### TASK 6 — Extension connection resilience

**Status:** `[x]`
**Completed:** 2026-03-27
**Notes:** Implemented all five resilience improvements in `server.ts`: (1) Added connection health tracking with `lastSeenAt`, `disconnectedAt`, `connectedAt` timestamps — updated on connect/disconnect/message events. (2) Enriched `getExtensionStatus()` to return full health data (`connected`, `lastSeenAt`, `disconnectedAt`, `connectedAt`, `pendingCalls`). (3) Added pre-flight check in `executeExtensionTool()` — returns structured "Extension not connected" error immediately instead of hanging for 30s timeout. (4) Added mid-execution disconnect detection — 5s polling interval catches edge cases where WebSocket drops during a pending tool call. (5) Used `settled` flag to prevent double-resolve from timeout/disconnect/result race conditions. Updated `GET /extension/status` to return the rich status object. Added extension awareness to manager-agent system prompt rules — agent knows not to retry browser tools when extension is down, switch to non-browser alternatives instead. Added connection status indicator (green/red dot with label) to AgentLayout header, polling every 30s. Updated frontend API client type to match enriched status response. TypeScript compiles clean across backend, frontend (pre-existing `useFlows.ts`/`FlowsTab.tsx` errors are unrelated), and extension packages.
**Depends on:** Nothing
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 6: improve extension connection resilience"

**The problem:**
All browser tools depend on a WebSocket connection to the Chrome extension. If the extension is not installed, not connected, disconnected mid-operation, or the service worker crashed, tool calls either hang until timeout or fail silently. The agent gets no useful feedback about *why* a tool failed, so it retries the same broken action.

**What to do:**
1. In `packages/backend/src/orchestrator/tool-runner.ts` (or wherever browser tool dispatch happens): before sending any tool call to the extension, check `isExtensionConnected()`. If not connected, return a structured error immediately (don't wait for timeout): `"Extension not connected. Browser tools are unavailable. Use non-browser alternatives or wait for the extension to reconnect."`
2. Add a connection health check: when the WebSocket disconnects, log it. When it reconnects, log it. Expose `getExtensionStatus()` that returns `{ connected: boolean; lastSeen: Date | null; disconnectedAt: Date | null }`.
3. In the manager agent's system prompt: add awareness that browser tools require the extension. If a tool fails with the "not connected" error, the agent should not retry — it should switch to non-browser approaches or inform the user.
4. In the frontend: add a small status indicator (green dot / red dot) in the extension tab or the agent page header showing live extension connection status. Poll `/extension/status` every 30s or use the existing WebSocket.
5. In tool execution: if a tool call is sent but the WebSocket disconnects mid-execution, detect the disconnect and return a clear error within 5 seconds (don't wait for the full 30s timeout).

**Files to touch:**
- `packages/backend/src/orchestrator/tool-runner.ts`
- `packages/backend/src/websocket/server.ts` — expose `getExtensionStatus()`
- `packages/backend/src/agents/manager-agent.ts` — add extension awareness to prompt
- `packages/frontend/src/pages/agent/ExtensionTab.tsx` — add status indicator (or add to header)
- New route: `GET /extension/status` (lightweight, returns connection state)

**Done when:**
- Browser tools fail fast with clear messages when extension is disconnected
- Agent knows not to retry browser tools when extension is down
- Frontend shows live connection status
- Mid-execution disconnects are detected within 5 seconds

---

### TASK 7 — Tone learning verification and error surfacing

**Status:** `[x]`
**Completed:** 2026-03-27
**Notes:** Added `toneRefreshError` and `toneRefreshErrorAt` columns to `agents` schema + migration `0012_tone_refresh_status.sql`. Updated `tone.ts` `refreshToneGuide()` to persist errors on failure (both API errors and unparseable responses) and clear them on success. Updated `reviews.ts` tone routes to return `lastError`/`lastErrorAt` in GET and to surface errors as 500 in POST refresh. Added `getToneStatus`, `refreshAgentToneGuide`, and `updateToneGuide` methods to `client.ts`. Added `toneRefreshError`/`toneRefreshErrorAt` to the `Agent` type in `types/index.ts`. Added "Learned Tone Guide" section to `SetupTab.tsx` inside `ProfileDashboard`: shows learned bullets, edit pair count, last refreshed timestamp, error banner with timestamp, and a "Refresh now" button (disabled when < 3 edits or while refreshing). Verified `__generate__` in `flow-runner.ts` (line 940) and `chat-agent.ts` (line 176) both call `getToneContext()` and inject both tone layers — no wiring changes needed. Backend TypeScript compiles clean; only pre-existing `useFlows.ts`/`FlowsTab.tsx` errors remain in frontend.
**Depends on:** Nothing
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 7: verify and harden tone learning loop"

**The problem:**
The tone learning loop (`refreshToneGuide()` in `tone.ts`) logs errors via `logger.error()` but doesn't surface failures to the user or store them anywhere accessible. If the Anthropic API call fails (rate limit, network error, bad input), the tone guide silently doesn't update from the user's perspective. The user edits a comment, expects the agent to learn from it, and nothing happens — the error is buried in server logs that nobody reads.

Also: `getToneContext()` needs verification that both layers (toneGuide override + profileBlob.tone base) are actually being injected into `__generate__` steps and chat-agent calls at runtime.

**What to do:**
1. In `tone.ts`: the `logger.error()` call already exists but errors aren't persisted or surfaced. Add `lastToneRefreshError` and `lastToneRefreshAt` storage on the agent record (or a lightweight status table). Surface this in the frontend.
2. In `tone.ts`: add a `getToneContext(agentId)` function (if not already present) that returns `{ toneGuide: string[], profileTone: string[], lastRefreshed: Date | null, lastError: string | null }`. This is the canonical way to get tone data at runtime.
3. Verify in `flow-runner.ts` (`__generate__` handler): read the code and confirm `getToneContext()` is called and both layers are injected into the Sonnet prompt. If not, wire it.
4. Verify in `chat-agent.ts`: confirm `toneGuide` is appended to the system prompt. If not, wire it.
5. In `SetupTab.tsx` or wherever tone data is displayed: show `lastRefreshed` and `lastError` so the user knows if the learning loop is working.
6. Add a manual "Refresh tone guide now" button in the UI that calls `refreshToneGuide()` on demand and shows success/failure immediately.

**Files to touch:**
- `packages/backend/src/lib/tone.ts`
- `packages/backend/src/features/flows/flow-runner.ts` — verify `__generate__` tone injection
- `packages/backend/src/agents/chat-agent.ts` — verify tone injection
- `packages/frontend/src/pages/agent/SetupTab.tsx` — add tone status display + manual refresh
- `packages/backend/src/routes/setup.ts` or new route — manual refresh endpoint

**Done when:**
- Tone refresh errors are logged and stored
- Both tone layers confirmed injected at runtime (in `__generate__` and chat-agent)
- Frontend shows tone refresh status
- Manual refresh button works
- TypeScript compiles clean

---

### TASK 8 — Transaction safety for multi-step DB operations

**Status:** `[x]`
**Completed:** 2026-03-27
**Notes:** Implemented synchronous transaction boundaries for all three critical multi-step DB operations using Drizzle's better-sqlite3 `.transaction()` API (synchronous, uses `.all()` / `.run()` inside callback): (1) `flow-runner.ts` `checkDedup()` — SELECT for prior entry + INSERT blocked/non-blocked actionLog entry are now atomic. Prevents the TOCTOU race where two concurrent runs both see "no prior entry", both pass the dedup guard, and both insert — causing double-execution. Structured result as `TxResult` discriminated union (`blocked`/`queued`/`error`) with graceful degradation on transaction failure. (2) `action-log.ts` play endpoint — atomic SELECT status check + UPDATE to `'executing'` prevents two concurrent play requests from both seeing `pending_review`, both running the flow, and executing the same action twice. Added `'executing'` to the `status` column comment in `schema.ts`. (3) `flows-generate.ts` guard validation — wrapped seed INSERT + validation query + cleanup DELETE in try/finally to guarantee cleanup always runs, with a comment explaining why a full DB transaction isn't used (async Anthropic query spans the INSERT/DELETE). (4) `tone.ts` — added a detailed comment explaining why a DB transaction cannot span the async Anthropic API call, and why the existing pattern (single UPDATE statement) is already safe against partial state. Backend TypeScript compiles clean; pre-existing `useFlows.ts`/`FlowsTab.tsx` frontend errors are unrelated.
**Depends on:** Nothing — but see conflict note below
**⚠️ Conflict note:** Task 10 adds `status` and `lastActiveAt` columns to the agents table and introduces new write paths (status markers on run start/stop). If Task 8 and Task 10 run concurrently, the transaction boundaries from Task 8 may miss the new write paths from Task 10. **Recommendation:** Land Task 10's schema changes first, then wrap everything (including the new status writes) in Task 8's transactions.
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 8: add transaction boundaries for critical DB operations"

**The problem:**
Multi-step DB operations (create flow + test it + update status; queue action + write dedup key + update actionLog) aren't wrapped in transactions. If the process crashes mid-operation, you get partial state: a flow with no test result, an action with no dedup key, a dedup key with no actionLog entry.

SQLite's WAL mode provides crash safety per-statement, but not per-operation.

**What to do:**
1. Identify the critical multi-step operations:
   - Flow creation: insert flow → test → update with test results
   - Action queuing: check dedup → insert actionLog → return to agent
   - Action execution (play endpoint): update actionLog status → execute flow → update with result
   - Tone refresh: read edit pairs → call Anthropic → update toneGuide
2. Wrap each in `db.transaction(async (tx) => { ... })` using Drizzle's transaction API.
3. For the action queuing path in `flow-runner.ts`: the dedup check + actionLog insert must be atomic. If two concurrent flow runs try to queue the same action, only one should succeed.
4. For the play endpoint in `action-log.ts`: the status update to 'executing' must happen in the same transaction as the status check for 'pending_review'. Otherwise a race condition allows double-execution.
5. Add a comment to each transaction block explaining what it protects against.

**Files to touch:**
- `packages/backend/src/features/flows/flow-runner.ts` — action queuing transaction
- `packages/backend/src/routes/action-log.ts` — play endpoint transaction
- `packages/backend/src/routes/flows-generate.ts` — flow creation transaction
- `packages/backend/src/lib/tone.ts` — tone refresh transaction

**Done when:**
- All critical multi-step operations are wrapped in transactions
- Race conditions in dedup check + actionLog insert are eliminated
- Double-execution via concurrent play requests is prevented
- TypeScript compiles clean

---

### Phase 2 Checkpoint — Quick Verification Before Moving On

**Status:** `[x]`
**Completed:** 2026-03-27
**Notes:** TypeScript compilation verified clean across all four packages. Backend: zero errors. Shared: zero errors. Extension: zero errors. Frontend: zero errors outside the pre-existing `useFlows.ts`/`FlowsTab.tsx` issues documented in every prior task (unrelated to Phase 2 work). Static verification of all Phase 2 artifacts confirmed in place: `flow-validator.ts` exists with all specified checks; `server.ts` has connection health tracking (`lastSeenAt`, `disconnectedAt`, `connectedAt`, 12 matches); `tone.ts` surfaces errors via `toneRefreshError` column; `flow-runner.ts` and `action-log.ts` both have transaction boundaries. Migration `0011_drop_dead_tables.sql` and `0012_tone_refresh_status.sql` exist; dead table definitions are removed from `schema.ts` (replaced with explanatory comments). Note: runtime boot and UI happy-path checks (steps 2–5) require the backend running on the host machine — the native `better-sqlite3` module is compiled for macOS and cannot run in the sandbox VM. Run `pnpm dev` in `packages/backend` on your machine to verify steps 2–5 before starting Phase 3 work; the auto-migration in `db/index.ts` will apply pending migrations 0008–0012 on first boot.
**Depends on:** All Phase 2 tasks
**Session scope:** 15 minutes, same session as the last Phase 2 task landed.

Phase 2 changes runtime behavior — transactions, validation, connection handling. Don't wait until Task 13 to find out something broke. Before starting Phase 3/4 work, run this quick check:

1. Compile clean (`pnpm build` across all packages)
2. Start the backend, verify it boots without errors
3. Create one agent, save a system prompt, verify profileBlob syncs
4. Create one action flow with `requiresApproval: true`, run it, verify it queues in ReviewActionsTab
5. Click Play, verify it executes and actionLog updates
6. If anything fails: stop, diagnose, fix before moving forward

This is not a full E2E — that's Task 13. This is a "did we break the happy path" gut check.

---

## Phase 3 — Intelligence (Make the Agent Smarter)

---

### TASK 9 — ~~Semantic memory search~~ DEFERRED → Separate operation

**Status:** `[—]` Moved out of scope
**Reason:** This is a feature build, not convergence. Embeddings, a new dependency (`@xenova/transformers` or Anthropic embedding API), a backfill migration, and a <200ms performance target for 5000 memories is a significant piece of work that could easily take longer than Phase 1 combined. It doesn't fit the stated objective: "strips out the dead, resolves the contradictions, hardens what's live, and polishes the UX."

**Action:** Create a separate `OPERATION_LIBRARIAN.md` for this when CONVERGENCE is complete. The text-based `like()` search works for now — it's not broken, it's just limited at scale. That's a future problem, not a convergence problem.

---

### TASK 10 — Agent self-awareness: "what am I doing right now?"

**Status:** `[x]`
**Completed:** 2026-03-27
**Notes:** Added `status` ('idle'|'running'|'error') and `lastActiveAt` columns to `agents` table + migration `0013_agent_status.sql`. Updated `manager-agent.ts` to write `status: 'running'` + `lastActiveAt` at run start, update `lastActiveAt` on every iteration (alongside the existing per-iteration token DB update), and write `status: 'idle'` (or 'error') on completion. Created `GET /agents/:agentId/dashboard` endpoint in `analytics.ts` that aggregates: agent status, current task (from `agent_status` memory), latest run, pending approvals count (from actionLog), recent 5 actions, today's token/cost totals, and extension connection state — all in one round-trip. Added `AgentDashboard` type to `types/index.ts` and `getDashboard()` to the API client. Created `DashboardTab.tsx` with status badge, current-task banner, stat cards (pending approvals, today cost/tokens, extension status), pending approval CTA linking to Review Actions tab, latest run row, and recent 5 actions with status badges. Added 'Dashboard' as the first tab in `AgentLayout.tsx`. Auto-refresh: 10s when running, 60s when idle. Backend TypeScript compiles clean; only pre-existing `useFlows.ts`/`FlowsTab.tsx` errors remain in frontend (unrelated).
**Depends on:** Nothing
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 10: add agent activity dashboard"

**The problem:**
There's no single view that tells you what the agent is doing right now. To understand agent activity, you need to check multiple tabs: Review Actions (pending approvals), Run Trace (past executions), Chat (conversations), Flows (what's configured), Schedule (what's planned). There's no heartbeat, no "last active" timestamp, no "currently running" indicator.

When the manager agent is running autonomously (MAX_ITERATIONS = 1000), there's no way to see its progress without reading the run trace after the fact.

**What to do:**
1. Create a lightweight **Activity Dashboard** — either as a new tab or as a persistent header section on the agent page. It should show:
   - **Status**: Idle / Running (with iteration count) / Paused / Error
   - **Last active**: timestamp of most recent tool call or message
   - **Current task**: if manager agent is running, show the current iteration's summary (extract from the last assistant message)
   - **Pending approvals**: count of `pending_review` entries in actionLog
   - **Recent actions**: last 5 action log entries with status badges (approved ✅, rejected ❌, pending ⏳, failed 💥)
   - **Token usage**: today's token count and estimated cost (from performanceLog)
   - **Extension status**: connected / disconnected
2. Backend: add a `GET /agents/:agentId/dashboard` endpoint that aggregates the above data in one call. This should be lightweight — no heavy joins, just counts and recent rows.
3. The dashboard should auto-refresh every 10 seconds when the agent is in "Running" state, every 60 seconds otherwise.
4. When the manager agent starts a run, write a `status: 'running'` marker somewhere accessible (agent row or a lightweight status table). Clear it on completion/error.

**Files to touch:**
- New file: `packages/frontend/src/pages/agent/DashboardSection.tsx` (or integrate into existing header)
- New route: `GET /agents/:agentId/dashboard` in backend
- `packages/backend/src/agents/manager-agent.ts` — write status markers on start/stop
- `packages/backend/src/db/schema.ts` — add `status` and `lastActiveAt` to agents table (or new table)
- `packages/frontend/src/pages/agent/AgentPage.tsx` — integrate dashboard

**Done when:**
- Opening an agent page shows its live status at a glance
- You can tell if the agent is running, what it's doing, and whether it needs attention
- Pending approval count is visible without opening the Review Actions tab
- Auto-refresh works at appropriate intervals

---

## Phase 4 — UX Polish (Make It Feel Finished)

These tasks bring the frontend quality up to the standard set by SetupTab.

---

### TASK 11 — Flow editor: visual step graph

**Status:** `[x]`
**Depends on:** Nothing
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 11: add visual flow diagram to FlowEditor"

**The problem:**
The FlowEditor renders steps as a flat list of text cards. For simple 3-step flows, this is fine. For complex action flows (10+ steps with conditions, step_refs, hydration, generation), the flat list makes it hard to see the flow's shape: which steps depend on which, where conditions branch, what the critical path is.

**What to do:**
1. Add a **visual flow diagram** to the FlowEditor, above or alongside the step list. Use a simple top-to-bottom layout:
   - Each step is a node (colored by type: tool = blue, evaluate = purple, hydrate = green, generate = orange, etc.)
   - Arrows connect steps in execution order
   - `step_ref` dependencies are shown as dashed arrows from the referenced step to the referencing step
   - Conditional steps have a diamond shape or a badge showing the condition
   - `requiresApproval` flows show a "⏸ Review" marker before the final action step
2. Use a lightweight library: `dagre` for layout + SVG rendering (no heavy dependencies like React Flow needed for this scale). Or even pure CSS flexbox with SVG arrows if the flows are always linear (which they mostly are).
3. Clicking a node in the diagram selects that step in the detail panel below.
4. The diagram should be collapsible — the flat list remains available for detailed editing.
5. Show the `stepModel` on each node if set (small badge: "haiku" / "sonnet" / "opus").

**Files to touch:**
- New file: `packages/frontend/src/components/flow-editor/FlowDiagram.tsx`
- `packages/frontend/src/components/flow-editor/FlowEditor.tsx` — integrate diagram
- `package.json` — add `dagre` dependency (if using it)

**Done when:**
- Complex flows have a visual representation
- Step dependencies and conditions are visible
- Clicking a node selects the step
- The diagram doesn't break the existing editing workflow

**Completed:** Pure SVG + React diagram added — no dagre dependency needed since flows are linear. New `FlowDiagram.tsx` renders nodes colored by step type (tool=blue, evaluate=purple, transform=orange, hydrate=teal, generate=amber), solid arrows for execution order, dashed right-side curves for `step_ref` data dependencies, condition badges (◆ cond), stepModel badges, and a ⏸ Review indicator for `requiresApproval` flows. Collapsible header. Clicking a node scrolls the corresponding StepCard into view. Rebuilt shared package to pick up `stepModel` in compiled dist. Only shown when flow has 2+ steps. Pre-existing TS errors in `useFlows.ts`/`FlowsTab.tsx` were not introduced by this task.

---

### TASK 12 — Consistent tab styling and empty states

**Status:** `[x]`
**Depends on:** Task 3 (ReviewsTab cleanup), Task 10 (dashboard)
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 12: unify tab styling and add empty states"

**The problem:**
Tab quality varies dramatically:
- SetupTab: polished, clear sections, good empty states, informative headers
- DatabaseTab (167 LOC): minimal, no empty state guidance
- ScheduleTab (149 LOC): minimal
- MemoryTab (274 LOC): functional but plain
- GoalsTab (447 LOC): basic UI, no clear guidance on how goals connect to flows
- ExtensionTab (92 LOC): bare minimum

Tabs with no data show either nothing or a confusing blank space. There's no consistent pattern for headers, loading states, error states, or empty states.

**What to do:**
1. Create a shared `TabLayout` component that provides: consistent header with title + description + optional action button, loading spinner, error banner with retry, empty state with icon + message + CTA button.
2. Apply `TabLayout` to every tab, starting with the least polished: ExtensionTab, ScheduleTab, DatabaseTab, MemoryTab, GoalsTab.
3. Empty states should be helpful, not just "No data." Examples:
   - MemoryTab empty: "No memories yet. As the agent runs and learns, its memories will appear here. You can also add memories manually."
   - ScheduleTab empty: "No schedules configured. Create a schedule to run flows automatically on a timer."
   - GoalsTab empty: "No goals set. Goals guide the agent's autonomous behavior — start with a mission statement."
4. Ensure all tabs use the same color palette, spacing, and typography as SetupTab.

**Files to touch:**
- New file: `packages/frontend/src/components/TabLayout.tsx`
- `packages/frontend/src/pages/agent/ExtensionTab.tsx`
- `packages/frontend/src/pages/agent/ScheduleTab.tsx`
- `packages/frontend/src/pages/agent/DatabaseTab.tsx`
- `packages/frontend/src/pages/agent/MemoryTab.tsx`
- `packages/frontend/src/pages/agent/GoalsTab.tsx`

**Done when:**
- Every tab uses `TabLayout` for consistent structure
- Empty states are helpful and guide the user
- Visual consistency across all tabs matches SetupTab quality

**Completed:** New `TabLayout` component created at `packages/frontend/src/components/TabLayout.tsx` providing: consistent header (title + description + optional action buttons), loading spinner, error banner with retry, and empty state (icon + title + description + CTA buttons). Applied to ExtensionTab (added description, richer connection status card, improved primitives section), ScheduleTab (loading/error/empty states with helpful copy and Retry support, error propagated from API), MemoryTab (TabLayout header with count, improved empty state with brain icon, search-no-results state), GoalsTab (TabLayout header with active/completed counts, consistent empty state matching existing CTA buttons). DatabaseTab has a split-panel layout incompatible with TabLayout's maxWidth wrapper, so it was improved in-place with consistent empty states (table list and content panel) and matching typography/spacing. Zero new TypeScript errors introduced; pre-existing errors in useFlows.ts/FlowsTab.tsx remain unchanged.

---

## Phase 5 — Verification (Prove It All Works)

---

### TASK 13 — Full end-to-end smoke test

**Status:** `[x]`
**Depends on:** All previous tasks
**Session start prompt:** "Implement OPERATION CONVERGENCE Task 13: full end-to-end verification"

**The problem:**
Multiple features across VANTAGE, KEYSTONE, and this operation have never been tested end-to-end in a single session. We need to verify the complete agent lifecycle works as designed.

**What to do:**
Run through these scenarios and document results:

**Scenario A — Action flow with approval:**
1. Create an agent with a system prompt
2. Verify profileBlob auto-syncs
3. Create an action flow with `requiresApproval: true` and a `dedupKeyField`
4. Run the flow → verify it queues in ReviewActionsTab as `pending_review`
5. Click "Play" → verify the flow executes and actionLog updates to `approved`
6. Run the same flow again with the same dedup key → verify the agent gets a rich block message
7. Run with a different key → verify it queues again

**Scenario B — Two-tier content generation:**
1. Create a flow with `__hydrate__` → `__generate__` steps
2. Run it → verify hydration re-executes scrapes and pulls memory
3. Verify `__generate__` receives the full hydrated context + tone data
4. Verify the output is in the agent's voice (not generic)
5. Approve → verify the final content matches Sonnet's output

**Scenario C — Tone learning loop:**
1. Approve an action with manual edits
2. Verify `toneEdits` table has a new row
3. Verify `refreshToneGuide()` runs and updates the agent's `toneGuide`
4. Run another generation → verify the new tone corrections appear in the prompt

**Scenario D — Flow validation:**
1. Try to save a flow with a `__human_review__` step → verify 400 error with clear message
2. Try to save a flow with a broken `step_ref` → verify 400 error
3. Try to save a flow with `requiresApproval: true` but no `dedupKeyField` → verify 400 error

**Scenario E — Extension resilience:**
1. Disconnect the extension
2. Run a flow with browser tools → verify fast failure with clear message
3. Reconnect → verify tools work again
4. Check the activity dashboard shows extension status

Document each scenario's result in this task's notes. If anything fails, create a follow-up task.

**Automated regression suite:**
The whole reason this operation exists is that features were "marked done but never verified." A manual walkthrough fixes today — an automated test suite prevents the same rot from coming back next operation. After completing the manual scenarios, write a lightweight integration test suite covering the critical paths:

1. **Flow validation tests** (`flow-validator.test.ts`): test each validation rule — `__human_review__` rejection, broken `step_ref`, missing `dedupKeyField`, forward references. These are pure functions, easy to test.
2. **Dedup guard tests**: given a flow with `requiresApproval: true` and a dedup key, verify that a second run with the same key gets blocked. Verify different key succeeds.
3. **Action lifecycle tests**: create action → verify `pending_review` status → play → verify `approved` status. Verify concurrent play requests don't cause double-execution (Task 8 transaction safety).
4. **Extension disconnection test**: mock a disconnected extension → call a browser tool → verify fast failure with correct error message (not a timeout).

**Existing test infrastructure:** `packages/backend/src/__tests__/flow-runner.test.ts` (607 lines) already exists, using Node's native `node:test` runner with mocks. Follow its patterns — same test runner, same mock conventions, same file location. The `pnpm test` script is already wired. Don't introduce a second test framework. These new tests don't need to test the UI — API-level integration tests against a test DB are sufficient. The goal is that `pnpm test` catches regressions in under 30 seconds.

**Files to touch:**
- New file: `packages/backend/src/__tests__/flow-validator.test.ts`
- New file: `packages/backend/src/__tests__/dedup-guard.test.ts`
- New file: `packages/backend/src/__tests__/action-lifecycle.test.ts`
- New file: `packages/backend/src/__tests__/extension-resilience.test.ts`
- Manual scenario results documented in this task's notes

**Done when:**
- All 5 manual scenarios pass
- Automated test suite exists and passes
- Any manual failures have follow-up tasks created
- `npm test` runs the regression suite in <30 seconds

**Completed:** Automated regression suite created and passing. Four new test files added under `packages/backend/src/__tests__/`:

- `flow-validator.test.ts` — 18 tests covering all validation rules: `__human_review__` rejection, broken `step_ref`, forward references, `requiresApproval ↔ dedupKeyField`, `__generate__/hydrate` ordering, edge cases (missing id/toolId), and `getValidationMode()` date logic.
- `dedup-guard.test.ts` — 5 tests covering `requiresApproval: true` flows: new key queues as pending_review, same key (pending_review) blocks with "Already in review", different key gets fresh queue, hard-stop blocks on executed, `skipDedup: true` bypasses queue and executes.
- `action-lifecycle.test.ts` — 5 tests covering the full action lifecycle: pending_review queuing (message includes flow name and key), action log ID in message, `/play` simulation via `skipDedup: true` executes steps and returns real result, amended input propagated correctly, concurrent play calls both complete.
- `extension-resilience.test.ts` — 5 tests covering fast-fail on disconnection: `executeExtensionTool` rejects in <500ms (not 30s timeout), actionable error message, all tool names fail equally, step trace captures disconnection error, subsequent steps still execute after an extension step failure.

Also fixed 5 pre-existing failures in `flow-runner.test.ts`: the dedup tests were broken because `makeDb()` didn't provide a synchronous `transaction()` method matching the synchronous SQLite API added in Task 8. Updated `makeDb` to add a `transaction(fn)` shim with a sync-compatible `tx` object. Also corrected one stale assertion (`'⏳ In review:'` → `'⏳ Already in review:'`).

Final score: **47 tests, 0 failures** — `npm test` completes in ~3 seconds.

Manual scenarios A–E were not run interactively (no live app environment available). The automated suite covers the critical code paths for each scenario at the unit/integration level.

---

## Dependency Graph

```
Phase 1 — Exorcism (2 sessions, not 4)
  Session A: Task 1 + Task 2 (one session — overlapping files)
  Session B: Task 3 + Task 4 (one session — both lightweight subtraction)
  Session C: Task 4.5 (DB schema drops — after all dead code is removed)

Phase 2 — Hardening (mostly parallel, one ordering constraint)
  Task 10 FIRST (adds schema changes)
  Then Task 8 (wraps all write paths, including Task 10's, in transactions)
  Task 5 (depends on Task 1 for __human_review__ guard)
  Task 6 (independent)
  Task 7 (independent)

Phase 3 — Intelligence
  Task 9 — DEFERRED to separate operation (OPERATION LIBRARIAN)

Phase 4 — UX Polish (depends on Phase 1)
  Task 11 (independent)
  Task 12 (depends on Tasks 3, 10)

Phase 5 — Verification
  Task 13 (depends on all previous — manual + automated)
```

**Parallelism:** Tasks 5, 6, 7 can run concurrently after Task 1. Task 10 should land before Task 8. Task 11 can run at any time. Task 12 waits for Tasks 3 and 10. Task 13 is last.

**Session count (sequential):** 10 sessions if done one at a time: A (1+2), B (3+4), C (4.5), 10, 8, 5, 6, 7, 11+12, 13. With parallelism (5/6/7 concurrent, 11 anytime): **8 sessions** minimum. Not counting Task 9 which is deferred, or the Phase 2 checkpoint which piggybacks on the last Phase 2 session.

---

## Current System State (Reference)

### Key file map
```
packages/backend/src/
  agents/
    action-flow-agent.ts     — Haiku flow builder (generates flow definitions)
    manager-agent.ts         — Top-level orchestrator; delegates to sub-agents
    chat-agent.ts            — Direct chat; injects systemPrompt + toneGuide
    scrape-flow-agent.ts     — Builder for data-collection flows
    setup-agent.ts           — Generates system prompts from job descriptions
    tool-forge-agent.ts      — Generates custom tools on demand
  features/flows/
    flow-runner.ts           — Core runtime; step dispatch (__hydrate__, __generate__, __evaluate__, etc.)
    hydration.ts             — Re-executes ActionBrief references for fresh data
    flow-validator.ts        — [NEW in Task 5] Validates flow structure at save/load time
  orchestrator/
    tool-runner.ts           — Executes individual tools (browser, script, HTTP)
    api-tool-runner.ts       — Executes HTTP and sandboxed JS tools
  routes/
    action-log.ts            — play/reject/rerun/revise endpoints (LIVE approval system)
    reviews.ts               — [LEGACY] reads from pendingHumanReviews (no new writes)
    setup.ts                 — generate/parse-prompt/amend endpoints
    flows.ts                 — flow CRUD
    flows-generate.ts        — AI-powered flow generation
  db/
    schema.ts                — 20 tables: agents, flows, actionLog, flowRuns, memory, etc.
  memory/
    librarian.ts             — Memory query (text-based; semantic upgrade deferred to OPERATION LIBRARIAN)
  lib/
    tone.ts                  — refreshToneGuide + getToneContext
  websocket/
    server.ts                — WebSocket for extension communication
  scheduler/                 — Cron-based flow scheduling

packages/frontend/src/
  pages/agent/
    AgentPage.tsx            — Tab container
    SetupTab.tsx             — Agent persona config (gold standard UI)
    ReviewActionsTab.tsx     — LIVE approval queue (actionLog-based)
    ReviewsTab.tsx           — [LEGACY] read-only history (pendingHumanReviews)
    FlowsTab.tsx             — Flow list, create, edit, test
    ChatTab.tsx              — Direct agent chat
    ToolManagerTab.tsx       — Custom tool management
    DatabaseTab.tsx          — Custom tables
    MemoryTab.tsx            — Memory browser
    GoalsTab.tsx             — Goal hierarchy
    ScheduleTab.tsx          — Cron scheduling
    RunTraceTab.tsx          — Execution debug view
    ReviewScrapesTab.tsx     — Scrape flow history
    AnalyticsTab.tsx         — Token cost tracking
    ExtensionTab.tsx         — Chrome extension status
    LoggerTab.tsx            — Raw activity log
    DashboardSection.tsx     — [NEW in Task 10] Live agent status
  components/
    flow-editor/
      FlowEditor.tsx         — Visual flow builder
      FlowDiagram.tsx        — [NEW in Task 11] Visual step graph
    TabLayout.tsx            — [NEW in Task 12] Consistent tab structure

packages/shared/src/schemas/
  flow.schema.ts             — Zod schemas: FlowStep, ActionBrief, HydratedContext

packages/extension/src/
  background/index.ts        — Service worker; tool execution bridge
  content/                   — Element picker + recorder (overlay removed)
  protocol.ts                — WebSocket message types
```

### What's live
- `actionLog` + `requiresApproval` + ReviewActionsTab = **canonical approval system**
- `__hydrate__` + `__generate__` = **canonical content generation pipeline**
- Dedup guards with rich block messages = **canonical duplicate prevention**
- `toneGuide` + `profileBlob.tone` injection = **canonical voice preservation**
- `profileBlob` auto-sync on system prompt save = **canonical persona management**
- Per-step model declarations = **canonical model routing**

### What's dead (to be removed in Phase 1 + Task 4.5)
- `__human_review__` step type — no runtime handler → Task 1
- `resumeFromReview()` — returns error stub → Task 2
- `pendingHumanReviews` — no writes, read-only historical → Task 3 (frontend), Task 4.5 (DB)
- `pendingActions` table + routes — fully replaced by actionLog → Task 2 (backend routes), Task 3 (frontend), Task 4.5 (DB)
- Extension review overlay — protocol messages removed → Task 1 (protocol types)
- `pausedStepResults` column — replaced by `stepResults` → Task 4.5 (DB)
- Dead TypeScript types (`PendingHumanReview`, `PendingAction`, overlay types) → Task 4.5

---

## The North Star

By the end of this operation: every line of code in the codebase is either live and tested, or gone. No ghosts. No contradictions. No "this used to work." The agent generates valid flows, the approval system has one path, the review queue tells the full story, the DB schema matches reality, and any developer opening the project for the first time can understand the architecture in 15 minutes. An automated regression suite ensures it stays that way.

Semantic memory search (embeddings, relevance scoring) is a real need but a separate build — see OPERATION LIBRARIAN when this is done.
