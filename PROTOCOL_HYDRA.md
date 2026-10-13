# PROTOCOL HYDRA
### Every agent that writes content must route through hydration. No exceptions.

**Objective:** When building an agent through the UI setup wizard, the flow builder had zero knowledge of the `__hydrate__` + `__generate__` pipeline. It would build content-writing flows (post a comment, send a DM, reply to a thread) with raw `comment_body` / `reply_text` inputs instead of routing through the smart two-step pipeline. This operation hardens the flow builder so that any new agent built with content action flows gets the pipeline automatically — without relying on anyone remembering to ask for it.

**Status:** In progress — Tasks 1.1 and 1.2 complete. Task 1.3 (live smoke test) requires running the app.

**How to use this file:**
- Start each session by reading this file first
- Pick the first session block that has `[ ]` as its session status
- Work through every task in that block before ending the session
- Mark the session `[x]` and leave a brief note on anything surprising
- Never leave the codebase in a broken/non-compiling state at end of session

**Status markers:**
- `[ ]` not started
- `[>]` in progress (session was interrupted — read the note before continuing)
- `[x]` done
- `[!]` blocked — see note
- `[—]` moved out of scope

**Background:** On 2026-04-01 the Reddit Karma Builder agent (`f4c5a61f`) was built without hydration steps in its `post_comment` and `reply_to_reddit_comment` flows. Both flows were surgically corrected directly in the DB. The root cause: `flow-generator-agent.ts` (the UI flow builder) had no knowledge of the smart content pipeline. `action-flow-agent.ts` and `scrape-flow-agent.ts` are only used by the autonomous manager path — NOT the UI. This operation fixes the correct file so no future agent has the same gap baked in at build time.

---

## Architecture note (read before touching anything)

There are **three** flow-building agents in this codebase. Only one is relevant to this operation:

| File | Called by | Handles |
|------|-----------|---------|
| `agents/ui/flow-generator-agent.ts` | `features/flows/flows-generate.routes.ts` → `runFlowGeneratorAgent()` | **UI setup wizard** — both scrape and action flows |
| `agents/autonomous/action-flow-agent.ts` | `agents/manager-agent.ts` | Autonomous manager path — action flows only |
| `agents/autonomous/scrape-flow-agent.ts` | `agents/manager-agent.ts` | Autonomous manager path — scrape flows only |

When a user builds an agent through the UI, every flow goes through `flow-generator-agent.ts`. The other two are irrelevant to this operation.

---

## SESSION 1 — Enforce hydration in the UI flow builder `[>]`

**Scope:** One TypeScript file: `flow-generator-agent.ts`. No schema changes. No new routes. The fix is purely in the prompt language the agent receives — making the hydration rule non-negotiable rather than absent.

---

### TASK 1.1 — Add mandatory hydration rules to flow-generator-agent.ts `[x]`

**Note:** Initially targeted `action-flow-agent.ts` (wrong file — autonomous manager path only). Corrected. The actual change was made to `flow-generator-agent.ts`.

`flow-generator-agent.ts` builds both scrape and action flows from the UI. The action flow preamble had no mention of `__hydrate__`, `__generate__`, ActionBriefs, or the smart pipeline.

Added a `## SMART CONTENT PIPELINE — MANDATORY for content-writing flows` section inside the action flow preamble block. The section covers:

1. The rule applies to ALL flows that write text content to an external platform, without exception
2. Non-negotiable language: ALWAYS use `__hydrate__` + `__generate__` as steps 0 and 1 for any flow that posts, comments, replies, or sends text
3. Never accept `comment_body`, `reply_text`, `message_text`, or any raw text string as a flow input — only `action_brief`
4. Negative/positive examples: `WRONG: post_comment({ target_url, comment_body })` → `RIGHT: post_comment({ target_url, action_brief })`
5. Full sentinel step documentation and output field mapping (`comment_text`, `message_text`, `tweet_text`, etc.)

**Files touched:**
- `packages/backend/src/agents/ui/flow-generator-agent.ts` (prompt extracted to `agents/ui/flow-generator.action.preamble.md`)

**Also done (belt-and-suspenders, low-value alone):**
- `packages/backend/src/agents/autonomous/action-flow-agent.ts` — same mandatory language added for the autonomous manager path
- `packages/backend/src/agents/ui/setup-agent.ts` — added rule to `FLOW RECOMMENDATION RULES` requiring "Smart content flow" phrase in any content-writing flow description

---

### TASK 1.2 — Emergency DB patches for existing broken flows `[x]`

Three flows were already live without hydration steps. Patched directly in SQLite without waiting for the systemic fix:

| Flow | Agent | Fix applied |
|------|-------|-------------|
| `post_comment` (`8c843fad`) | Reddit Karma Builder (`f4c5a61f`) | Added `__hydrate__` + `__generate__` as steps 0–1, `comment_body` → `action_brief`, step 2 references generate output |
| `reply_to_reddit_comment` (`a0734c9a`) | Reddit Karma Builder (`f4c5a61f`) | Same + `requires_approval: true` |
| `comment_on_post` (`cb61d3a2`) | Reddit Comment Agent | Same surgical fix |

These patches are permanent in the DB. They do not need to be re-applied.

---

### TASK 1.3 — Smoke test end-to-end `[ ]`

**Note:** Task 1.1 is complete and the app is running in dev mode (`tsx watch`) — changes are live immediately. This task requires building a fresh agent through the UI to confirm the output is correct.

Run the Reddit Karma Builder job description through the setup flow from scratch. Create a new agent — do not reuse the existing one.

Confirm all of the following before marking this task done:

- [ ] The setup agent recommends `post_comment` and `reply_to_reddit_comment` with "Smart content flow" in their descriptions
- [ ] The flow builder produces both flows with `__hydrate__` as step 0 and `__generate__` as step 1
- [ ] Both flows accept `action_brief` in their input schema — not `comment_body` or `reply_text`
- [ ] `requires_approval: true` on both action flows
- [ ] The manager agent, when triggered, produces an `ActionBrief` object — not a raw string

If any check fails, diagnose in `agents/ui/flow-generator.action.preamble.md` first (the prompt the UI flow builder receives), then `agents/autonomous/action-flow-agent.ts` if the failure is in the autonomous manager path.

---

## End state

When this operation is complete, any agent built with a content action flow — commenting, replying, posting, sending — will automatically get the full pipeline:

```
GENERATE → HYDRATE → REVIEW → EXECUTE
```

No one has to remember to ask for it. No agent can skip it. The hydration step we spent time building actually gets used every time.
