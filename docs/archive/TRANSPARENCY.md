# Transparency & Explainability — Design Document

> **Goal:** Make the agent genuinely legible to its owner. You should be able to ask "what did you just do and why?" and get a clear, honest answer. You should be able to see how everything connects — flows, tools, DB, which model made which decision. Transparency and explainability are first-class features, not afterthoughts.

---

## The Problem Right Now

The system is built around **outcomes** — what tool was called, what result came back, did it succeed. What it doesn't capture is **reasoning** — why the agent chose that path, what it was trying to accomplish, what it considered and rejected.

When a flow fails or does something unexpected, you currently have to reconstruct what happened from:
- Raw message logs (noisy, not linked to anything)
- `flow_runs` rows (input/output/success — no "why")
- `action_log` rows (dedup guards — no causal context)
- Goals table (what the agent was working toward — not linked to runs)

These four things are stored separately with no links between them. The "why" that existed in the agent's reasoning moment-to-moment gets thrown away between turns.

---

## What Needs to Exist

For "what did you just do and why?" to be answerable, you need three things:

1. **Reasoning stored** — the agent's internal monologue before each tool call, persisted alongside the call itself
2. **Everything linked** — goal → run → flow calls → DB writes, as a causal chain
3. **Surfaces to read it** — a UI that presents this chain as a narrative, not a log dump

---

## The Data Model Gap

### What exists today

| Table | What it stores | What's missing |
|---|---|---|
| `runs` | status, trigger, tokens, cost | which goals it was working on; which model |
| `messages` | raw conversation content per run | not linked to `flow_runs`; reasoning not extracted |
| `flow_runs` | input, output, success, error, duration | no reasoning; no goal link; no model tag |
| `action_log` | dedup history per action | no run link; no reasoning |
| `goals` | what the agent is trying to do | not linked to which runs or flow calls they triggered |
| `rows` (user tables) | data the agent writes | no attribution — can't tell which run wrote a row |

### What was added

| What | Where | Why |
|---|---|---|
| `reasoning` text | `flow_runs` | The assistant message before the tool call — *why* the agent decided to run this flow |
| `goalId` | `flow_runs` | Which goal triggered this run — closes the goal → flow call link |
| `modelId` | `flow_runs`, `runs` | Which model (cheap autonomous vs expensive interactive) made the decision |
| `runId` | `rows` (user tables) | Attribution — which run wrote this row to the DB |

---

## Tasks

### T1 — Capture reasoning text on flow_runs
**Status: `done`**

**What:** Added a `reasoning` column to `flow_runs`. When the orchestrator calls a flow, the assistant message text immediately preceding the tool call is extracted and stored alongside the `input`/`output`.

**Why it matters:** This is the single highest-leverage change. It's the "why" in "what did you just do and why?" Right now that text exists in the `messages` table in raw form but it's buried in JSON, not linked to the specific flow call, and not surfaced anywhere. Extracting and storing it separately makes it immediately queryable.

**Where it can fail:** The orchestrator calls multiple tools in parallel sometimes. The "reasoning" for a batch of tool calls is a single assistant message with multiple tool_use blocks — the reasoning is attributed to all of them (the text block before the whole batch). If the agent's message is mostly just a tool call with no prose, `reasoning` will be empty — that's fine and expected for mechanical steps.

**What was implemented:**
- `reasoning TEXT` column on `flow_runs` in schema + migration
- In `orchestrator/index.ts`, before the tool loop, extract text content blocks from the last assistant message
- Pass `reasoning` through `FlowContext` → `finalize()` in flow-runner.ts
- Same extraction added to `autonomous.ts` for the autonomous loop

---

### T2 — Link flow_runs to goals
**Status: `done`**

**What:** When the autonomous agent calls a flow while working on a goal, records which `goalId` triggered it. Added `goalId` column to `flow_runs`.

**Why it matters:** Right now you can see that a flow ran, but not *why* it ran. Was it working toward the "engage 5 new contacts this week" goal? The "monitor competitor posts" goal? Without this link, the run history is a list of events with no narrative structure. With it, you can answer: "everything the agent did this session for goal X."

**Where it can fail:** The goal ID extraction is heuristic — it parses UUID patterns from the agent's reasoning text (the agent writes goal IDs in `[uuid]` format from `list_goals` output). If the agent doesn't reference a goal UUID in its reasoning text for a given turn, `goalId` will be null. This is acceptable — not every flow call is goal-directed.

**What was implemented:**
- `goalId TEXT` (nullable) on `flow_runs` in schema + migration
- `goalId` added to `FlowContext` interface in flow-runner.ts
- In `autonomous.ts`, extract UUID from reasoning text and pass as `goalId` through context

---

### T3 — Tag every run and flow_run with the model that made the decision
**Status: `done`**

**What:** Added `modelId` to both `runs` and `flow_runs`. For `runs`, it's stamped when the run starts (from `agent.model`). For `flow_runs`, it's the model that decided to call that flow.

**Why it matters:** The autonomous loop uses a cheaper, faster model (Haiku) for background decisions. The interactive chat uses the full model. A flow run triggered by the cheap autonomous loop is a materially different quality of decision than one triggered interactively. When something goes wrong, knowing which model made the call tells you whether to fix the instructions or whether it was just a cheap-model shortcut. Right now you can't tell.

**Where it can fail:** The model name recorded on `flow_runs` is the *orchestrator's* model. In rare cases (e.g. if the agent config changes mid-session) these might not be perfectly accurate. But for practical diagnosis purposes, this is good enough.

**What was implemented:**
- `modelId TEXT` on `flow_runs` and `runs` in schema + migrations
- In `orchestrator/index.ts`, stamp `agent.model` when the run transitions to `running`
- In `autonomous.ts`, pass `AUTONOMOUS_MODEL` constant through context to flow calls

---

### T4 — Attribute DB row writes to the run that caused them
**Status: `done`**

**What:** Added `runId` and `flowRunId` columns to the `rows` table. When a flow calls `insert_row`, the current `runId` is recorded.

**Why it matters:** When you look at a table and see a row that shouldn't be there, or a contact record that was updated unexpectedly, you currently have no way to trace back to what caused it. With run attribution, you can trace back: "Written by flow `comment_on_post`, run #xyz, model: haiku."

**Where it can fail:** `flowRunId` on `rows` is not currently populated — `insert_row` is a management tool that doesn't go through the flow runner (which has the `flowRunId`). The `runId` attribution is done, but `flowRunId` will remain null for rows inserted via the management tool. Rows inserted by flow steps (if that path exists) would have `flowRunId` available.

**What was implemented:**
- `runId TEXT`, `flowRunId TEXT` (nullable) on `rows` in schema + migrations
- In `handleInsertRow()` in `orchestrator/index.ts`, pass the current `runId`

---

### T5 — "Explain this run" endpoint
**Status: `done`**

**What:** `GET /runs/:runId/explain` — takes a run ID, reads the full message thread + all linked flow_runs + goals, feeds it to Claude Haiku, and returns a plain-English narrative: "Here's what I was doing, what I found, what I decided, and why."

**Why it matters:** Even with reasoning stored in the DB, reading raw JSON is exhausting. The explanation endpoint synthesizes everything into a readable story. It's the difference between reading a server log and reading a commit message. This is what you call when you look at a run and think "I don't understand what happened here."

**Where it can fail:** The synthesis quality depends on how much reasoning was captured (T1 and T2). If reasoning is empty or goals aren't linked, the explanation will be shallow — more of a "what" than a "why." Also, calling Claude Haiku to explain a run costs a few cents of tokens — fine for occasional debugging, shouldn't be called on every run automatically.

**What was implemented:**
- New route `GET /runs/:runId/explain` in `routes/explain.ts`
- Fetches: the run's messages (last 30), all flow_runs, linked goals, linked DB writes
- Builds a structured context block and asks Haiku to summarize in plain language as first-person prose
- Returns `{ narrative, flowsCalled, goalWorkedOn, modelUsed, flowRunCount, dbRowsWritten }`
- Also added `GET /runs/:runId/flow-runs` to support the trace view UI (T7)

---

### T6 — "Why did you call X?" as a chat capability
**Status: `done`**

**What:** When you ask the agent in chat "why did you call `post_comment` just now?" or "what were you thinking when you skipped that contact?", it can look up its own reasoning from the stored records and give you a concrete answer rather than a reconstruction from memory.

**Why it matters:** This is the UX payoff for T1. Storing reasoning is pointless if you can't ask about it conversationally. The agent should be able to query its own trace the same way it queries the action log or memory.

**Where it can fail:** The quality of the answer is only as good as the reasoning that was captured. If the agent called a flow mechanically (no text block before the tool call), `reasoning` will be null and the response will just show the outcome. The agent also doesn't know its own current `runId`, so `explain_flow_run` returns the most recent runs by recency, not necessarily the ones from the current session.

**What was implemented:**
- `explain_flow_run` added to `MANAGEMENT_TOOL_NAMES` and tool definition list in `orchestrator/index.ts`
- Handler queries `flow_runs` for the agent, filters by flow name and/or timestamp, returns reasoning/goal/model/outcome for each
- `MEMORY_SYSTEM_ADDENDUM` updated: rule 5 says "when the user asks WHY you did something, call explain_flow_run immediately — do not reconstruct from memory"
- Tool definition includes guidance on when to use it

---

### T7 — Run trace view in the UI
**Status: `done`**

**What:** A new "Trace" tab that shows all recent runs as a causal timeline. Each run shows its trigger, status, model, cost, and input. Click to expand and see the flow calls with reasoning, goal, model, duration, and eval result. Click "Explain this run" to get the Haiku-generated narrative.

**Why it matters:** The current run history is a flat list. You can't see how flow calls relate to each other or to the goal the agent was working on. The trace view makes that structure visible at a glance.

**Where it can fail:** The view is only as rich as the data that was captured. Runs from before T1–T4 were deployed will show flow calls but no reasoning, goal, or model info — those fields will be null. That's expected: the data improves going forward. The "Explain" button costs tokens, so it's gated behind a click.

**What was implemented:**
- New `RunTraceTab.tsx` component with expandable run rows
- Each run shows: trigger badge, status badge, model tag, cost, relative timestamp, input snippet
- Expanded view: flow call cards with reasoning, goal ID, model, duration, eval result, output snippet
- "✦ Explain this run" button that calls `GET /runs/:runId/explain` and shows the narrative inline
- Added to `AgentLayout.tsx` as `{ path: 'trace', label: 'Trace' }` tab
- New `api.getRunFlowRuns(runId)` and `api.explainRun(runId)` methods in client

---

### T8 — Connected "agent brain" view
**Status: `done`**

**What:** A "Brain Map" tab that shows everything connected: active goals, all flows with their run stats and table connections, and which flows read/write which tables. Not a debug page — a map you can read to understand what the agent actually does and how it's set up.

**Why it matters:** Right now understanding the agent requires jumping between four tabs (Flows, Tools, Tables, Goals) and mentally connecting the dots. This view does the connecting for you. It's the answer to "I want to see how everything connects."

**Where it can fail:** The flows ↔ tables mapping depends on `readsFrom`/`writesTo` fields being populated in flows. If those fields are empty, the table connections section will say "not yet linked to flows." This is the biggest gap — the data only exists if someone filled in those fields in the FlowEditor. Going forward, the flow generator should fill them automatically. The "Explain" link on each flow isn't yet implemented (requires a `GET /flows/:flowId/explain` endpoint that summarizes what the flow does).

**What was implemented:**
- New `AgentMapTab.tsx` with summary bar (goals / flow counts / tables), active goals list, flows grouped by type (action / scrape / other), and tables section showing which flows connect to them
- Each flow card shows: name, badges (pinned / infeasible / human review / approval), description snippet, success rate, run count, avg duration, last run, and read/write table connections
- Each table card shows which flows write to it and which read from it
- Added to `AgentLayout.tsx` as `{ path: 'map', label: 'Brain Map' }` tab

---

## Priority Order

The order tasks were implemented:

1. **T1 (reasoning on flow_runs)** — unlocks every "why" question immediately, low effort ✓
2. **T3 (model tagging)** — trivial to add, immediately useful for diagnosing cheap-model failures ✓
3. **T2 (goal linkage)** — heuristic extraction, closes the goal → flow call link ✓
4. **T4 (DB attribution)** — runId on rows, traces DB writes back to their origin ✓
5. **T5 (explain endpoint)** — usable as soon as T1 exists; lets you inspect any past run ✓
6. **T6 (chat capability)** — turns T1 data into a conversational interface ✓
7. **T7 (trace view)** — frontend; surfaces T1–T5 data in a readable timeline ✓
8. **T8 (brain map)** — frontend; shows the whole agent structure connected ✓

---

## What Won't Work Until Other Things Are Done

- **T8 table connections** are only populated if `readsFrom`/`writesTo` fields are filled in flows. The flow generator should ideally fill these automatically.
- **T2 goal linkage** is heuristic — if the agent's reasoning doesn't contain a UUID, `goalId` stays null. A more reliable approach would be explicit goal tracking in the autonomous loop (pass `currentGoalId` as a first-class session variable).
- **T4 flowRunId on rows** is not yet set — `insert_row` is a management tool outside the flow runner and doesn't have a `flowRunId` in context. Only `runId` is tracked currently.
- **T7 "Explain" quality** is shallow for older runs (pre-T1 deployment) since reasoning fields are null.

The right sequence was: capture data first (T1, T3, T2, T4), then surface it (T5, T6), then build the full picture (T7, T8). That's what was done.
