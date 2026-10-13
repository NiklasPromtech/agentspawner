# AgentSpawner — Codebase Structure

> A detailed technical reference for the entire codebase as of March 2026.
>
> **Last updated:** March 2026, after completing the full refactor (Groups 1–7 of REFACTOR_TASKS).

---

## Table of Contents

1. [Monorepo Overview](#monorepo-overview)
2. [Backend](#backend)
   - [Database Schema](#database-schema)
   - [Orchestrator](#orchestrator)
   - [Flow Runner](#flow-runner)
   - [Feature Modules](#feature-modules)
   - [Routes](#routes)
   - [WebSocket & Extension Bridge](#websocket--extension-bridge)
   - [Supporting Services](#supporting-services)
3. [Frontend](#frontend)
   - [Pages](#pages)
   - [Key Components](#key-components)
   - [Hooks](#hooks)
   - [API Client](#api-client)
   - [State Management](#state-management)
4. [Chrome Extension](#chrome-extension)
5. [Shared Package](#shared-package)
6. [Data Models In Detail](#data-models-in-detail)
7. [Key Execution Flows](#key-execution-flows)
8. [Cross-Cutting Patterns](#cross-cutting-patterns)

---

## Monorepo Overview

AgentSpawner is a **pnpm workspaces monorepo** with four packages:

```
AgentSpawner/
├── package.json              # Root scripts (dev, build, db:generate, db:migrate)
├── pnpm-workspace.yaml       # Workspace package declarations
├── tsconfig.base.json        # Shared TS compiler settings
└── packages/
    ├── backend/              # Fastify server — orchestration engine
    ├── frontend/             # React/Vite SPA
    ├── shared/               # @agentspawner/shared — Zod schemas + types used by both
    └── extension/            # Chrome Manifest v3 extension
```

**Tech stack summary:**

| Layer | Stack |
|---|---|
| Backend runtime | Node.js + Fastify |
| Database | SQLite via Drizzle ORM (WAL mode), migrations in `drizzle/` |
| LLM | Anthropic Claude API (Opus/Sonnet/Haiku) |
| Frontend | React 18 + Vite + Tailwind + TanStack React Query |
| Shared types | `@agentspawner/shared` — Zod schemas for `FlowStep`, `InputExpression`, `FlowSchema` |
| Logging | Pino (`lib/logger.ts`) — structured JSON logging, replaces all `console.*` |
| Extension | Chrome Manifest v3, TypeScript, Vite |
| Language | TypeScript throughout |

---

## Backend

`packages/backend/src/`

### Entry Point

**`index.ts`** — Fastify server startup:
- Registers all route plugins (including feature-module routes for `agents` and `flows`)
- Initializes database (lazy, first request) using Drizzle migrator
- Connects CORS, multipart, websocket plugins
- Starts node-cron scheduler
- Starts Telegram polling if configured
- Registers `GET /health` via `routes/health.ts`
- Installs a `SIGTERM` handler that marks running runs as `stopped` and closes cleanly

**`config.ts`** — Loads from `.env`:
- `PORT` (default 3001)
- `DB_PATH` (SQLite file path)
- `ENCRYPTION_SECRET` (64-char hex for AES-256)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

---

### Database Schema

`packages/backend/src/db/schema.ts` — 18 Drizzle ORM tables.

**Migrations:** Managed via Drizzle's file-based migrator (`drizzle-orm/better-sqlite3/migrator`). Migration SQL files live in `packages/backend/drizzle/`. On startup, `db/index.ts` calls `migrate()` — the migrator is idempotent and tracks applied migrations in `__drizzle_migrations`. The old inline `ALTER TABLE` hack array has been removed.

#### Core agent tables

**`agents`**
The root entity. One agent = one autonomous worker with its own system prompt, API key, and set of flows/tools.

| Column | Type | Notes |
|---|---|---|
| id | text PK | UUID |
| name | text | Display name |
| systemPrompt | text | Full system prompt fed to model |
| model | text | Claude model ID |
| apiKeyEncrypted | text | AES-256 encrypted Anthropic API key |
| telegramKeyEncrypted | text | Encrypted Telegram token |
| suppressionToken | text | e.g., `__done_a1b2c3__` — injected into prompt; if tool returns this exact string, run ends |
| toneGuide | text JSON | Structured tone preferences learned over time |
| createdAt / updatedAt | text | ISO timestamps |

**`agentSecrets`**
Per-agent key-value secrets injected into script-type API tools.

| Column | Notes |
|---|---|
| agentId | FK → agents |
| key | Secret name (e.g., `TWITTER_PASSWORD`) |
| value | AES-256 encrypted at rest (via `crypto/index.ts`). All writes call `encrypt()`, all reads call `decrypt()`. |

---

#### Flow tables

**`flows`**
The central automation primitive. A flow is a named, schema-typed sequence of browser/API/transform steps.

| Column | Notes |
|---|---|
| id | UUID |
| agentId | FK → agents |
| name | snake_case; must not conflict with tool names |
| description | Natural language description for the agent |
| inputSchema | JSON Schema string — defines what params the flow accepts |
| steps | JSON array of `FlowStep` objects |
| returnStepId | Which step's result to return (null = last step) |
| returnSteps | Array of `{key, stepId}` — compose a multi-field return object |
| reasoningModel | If set, run a second Claude call to formulate a final answer |
| flowType | `'scrape'` (read-only) or `'action'` (side-effectful) |
| dedupKeyField | Input field used as the dedup identity (e.g., `'username'`) |
| dedupBreakType | `'hard'` (never repeat) or `'soft'` (cooldown period) |
| dedupIntervalHours | For soft dedup: hours before re-allowing |
| requiresApproval | If true: create `pendingAction` instead of executing |
| requiresHumanReview | If true: pause at `__human_review__` steps |
| infeasible | Boolean — archived as impossible (not exposed to agent) |
| pinned | Boolean — human-approved and preferred |

**`flowRuns`**
Immutable audit log — one record per flow execution.

| Column | Notes |
|---|---|
| flowId / flowName | What ran |
| agentId / runId | Who triggered it |
| input | JSON snapshot of params at invocation time |
| output | JSON result (null if errored) |
| success | Boolean |
| error | Error message |
| durationMs | Wall-clock time |
| evaluationPassed | Result of `__evaluate__` vision check (null if no eval) |
| reasoning | T1: agent's text reasoning before calling this flow |
| goalId | T2: which goal caused this run |
| modelId | T3: which LLM handled the decision |

**`actionLog`**
Deduplication guard for action flows.

| Column | Notes |
|---|---|
| agentId / flowId / flowName | Identity |
| keyField / keyValue | The dedup key (e.g., `username: 'alice'`) |
| blocked | Whether this was blocked by a prior log entry |

---

#### Execution tables

**`runs`**
Top-level execution session (chat, autonomous, scheduled, or telegram-triggered).

| Column | Notes |
|---|---|
| status | `pending \| running \| completed \| failed \| stopped` |
| trigger | `manual \| schedule \| telegram \| autonomous` |
| input | User's initial message or schedule input |
| error | Error details if failed |
| inputTokens / outputTokens / costUsd | Usage tracking |
| modelId | Which model was used |

**`messages`**
Conversation history within a run.

| Column | Notes |
|---|---|
| runId | FK → runs |
| role | `user \| assistant \| tool_result` |
| content | JSON — full Anthropic API message content array |

---

#### Data management tables

**`tables`** + **`rows`**
User-defined data stores. Each `table` has a JSON `columns` schema; each `row` has a JSON `data` field plus attribution back to the `runId` and `flowRunId` that created it.

**`memory`**
Shared knowledge base across agents.

| Column | Notes |
|---|---|
| content | The knowledge text |
| category | `profile \| post \| interaction \| research \| market_data \| web_content \| data \| other` |
| entities | JSON array of entity names for search |
| sourceAgentId / sourceTool / sourceUrl | Provenance |
| rawHash | SHA-256 of content — UNIQUE constraint prevents duplicates |

**`schedules`**
Cron-based recurring runs.

| Column | Notes |
|---|---|
| cron | e.g., `'0 9 * * 1-5'` |
| input | JSON passed as initial message |
| flowId | If set, run a specific flow instead of full orchestrator |
| timezone | IANA timezone |
| lastRunAt | For "never run again before X" logic |

---

#### Agent task management tables

**`goals`**
Hierarchical task system.

| Column | Notes |
|---|---|
| parentId | Enables goal trees (mission → objective → task) |
| type | `mission \| objective \| task` |
| status | `pending \| in_progress \| completed \| blocked \| cancelled` |
| priority | 1 (critical) → 4 (low) |
| notes | Agent updates this with progress |

**`pendingActions`**
Human approval queue.

| Column | Notes |
|---|---|
| type | `dm \| email \| post \| api_call \| other` |
| payload | Full action parameters |
| status | `pending \| approved \| rejected \| completed` |
| resolvedBy | Who approved/rejected |

**`pendingHumanReviews`**
Human review queue for AI-drafted content (comments, DMs, posts).

| Column | Notes |
|---|---|
| draftContent | What the agent wrote |
| tabUrl | Page context |
| contentLabel | Display label |
| finalContent | What the human actually approved |
| rejectionReason | Why rejected |

**`toneEdits`**
Feedback loop — stores (agent draft, human final) pairs to refine tone guide over time.

---

#### Other tables

**`tools`** — Browser automation tools (code evaluated by extension)
**`apiTools`** — Custom HTTP or JS script tools
**`contacts`** — Outreach tracking (platform, handle, status, last action)
**`performanceLog`** — Long-term outcome metrics (success/failure by category)

---

### Orchestrator

`packages/backend/src/orchestrator/`

#### `index.ts` — Standard (chat/manual) orchestrator

`runOrchestrator(runId, agentId, userInput, emit, history)` is the main function. It:

1. Loads the agent, all its tools, flows, API tools, and secrets from DB
2. Builds the Anthropic tool definitions array (browser tools + flows + API tools + management tools)
3. Injects the suppression token into the system prompt
4. Enters a loop:
   - Calls `anthropic.messages.create()` with current history
   - On `stop_reason: 'tool_use'`: dispatches each tool call
   - On `stop_reason: 'end_turn'`: breaks
5. Persists messages and results to DB after each turn
6. Mirrors responses to Telegram if configured
7. Saves final run status

**Management tools exposed to every agent:**
- `recall_memory` — Search shared memory by entity
- `store_memory` — Save new knowledge
- `list_tools`, `list_flows`, `list_api_tools`, `list_tables`, `list_goals`, `list_schedules`
- `query_table`, `insert_row`
- `list_flow_runs`, `explain_flow_run` — Audit trail access

#### `autonomous.ts` — Autonomous (continuous) orchestrator

`runAutonomousOrchestrator(agentId, initPrompt, emit, budgetUsdPerHour)`:

- Uses **Claude Haiku** for cost efficiency ($0.80/$4.00 per M tokens)
- `MAX_ITERATIONS = 1000` — runs until explicitly stopped
- Follows `AUTONOMOUS_META_PROMPT` cycle: ORIENT → QUEUE → GOALS → RECALL → ACT → BUILD → SCHEDULE → REFLECT → STATUS → CHECKIN → STOP
- `compactConversation()` — At 140k input tokens, summarizes and resets history
- Cost tracking — halts if hourly budget exceeded
- Writes session journal entries to memory table

#### `sub-agents.ts` — Flow Builder sub-agent

`runFlowBuilderAgent(userMessage, context)`:
- A dedicated orchestrator instance with flow-building instructions
- Understands browser mechanics, input mapping, step ordering
- Returns a proposal with `steps_summary` and `input_schema`

---

### Flow Runner

**Canonical location:** `packages/backend/src/features/flows/flow-runner.ts`

`packages/backend/src/orchestrator/flow-runner.ts` is a one-line re-export shim (`export * from '../features/flows/flow-runner.js'`) kept for backward compatibility with the 7 callers that reference the orchestrator path.

The flow runner is implemented as a **`FlowRunnerService` class**. Constructor accepts `flow`, `flowInput`, `agentId`, and `context`, and initialises all run-local state. Public entry point is `run()`. The module-level `runFlow` and `runFlowDetailed` functions instantiate the class and call `run()`.

**Private methods:**

| Method | Responsibility |
|---|---|
| `checkDedup()` | Dedup check + human approval queue + human review pause. Returns early `FlowRunResult` or null. |
| `executeSteps()` | Full step loop — resolves inputs, dispatches tools, evaluates conditions, handles sentinels. |
| `resolveInputExpression()` | Resolves a single `InputExpression` against `flowInput` and `stepResults`. |
| `assembleResult()` | Builds final return value from `returnSteps` / `returnStepId` / last-step config. |
| `postRun()` | Writes `actionLog`, decorates result with metadata. |
| `finalize()` | Persists `flowRun` record to DB. |

**Execution flow for `run()`:**
1. `checkDedup()` — returns early if blocked or queued
2. `executeSteps()` — returns early on step failure sentinel, or runs all steps
3. `assembleResult()` — builds final result value
4. Reasoning model delegation (if `flow.reasoningModel` set) — second Claude call
5. `postRun()` — action log + result decoration
6. `finalize()` — DB persistence

**Special step types:**
- `__transform__` — Runs a JS script inside `vm.createContext` with a **2-second timeout**. Sandbox contains only `{ input, result }`; `require`, `process`, and `fs` are not accessible.
- `__evaluate__` — Takes a screenshot, calls Claude with a vision prompt, returns pass/fail

**Error surfacing:** When a `step_ref` path resolves to `undefined`, a descriptive error is thrown containing the field name, path string, step ID, actual type of the step result, and the first 100 chars of the result. The error propagates through `finalize()` as a step-level trace entry.

**Tests:** `packages/backend/src/__tests__/flow-runner.test.ts` — 11 tests covering literal/flow_input/step_ref resolution, path-not-found error, hard dedup block, soft dedup cooldown, min_array_length condition pass/fail, skipToStepId jump, and multi-return assembly.

---

### Feature Modules

Two routes have been moved into feature modules under `packages/backend/src/features/`. Each feature has three layers:

```
features/
├── agents/
│   ├── agents.routes.ts      # Thin Fastify handler (≤55 lines) — parses + delegates
│   ├── agents.service.ts     # Business logic: CRUD, encrypt/decrypt, Telegram, provisioning
│   └── agents.repository.ts  # All Drizzle/SQLite access for agents + tools tables
└── flows/
    ├── flows.routes.ts       # Thin Fastify handler (≤120 lines)
    ├── flows.service.ts      # Business logic: CRUD, Zod validation, cross-ref checks, test runs
    ├── flows.repository.ts   # All Drizzle/SQLite access for flows, flowRuns, agents, tools
    └── flow-runner.ts        # FlowRunnerService class (canonical location)
```

The old `routes/agents.ts` and `routes/flows.ts` have been deleted.

**`flows.service.ts`** also validates flow steps on write:
- `FlowSchema.safeParse()` validates step structure (Zod, from `@agentspawner/shared`)
- `validateStepsAndCrossRefs()` verifies that every `step_ref.stepId` references an existing step in the same flow
- Malformed payloads return `400` with `{ error, details: [{path, message}] }`

---

### Routes

`packages/backend/src/routes/`

| File | Prefix | Purpose |
|---|---|---|
| ~~`agents.ts`~~ | — | Moved to `features/agents/` |
| ~~`flows.ts`~~ | — | Moved to `features/flows/` |
| `runs.ts` | `/agents/:id/runs`, `/runs/:id` | Create runs, stop, wake up (autonomous), SSE stream, messages |
| `flows-generate.ts` | `/agents/:id/flows/generate` | SSE streaming flow generation via Flow Builder |
| `health.ts` | `/health` | Health check: `{ status, db, extension, runningRuns }` — 200 healthy / 503 DB unreachable |
| `tools.ts` | `/agents/:id/tools` | CRUD browser tools, test |
| `api-tools.ts` | `/agents/:id/api-tools` | CRUD API tools, manage secrets |
| `tables.ts` | `/agents/:id/tables` | CRUD user data tables + row management |
| `memory.ts` | `/memory` | Search, create, delete memory entries |
| `schedules.ts` | `/agents/:id/schedules` | CRUD cron schedules |
| `goals.ts` | `/agents/:id/goals` | CRUD goal tree |
| `actions.ts` | `/agents/:id/actions` | Pending actions queue — approve/reject |
| `reviews.ts` | `/agents/:id/reviews` | Human review queue — approve/edit/reject |
| `contacts.ts` | `/agents/:id/contacts` | CRUD outreach contacts |
| `analytics.ts` | `/agents/:id/analytics` | Performance metrics |
| `explain.ts` | `/agents/:id/explain` | Fetch reasoning from flow runs |

**SSE pattern** — both `runs.ts` and `flows-generate.ts` use the `SseStream` class from `lib/sse-stream.ts`:
```typescript
const sse = new SseStream(reply);   // sets headers + attaches close listener
if (!sse.isOpen) return;            // replaces clientDisconnected flag
sse.send({ type: 'event', ... });
sse.end();
```

---

### WebSocket & Extension Bridge

`packages/backend/src/websocket/server.ts`

Manages a persistent WebSocket connection from the Chrome extension:
- Receives `HELLO` on connect, sends `HELLO_ACK`
- Queues `EXECUTE_TOOL` messages for pending tool calls
- Matches `TOOL_RESULT` responses back to waiting orchestrator calls
- Routes tab lifecycle commands (open, close, navigate, wait_load, sleep)

When the extension is not connected, browser tools return a `"extension not connected"` error.

---

### Supporting Services

**`lib/` — shared backend utilities:**

| File | Purpose |
|---|---|
| `lib/logger.ts` | Pino logger instance + `childLogger(bindings)` factory. Respects `LOG_LEVEL` env var. All backend files use this instead of `console.*`. |
| `lib/sse-stream.ts` | `SseStream` class — wraps `FastifyReply`, sets SSE headers, tracks `isOpen` state via `close` listener, exposes `send(event)` and `end()`. Used by `runs.ts` and `flows-generate.ts`. |

**Other services:**

| File | Purpose |
|---|---|
| `crypto/index.ts` | AES-256 encrypt/decrypt using `ENCRYPTION_SECRET`. Used for agent API keys, Telegram keys, and agent secrets. |
| `scheduler/index.ts` | node-cron — fires scheduled runs, updates `lastRunAt` |
| `telegram/index.ts` | Long-poll Telegram bot API, relay messages to orchestrator |
| `memory/librarian.ts` | Background memory writer with SHA-256 dedup |
| `abort-registry.ts` | Tracks `AbortController` per run for stop functionality |
| `nudge-registry.ts` | Supervisor check-in queue for autonomous mode |
| `provision-tools.ts` | Auto-creates default tools when a new agent is created |
| `api-tool-runner.ts` | Runs `script` tools (JS eval in sandbox) and `http` tools (template substitution) |

---

## Frontend

`packages/frontend/src/`

### Pages

**`pages/Home.tsx`** — Dashboard
- Lists all agents with status badges
- Polls every 8s for active autonomous run status
- Shows saved onboarding drafts and flow generator drafts (from localStorage)
- "New Agent", "Chat", "Autonomous Mode" CTAs

**`pages/AgentOnboarding.tsx`** — Multi-step agent setup wizard (1,000+ lines)
- Step 1: Name + system prompt
- Step 2: Model selection
- Step 3: API key entry (or copy from existing agent)
- Step 4: Optional Telegram credentials
- Step 5: Flow planning — AI proposes a set of flows to build
- Step 6+: Sequential flow generation via `FlowGenerator` component
- Persists draft to localStorage per agent
- Back/skip/progress-pill navigation between flow building steps

**`pages/agent/` — Tabbed agent interface** (21 tabs):

| Tab | File | Purpose |
|---|---|---|
| Chat | `ChatTab.tsx` | Conversation with agent, streaming, tool call display |
| Flows | `FlowsTab.tsx` | List, filter, pin, test flows |
| Flow Editor | `FlowEditor.tsx` | Visual step-by-step flow builder (94KB) |
| Flow Generator | `FlowGenerator.tsx` | AI-assisted flow creation via chat (39KB) |
| Tools | `ToolManagerTab.tsx` | Browser tool CRUD + Monaco code editor |
| API Tools | `ApiToolsTab.tsx` | Script/HTTP tool management + secrets |
| Schedules | `ScheduleTab.tsx` | Cron job management |
| Database | `DatabaseTab.tsx` | User data table viewer |
| Goals | `GoalsTab.tsx` | Goal tree (mission/objective/task) |
| Memory | `MemoryTab.tsx` | Memory browser + search |
| Actions | `ActionsTab.tsx` | Human approval queue |
| Reviews | `ReviewsTab.tsx` | Human review + tone feedback |
| Analytics | `AnalyticsTab.tsx` | Performance metrics dashboard |
| Run Trace | `RunTraceTab.tsx` | Flow execution history |
| Setup | `SetupTab.tsx` | Agent config (prompt, model, tone guide, Telegram) |
| Extension | `ExtensionTab.tsx` | Extension connection status |
| Agent Map | `AgentMapTab.tsx` | Visual graph of flows/tools |
| Logger | `LoggerTab.tsx` | Debug log viewer |

---

### Key Components

**`FlowEditor.tsx`** (~285 lines after refactor) — Orchestrates the step-by-step flow definition UI. Now delegates to sub-components in `components/flow-editor/`. Uses `useFlowEditorState` (a `useReducer` hook) for all flow draft mutations. Only retains UI-only state (saving, error, testInput, etc.) and JSX composition.

**Sub-components in `components/flow-editor/`:**

| Component | Purpose |
|---|---|
| `InputMappingField.tsx` | Per-field literal / flow_input / step_ref selector with type sub-fields and hints. Also exports `ExprEditor` for use in `WaitForAnyStepCard`. |
| `ConditionEditor.tsx` | Condition type, value, failMessage, skipToStepId, suggest-tool selectors. Handles `element_exists` branch variant separately. |
| `StepForm.tsx` | Step body: evaluate prompt, human review fields, wait_for_any, input mapping, inline test result, ConditionEditor. Also contains `WaitForAnyStepCard`. |
| `StepCard.tsx` | Outer container: colored border, header row (step number, label, tool badge, move/duplicate/return/delete). Delegates body to `StepForm`. |
| `HumanLoopFlags.tsx` | Requires-approval / inline-review checkboxes. |
| `DedupSettings.tsx` | Dedup key, type, interval fields. Includes `HumanLoopFlags`. |
| `FlowMetadata.tsx` | Metadata + Table Metadata accordion sections. |
| `ReturnStepSelector.tsx` | Return-step hint + multi-key editor. |
| `ToolPickerModal.tsx` | Modal for selecting a tool or flow when adding/changing a step. |
| `TestPanel.tsx` | Inline flow test runner panel. |
| `InsertStepBar.tsx` | "Add step" divider bar between steps. |
| `styles.ts` | Shared CSS-in-JS constants for the editor. |
| `flow-editor-utils.ts` | Pure helpers: `parseSchema`, `detectFlowInputKeys`, `buildAutoKey`. |

**`FlowGenerator.tsx`** — AI-powered flow chat (UI-only shell after refactor):
- Renders chat items, input box, accept/reject UX, screenshot display
- All SSE stream logic lives in `useFlowGeneratorStream` hook
- Draft persistence via `drafts.save` / `drafts.load` from `lib/drafts.ts`

**`components/CodeEditor.tsx`** — Monaco editor wrapper for JS tool code

**`components/CronEditor.tsx`** — Human-friendly cron expression builder

**`components/MessageBubble.tsx`** — Chat message renderer (handles tool calls, results, text)

**`components/AgentCard.tsx`** — Dashboard agent summary card

---

### Hooks

`packages/frontend/src/hooks/`

| Hook file | Exports | Purpose |
|---|---|---|
| `useFlowGeneratorStream.ts` | `useFlowGeneratorStream` | All SSE stream management for the flow generator: AbortController, autoSentRef, cancelRef, event accumulation, status state. React Strict Mode safe. |
| `useFlows.ts` | `useFlows`, `useCreateFlow`, `useUpdateFlow`, `useDeleteFlow`, `usePinFlow`, `useMarkFlowInfeasible` | TanStack React Query hooks for flows CRUD. All mutations invalidate the `['flows', agentId]` query key on success. |
| `useFlowEditorState.ts` | `useFlowEditorState` | `useReducer` hook managing `FlowDraft` state. Actions: `PATCH`, `SET_INPUT_DESCRIPTION`, `ADD_STEP`, `REMOVE_STEP`, `UPDATE_STEP`, `MOVE_STEP`, `DUPLICATE_STEP`, `TOGGLE_RETURN_STEP`, `SET_RETURN_STEP_KEY`, `APPLY_FIX`. |

---

### API Client

`packages/frontend/src/api/client.ts`

One file with typed functions for every backend endpoint. Includes:
- Standard `fetch` calls returning typed promises
- `generateFlowStream(agentId, messages, onEvent, signal)` — SSE consumer using `EventSource`-style `fetch` with `ReadableStream`
- Error handling: non-ok responses emit `{ type: 'error', message: ... }`; stream-end without `done` event emits a synthetic `done`

---

### State Management

**Deliberately minimal** — no Redux, no Zustand:
- Component-local `useState` for UI state
- `useFlowEditorState` (`useReducer`) for flow editing state
- **TanStack React Query** for server data in `FlowsTab` — `useQuery` for fetching, `useMutation` for writes with automatic cache invalidation. `QueryClientProvider` wraps the app tree in `main.tsx`.
- **`lib/drafts.ts`** for localStorage draft persistence (replaces scattered direct `localStorage` calls):
  - `drafts.save<T>(key, data)` — stamps a `savedAt` timestamp; 7-day TTL
  - `drafts.load<T>(key)` — auto-clears stale entries; returns `null` if expired
  - `drafts.clear(key)` — explicit clear
  - `drafts.list<T>(prefix)` — enumerate all live entries under a namespace
  - `drafts.keys.onboarding` — key for `AgentOnboarding.tsx`
  - `drafts.keys.generator(agentId)` — key for `FlowGenerator.tsx`

---

## Shared Package

`packages/shared/` — `@agentspawner/shared`

Both `packages/backend` and `packages/frontend` declare `"@agentspawner/shared": "workspace:*"` as a dependency.

**`src/schemas/flow.schema.ts`** — Zod schemas and inferred TypeScript types:

| Export | Description |
|---|---|
| `InputExpressionSchema` / `InputExpression` | Union of `literal`, `flow_input`, `step_ref` |
| `StepConditionSchema` / `StepCondition` | Condition block (check type, minLength, value, failMessage, skipToStepId, etc.) |
| `EvaluateBlockSchema` / `EvaluateBlock` | Vision eval block (prompt + optional screenshotStepId) |
| `TransformBlockSchema` / `TransformBlock` | Transform block (JS script string) |
| `FlowStepSchema` / `FlowStep` | Full step definition — id, toolId, label, inputMapping, condition, evaluate, transform |
| `FlowSchema` / `Flow` | Full flow — array of steps validated for cross-ref integrity |

**Usage:**
- Backend `flows.service.ts` calls `FlowSchema.safeParse()` to validate on write
- Frontend `types/index.ts` re-exports `InputExpression`, `FlowStep`, etc. from `@agentspawner/shared` instead of re-defining them

---

## Chrome Extension

`packages/extension/src/`

Three-layer Manifest v3 architecture:

### `background/index.ts` — Service worker
- Opens WebSocket to `ws://localhost:3001`
- Receives `EXECUTE_TOOL` from backend
- Routes to offscreen document (has tab API access)
- Returns `TOOL_RESULT` to backend
- Handles reconnect on disconnect

### `offscreen/index.ts` — Offscreen document
- Actually opens/closes/navigates Chrome tabs via `chrome.tabs.*`
- Executes content scripts in target tabs
- Takes screenshots via `chrome.tabs.captureVisibleTab()`
- Sends results back to background

### `content/index.ts` — Content script
- Injected into visible target tabs
- Receives `EXECUTE_PRIMITIVE` messages
- Performs DOM manipulation (click, type, scroll, get_text, etc.)
- Returns `PRIMITIVE_RESULT`

### `popup/index.ts` — Extension popup (15KB)
- **Picker mode** — Click-to-select CSS selectors for tool building
- **Runner mode** — Execute individual primitives for testing
- Supports `item`, `object`, and `array` selection modes

### Protocol (`protocol.ts`)

```
Backend ──EXECUTE_TOOL──► Background ──TAB_EXEC──► Offscreen ──EXECUTE_PRIMITIVE──► Content
       ◄──TOOL_RESULT──── Background ◄──PRIMITIVE_RESULT─────────────────────────── Content
```

---

## Data Models In Detail

### Flow Step

```typescript
interface FlowStep {
  id: string;                                   // UUID
  toolId: string;                               // tool name, flow name, '__transform__', '__evaluate__'
  label: string;                                // Human-readable (used as key in stepResults)
  inputMapping: Record<string, InputExpression>;
  condition?: {
    check: 'min_array_length' | 'non_empty' | 'result_equals' | 'result_not_equals' | 'has_error' | 'no_error';
    minLength?: number;
    value?: string;
    failMessage: string;
    skipToStepId?: string;         // On fail: jump here (for cleanup) then error
    skipToStepIdOnNoMatch?: string; // If condition NOT met: jump here and continue
  };
  evaluate?: {
    prompt: string;
    screenshotStepId?: string;     // Reuse an existing screenshot
  };
  transform?: {
    script: string;                // JS body, receives `input`, returns value
  };
}
```

### InputExpression (Data Wiring)

```typescript
type InputExpression =
  | { type: 'literal';   value: unknown }
  | { type: 'flow_input'; key: string }
  | { type: 'step_ref';  stepId: string; path: string }  // dot-path into prior step result
```

### SSE Event Types (Flow Generator)

| Event type | Payload |
|---|---|
| `thinking` | `{ text: string }` — Agent's internal reasoning |
| `tool_call` | `{ name, input }` — Tool being invoked |
| `tool_result` | `{ name, result }` — Tool result |
| `screenshot` | `{ data: string }` — Base64 screenshot |
| `flow_update` | `{ flow: FlowInput }` — Updated flow definition |
| `reply` | `{ text: string }` — Agent's chat response |
| `complete` | `{ flow: FlowInput }` — Final accepted flow |
| `error` | `{ message: string }` — Error |
| `done` | — Stream finished |

---

## Key Execution Flows

### Manual Chat Run

```
User types → ChatTab → api.createRun() → POST /agents/:id/runs
  → runOrchestrator() loop (Claude API ↔ tools ↔ DB)
  → SSE stream → frontend renders events in real-time
```

### Autonomous Mode

```
User clicks Wake Up → api.wakeUp() → POST /agents/:id/wake-up
  → runAutonomousOrchestrator() (Haiku, 1000 iterations)
    → ORIENT: list runs, flows, tools
    → QUEUE: process pending actions
    → GOALS: list goals, pick highest priority
    → RECALL: search memory for context
    → ACT: execute flows
    → BUILD: create new flows/tools if needed
    → SCHEDULE: set up recurring tasks
    → REFLECT: analyze performance
    → repeat until stopped or budget exceeded
```

### Flow Execution (inside orchestrator)

```
Agent tool_call → runFlow(flow, input) →
  [dedup check] → [step loop] →
    resolve inputs → dispatch tool → store result → check condition →
  → [return assembly] → [log flowRun] → [create pendingAction?]
```

### Scheduled Run

```
node-cron fires → scheduler.ts → POST internally to run endpoint
  → if schedule.flowId: runFlow directly
  → else: runOrchestrator with schedule.input
  → update schedule.lastRunAt
```

---

## Cross-Cutting Patterns

### T1 — Reasoning Capture
Before any flow is called, the orchestrator captures the agent's text reasoning (the `<thinking>` content) and stores it in `flowRuns.reasoning`. Visible in RunTraceTab.

### T2 — Goal Linkage
When an autonomous agent runs a flow to complete a goal, the `goalId` is stored in `flowRuns.goalId`. Enables "why did this happen?" queries.

### T3 — Model Tagging
Every flow run records which LLM handled it (`flowRuns.modelId`). Enables cost/quality analysis by model.

### T4 — Row Attribution
When a flow inserts rows into a user table, it stores `runId` and `flowRunId` as attribution fields. Full provenance chain.

### Deduplication Guard
Action flows can declare `dedupKeyField` + `dedupBreakType`. The flow runner queries `actionLog` before executing. A hard break never allows repeat; a soft break enforces a cooldown window. Prevents the agent from repeatedly DMing the same person.

### Suppression Token
Each agent gets a unique token (e.g., `__done_a1b2c3__`). It's injected into the system prompt, and the orchestrator watches for it in tool results. If any tool returns exactly this token, the run ends gracefully without an LLM call. Used as an escape hatch.

### Human-in-the-Loop
Two modes:
- `requiresApproval = true` → creates `pendingAction` instead of executing; agent waits
- `requiresHumanReview = true` → creates `pendingHumanReview` at `__human_review__` steps; captures draft + context for human editing

### Tone Learning Loop
Agent drafts content → human reviews in ReviewsTab → approves with edits or rejects → system stores `(agentDraft, humanFinal)` pair in `toneEdits` table → next flow generation incorporates tone guide updates.

### Draft Persistence (Frontend)
Both the onboarding wizard and the flow generator checkpoint their state to localStorage through the `drafts` service (`lib/drafts.ts`). Entries carry a `savedAt` timestamp and expire after 7 days. If the user closes the tab, they can resume exactly where they left off.

### Structured Logging
All backend modules use `logger` from `lib/logger.ts` (Pino). Log lines are JSON with context fields (`agentId`, `runId`, `flowId` as appropriate). The `FlowRunnerService` constructor creates a child logger bound to `{ flowId, agentId }` for per-run tracing. The `LOG_LEVEL` environment variable controls verbosity.

### Transform Step Sandboxing
`__transform__` steps run inside `vm.createContext` with a 2-second timeout. The sandbox exposes only `{ input, result }` — no `require`, `process`, `fs`, or other Node.js globals are accessible from user-authored transform scripts.
