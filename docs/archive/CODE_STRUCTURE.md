# AgentSpawner — Code Structure

## Overview

AgentSpawner is a **pnpm monorepo** that lets users create, configure, and run AI agents powered by the Anthropic API. Agents can use browser automation tools, call HTTP APIs, execute JavaScript scripts, run multi-step automation flows, be triggered on a schedule or via Telegram, and store structured data — all managed through a web UI.

The repo is split into four packages:

```
agentspawner/
├── packages/
│   ├── backend/     — Fastify API server + orchestration engine
│   ├── frontend/    — React SPA (Vite)
│   ├── extension/   — Chrome browser extension
│   └── shared/      — Shared Zod schemas (flow step types)
├── package.json     — Workspace root with dev/build scripts
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

---

## Package: `shared`

A tiny TypeScript package that defines the canonical schema for **flow steps** using Zod. Both the backend and frontend import from here to stay in sync on the shape of a flow.

Key types:
- `InputExpression` — how a step receives its inputs: hardcoded literal, a value from the flow's own input, or a reference to a previous step's output.
- `StepCondition` — an optional guard on a step (e.g. `min_array_length`, `result_equals`) that can short-circuit or skip to another step.
- `EvaluateBlock` — an AI-powered pass/fail check on a step's output.
- `TransformBlock` — a JavaScript snippet that post-processes a step's output.
- `FlowStep` — the full step definition combining all of the above.

---

## Package: `backend`

The core of the system. A **Fastify** HTTP server written in TypeScript, backed by a local **SQLite** database via **Drizzle ORM**.

### Entry point: `src/index.ts`

Bootstraps the server by:
1. Registering CORS and WebSocket plugins.
2. Registering all route handlers.
3. Connecting to SQLite and marking any orphaned `running`/`pending` runs as `stopped` (they cannot survive a server restart since their orchestrators are in-memory).
4. Provisioning any default tools that are missing for existing agents.
5. Starting cron schedules and Telegram pollers.
6. Listening on the configured port.
7. Handling `SIGTERM` gracefully by draining in-flight runs before closing.

### Database: `src/db/schema.ts`

Defines 16 SQLite tables using Drizzle ORM. All primary keys are text UUIDs; timestamps are ISO strings stored as text. The main entities are:

| Table | Purpose |
|---|---|
| `agents` | An agent: its name, system prompt, chosen Claude model, encrypted API key, Telegram credentials, and tone guide. |
| `tools` | Browser/extension tools attached to an agent. Can be `extension` (runs JS in a browser tab), `local`, `web_search`, or `web_fetch`. |
| `runs` | A single execution session (manual, scheduled, or Telegram-triggered). Tracks status, cost, token usage, and which model ran it. |
| `messages` | Every message exchanged during a run (user, assistant, tool results) stored as JSON. |
| `flows` | Multi-step automation flows. Steps are stored as a JSON array; the flow schema is validated using the `shared` package. |
| `flow_runs` | Audit log of every flow invocation with timing, success, evaluation result, and the agent's internal reasoning text. |
| `schedules` | Cron-based triggers for agents, optionally pointing at a specific flow. |
| `memory` | A shared knowledge store: free-text entries tagged with category, entities, and provenance. |
| `goals` | Hierarchical goals (`mission → objective → task`) with priority, status, and due dates. |
| `tables` / `rows` | User-defined data tables — essentially a lightweight in-process database for agents to read/write structured data. |
| `apiTools` | Custom HTTP or sandboxed-JS tools with their own input schema and secrets. |
| `agentSecrets` | Encrypted key-value store for per-agent secrets (injected into API tools at runtime). |
| `pendingActions` | Human-approval queue for irreversible actions (DMs, emails, posts) that the agent has queued but not yet executed. |
| `pendingHumanReviews` | Draft content (e.g. a social post) held for human approval before the flow continues. |
| `actionLog` | Deduplication and audit log: records every action flow attempt, whether it was blocked by a guard or not. |
| `contacts` | CRM-style contact records tracking outreach status per platform. |
| `performanceLog` | Outcome tracking for agent actions (success/failure, numeric value, notes). |
| `toneEdits` | Agent drafts vs. human-edited finals, used to learn the user's voice over time. |

### Orchestrator: `src/orchestrator/`

The brain of the system. `index.ts` contains `runOrchestrator`, the main **agentic loop**:

1. Loads the agent, decrypts its API key, and fetches all its tools, flows, and API tools from the DB.
2. Builds a list of Anthropic tool definitions from: extension tools, API tools, flows (exposed as callable tools), a set of built-in memory tools (`recall_memory`, `store_memory`), and management introspection tools (`list_tools`, `list_flows`, `list_tables`, `list_goals`, etc.).
3. Enters a `while` loop, calling the Anthropic API in streaming mode.
4. On each `tool_use` response, dispatches to the appropriate handler:
   - **Management tools** (list_*, query_table, insert_row, explain_flow_run) — handled inline with DB queries.
   - **Flows** — delegated to `flow-runner.ts`.
   - **API tools** — delegated to `api-tool-runner.ts`.
   - **Extension tools** — delegated to `tool-runner.ts`, which sends the tool call over WebSocket to the browser extension.
5. Every tool result is persisted to the `messages` table and optionally mirrored to Telegram.
6. Tool results are also fire-and-forget submitted to `memory/librarian.ts` which uses a secondary Claude call to extract and categorise notable facts.
7. The loop ends when the model returns `end_turn` or the run is aborted.

Supporting files in this directory:
- `abort-registry.ts` — global map of `AbortController` instances so any route can stop a running orchestrator.
- `nudge-registry.ts` — allows injecting a follow-up message into an active run (used by the human-review flow).
- `autonomous.ts` — a separate orchestrator variant designed for unattended, goal-driven sessions.
- `sub-agents.ts` — spawns child orchestrator sessions.
- `provision-tools.ts` — idempotently creates default tools for new or existing agents.
- `default-tools.ts` — the definitions of the built-in default tool set.
- `tool-types/` — individual handlers for each tool type: `extension.ts`, `local.ts`, `web-fetch.ts`, `web-search.ts`, `builtin.ts`.

### Flow runner: `src/features/flows/flow-runner.ts`

Executes a saved flow — a sequential list of steps — given an input object:

1. Validates the flow's `steps` JSON against the shared Zod schema.
2. Iterates steps, resolving each step's inputs via `InputExpression` references (literal, flow input, or previous step output).
3. Runs the step's tool (extension, API tool, built-in), respecting optional per-step delays.
4. After each step, evaluates any `condition` guard; if it fires, it can abort or jump to a cleanup step.
5. Optionally runs an `EvaluateBlock` — a second Anthropic call that reads the step output and returns pass/fail.
6. Optionally runs a `TransformBlock` — inline JS to reshape the output.
7. Writes the full run to `flow_runs`, including timing, evaluation outcome, and the agent's pre-call reasoning text.
8. Handles deduplication: checks the `action_log` table before executing action-type flows; if the key has been seen recently it returns a block message instead.

### Routes: `src/routes/` and `src/features/*/`

Each route file registers one domain's endpoints on the Fastify instance. The split between `src/routes/` (older, flat files) and `src/features/*/` (newer, feature-folder pattern with repository/service/routes separation) reflects an ongoing refactor. Key route groups:

- `agents` — CRUD for agents.
- `tools` — CRUD for extension/local tools.
- `flows` — CRUD for flows plus run-flow endpoint.
- `runs` — start a run, stream events via SSE, stop a run.
- `messages` — retrieve message history for a run.
- `schedules` — CRUD for cron schedules.
- `api-tools` — CRUD for HTTP/script tools.
- `memory` — read/write the shared memory store.
- `goals` — CRUD for the hierarchical goal tree.
- `contacts` — CRM contact management.
- `actions` / `action-log` — pending action queue and action history.
- `reviews` — human-review approval workflow.
- `analytics` — aggregate stats over run history.
- `generate-tool` / `flows-generate` — AI-assisted tool and flow generation endpoints.
- `explain` — wraps `explain_flow_run` for the UI.
- `recording` — triggers the extension to start screen recording.
- `setup` — first-run configuration (API key, model selection).
- `health` — simple liveness check.

### Scheduler: `src/scheduler/index.ts`

Loads all enabled `schedules` from the DB on startup (and after any schedule change), parses the cron expression, and uses `node-cron` to fire runs at the right time. Each tick creates a new `run` record and calls `runOrchestrator`.

### Telegram: `src/telegram/index.ts`

Starts a long-polling loop for each agent that has a `telegramKeyEncrypted` value. Incoming messages create a new run via the orchestrator, and outgoing assistant text is chunked and sent back over the Bot API.

### WebSocket: `src/websocket/`

A persistent WebSocket connection between the backend and the browser extension. `protocol.ts` defines the message types. The backend sends `EXECUTE_TOOL` messages; the extension sends back `TOOL_RESULT`. This is how extension-type tools actually run: the backend pauses the orchestrator and waits for the extension to execute JS in a real browser tab and return the result.

### Supporting utilities

- `src/config.ts` — reads `PORT`, `ENCRYPTION_KEY`, and other env vars.
- `src/crypto/index.ts` — AES-GCM encryption/decryption for API keys and secrets.
- `src/lib/logger.ts` — structured `pino` logger wrapper.
- `src/lib/sse-stream.ts` — helper for writing Server-Sent Events to Fastify replies.
- `src/memory/librarian.ts` — background memory extraction using a secondary Claude call.

---

## Package: `extension`

A Chrome Manifest V3 extension that acts as the **browser-side execution environment** for extension-type tools.

```
src/
├── background/index.ts   — Service worker; owns the WebSocket connection to the backend
├── offscreen/index.ts    — Offscreen document; handles WebSocket I/O (needed because service workers can't maintain persistent sockets)
├── content/index.ts      — Content script injected into every page; receives EXECUTE_PRIMITIVE messages and runs the tool code
├── popup/index.ts        — Extension popup UI (connection status)
├── primitives/index.ts   — Library of DOM primitives (click, type, scroll, screenshot, etc.)
└── protocol.ts           — Shared message type definitions (mirrors backend/websocket/protocol.ts)
```

The message flow for a tool call is:
`Backend → WebSocket → Offscreen → Background → Content script → runs JS in tab → Content script → Background → Offscreen → WebSocket → Backend`

---

## Package: `frontend`

A **React + Vite** single-page application. All state management is local (hooks + API calls); there is no global state library.

```
src/
├── main.tsx                    — App bootstrap
├── App.tsx                     — Root router
├── api/client.ts               — Thin fetch wrapper for the backend API
├── types/index.ts              — TypeScript types mirroring the backend schema
├── pages/
│   ├── Home.tsx                — Agent list / dashboard
│   ├── AgentOnboarding.tsx     — First-run wizard
│   └── agent/                  — Per-agent tabbed layout and all its tabs
│       ├── AgentLayout.tsx
│       ├── ChatTab.tsx
│       ├── FlowsTab.tsx / FlowEditor.tsx / FlowGenerator.tsx
│       ├── ToolManagerTab.tsx / ToolEditor.tsx
│       ├── ApiToolsTab.tsx
│       ├── ScheduleTab.tsx
│       ├── MemoryTab.tsx
│       ├── GoalsTab.tsx
│       ├── ActionsTab.tsx
│       ├── ReviewsTab.tsx
│       ├── DatabaseTab.tsx
│       ├── AnalyticsTab.tsx
│       ├── LoggerTab.tsx
│       ├── RunTraceTab.tsx
│       ├── AgentMapTab.tsx
│       ├── ExtensionTab.tsx
│       └── SetupTab.tsx
├── components/
│   ├── flow-editor/            — The visual flow-building UI components
│   └── AgentCard, CodeEditor, CronEditor, MessageBubble
├── hooks/
│   ├── useFlowEditorState.ts   — All flow editor state and mutations
│   ├── useFlowGeneratorStream.ts — Streaming AI-assisted flow generation
│   └── useFlows.ts
└── lib/drafts.ts / utils/session-draft.ts — Local draft persistence
```

The agent view is structured as a tabbed layout (`AgentLayout.tsx`) with one tab per major capability. The flow editor is the most complex UI: it allows building, testing, and visually inspecting multi-step automation flows.

---

## Data & Runtime Flow Summary

```
User / Schedule / Telegram
        ↓
    POST /runs  (backend)
        ↓
  runOrchestrator (loop)
        ↓
  Anthropic Messages API  ←→  Claude model
        ↓ tool_use
  ┌─────────────────────┐
  │ Management tools    │ → SQLite queries (inline)
  │ Memory tools        │ → SQLite + Claude (librarian)
  │ Flows               │ → flow-runner → tool-runner / api-tool-runner
  │ API tools           │ → HTTP request or sandboxed JS (vm2)
  │ Extension tools     │ → WebSocket → Chrome extension → browser tab
  └─────────────────────┘
        ↓
  SSE stream → Frontend (run trace, chat messages)
```
