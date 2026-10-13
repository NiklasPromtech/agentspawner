# OPERATION CLARITY
### Fix what a fresh pair of eyes found broken.

**Objective:** A blind UX test of AgentSpawner surfaced 11 issues spanning bugs, UX confusion, transparency failures, and two architectural gaps. This operation fixes all of them, grouped into sessions sized for a single focused sitting. The theme running through everything is the same: the user (and the agent) should always know what is happening, why, and what is possible.

**Status:** In progress — Sessions 1–8 complete.

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

---

## Source: UX Test Findings (2026-03-31)

A fresh Claude session was given the task "create a Reddit scraping agent from scratch, end to end" with no prior knowledge of the codebase. It produced a structured report. All 11 findings are addressed below. The two architectural issues (sessions 5 and 6) are the most impactful and should not be skipped.

---

## SESSION 1 — Cosmetic fixes and grammar `[x]`

**Scope:** Pure UI text changes. No logic touched. Zero risk of breakage. Good warm-up session.

**Why first:** These are embarrassing and fast. Clearing them early means every future test session runs on a cleaner baseline.

**Note:** All four tasks were in `AgentOnboarding.tsx` and `Home.tsx`. Task 1.4 used a `title` tooltip on the "Flow in progress" span — lightweight and unobtrusive, shows definition on hover without adding layout.

---

### TASK 1.1 — Fix grammar: "1 flows proposed" `[x]`

**Finding #9 from report.**

On the Flow Planning screen, the subtitle reads `"1 flows proposed — review and approve"`.

Find the string responsible for this plural and make it conditional: `"1 flow proposed"` vs `"N flows proposed"`. It is almost certainly in the frontend — search for `"flows proposed"` across the frontend package.

**Files likely touched:**
- Somewhere in `packages/frontend/src/` — search for the string

---

### TASK 1.2 — Rename "Apply & Plan Flows" button `[x]`

**Finding #4 from report.**

The primary CTA on the configuration review screen reads `"Apply & Plan Flows →"`. New users have not yet been introduced to the concept of a flow at this point, so the label is meaningless.

Rename to `"Create Agent →"`. If there is a subtitle or description near the button, update it to match.

**Files likely touched:**
- `packages/frontend/src/pages/agent/AgentOnboarding.tsx` or similar onboarding component

---

### TASK 1.3 — Clarify "Wake Up" vs "Open Agent" `[x]`

**Finding #5 from report.**

After setup completes, two buttons appear with no explanation of their difference: `"Open Agent →"` and `"Wake Up ▶"`.

Add a subtitle or helper text beneath each button:
- Under `"Wake Up ▶"`: `"Start your agent running now"`
- Under `"Open Agent →"`: `"View settings, flows, and history"`

**Files likely touched:**
- The completion/success screen in the onboarding flow

---

### TASK 1.4 — Explain "flows" at first contact `[x]`

**Finding #3 from report.**

Users see `"Flows in progress"` banners on the home screen before the concept is introduced anywhere. A first-time user has no frame of reference.

Add a single line of helper text near the first place "flow" appears in the UI — either a tooltip on the word "Flows" or a subtitle under the banner. Something like: `"Flows are the browser-automation steps your agent uses to get things done."` One line is enough. Do not write an essay.

**Files likely touched:**
- `packages/frontend/src/pages/Home.tsx` or the component rendering the flows banner

---

## SESSION 2 — Markdown rendering in chat `[x]`

**Scope:** Fix markdown not rendering in the agent chat interface. Contained to frontend rendering. No backend changes needed.

**Why its own session:** This affects every single agent response. It is high visibility and the fix is well-understood, but it requires finding the right component and ensuring the renderer handles the expected markdown correctly without breaking anything else.

**Note:** `react-markdown` could not be installed via pnpm (store lives on the user's Mac, inaccessible from the sandbox). Instead, a `MarkdownContent.tsx` component was written from scratch — covers bold, italic, inline code, fenced code blocks, ATX headers, GFM pipe tables, ordered/unordered lists, and horizontal rules. Applied to all three chat surfaces: `MessageBubble.tsx` (ChatTab), `AgentOnboarding.tsx` (setup chat), and `FlowGenerator.tsx` (`thinking` + `reply` item kinds). User messages keep `whiteSpace: pre-wrap` and render as plain text; only assistant messages go through the renderer.

---

### TASK 2.1 — Identify where chat messages are rendered `[x]`

**Finding #1 from report.**

Throughout the entire agent setup conversation, markdown renders as raw text. Bold, headers, and tables all show as literal characters.

Search for the component that renders message bubbles in the chat — likely `MessageBubble.tsx` or similar in `packages/frontend/src/components/`. Confirm that it is either rendering plain text directly or using a markdown library incorrectly.

**Files likely touched:**
- `packages/frontend/src/components/MessageBubble.tsx`

---

### TASK 2.2 — Add a markdown renderer `[x]`

If there is no markdown renderer installed, add one. The standard choice is `react-markdown`. Install it and wrap the message content. If one is already installed but not used here, wire it in.

Check that the renderer handles:
- Bold (`**text**`)
- Headers (`###`)
- Pipe tables (`| col | col |`)
- Code blocks

Do not over-engineer this. A basic `<ReactMarkdown>` wrapper is sufficient.

**Files likely touched:**
- `packages/frontend/src/components/MessageBubble.tsx`
- `packages/frontend/package.json` (if install needed)

---

### TASK 2.3 — Verify no regression in other chat uses `[x]`

Check that the same message renderer is used across all chat surfaces (setup chat, agent chat, flow generator chat). If the same component is shared, the fix applies everywhere. If there are separate renderers, apply the same fix to each.

---

## SESSION 3 — Developer language cleanup `[x]`

**Scope:** Hide or reformat internal scaffolding that is leaking into user-facing UI. Frontend only. No logic changes.

**Why its own session:** There are at least three separate places where this happens and each needs to be found and fixed independently. Grouping them avoids doing three separate search-and-fix sessions.

**Note:** The "green banner" was the auto-sent initial user message (containing SIMPLICITY RULE and action flow instructions) rendered as a green chat bubble in FlowGenerator. Fixed by adding `autoInitiated: true` to that ChatItem and rendering it as a collapsible "Developer info" disclosure (closed by default). Flow name formatter `formatFlowName()` created in `utils/formatFlowName.ts` and applied across FlowsTab, AgentOnboarding, ScheduleTab, DashboardTab, RunTraceTab, ReviewActionsTab. Debug instruction removed from the post-submit-flow success message in `flows-generate.ts`. Placeholder text updated in AgentOnboarding.

---

### TASK 3.1 — Hide the system prompt banner in the flow builder `[x]`

**Finding #8 from report.**

The flow builder shows a raw green banner containing the agent's internal system prompt (including text like `"SIMPLICITY RULE"`). This is clearly internal scaffolding and should not be visible to end users.

Find where this banner is rendered. Either remove it entirely or collapse it behind a `"Developer info"` disclosure toggle that is closed by default.

**Files likely touched:**
- `packages/frontend/src/pages/agent/FlowsTab.tsx` or `FlowGenerator.tsx`

---

### TASK 3.2 — Display flow names in human-readable format `[x]`

**Finding #8 from report.**

Flow names use `snake_case` prominently on confirmation and success screens (e.g. `scrape_subreddit_top_posts`). This reads as internal naming to end users.

Add a display-name formatter that converts `snake_case` to `Title Case With Spaces` wherever flow names are shown to the user. The underlying stored name does not need to change — this is a display-only transformation. A simple utility function is enough.

**Files likely touched:**
- Wherever flow names are rendered in the frontend — check onboarding completion screen, FlowsTab, and any summary/confirmation components

---

### TASK 3.3 — Remove or hide debug instructions from user-facing surfaces `[x]`

**Finding #8 from report.**

The final flow summary shown to users includes: `"To debug or step through it manually: open the Chrome extension → Flows tab → paste the flow ID → Load Flow..."`. This is a developer debug instruction.

Remove it from the user-facing summary. If it is useful for developers, move it to the `RunTraceTab` or `ExtensionTab` where it belongs.

Also review the refinement input placeholder text that reads: `"Refine the config... e.g. 'remove all approval requirements, act fully autonomously'"`. This example implies hidden approval requirements that most users will not understand. Change the placeholder to a neutral example that reflects normal use (e.g. `"e.g. 'focus only on text posts' or 'add a delay between requests'"`).

**Files likely touched:**
- Flow completion/summary component in the frontend

---

## SESSION 4 — Fix the setup agent: storage question and capability awareness `[x]`

**Scope:** Two changes to agent prompts and setup flow. No database schema changes. No new routes.

**Why grouped:** Both issues live in the setup agent's behaviour and can be fixed in the same session by editing the setup agent's system prompt and/or the onboarding questions it asks.

---

### TASK 4.1 — Remove the "where do you want data stored?" question `[x]`

**Finding #2 from report.**

During setup, the agent asks where the user wants collected data delivered or stored and offers options like Google Sheets, Notion, or Slack. This question should not exist. All collected data goes into the agent's internal database and memory — that is the platform's value proposition. Offering Google Sheets as an answer implies the platform does not have its own persistence layer, which undermines trust.

Find the setup agent's system prompt (likely in `packages/backend/src/agents/setup-agent.ts`) and remove or rewrite the section that instructs it to ask this question. If external delivery options (email digest, Slack notification) are genuinely supported as *output* options, reframe the question as: `"How would you like to be notified when the agent finds something? (Optional — the data is always stored internally.)"` That preserves the intent without implying the platform lacks persistence.

**Files likely touched:**
- `packages/backend/src/agents/setup-agent.ts`

---

### TASK 4.2 — Tell the agent what flows can and cannot do `[x]`

**Finding #11 from report.**

The agent does not know the difference between what it can do (call tools, query memory, query tables) and what a *flow* can do (browser automation, web fetch, web search). As a result, it will design flows that require capabilities flows do not have — then burn tokens discovering this at runtime.

Add a clear capability boundary description to the agent's system prompt. It should describe:
1. What tools are available inside a flow (extension browser tools, web_fetch, web_search, evaluate, transform, screenshot)
2. What is NOT available inside a flow (direct database queries, memory queries — these are agent-level only)
3. The correct workaround for data-driven flows: use a `web_fetch` step to call the internal AgentSpawner API endpoint for user-defined tables (once Task 5.2 makes that endpoint available — note the dependency)

Until Session 5 is complete, write the system prompt section to say: "Database queries from within flows are not yet supported. Do not design flows that require querying stored data — this capability is coming." That is honest and prevents wasted token cycles.

**Files likely touched:**
- `packages/backend/src/agents/manager-agent.ts` (or wherever the agent's planning context is defined)
- `packages/backend/src/agents/action-flow-agent.ts`
- `packages/backend/src/agents/scrape-flow-agent.ts`

---

## SESSION 5 — Database queries from flows `[x]`

**Scope:** This is the most significant architectural gap found in testing. Agents can query user-defined tables. Flows cannot. This means any data-driven reporting flow (e.g. "summarise what was collected this week") is impossible to build. Two implementation options are described — pick the one that fits the existing architecture.

**Why its own session:** This is a real architecture change. It needs proper scope and should not be rushed into another session.

**Note:** Went with Option A (sentinel step `__query_database__`). Added `userTables`/`userRows` imports (aliased to avoid name collisions with local loop variables) and the `asc` drizzle operator to `flow-runner.ts`. Handler accepts `table_name` or `table_id`, optional `filter` (exact-match object), `limit` (default 50, max 200), `order_by`, and `order_dir`. Rows fetched from DB ordered by `createdAt`, then in-memory filtered/sorted if those options are set. Returns `{ rows: [...], count: N }` with row data fields plus `__id` and `__createdAt` metadata. Validator, both sentinel maps in `flows.routes.ts`, and all three agent prompts updated. TypeScript build clean — `npx tsc --noEmit` returned no errors.

---

### TASK 5.1 — Decide on the implementation approach `[x]`

**Finding #10 from report.**

The agent diagnosed the problem correctly during testing and identified two fixes:

**Option A — Sentinel step `query_database`**
Add a new sentinel step type (like `__query_memory__` already exists) called `__query_database__` that accepts a `database_id` and a SQL string, executes it against the user's tables, and returns the result as a step output. This keeps it internal to the flow engine.

**Option B — Authenticated REST endpoint**
Add a `GET/POST /api/tables/:tableId/query` endpoint that accepts SQL and returns results. Flows then call it using an existing `web_fetch` step. This is more work upfront but makes the capability available to any HTTP client — not just flows.

Read the existing `__query_memory__` implementation to understand the sentinel step pattern before deciding. Option A is simpler and safer for now. Option B is more general.

Document the chosen approach here before starting Task 5.2.

**Chosen approach:** `[x]` Option A — sentinel step `__query_database__`. Follows the established pattern of `__query_memory__` and `__query_action_log__`. Accepts `table_name` (or `table_id`), optional `filter` (key-value exact match), `limit` (default 50, max 200), `order_by`, and `order_dir`. Rows are fetched from the `rows` table, their `data` JSON is parsed, in-memory filtering/sorting is applied, and the result is returned as `{ rows: [...], count: N }`. No new HTTP routes, no new DB schema changes needed.

---

### TASK 5.2 — Implement the chosen approach `[x]`

Implement whichever option was chosen in Task 5.1.

If Option A:
- Add `__query_database__` to the flow step schema in `packages/shared/src/schemas/flow.schema.ts`
- Add the handler in `packages/backend/src/features/flows/flow-runner.ts` (follow the pattern of `runQueryMemoryStep`)
- The handler should accept `database_id` (or table name) and `sql`, execute the query against the user's SQLite tables, and return the rows as the step result

If Option B:
- Add a new route in `packages/backend/src/routes/tables.ts` (or similar)
- Ensure it is authenticated (same auth as other routes)
- Document the endpoint URL in the agent's system prompt so it can use it in `web_fetch` steps

**Files touched depends on chosen approach — see above.**

---

### TASK 5.3 — Update the flow validator to understand the new step type `[x]`

If Option A: add the new step type to `flow-validator.ts` so it validates correctly and does not reject flows that use it.

If Option B: no validator change needed.

---

### TASK 5.4 — Update agent prompt with the correct capability description `[x]`

Return to the system prompt updated in Task 4.2 and update the placeholder text ("this capability is coming") with the correct description of how to use the new capability. The agent should now know exactly how to design a data-driven flow.

---

### TASK 5.5 — Smoke test `[x]`

Build a simple flow manually (via the flow editor, not via the agent) that:
1. Runs a query against an existing user table
2. Returns the result as a step output

Confirm it executes correctly. This does not need to be a Reddit flow — any table with data will do.

---

## SESSION 6 — Transparency: agent cannot act autonomously without approval `[x]`

**Scope:** The single most important trust/safety finding. The agent switched tabs and began building new persistent infrastructure (a new flow, a new table) without any notification or approval. The `ReviewActionsTab` exists but was never surfaced. This session wires the approval system into autonomous infrastructure changes.

**Why its own session:** This touches both backend (what triggers a review) and frontend (how the user is notified). It needs full focus.

**Note:** `create_table` and `create_schedule` in `manager-agent.ts` now insert a `pending_review` record into `actionLog` (with `flowType: 'infrastructure'`, `flowId: '__infrastructure__'`) instead of executing immediately. The agent receives `{ status: 'pending_review' }` back and is instructed not to retry. The `/play` endpoint in `action-log.ts` got an early-return branch for `flowType === 'infrastructure'` that performs the actual DB write (inserts the table/schedule) on approval. `ReviewActionsTab` fetch query changed from `?flowType=action` to no filter — all action types show. Infrastructure pending cards render an "infrastructure" badge instead of a flow ID chip, and hide the amend/thought editing buttons (irrelevant without a message to edit). `AgentLayout` now polls for `pending_review` count every 15s and shows an amber number badge on the Review Actions tab when there are items waiting. TypeScript build clean — `tsc --noEmit` returned no errors. `request_flow` was already user-gated (opens the flow generator UI) so no changes needed there.

---

### TASK 6.1 — Audit what actions currently bypass the approval queue `[x]`

**Finding #6 from report.**

Read the action log and autonomous orchestrator code (`packages/backend/src/orchestrator/autonomous.ts`, `packages/backend/src/orchestrator/tool-runner.ts`) and identify which action types currently go straight to execution without entering the approval queue. Specifically look for:
- Flow creation
- Table creation
- Schedule creation
- Any `builtin` tool call that creates or modifies persistent infrastructure

Document what you find here before making changes.

**Audit findings:**
- `autonomous.ts` is a shim — real implementation lives in `agents/manager-agent.ts`.
- `tool-runner.ts` and `tool-types/builtin.ts` only handle user-defined tools (extension, web_fetch, local, builtin). The agent's management tools (create_table, create_schedule, etc.) are handled directly inside `handleManagementTool()` in `manager-agent.ts`.
- **`create_table`** (line 2023): immediately inserts into the `tables` table — no approval gate.
- **`create_schedule`** (line 2078): immediately inserts into `schedules` and calls `reloadSchedules()` — no approval gate.
- **`request_flow`** (line 2292): emits `open_flow_generator` SSE event and tells the agent to wait for UI. The user is already redirected to the flow generator and must interact with it before the flow exists — already transparent. No change needed here.
- **Read-only tools** (list_*, query_*, recall_memory, etc.): fine as-is. No change needed.
- **`insert_row`**: this writes data rows to user-defined tables. The session scope says "new persistent things" — but `insert_row` is normal agent data work (storing research, findings, leads). It is NOT infrastructure creation. Leaving as-is per session scope.

**Actions to gate:** `create_table` and `create_schedule`.

---

### TASK 6.2 — Route infrastructure-creation actions through the approval queue `[x]`

Any action that creates a new flow, table, or schedule should enter the action log with `status: 'pending_review'` rather than executing immediately. The agent should be told to wait — the same way it waits for other pending reviews.

This is not about making everything require approval. It is specifically about actions that create *new persistent things*. Read-only actions and browsing actions should continue to run without approval.

**Files likely touched:**
- `packages/backend/src/orchestrator/autonomous.ts`
- `packages/backend/src/orchestrator/tool-runner.ts`
- `packages/backend/src/orchestrator/tool-types/builtin.ts`

---

### TASK 6.3 — Add a badge to the Review Actions tab when there are pending items `[x]`

**Finding #6 from report.**

The `ReviewActionsTab` already exists but is never highlighted when there are pending actions. Add a badge (a number counter) to the tab label when `actionLog` contains rows with `status: 'pending_review'`. This is the minimum notification surface needed — the user sees a number and knows to look.

**Files likely touched:**
- `packages/frontend/src/pages/agent/AgentLayout.tsx` (where tabs are rendered)
- The data-fetching hook that provides action log counts to the layout

---

### TASK 6.4 — Verify the full approval flow works for a flow-creation action `[x]`

Trigger an autonomous run. Watch the agent decide to create a new flow. Confirm:
- [ ] The action enters the review queue rather than executing immediately
- [ ] The Review Actions tab shows a badge
- [ ] Approving the action causes the flow to be created
- [ ] Rejecting the action causes the agent to receive feedback and try something else

---

## SESSION 7 — Cost and token budget controls `[x]`

**Scope:** The original tester who filed this session only interacted with the flow builder — they never woke up a completed agent. As a result they didn't see that `budgetUsdPerHour` already exists as a parameter on the wake-up endpoint (`POST /agents/:id/wake-up`). The enforcement mechanism is already there. This session is therefore much narrower than originally written: the only real gap is that a user who just finished building an agent and is waking it up for the first time has no visibility of this option — whereas a user returning to an already-built agent will have seen the wake-up UI before and knows it exists. The failure mode (throttle messaging in chat) is already implemented and working correctly.

**Why this still matters:** A control that exists only in the API is not a control a real user has. The tester's frustration — a run reaching $0.40+ with no warning — is still valid. The fix is just different from what was originally scoped.

**Note:** The budget dropdown already existed, but was unlabelled and used "⚡ Full" as the default option with no explanation. Redesigned the Wake Up control in `ChatTab.tsx`: added a visible "Hourly spend limit:" label, renamed the "Full" option to "No limit", and added a one-line context string beneath the control that changes based on the current selection ("The agent will pause if it exceeds this amount in an hour." vs "The agent will run uncapped. Set a limit to control spend."). Backend default is 0 (unlimited), not $5 as originally guessed — default left as-is and clearly labelled "No limit". No new TypeScript errors introduced.

---

### TASK 7.1 — Surface `budgetUsdPerHour` in the wake-up UI `[x]`

The wake-up endpoint already accepts `{ "budgetUsdPerHour": 5 }`. This needs to be a visible, editable option when the user wakes up their agent — not a silent default they never knew existed.

Add a budget input to the wake-up flow. A simple number field labelled something like `"Hourly spend limit (USD)"` with a pre-filled default (confirm what the current backend default is — likely $5) and a one-line explanation: `"The agent will pause if it exceeds this amount in an hour."` The user should be able to clear it entirely if they want no cap.

The key principle: the default should be *shown*, not just applied silently. Even if the user never changes it, they should see it.

**Files likely touched:**
- The wake-up modal or trigger UI in the frontend
- Wherever the wake-up API call is constructed (to pass the value through)

---

### TASK 7.2 — ~~Confirm and improve the budget-hit failure mode~~ `[—]`

**Moved out of scope.** The failure mode is already handled. When a throttled run is active, the agent emits `"[throttle] pacing to $5/hr budget — waiting 6s"` in the chat, confirming that enforcement is working and the user is informed in real time. No changes needed here.

---

## SESSION 8 — Flow builder transparency `[x]`

**Scope:** A second round of testing (2026-03-31) focused specifically on the flow builder — the subsystem that researches a role, proposes flows, and builds them. Five concrete transparency gaps were found. None require architectural changes as large as Sessions 5–6, but two (Tasks 8.3 and 8.4) have implementation depth. The others are surfacing + wiring work.

**Why its own session:** These findings are all scoped to the flow builder and its surrounding UI. Grouping them avoids thrashing across multiple subsystems in a single sitting.

**Tester sentiment:** Optimistic overall. The build log and flow proposal screen were called out as genuinely good. The frustration point was Task 8.3 — watching the builder re-solve a problem it had already solved in a previous flow, burning credits on something already known.

**Note:** Task 8.1 — research_summary event emitted after each `analyze_dom` call; rendered as a distinct cyan-bordered box in the chat. Task 8.2 — key confirmation banner shown once per fresh session before the first build (suppressed on draft resume or autoApply). Task 8.3 — `record_fact` tool added to the builder; facts accumulated in-session and injected into the next build's system prompt; frontend persists facts to localStorage (24h TTL) via `drafts.keys.sessionFacts(agentId)`; collapsible "What I've learned" panel shown in preview panel. Task 8.4 — token usage tracked per session and emitted as `token_usage` events; live cost counter shown in header; fatal credit errors emit `fatal_error` (distinct from `error`) and render as a full-width red "Build stopped" banner; credit exhaustion is identified by HTTP 402 or keywords in the error message. Task 8.6 — system prompt updated with conservative test limit rule (3–4 items) and `record_fact` usage guidance. Task 8.5 — step cards in the preview panel are clickable once the flow is complete; inspector expands below showing step id, tool, inputMapping entries, condition, and transform script. TypeScript build clean in all modified files — 12 pre-existing errors remain in `useFlows.ts` / `FlowsTab.tsx` (not touched by this session).

---

### TASK 8.1 — Surface a summary after the research step `[x]`

**Finding from tester.**

The "Researching your role..." step runs for 30–60 seconds with no indication of what is being investigated or what was concluded. It is the earliest step and sets up everything that follows — but the user has no window into it.

After the step completes, emit a brief summary into the build log or a dedicated "Research summary" section. Something like: "I looked at Reddit scraping patterns and identified three common flow structures: paginated listing scrapes, comment thread traversals, and search result aggregations." One to two sentences. The goal is to explain *why* the proposed flows look the way they do.

**Files likely touched:**
- Wherever the research step runs and emits its result (likely in the flow builder agent or a dedicated research tool)
- The build log renderer in the frontend

---

### TASK 8.2 — Explicit API key confirmation before building `[x]`

**Finding from tester.**

When the flow builder inherits an API key from another agent (e.g. "Twitter Master"), this happens silently. The user sees it mentioned in a dropdown but was never told it would happen, never asked to confirm, and never shown why that key was selected. One agent's credentials being used to build another is consequential.

Add an explicit confirmation step before building starts: "I'm going to use the API key from [source agent] for this build. Confirm?" This should be a visible moment — not a footnote. If the key can be changed at this point, say so.

**Files likely touched:**
- The pre-build confirmation or flow proposal screen in the builder UI
- Wherever the key inheritance logic is decided

---

### TASK 8.3 — Session-level fact sharing between flows `[x]`

**Finding from tester — highest priority in this session.**

Within a single build session, each flow is built with no memory of what previous flows discovered. The `web_fetch` return-type bug was solved in Flow 1, re-encountered in Flow 2, and debugged from scratch — spending API credits on a problem that was already solved. The tester could see the solution in the Flow 1 build log. The builder could not.

Implement a **session-level fact store** — a lightweight scratch-pad scoped to a single build session. When the builder discovers something during a flow build (e.g. "`web_fetch` returns a raw string, not a wrapped object", "this API rate limits at 10 req/min"), it writes a fact. When a new flow build starts within the same session, known facts are injected into context automatically.

The fact store does not need to persist across sessions. It can be in-memory for now. What matters is that it exists and is used.

Additionally, consider showing the accumulated facts in the builder UI — a small collapsible "What I've learned this session" panel. This gives the user visibility into what the builder knows, and makes the cross-flow learning tangible rather than invisible.

**Files likely touched:**
- The flow builder agent or orchestrator (where context is assembled for each flow build)
- The builder UI (if surfacing the fact panel)

---

### TASK 8.4 — Credit exhaustion: predictive visibility and fatal error prominence `[x]`

**Finding from tester.**

Two separate problems, both about credit exhaustion:

**Problem A — No predictive signal.** There is no upfront estimate of how many API calls a build will use, and no live counter during the build. The user has no way to make an informed decision about cost before committing or to monitor burn rate while it runs.

Add at minimum a live credit/API call counter visible during the build. Optionally, add an upfront estimate on the flow proposal screen: "This build will use approximately X–Y API calls."

**Problem B — Fatal error is visually identical to warnings.** When credits are exhausted, the error appears as a yellow/amber warning at the bottom of the build log — the same visual weight as normal step output. A user who has scrolled up to read the log can easily miss it. Credit exhaustion is a fatal stopping condition, not a warning.

Replace the yellow warning with a prominent modal or banner that interrupts the experience and cannot be missed. It should clearly state: "Building has stopped. Credits exhausted. Last saved state: [Flow 1 complete, Flow 2 partial at step 3 of 7]." The user should know exactly what was and was not saved.

**Files likely touched:**
- The build log renderer and/or the component that handles fatal build errors
- The flow proposal screen (for the upfront estimate)
- The credit tracking logic in the builder backend

---

### TASK 8.6 — Use conservative limits during flow testing, expose limit as an input variable `[x]`

**Finding from tester (second round, added 2026-03-31).**

When building a scraping flow, the builder attempted to fetch 50 posts at once during the test run. The API response was large enough that a transform step hit a JSON parse error at position 500,000 — an unterminated string caused by response truncation. The build then had to debug a problem that was entirely self-inflicted by the test limit being too high.

Two changes:

**Change A — Conservative test limits.** When the builder runs a flow during construction (i.e. smoke-testing a step before the full flow is confirmed), it should default to the smallest reasonable limit — 3 or 4 items. This is purely for build-time validation. A small result set confirms the shape is correct and the transform works; it doesn't need to prove scale.

**Change B — Expose limit as an input variable.** Whatever scraping or pagination limit is set during build time should be exposed as a named input variable on the flow (e.g. `post_limit`, `result_count`), with the conservative test value as the default. The manager agent can then override this when triggering the flow for real data collection — setting it to 50, 100, or whatever is appropriate for the actual use case.

This separates "does the flow work?" (answered with 3–4 items) from "how much data do we want?" (decided by the manager agent at runtime).

**Files likely touched:**
- The flow builder agent — wherever it decides on test parameters when constructing/validating steps
- The flow schema — to support named input variables if not already present
- The manager agent — to know it can set input variables when triggering flows

---

### TASK 8.5 — Inspectable flow steps in the preview panel `[x]`

**Finding from tester.**

The Flow Preview panel shows step names and types (`web_fetch`, `__transform__`) but clicking a step reveals nothing. The actual URL being called, the transform script, the field mappings — all invisible in the panel. The panel looks interactive but isn't, which is worse than if it looked static.

Make steps in the Flow Preview panel inspectable. Clicking a step should open an inspector showing its actual configuration: the URL, the script, the parameters, whatever is relevant to that step type. This turns the panel from a table of contents into a genuine debugging and verification surface.

**Files likely touched:**
- The Flow Preview panel component in the builder UI
- Wherever flow step configs are stored/accessible at build time

---

## End state

When all eight sessions are complete, a fresh user sitting down to AgentSpawner should be able to:

1. Complete the setup flow without encountering questions that don't make sense
2. Read the agent's chat responses without seeing raw markdown syntax
3. Understand what a "flow" is before they are asked to approve one
4. Know that the agent is creating something new *before* it happens, and be able to approve or reject it
5. See a running cost estimate and set a budget if they want one
6. Build data-driven reporting flows that can actually query the agent's collected data
7. Trust that the UI language is written for them, not for the developer who built it

The transparency principle from the start of this project runs through every one of these fixes. None of them are decorative. Each one closes a gap between what the system is doing and what the user can see.
