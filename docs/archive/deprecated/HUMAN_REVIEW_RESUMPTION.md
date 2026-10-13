# Human Review → Flow Resumption

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

When a flow hits `__human_review__`, it should pause, show the draft to the user, and resume automatically when approved. Today it pauses but never resumes — approving in the Reviews tab does nothing beyond updating a DB row.

**Chosen design:** Human reviews the draft *before* any browser tab opens. On approval the flow resumes, opens the tab, fills the form with `finalContent` (possibly edited by the human), and submits.

---

## Group 1 — Backend wiring
*Tasks 1–4 must be done in order. Each builds on the previous.*

### Task 1 — DB: Add pause state columns to `flow_runs`
**Files:** `packages/backend/src/db/schema.ts`, new migration in `drizzle/`
**Done when:** `flow_runs` table has `paused_step_results` (text) and `paused_at` (text) columns. Migration file exists and has been applied. Server starts cleanly.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Added `pausedStepResults` and `pausedAt` columns to `flowRuns` in `schema.ts`. Migration file created at `drizzle/0007_add_flow_run_pause_state.sql`. Migration applied successfully.

---

### Task 2 — FlowRunner: save state on pause instead of discarding it
**Files:** `packages/backend/src/features/flows/flow-runner.ts`
**Done when:** When a flow hits `__human_review__`, the current `stepResults` are serialized and written to `flow_runs.paused_step_results` before `finalize()` is called. The flow still terminates normally from the caller's perspective.
**Depends on:** Task 1
**Status:** `[x]`
**Notes:** Extended `FinalizeResult` type with `pausedStepResults` and `pausedAt`. The `__human_review__` block now passes these into `finalize()` which writes them to the DB. Flow still terminates — caller behaviour unchanged.

---

### Task 3 — FlowRunner: add `resumeFromReview()` function
**Files:** `packages/backend/src/features/flows/flow-runner.ts`
**Done when:** An exported `resumeFromReview(reviewId)` function exists. It loads the review, the paused flow run, the flow definition, and the agent. It reconstructs `stepResults` from the saved snapshot, injects the review's `finalContent` into `stepResults[reviewStepId]`, and runs the remaining steps starting from the step after `__human_review__`. The function throws if the review is not in an approved state.
**Depends on:** Task 2
**Status:** `[x]`
**Notes:** Added `resumeFromReview()` as an exported standalone function. Added `ResumeOptions` interface and optional 5th constructor param to `FlowRunnerService`. `run()` skips dedup when resuming. `executeSteps()` accepts `startFromIndex` to skip already-completed steps. `finalContent` is injected into `stepResults` so downstream `fill` steps can reference it via `step_ref`.

---

### Task 4 — Resolve endpoint: trigger resume on approval
**Files:** `packages/backend/src/routes/reviews.ts`
**Done when:** `POST /reviews/:reviewId/resolve` calls `resumeFromReview(reviewId)` (fire-and-forget) when the decision is `approved` or `approved_with_edits`. The HTTP response still returns immediately — it does not wait for the flow to finish.
**Depends on:** Task 3
**Status:** `[x]`
**Notes:** Imported `resumeFromReview` from `flow-runner.ts`. Added `void resumeFromReview(reviewId).catch(logger.error)` after the DB update, gated on the two approved decisions. HTTP response is unchanged.

---

## Group 2 — Flow builder and test mode
*These are independent of each other. Do in any order.*

### Task 5 — Flow builder: generate correct structure for action flows
**Files:** `packages/backend/src/routes/flows-generate.ts`
**Done when:** When you ask the flow generator to build a posting/submitting flow, it places `__human_review__` as step 1 (before any `navigate` or `fill`), and wires downstream `fill` steps to use `{ type: "step_ref", stepId: "<review_step_id>", path: "finalContent" }` instead of a literal. Generate `post_new_thread` and confirm the structure matches.
**Depends on:** nothing (can be done before or after Group 1)
**Status:** `[x]`
**Notes:** Added `## ACTION FLOWS WITH HUMAN REVIEW` section to `buildSystemPrompt` with explicit step ordering rules and wiring instructions. Existing `__human_review__` documentation updated to reflect the resume behaviour.
- [ ] **Still needed:** Generate a fresh `post_new_thread` flow and verify the AI produces the correct structure. Run it and confirm it pauses before opening any tab, then resumes and submits after approval.

---

### Task 6 — Test mode: auto-approve `__human_review__` in the FlowEditor test panel
**Files:** `packages/backend/src/features/flows/flow-runner.ts`
**Done when:** Running a flow via the FlowEditor "Test" button (which sets `flow.name = '__inline_test__'`) skips the human review pause entirely — it auto-approves with the draft content and continues to the next step. No DB row is inserted. The test completes in one pass.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Used existing `isInternalTestRun` flag (already set when `flow.name === '__inline_test__'`). Added guard in the `__human_review__` block: skips DB insert and paused-state save, populates `stepResults[step.id]` with `{ status: 'auto_approved_for_test', finalContent: draftContent }`, and continues.
- [ ] **Still needed:** Run a flow with a `__human_review__` step via the FlowEditor test panel and confirm it completes without pausing.

---

## Group 3 — Frontend

### Task 7 — Reviews tab: show resume feedback
**Files:** `packages/frontend/src/pages/agent/ReviewsTab.tsx`
**Done when:** After clicking Approve, a green "↺ Flow resumed ✓" badge appears on the review card for ~30 seconds. If the resume call fails, an error banner appears with the message (not a silent failure). No other UI changes required.
**Depends on:** Task 4
**Status:** `[x]`
**Notes:** Approve button now tracks approved review IDs in local state. Green badge renders on history card for 30s. Error banner with dismiss button shown above history section on failure.

---

### Task 8 — Verify the full end-to-end flow works
**Files:** none — this is a manual test
**Done when:** You can run through this sequence without errors:
1. Generate a `post_new_thread` flow — confirm `__human_review__` is step 1
2. Run the flow — confirm it pauses and a pending review appears in the Reviews tab
3. Confirm no browser tab was opened yet
4. Click Approve in the Reviews tab
5. Confirm the flow resumes, opens the tab, fills the form, and clicks submit
6. Confirm the "↺ Flow resumed ✓" badge appears
**Depends on:** Tasks 1–7
**Status:** `[ ]`

---

### Task 9 — (Optional / future) Chrome extension overlay
**Files:** `packages/extension/src/content/index.ts`
**Done when:** A floating overlay appears on the page being reviewed when a pending review exists for that tab's URL. The overlay has Approve / Edit + Approve / Reject buttons. Approving from the overlay calls `POST /reviews/:reviewId/resolve` and dismisses the overlay.
**Depends on:** Tasks 1–7 complete and working
**Status:** `[ ]`
**Notes:** The `GET /reviews/by-tab?url=<currentUrl>` endpoint already exists. Only relevant if you later switch to reviewing after the form is filled — not needed for the current "review before fill" design. Skip until specifically requested.
