# OPERATION VANTAGE
### Two-Agent Action Pipeline — Architecture & Implementation Plan

**Objective:** Replace the current flat single-model action flow with a two-tier pipeline where a cheap scout agent (Haiku) assembles a rich intelligence brief, all references are hydrated fresh, and a capable writer agent (Sonnet) generates the final content from that full context. The human review queue receives the complete reasoning chain, not just a draft.

**Status:** Planning complete. Ready for sequential implementation.

---

## Background & Architecture Decision Log

### The Problem We're Solving

The current system has the agent (Haiku) doing everything in one pass: scouting Reddit, deciding what to act on, and writing the actual comment — all with the same cheap model, all in one context window. This produces three concrete failures:

1. **Tone violations.** Haiku ignores buried instructions in long system prompts. The em dash ban exists in the system prompt. Haiku writes em dashes anyway.
2. **Opaque review queue.** When a `post_comment` lands in review, you see the URL and the draft. You don't see *why* the agent thought this was worth posting, what it read, or what it already knows about this topic. You're approving in the dark.
3. **Dead learning data.** `toneGuide` is updated by human edits but never injected anywhere at runtime. `profileBlob` is parsed but never read by the agent. Both are inert.

### The Solution

```
[Haiku scout] → rich brief (with references) → [hydration step] → full context → [Sonnet writer] → draft → [review queue]
```

**Haiku's job:** Figure out what's worth acting on. Package a brief containing: the intended action, the reason, pointers to the scrapes that informed the decision, memory query keys, and relevant DB table/row references. Write a rough *intent draft* — not the final comment, just what it wants to say conceptually.

**Hydration step:** Re-execute all the references in the brief. Re-run the scrapes (fresh data). Pull memory results. Pull DB rows. Assemble `decision_context_return`. References are re-run (not passed through) so Sonnet gets current data and Haiku doesn't have to carry full payloads in its output.

**Sonnet's job:** Receive the fully hydrated context bundle + tone rules. Write the actual final comment in the agent's voice. Has everything it needs in one structured prompt — no hunting for context.

**Review queue:** Receives the Sonnet output as the pending action, but the full hydrated bundle is stored alongside it so the reviewer can inspect the entire reasoning chain.

### Key Decisions Made

- **References re-execute, not pass-through.** Haiku sends `{ tool: "scrape_post_comments", input: { post_url: "..." }, relevance: "..." }`. The hydration step runs that tool fresh. Sonnet gets current data, not Haiku's cached version. Haiku also never has to write out full comment threads (which it botches).
- **Smart agent step lives inside the flow**, not between flow and review queue. Flows stay self-contained. The review queue always receives the output of a finished, complete reasoning chain.
- **Per-step model declaration.** Each flow step can declare which model tier it uses. Scouting steps use `haiku`. The content generation step uses `sonnet` or `opus`. This is already partially structured in the flow runner (`reasoningModel` on the flow level) — we're extending it to the step level.
- **Tone is injected as structured data, not buried in a system prompt.** The Sonnet step receives `tone` as an explicit array in its prompt context. The `toneGuide` (learned from edits) is the highest-priority signal; `profileBlob.tone` (parsed from system prompt) is the base layer. Both are injected.
- **profileBlob auto-syncs.** Whenever a system prompt is saved (generate, raw edit, amend), `profileBlob` is re-parsed automatically. It stays in sync with the prompt without manual intervention.

---

## The Rich Brief Format (Haiku output → hydration step input)

```json
{
  "action": {
    "type": "post_comment",
    "post_url": "https://www.reddit.com/r/ethereum/comments/...",
    "draft": "this is the rough shape of what i want to say — not polished"
  },
  "decision_context": {
    "reason": "Post has 180+ upvotes, low reply count, directly relevant to user segmentation theme",
    "supporting_scrapes": [
      {
        "tool": "scrape_post_comments",
        "input": { "post_url": "https://..." },
        "relevance": "Revealed overlapping discussion around signal quality and user segmentation"
      },
      {
        "tool": "search_subreddit_posts",
        "input": { "subreddit": "ProductManagement", "keyword": "user segmentation" },
        "relevance": "Confirmed ongoing discussion value in related builder communities"
      }
    ],
    "memory_queries": ["dapp", "incentive", "segmentation"],
    "database_context": [
      { "table_id": "abc123", "description": "past_reddit_comments — check for topic overlap" },
      { "table_id": "def456", "description": "author_engagement_history — check if we've interacted with this author" }
    ]
  }
}
```

After hydration, `decision_context_return` contains the actual results of each reference — full scrape data, memory matches with scores, DB rows found.

---

## Task List

Tasks are ordered by dependency. Each can be implemented in a separate session. Read the relevant file list before starting each task.

---

### TASK 1 — Define the rich brief input schema
**Status:** `[x] DONE`
**Depends on:** Nothing — pure type/schema work
**Session start prompt:** "Implement OPERATION VANTAGE Task 1: define the rich brief input schema"

**What to build:**
Add TypeScript types and Zod schemas for the `ActionBrief` format — the rich bundle Haiku produces. This should live in the shared schemas so both backend and frontend can use it.

The schema needs:
- `ActionBrief` — top-level type with `action` and `decision_context`
- `ActionBriefAction` — `{ type: string; draft?: string; [key: string]: unknown }` (type + draft + any flow-specific fields like `post_url`)
- `DecisionContext` — `{ reason: string; supporting_scrapes: ScrapeReference[]; memory_queries: string[]; database_context: DbReference[] }`
- `ScrapeReference` — `{ tool: string; input: Record<string, unknown>; relevance: string }`
- `DbReference` — `{ table_id: string; description: string }`
- `HydratedContext` — the post-hydration version, where each reference has an added `return` field with actual results

**Files to touch:**
- `packages/shared/src/schemas/flow.schema.ts` — add the new types/schemas
- `packages/frontend/src/types/index.ts` — add matching frontend types
- `packages/backend/src/features/flows/flow-runner.ts` — import types (no logic yet)

---

### TASK 2 — Flow step: per-step model declaration
**Status:** `[x] DONE`
**Depends on:** Nothing (can run in parallel with Task 1)
**Session start prompt:** "Implement OPERATION VANTAGE Task 2: per-step model declaration in flows"

**What to build:**
Currently `reasoningModel` is a field on the flow itself (used for `__evaluate__` steps). We need to add `stepModel?: string` to `FlowStep` so individual steps can declare which model they use.

The flow runner already has `flow.reasoningModel` for evaluate steps. Extend this so:
- If `step.stepModel` is set, use it for that step's evaluate call
- Fall back to `flow.reasoningModel`, then to the agent's `model`
- The flow builder UI (Setup tab flow generator) should expose this as an optional field when configuring evaluate steps

**Files to touch:**
- `packages/shared/src/schemas/flow.schema.ts` — add `stepModel?: string` to `FlowStep`
- `packages/backend/src/features/flows/flow-runner.ts` — read `step.stepModel` in the evaluate step handler (around line 645–700)
- `packages/backend/src/db/schema.ts` — flows table already stores steps as JSON so no migration needed
- `packages/frontend/src/types/index.ts` — update `FlowStep` interface

---

### TASK 3 — Flow runner: context hydration step (`__hydrate__`)
**Status:** `[x] DONE`
**Depends on:** Task 1 (needs the ActionBrief types)
**Session start prompt:** "Implement OPERATION VANTAGE Task 3: __hydrate__ step in the flow runner"

**What to build:**
A new sentinel step type `__hydrate__` (parallel to existing `__evaluate__`). When the flow runner encounters a step with `toolId: '__hydrate__'`, it:

1. Reads the `ActionBrief` from a specified prior step's result (referenced by `stepId` in the step's `inputMapping`)
2. Iterates over `decision_context.supporting_scrapes` — for each, looks up the tool by name and executes it with the provided inputs (same mechanism as normal flow steps)
3. Iterates over `decision_context.memory_queries` — queries the agent's memory for each key, collects results
4. Iterates over `decision_context.database_context` — queries each referenced table for relevant rows
5. Assembles the full `HydratedContext` (brief + all return data)
6. Returns `HydratedContext` as the step result

The result is stored in `priorStepResults` like any other step, so the next step (Sonnet generation) can reference it via `step_ref`.

**Files to touch:**
- `packages/backend/src/features/flows/flow-runner.ts` — add `__hydrate__` handler alongside existing `__evaluate__` handler (around line 645 and line 1174)
- `packages/backend/src/memory/librarian.ts` — check the query interface for memory lookups
- New file: `packages/backend/src/features/flows/hydration.ts` — isolate the hydration logic for testability

---

### TASK 4 — Flow runner: smart agent generation step (`__generate__`)
**Status:** `[x] DONE`
**Depends on:** Task 2 (needs per-step model), Task 3 (needs hydrated context)
**Session start prompt:** "Implement OPERATION VANTAGE Task 4: __generate__ step in the flow runner"

**What to build:**
A new sentinel step type `__generate__` that takes a `HydratedContext` and produces the final action content (e.g. `comment_text`). This is where Sonnet/Opus is called.

The step handler should:
1. Pull the `HydratedContext` from the referenced prior step
2. Pull the agent's `toneGuide` from the DB (this is the learned corrections layer)
3. Pull `profileBlob.tone` from the agent (this is the base tone layer from the system prompt)
4. Build the generation prompt: original post context + top comments + memory results + past comments from DB + draft intent + tone rules (toneGuide takes priority over profileBlob.tone)
5. Call the model specified by `step.stepModel` (defaults to `flow.reasoningModel` or agent's model)
6. Return `{ [action.type fields]: "...", generated_content: "..." }` — the structured output that the next step (actual posting) expects

The system prompt for this call is the agent's `systemPrompt` (the full persona) — this is where Niklas's voice comes from.

**Files to touch:**
- `packages/backend/src/features/flows/flow-runner.ts` — add `__generate__` handler
- `packages/backend/src/routes/action-log.ts` — the `revise` endpoint already does a version of this; reference for prompt structure
- `packages/backend/src/lib/tone.ts` — use for pulling tone data

---

### TASK 5 — Update action flow agent (Haiku) to produce rich briefs
**Status:** `[x] DONE`
**Depends on:** Task 1 (needs schema), Tasks 3 & 4 (so you can test end-to-end)
**Session start prompt:** "Implement OPERATION VANTAGE Task 5: update action-flow-agent to produce ActionBrief output"

**What to build:**
Update `ACTION_FLOW_AGENT_SYSTEM_PROMPT` to instruct the builder to produce flows that:
1. Have Haiku scouting steps (existing scrape flow calls) that culminate in a `__hydrate__` step
2. Follow with a `__generate__` step that uses `sonnet` as `stepModel`
3. The final action step (e.g. `reddit_post_comment`) takes its content from the `__generate__` step output

The Haiku agent that runs at action-decision time also needs updating. When it decides to act, instead of directly populating `comment_text`, it populates the `ActionBrief` format with its intent draft and references.

This is the biggest conceptual shift — the Haiku runtime agent changes from "decide and draft" to "decide and brief."

**Files to touch:**
- `packages/backend/src/agents/action-flow-agent.ts` — update system prompt and output schema expectations
- `packages/backend/src/agents/manager-agent.ts` — understand how it delegates to action-flow-agent; may need updates
- `packages/backend/src/features/flows/flow-runner.ts` — verify the new step types are wired correctly

---

### TASK 6 — Auto-sync profileBlob when system prompt is saved
**Status:** `[x] DONE`
**Depends on:** Nothing (standalone)
**Session start prompt:** "Implement OPERATION VANTAGE Task 6: auto-sync profileBlob on system prompt save"

**What to build:**
Currently `profileBlob` is only populated via the generate flow or the manual "Parse from prompt" button. It should auto-update whenever `systemPrompt` changes.

Add a call to the parse-prompt logic (already implemented in `setup.ts`) as a post-save hook whenever `systemPrompt` is updated. This should be:
- Non-blocking (fire and forget — don't make the save wait for it)
- Only triggered when `systemPrompt` actually changed (compare old vs new)
- Applicable from all save paths: generate flow, raw edit save, amend-apply

**Files to touch:**
- `packages/backend/src/features/agents/agents.routes.ts` — the `PATCH /agents/:id` handler; add post-save hook
- `packages/backend/src/routes/setup.ts` — extract the parse-prompt logic into a reusable function (currently inline in the endpoint handler)

---

### TASK 7 — toneGuide injection at runtime (close the learning loop)
**Status:** `[x] DONE`
**Depends on:** Task 4 (`__generate__` step needs to inject tone — do this together or right after)
**Session start prompt:** "Implement OPERATION VANTAGE Task 7: inject toneGuide into runtime generation"

**What to build:**
Ensure `toneGuide` is injected into every `__generate__` step call and also into the chat agent (for conversational responses). Currently `toneGuide` is stored but never read at runtime.

Two injection points:
1. `__generate__` step handler (Task 4 should already do this — verify it's complete)
2. `chat-agent.ts` — append toneGuide bullets to the system prompt as a "Tone corrections from human review:" section, below the main system prompt

Priority hierarchy at injection time:
- `toneGuide` bullets = **override layer** (label them: "These tone corrections were made by your human reviewer — follow them precisely")
- `profileBlob.tone` bullets = **base layer** (already in system prompt, just reinforce in structured form)

**Files to touch:**
- `packages/backend/src/agents/chat-agent.ts` — inject toneGuide into system prompt construction (around line 168)
- `packages/backend/src/features/flows/flow-runner.ts` — verify `__generate__` step injects tone (should be done in Task 4)
- `packages/backend/src/lib/tone.ts` — add helper `getToneContext(agentId)` that returns both layers in the right format

---

### TASK 8 — Update review UI to render rich context bundle
**Status:** `[x] DONE`
**Depends on:** Tasks 3–5 (need actual data flowing through to see it in review)
**Session start prompt:** "Implement OPERATION VANTAGE Task 8: update ReviewActionsTab to render hydrated context"

**What to build:**
The review queue currently renders a flat list of input fields. When an action has the rich bundle format, it should render:

- **Why** banner (already exists for `reason_for_action` — extend this for the `decision_context.reason` field)
- **Supporting evidence** section — collapsible, shows each scrape's return data (post title, top comments, detected themes, etc.)
- **Memory** section — collapsible, shows what the agent remembered about relevant topics
- **Database context** section — collapsible, shows what was found in custom tables (past comments, author history, etc.)
- **Draft intent** — the rough draft the Haiku agent wrote, shown separately from the final Sonnet output so you can compare
- **Final content** — the Sonnet-generated comment, which is what actually gets posted and what the edit/thought buttons act on

The key insight for rendering: the action input will have a nested structure. The renderer needs to detect whether an action has the rich bundle format vs. the old flat format and handle both (backwards compatibility).

**Files to touch:**
- `packages/frontend/src/pages/agent/ReviewActionsTab.tsx` — main rendering logic, particularly `PendingCard` and the input preview section
- `packages/frontend/src/types/index.ts` — may need updated `ActionLogEntry` type if input schema changes

---

## Current System State (Reference)

### What exists and works
- `toneGuide` — stored, updated from edits (`lib/tone.ts`), **not injected at runtime**
- `profileBlob` — stored, manually parsed, **not read at runtime**
- `__evaluate__` step — Claude reasoning step on any flow, uses `flow.reasoningModel`
- `requiresApproval` on flows — queues action as `pending_review` before executing
- Action log `input` field — stores whatever JSON the flow was called with
- `revise` endpoint — takes `{ thought }`, calls Haiku to rewrite content (added this session)
- `toneEdits` table — records human edit pairs, feeds `refreshToneGuide` (wired up this session)
- `parse-prompt` endpoint — extracts `profileBlob` from existing system prompt (added this session)
- Review queue — shows full input fields, copy action/flow ID, play/amend/thought/reject

### What exists but is unused / incomplete
- `reasoningModel` on flow — flow-level model override for evaluate steps; not yet per-step
- `profileBlob.tone` — parsed and stored; not injected into any runtime call
- `toneGuide` — stored; not injected into any runtime call
- `agentType` or similar model-tier field on flows — check `packages/backend/src/db/schema.ts` flows table before Task 2; may already be partially defined

### Key file map
```
packages/backend/src/
  agents/
    action-flow-agent.ts     — Haiku flow builder agent (generates flow definitions)
    manager-agent.ts         — Top-level orchestrator; delegates to sub-agents
    chat-agent.ts            — Handles direct chat; injects systemPrompt
  features/flows/
    flow-runner.ts           — Core runtime; executes steps, handles __evaluate__
  lib/
    tone.ts                  — refreshToneGuide(); Anthropic call from edit pairs
  routes/
    action-log.ts            — play/reject/rerun/revise endpoints + tone learning
    setup.ts                 — generate/parse-prompt/amend endpoints
  db/
    schema.ts                — agents, flows, actionLog, toneEdits, pendingHumanReviews tables
  memory/
    librarian.ts             — memory query interface

packages/frontend/src/
  pages/agent/
    ReviewActionsTab.tsx     — Review queue UI (heavily updated this session)
    SetupTab.tsx             — Agent setup, profileBlob dashboard, parse button
  types/index.ts             — ActionLogEntry, Flow, FlowStep, Agent interfaces
  api/client.ts              — Frontend API wrapper

packages/shared/src/schemas/
  flow.schema.ts             — Shared Zod schemas for FlowStep, InputExpression, etc.
```

---

## Session Handoff Notes

Each task should start by re-reading the files listed under "Files to touch" for that task, plus `flow-runner.ts` lines 600–700 (the step dispatch block) as general orientation.

Tasks 1 and 2 can run in parallel. Tasks 3 and 4 depend on Task 1 and should be done sequentially. Task 5 (the agent update) is the integration test for 1–4. Tasks 6 and 7 are independent and can interleave. Task 8 is last because it needs real data flowing through the pipeline.

The architectural north star: by the end of all 8 tasks, every pending action in the review queue should tell a complete story — what was found, why it matters, what we already know, and what the agent wants to say. The human reviewer approves a decision, not just a draft.
