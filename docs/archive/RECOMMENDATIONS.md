# AgentSpawner — Improvement Recommendations

The codebase is well-structured and clearly the product of iterative development with real usage. The recommendations below are grouped by theme and are roughly ordered by impact.

---

## 1. Architecture & Code Organisation

**Split the monolithic orchestrator.** `src/orchestrator/index.ts` is doing a large amount of work in a single ~500-line function: loading agent config, building tool definitions, running the agentic loop, handling every management tool inline, persisting messages, and mirroring to Telegram. The management tool handlers (all the `else if (block.name === 'list_*')` branches) could be extracted into a dedicated `ManagementToolHandler` class or a plain map of `toolName → handler(input, context)`. This would make the loop itself much shorter and each handler independently testable.

**Finish the feature-folder refactor.** There are two route patterns side-by-side: `src/routes/` (flat files) and `src/features/*/` (repository + service + routes). The newer pattern is clearly better — finish migrating `tools`, `runs`, `schedules`, `memory`, `goals`, `contacts`, `actions`, `reviews`, and the others into their own feature folders with the same three-file split. Consistency makes it easier to find things and enforce patterns like "no DB queries in route handlers".

**Centralise DB access.** Several route files call `getDb()` directly and write Drizzle queries inline. The feature-folder pattern already separates this into a repository layer — apply that pattern everywhere. Route handlers should only call service/repository functions, never touch the ORM directly.

---

## 2. Reliability & Correctness

**Replace the orphaned-run cleanup with proper persistence.** The current approach marks all `running`/`pending` runs as `stopped` on startup. This is correct but lossy — any run that was genuinely in-flight when the server crashed is silently abandoned. A better model is to persist enough run state (e.g. the message history and current step) to allow a restart to resume or at least report what was happening when it died.

**Add a circuit-breaker / timeout to the orchestrator loop.** Currently a run can loop indefinitely if the model keeps returning `tool_use`. There is no max-turn limit, no per-run wall-clock timeout, and no cost ceiling. Adding a configurable `maxTurns` and `maxCostUsd` guard would prevent runaway sessions from exhausting the API budget.

**Use database transactions for multi-table writes.** Several operations (e.g. creating an agent and then provisioning its default tools) involve multiple inserts that should be atomic. Drizzle supports SQLite transactions; wrapping these in `db.transaction(async (tx) => { ... })` would prevent partial state if one insert fails.

**Resolve the dual abort-controller pattern.** `runOrchestrator` maintains its own `abortControllers` map *and* also calls `registerAbort` / `unregisterAbort` from the shared registry. The comment says "Keep local map for backward compatibility" but this duplication means there are two code paths to maintain. Pick one and remove the other.

---

## 3. Security

**Rotate or validate the encryption key on startup.** `src/crypto/index.ts` encrypts secrets with a key from the environment. There is currently no check that the key is present, non-empty, or of the correct length at startup. The server should fail fast with a clear error message if `ENCRYPTION_KEY` is missing or invalid rather than silently storing blank-encrypted secrets.

**Sandbox API tool script execution more aggressively.** Scripts in `apiTools` are executed with access to `secrets`. If `vm2` (or whatever sandboxing is in use) has an escape vulnerability — which is a known risk — a malicious script could read environment variables or file system paths. Consider running these scripts in a separate child process or a WASM-based sandbox, or at minimum add a explicit allowlist of what Node globals are available.

**Scope the CORS allowlist by environment.** The hardcoded CORS origins (`http://localhost:5173`, `http://127.0.0.1:5173`) are fine for local development but the same code would be used in any deployment. Read these from config/environment variables so a production deployment can lock them down properly.

**Consider encrypting the SQLite database at rest.** API keys, Telegram tokens, and agent secrets are encrypted at the field level, which is good. But the memory store, message history, contacts, and flow data are stored in plaintext in `agentspawner.db`. If someone gets read access to the file they get a lot of sensitive context. SQLite encryption extensions (e.g. SQLCipher) or periodic export to an encrypted backup would add defence in depth.

---

## 4. Testing

**The test coverage is minimal.** There is a single test file (`src/__tests__/flow-runner.test.ts`). Given the complexity of the orchestrator loop and flow runner, this is a meaningful risk. Priority areas for new tests: the flow runner's input-expression resolution logic, the deduplication guard in `action_log`, the condition/skip-to logic in steps, and the orchestrator's message-persistence behaviour.

**Add integration tests for the API routes.** Fastify has excellent built-in test support (`fastify.inject`). A suite of route-level tests that spin up the server against an in-memory SQLite database would catch regressions in CRUD endpoints without needing a real browser.

**Test the extension protocol round-trip.** The WebSocket protocol between backend and extension is load-bearing but untested. A mock extension client that connects to the test server and responds to `EXECUTE_TOOL` messages would let the orchestrator be tested end-to-end without a real browser.

---

## 5. Developer Experience

**Add a `dev:full` script that starts backend, frontend, and watches the shared package.** Currently `pnpm dev` starts backend and frontend but changes to `packages/shared` require a manual rebuild. Adding `shared` to the `--filter` list (or using `tsc --watch` in shared) would close this gap.

**Add a `pnpm typecheck` script.** There are no type-check scripts in the root `package.json`. Running `tsc --noEmit` across all packages in CI would catch type errors before they reach runtime.

**Standardise error responses.** The global Fastify error handler converts `ZodError` to 400, but other errors return 500 with `{ error: message }`. Some route handlers throw plain `Error` objects, others return `reply.status(4xx).send(...)` inline. A shared error class hierarchy (`AppError`, `NotFoundError`, `ValidationError`) with a single handler that maps them to consistent HTTP responses would make the API surface more predictable.

**Document environment variables.** `.env.example` exists but it is not clear from the code what all the variables do, which are required, and what the valid values are. A short table in the root README (or a dedicated `docs/env.md`) would save onboarding time.

---

## 6. Performance

**Add indexes to the most-queried columns.** The schema has no explicit indexes beyond primary keys. Columns that are filtered on in hot paths — `runs.agentId`, `runs.status`, `messages.runId`, `flowRuns.agentId`, `memory.entities`, `actionLog.agentId + flowId + keyValue` — should have indexes. Without them, every query does a full table scan, which degrades noticeably as data accumulates.

**The memory librarian is fire-and-forget.** `storeToMemory` is called without awaiting and failures are only logged. If the Anthropic call inside the librarian fails repeatedly (e.g. rate limit), facts are silently dropped. A lightweight retry queue or a dead-letter table would make memory ingestion more reliable.

**Paginate the `messages` history injected into the orchestrator.** When loading conversation history for a multi-turn chat, the code currently fetches all messages for a run. A long run with many tool calls can produce a very large context window. Capping history to the last N messages, or summarising older turns, would keep prompt sizes manageable.

---

## 7. UX / Product

**The flow editor state (`useFlowEditorState.ts`) handles too many concerns.** It manages step CRUD, input mapping, test execution, validation, and draft saving all in one hook. Breaking it into smaller focused hooks (`useFlowSteps`, `useFlowTestRunner`, `useFlowDraft`) would make each concern easier to reason about and test.

**The split between `src/routes/` and `src/features/*/routes` is confusing for the frontend API client.** The `api/client.ts` has to know where each endpoint lives even though they are logically related. A versioned base path (e.g. `/api/v1/`) and consistent REST naming would also make it easier to generate a typed API client from the OpenAPI spec (if one is added).

**Add OpenAPI/Swagger documentation.** Fastify has first-class support for generating OpenAPI specs via `@fastify/swagger`. Given the number of routes, having a machine-readable spec would simplify frontend development, allow auto-generating a typed client, and serve as living API documentation.
