# OPERATION VANTAGE RECORDING
### Teach the builder. Don't make it guess.

**Objective:** The action flow builder currently forces the agent to discover how a page works from scratch — inspect the DOM, guess at selectors, fail on Shadow DOM, loop. The fix is obvious: let the user demonstrate the action once via recording, and have the agent build the parameterized flow from that. No discovery phase. No Shadow DOM mysteries. The agent just needs to generalize what it watched.

**Status:** Planning complete. Ready for implementation.

**How to use this file:**
- Start each session by reading this file first
- Pick the next `[ ]` task
- Mark completed tasks `[x]` and write a brief note before ending the session
- Never leave the codebase in a broken/non-compiling state at end of session

**Status markers:**
- `[ ]` not started
- `[>]` in progress (session was interrupted — read the note before continuing)
- `[x]` done
- `[!]` blocked — see note
- `[—]` moved out of scope

---

## The Problem

Action flows that operate on specific targets (a Reddit comment, a LinkedIn post, a tweet) require knowing the exact URL structure before the agent can build anything useful. The agent doesn't know that replying to a Reddit comment needs a `subreddit` + `post_id` + `comment_id` derived from a permalink URL — it only knows the `comment_id` was provided as an input. It then spins on DOM inspection and guesses wrong.

The recording system (`/recording/start`, `/recording/event`, `/recording/stop`) already captures exactly the information the agent needs: the URL structure, the working selectors, the action sequence. It's just not wired into the action flow builder entrypoint.

The existing flow in `FlowsTab.tsx` already has recording support, but it's buried behind the full tabs UI. There's no fast path to just test "give agent a task + optional recording → get a flow."

---

## What Exists (Don't Rebuild)

- **Recording backend** — `packages/backend/src/routes/recording.ts`. Already handles `START_RECORDING`, captures `navigate/click/type` events, exposes `/recording/events`. Works.
- **Recording frontend integration** — `FlowsTab.tsx` already has `startRecording`, `stopRecording`, `recordEvents` state, and `eventsToDescription()` which formats events into an agent-readable string.
- **FlowGenerator component** — accepts `initialMessages` + `autoSend` to kick off building with a pre-seeded first message. The recording path in FlowsTab already uses this pattern.
- **`/test/action-flow` dev page** — Task 1 below adds this. It's a thin shell around FlowGenerator, for quickly testing the action flow builder without going through onboarding.

---

## Phase 1 — Test Harness

Fast path for iterating on the action flow builder without going through the full product flow.

---

### TASK 1 — `/test/action-flow` dev page

**Status:** `[x]`
**Completed:** 2026-03-30

Add a route at `/test/action-flow` that lets you pick an agent, type a task description, and immediately launch the FlowGenerator in action-flow mode. No onboarding wizard. No job description step. No scraping flows first.

**What it does:**
- Fetches the agent list on load, renders a dropdown to pick one
- Single textarea for the task description
- "Build" button seeds FlowGenerator with `{ role: 'user', content: taskDescription }` and `autoSend: true`
- `flowType="action"` passed to FlowGenerator so it gets the action-focused system prompt
- Remembers last-selected agent in localStorage

**Files touched:**
- `packages/frontend/src/pages/ActionFlowTestPage.tsx` — new file
- `packages/frontend/src/App.tsx` — add route `/test/action-flow`

---

## Phase 2 — Recording-Guided Action Flow Builder

Wire the recording system into the action flow builder as an optional "show me once" step before the agent starts building.

---

### TASK 2 — "Record first" entry point in the action flow builder

**Status:** `[x]`
**Completed:** 2026-03-30

When building an action flow, show an optional pre-step: **"Guide me with a recording"**. The user navigates to the right page first, starts the recording, performs the action once, stops. The recording events are then injected into the FlowGenerator's initial message alongside the task description.

**The prompt injected should look roughly like:**

```
I recorded the following browser interaction:

1. Navigated to: https://www.reddit.com/r/lovable/comments/1s7a4zy/comment/od9e54x/
2. Clicked: [data-testid="reply-button"] ("Reply")
3. Typed into: shreddit-composer[name='content'] > div[name='body'] — "test reply"

Goal: Reply to a specific Reddit comment identified by comment_id.

Build a parameterized action flow from this recording. The URL shows the full structure —
identify which parts are variable inputs (subreddit, post_id, comment_id) vs. fixed structure.
Use the selectors from the recording directly — they are known to work. Replace the specific
values I used in the recording with flow input parameters.
```

**Where this lives:** The `/test/action-flow` page (Task 1) should be the first place this gets wired in, since it's the fastest iteration surface. The full FlowsTab recording flow can be updated in a later pass once the pattern is validated.

**Files touched:**
- `packages/frontend/src/pages/ActionFlowTestPage.tsx` — add recording section (start/stop/events display)
- No backend changes needed — recording routes already exist

**Key design note:** The recording entry is optional. If the user types a task and hits Build without recording, it goes straight to FlowGenerator as before. The recording just pre-populates context when provided.

---

### TASK 3 — "Get to the page, then record" guidance copy

**Status:** `[x]`
**Completed:** 2026-03-30

Add a single instructional line shown before the user starts a recording in the action flow builder. It doesn't need to explain Reddit or any specific site. It just needs to convey the one principle:

> **Get to the page first, then start recording.**
> The recording captures what you do — not how you got there. Navigate to the exact target (the comment, the profile, the post) before pressing Start.

This copy goes in `ActionFlowTestPage.tsx` (and eventually `FlowsTab.tsx`) as a small hint above the recording start button. One line is enough.

**Files touched:**
- `packages/frontend/src/pages/ActionFlowTestPage.tsx`

---

### TASK 4 — Parameterization hint in the FlowGenerator system prompt

**Status:** `[x]`
**Completed:** 2026-03-30

When a recording is present in the initial message, the agent should know to:
1. Look at the first `navigate` URL and identify which segments are variable vs. structural
2. Use selectors from the recording verbatim — they are known-working and shadow DOM is already handled
3. Replace literal values from the recording (the specific comment_id, the typed text) with flow input parameters
4. Infer required inputs from the URL structure, not just from the task description

This means adding a short section to the action flow system prompt in `flows-generate.ts` under a heading like `## When a recording is provided`. The agent already handles recordings reasonably well — this just makes the parameterization rules explicit so it doesn't leave literal values hardcoded.

**Files touched:**
- `packages/backend/src/routes/flows-generate.ts` — add `## When a recording is provided` section to `buildSystemPrompt()`

---

## Phase 3 — Polish

---

### TASK 5 — Wire recording into the main FlowsTab action flow path

**Status:** `[x]`
**Completed:** 2026-03-30
**Note:** This wired recording into `FlowsTab.tsx` (the existing-agent path) but did NOT cover `AgentOnboarding.tsx` — see Task 7.

Once the pattern is validated on `/test/action-flow`, backport it to the main `FlowsTab.tsx` action flow builder. The existing recording UI in FlowsTab can be simplified — instead of a separate "Record" section and "Build with AI" step, fold it into the action flow builder dialog as an optional "Guide with recording" step before the FlowGenerator launches.

**What changed:** Removed the separate `recordFormOpen` URL entry form, `goalFormOpen` goal refinement form, and the recording overlay (three separate full-page replacement views). Replaced them with a single `generatorPreDialogOpen` pre-dialog (mirrors ActionFlowTestPage) — task textarea + collapsible recording section + Build button. The "● Record" button in the flow list header was removed; "✦ Generate" now opens the pre-dialog. `buildMessageWithRecording` (same prompt format as ActionFlowTestPage, including partial-recording note) and `handleBuildFromPreDialog` added. The manual path (Skip AI → FlowEditor) remains accessible from the pre-dialog when a recording is present.

**Files touched:**
- `packages/frontend/src/pages/agent/FlowsTab.tsx`

---

### TASK 6 — Partial recording handling

**Status:** `[x]`
**Completed:** 2026-03-30

If a recording has events but `done: false` (user stopped early or forgot to press Stop), still use the partial events. Add a note to the injected message: "Note: recording may be incomplete — the user did not press Stop. Infer the remaining steps from the goal."

This is a one-line change to the message construction in `ActionFlowTestPage.tsx` and `FlowsTab.tsx`.

**Files touched:**
- `packages/frontend/src/pages/ActionFlowTestPage.tsx`
- `packages/frontend/src/pages/agent/FlowsTab.tsx`

---

### TASK 7 — Wire recording pre-dialog into the `/agents/new` onboarding wizard

**Status:** `[x]`
**Completed:** 2026-03-31

The onboarding wizard (`AgentOnboarding.tsx`) launched `FlowGenerator` directly for every flow, bypassing the pre-dialog added in Tasks 2–5. This meant users building action flows during initial setup were never offered the "Guide me with a recording" step — the agent jumped straight to DOM inspection.

**Fix:** When `currentFlow.type === 'action'` and the user hasn't yet clicked "Build", show the same pre-dialog (recording section + build button) before `FlowGenerator` starts. Scrape flows are unaffected — they go straight to the generator as before. Recording state resets automatically when the user navigates between flows via the progress pills.

**Files touched:**
- `packages/frontend/src/pages/AgentOnboarding.tsx` — added `eventsToDescription`, `buildOnboardingMsgWithRecording` helpers; recording state (`recordingUrl`, `recording`, `recordingDone`, `recordEvents`, `recordingPreOpen`, `pollRef`); `onboardingReadyToGenerate` gate; `handleStartRecording`, `handleStopRecording`, `handleDiscardRecording` handlers; pre-dialog JSX inside the `flow_building` phase render; reset logic in the `currentFlowIndex` effect.

---

## Context: Why recordings solve the right problem

The two failure modes this operation addresses:

**1. Unknown URL structure.** The agent is given `comment_id: od9e54x` and asked to reply to a Reddit comment. It doesn't know that the reply page URL is `reddit.com/r/{subreddit}/comments/{post_id}/{slug}/{comment_id}/` — it needs `subreddit` and `post_id` too. A recording's first `navigate` event immediately reveals this. The agent sees the full URL and can infer the required input schema.

**2. Shadow DOM.** Reddit's comment UI uses Web Components (`shreddit-comment`, `faceplate-form`, etc.) that `document.querySelector` can't reach across shadow roots. The agent discovers this after 3-5 failed `inspect_page` attempts. A recording's `click` and `type` events contain selectors that the extension already used successfully — they work. The agent never needs to rediscover them.

Both problems evaporate when the agent builds from a recording instead of from scratch.
