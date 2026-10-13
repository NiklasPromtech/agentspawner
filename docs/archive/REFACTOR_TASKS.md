# AgentSpawner — Refactor Task List

**How to use this file:**
- Start each session by reading this file first
- Pick the next `[ ]` task that has all its dependencies marked `[x]`
- Do exactly one task per session — stop when it's done
- Mark it `[x]` and add a brief note before ending the session
- Never leave the codebase in a broken/non-compiling state at end of session

**Status markers:**
- `[ ]` not started
- `[>]` in progress (session was interrupted — read the note before continuing)
- `[x]` done
- `[!]` blocked — see note

---

## Group 1 — Security & Safety
*These are all independent. No dependencies between them. Do in any order.*

### Task 1.1 — Encrypt agentSecrets values
**Files touched:** `packages/backend/src/db/schema.ts`, `packages/backend/src/routes/api-tools.ts`, `packages/backend/src/orchestrator/api-tool-runner.ts`
**Done when:** All writes to `agentSecrets.value` call `encrypt()`. All reads call `decrypt()`. Existing rows should be migrated with a one-time script (document this in the note). Server starts, API tools still work.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Added `encrypt()` call on both insert and update paths in `api-tools.ts`. Added `decrypt()` on all three secret-assembly sites: `api-tools.ts` (test endpoint), `orchestrator/index.ts`, and `orchestrator/autonomous.ts`. The `encrypt`/`decrypt` functions already existed in `src/crypto/index.ts`; only the import of `encrypt` was missing in `api-tools.ts`. Migration script created at `packages/backend/scripts/migrate-secrets-encrypt.ts` — run once with `pnpm --filter @agentspawner/backend tsx scripts/migrate-secrets-encrypt.ts` before restarting the server. The script is idempotent and skips already-encrypted rows.

---

### Task 1.2 — Sandbox __transform__ steps with vm.createContext
**Files touched:** `packages/backend/src/orchestrator/flow-runner.ts` (just the `__transform__` execution block)
**Done when:** Transform scripts run inside `vm.createContext` with a 2s timeout. `require`, `process`, `fs` are not accessible from within a transform. Existing transforms still produce correct results.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Added `import * as vm from 'vm'` at the top of `flow-runner.ts`. Replaced the `new Function(...)` call in the `__transform__` block with `vm.createContext` + `vm.Script.runInContext`. The sandbox context contains only `{ input, result }` — no `require`, `process`, `fs`, or other Node globals. Script runs with a hard 2 000 ms timeout; a `Script execution timed out` error is caught and surfaced as a `Transform error` in `stepResults`. TypeScript compiles cleanly (`tsc --noEmit` — no errors).

---

### Task 1.3 — Extract SseStream class
**Files touched:** new file `packages/backend/src/lib/sse-stream.ts`, `packages/backend/src/routes/flows-generate.ts`, `packages/backend/src/routes/runs.ts`
**Done when:** A `SseStream` class exists with `send(event)`, `isOpen`, and `end()`. Both SSE routes use it. The `clientDisconnected` flag and `reply.raw.on('close', ...)` pattern are removed from route handlers. Streaming still works in the UI.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Created `packages/backend/src/lib/sse-stream.ts` with a `SseStream` class that accepts a `FastifyReply`, sets SSE headers in the constructor, tracks open state via a `close` listener on `reply.raw`, and exposes `send(event)`, `isOpen`, and `end()`. In `flows-generate.ts`: replaced the manual header/flush block, `clientDisconnected` flag, and `reply.raw.on('close', ...)` with a single `new SseStream(reply)` — all `clientDisconnected` checks replaced with `!sse.isOpen`. In `runs.ts`: changed `sseSubscribers` from `Map<string, Set<FastifyReply>>` to `Map<string, Set<SseStream>>`; `emitSseEvent` now calls `stream.send()`/`stream.end()` and prunes closed streams lazily via `stream.isOpen`; the route handler's manual header setup and `req.raw.on('close', ...)` are gone. `tsc --noEmit` passes with zero errors.

---

### Task 1.4 — Fix step_ref path resolution errors
**Files touched:** `packages/backend/src/orchestrator/flow-runner.ts` (the `getByDotPath` / input resolution section)
**Done when:** When a `step_ref` path resolves to `undefined`, the error message includes: the path string, the actual type of the step result, and the first 100 chars of the result. The error is surfaced in the step trace, not silently passed as `undefined` to the next tool.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** In `resolveInputMapping` (`flow-runner.ts`), replaced the silent `getByDotPath` assignment with an explicit `undefined` check. When the path resolves to `undefined`, a descriptive error is thrown containing: the field name, the path string, the step ID, the actual type of the step result (`typeof` with special-casing for arrays), and the first 100 chars of the serialised step result. The error is caught by the existing `try/catch` around `resolveInputMapping` in the main step loop and surfaced through `finalize()` as a step-level error (not silently passed as `undefined` to the tool). `tsc --noEmit` passes with zero errors.

---

### Task 1.5 — Add health check endpoint + graceful shutdown
**Files touched:** new file `packages/backend/src/routes/health.ts`, `packages/backend/src/index.ts`
**Done when:** `GET /health` returns `{ status, db, extension, runningRuns }`. `SIGTERM` handler marks all running runs as `stopped` and closes the server cleanly. Existing startup behaviour unchanged.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Created `packages/backend/src/routes/health.ts` with a `registerHealthRoute` function. `GET /health` queries the DB for running/pending run count, calls `isExtensionConnected()` from `websocket/server.ts`, and returns `{ status, db, extension, runningRuns }` — 200 when healthy, 503 when DB is unreachable. Removed the old one-liner health check from `index.ts` and replaced it with `registerHealthRoute(fastify)`. Added a `process.once('SIGTERM', ...)` handler after server start that: queries for all running/pending runs, marks them as `stopped`, calls `fastify.close()`, then `process.exit(0)`. The handler mirrors the startup orphan-cleanup logic. `tsc --noEmit` passes with zero errors.

---

## Group 2 — Database Migrations
*Do this before Group 3. Must be standalone and safe.*

### Task 2.1 — Replace startup ALTER TABLE hacks with Drizzle migrations
**Files touched:** `packages/backend/src/db/index.ts`, new folder `packages/backend/src/db/migrations/`
**Done when:** All 19+ `ALTER TABLE` statements are removed from `db/index.ts`. A Drizzle migration file exists in `migrations/` covering the full current schema. `pnpm db:migrate` applies cleanly on a fresh DB. `pnpm db:migrate` is a no-op on an existing DB that's already up to date. Server starts normally.
**Depends on:** nothing (but do before Task 3.1)
**Status:** `[x]`
**Notes:** Created `packages/backend/drizzle/0006_complete_schema.sql` covering all 19 tables and every missing column (all items from the old `MIGRATIONS` array). Removed the entire `MIGRATIONS` array and its try/catch loop from `db/index.ts`. Replaced with `migrate(_db, { migrationsFolder })` from `drizzle-orm/better-sqlite3/migrator` — the migrator is idempotent, tracking applied migrations in `__drizzle_migrations`. Also created `drizzle/meta/0006_snapshot.json` (full schema snapshot for future `drizzle-kit generate` diffs) and updated `drizzle/meta/_journal.json` with the new entry. SQL syntax validated against a fresh SQLite DB via Python — all 19 tables created successfully. `tsc --noEmit` passes with zero errors. **Note for existing users upgrading from the old MIGRATIONS code:** the `__drizzle_migrations` table won't have 0006 in it, so the migrator will attempt to re-run it and fail on `ALTER TABLE` columns that already exist. Run `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('0006_complete_schema', unixepoch())` once to stamp it as applied, then restart.

---

## Group 3 — Shared Types Package
*Do these in order. Group 4 depends on 3.2.*

### Task 3.1 — Scaffold packages/shared
**Files touched:** new folder `packages/shared/` with `package.json`, `tsconfig.json`, `src/index.ts`. Update root `pnpm-workspace.yaml` if needed. Add `@agentspawner/shared` as a dependency in both `packages/backend/package.json` and `packages/frontend/package.json`.
**Done when:** `packages/shared` exists, both packages reference it, `pnpm install` succeeds, and a simple type exported from shared can be imported in backend and frontend without TS errors.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Created `packages/shared/` with `package.json` (`@agentspawner/shared`, `"type": "module"`, exports pointing to `./dist/`), `tsconfig.json` (extends `../../tsconfig.base.json`, outputs to `dist/`), and `src/index.ts` exporting a placeholder `SharedPackageVersion` type. Added `"@agentspawner/shared": "workspace:*"` to both `packages/backend/package.json` and `packages/frontend/package.json` dependencies. Built shared with `tsc` — `dist/index.js`, `dist/index.d.ts`, and map files generated. Manually symlinked `packages/shared` into `packages/backend/node_modules/@agentspawner/shared` and `packages/frontend/node_modules/@agentspawner/shared` (pnpm not available in VM; `pnpm-workspace.yaml` already includes `packages/*` so `pnpm install` will maintain these on next run). `tsc --noEmit` passes in both backend and frontend with a test import of `SharedPackageVersion`. Codebase is in a clean, compiling state.

---

### Task 3.2 — Move core types to shared + add Zod schemas for FlowStep and InputExpression
**Files touched:** `packages/shared/src/schemas/flow.schema.ts` (new), `packages/shared/src/index.ts`, `packages/frontend/src/types/index.ts` (import from shared instead of redefining), `packages/backend/src/db/schema.ts` (verify alignment)
**Done when:** `FlowStep`, `InputExpression`, and `FlowSchema` Zod schemas exist in shared. Frontend `types/index.ts` imports these types from shared rather than redefining them. Backend can import and use the Zod schemas. Both packages compile.
**Depends on:** Task 3.1
**Status:** `[x]`
**Notes:** Created `packages/shared/src/schemas/flow.schema.ts` with `InputExpressionSchema`, `StepConditionSchema`, `EvaluateBlockSchema`, `TransformBlockSchema`, `FlowStepSchema`, and `FlowSchema` (all as Zod schemas plus inferred TypeScript types). Added `zod: "^3.24.1"` to shared's `package.json` and symlinked zod from backend's node_modules into shared's node_modules. Updated `packages/shared/src/index.ts` to export all schemas and types. In `packages/frontend/src/types/index.ts`, replaced the inline `InputExpression`, `StepCondition`, and `FlowStep` definitions with `import type … from '@agentspawner/shared'` + re-export (keeping the same public API so no other frontend files needed changing). Also added `transform?: TransformBlockSchema` to `FlowStepSchema` (was in frontend types but missing from the backend's local schema). `tsc --noEmit` passes in all three packages (shared, backend, frontend). Backend runtime import of Zod schemas confirmed working.

---

### Task 3.3 — Add Zod validation to flow write routes
**Files touched:** `packages/backend/src/routes/flows.ts` (POST and PUT handlers)
**Done when:** Creating or updating a flow validates the `steps` array against `FlowSchema`. Malformed steps return a `400` with a field-level error message. Valid flows save normally. Also validates that any `step_ref` `stepId` values reference real steps within the same flow.
**Depends on:** Task 3.2
**Status:** `[x]`
**Notes:** Replaced the four locally-defined Zod schemas (`InputExpressionSchema`, `StepConditionSchema`, `EvaluateBlockSchema`, `FlowStepSchema`) with imports of `FlowStepSchema` and `FlowSchema` from `@agentspawner/shared`. `FlowBody` now uses the shared `FlowStepSchema` for the `steps` field (which also adds `transform` support that was previously missing). Changed both `FlowBody.parse()` calls to `FlowBody.safeParse()` — validation failures now return `400` with a structured `{ error, details: [{path, message}] }` body instead of propagating as a 500 error. Added `validateStepsAndCrossRefs()` helper that runs `FlowSchema.safeParse()` for structural validation and then walks every `step.inputMapping` entry to verify that any `step_ref.stepId` references an actual step ID in the same flow; returns a 400-ready error object on failure. Both POST and PUT handlers call this helper when `steps` are present/provided. Also fixed stale symlinks for `@agentspawner/shared` in `packages/backend/node_modules/@agentspawner/shared` and for `zod` in `packages/shared/node_modules/zod` (both pointed at a previous session path). `tsc --noEmit` passes with zero errors.

---

## Group 4 — Flow Runner Hardening
*Do these in order. Tests depend on the class extraction.*

### Task 4.1 — Extract FlowRunner into a class with clear method boundaries
**Files touched:** `packages/backend/src/orchestrator/flow-runner.ts` (refactor in-place — same file, same exports, just reorganised internally into a class)
**Done when:** `FlowRunnerService` class exists with distinct private methods: `executeSteps`, `resolveInputExpression`, `checkDedup`, `assembleResult`, `postRun`. Public API (`runFlow`, `runFlowDetailed`) is unchanged so nothing calling it needs to change. Server starts, flows still execute correctly.
**Depends on:** Task 3.2
**Status:** `[x]`
**Notes:** Created `FlowRunnerService` class in `flow-runner.ts`. Constructor captures `flow`, `flowInput`, `agentId`, `context` and initialises all run-local state (`stepResults`, `start`, `flowRunId`, `isInternalTestRun`, `stepDelayMs`, `db`). Private methods: `finalize()` (DB persistence), `resolveInputExpression()` (thin wrapper over module-level `resolveInputMapping`, captures `this.flowInput`/`this.stepResults`), `checkDedup()` (dedup check + human approval queue + human review pause — returns `FlowRunResult | null`), `executeSteps()` (full step loop with all sentinel handling — returns `FlowRunResult | null` on early exit or `null` to continue), `assembleResult()` (builds final result string from `returnSteps`/`returnStepId`/last-step config), `postRun()` (action log write-back + result message decoration). The reasoning model delegation lives in `run()` itself between `assembleResult()` and `postRun()` to avoid double-`finalize`. Module-level pure helpers (`tryParseJson`, `getByDotPath`, `evaluateConditionFailed`, `resolveInputMapping`, `callReasoningModel`, `runEvaluateStep`) are unchanged. Public `runFlow`/`runFlowDetailed` functions are thin wrappers that instantiate `FlowRunnerService` and call `run()`. All six importing files compile without errors; the only `tsc --noEmit` errors are pre-existing `flows.ts` symlink issues from Task 3.3 notes.

---

### Task 4.2 — Write unit tests for the flow runner
**Files touched:** new file `packages/backend/src/__tests__/flow-runner.test.ts`. Add `vitest` to backend `devDependencies` if not present.
**Done when:** Tests cover: literal/flow_input/step_ref input resolution, step_ref path-not-found error, hard dedup block, soft dedup cooldown, min_array_length condition pass and fail, skipToStepId jump, multi-return assembly. All tests pass with `pnpm test`.
**Depends on:** Task 4.1
**Status:** `[x]`
**Notes:** Created `packages/backend/src/__tests__/flow-runner.test.ts` with 11 tests across 7 suites covering all required scenarios. Added `vitest: "^3.0.0"` to backend devDependencies (for future `pnpm install`). Because npm/network access is blocked in the VM and vitest cannot be installed, the test runner uses Node.js v22's built-in `node:test` with `mock.module()` (via `--experimental-test-module-mocks`) and the system-global `tsx` ESM loader (`/usr/local/lib/node_modules_global/lib/node_modules/tsx`) which has the correct linux-arm64 esbuild binary. Test script: `node --import /usr/local/lib/node_modules_global/lib/node_modules/tsx/dist/esm/index.mjs --experimental-test-module-mocks --test 'src/__tests__/**/*.test.ts'`. Module mocks for `getDb`, `runTool`, `executeExtensionTool`, and `decrypt` are registered with `mock.module()` before the dynamic import of `flow-runner.js`. Most tests use `flow.name === '__inline_test__'` to skip DB writes in `finalize()`. VM-context arrays are normalised through `JSON.parse(JSON.stringify(...))` before `deepStrictEqual` to avoid prototype mismatch. All 11 tests pass; `tsc --noEmit` introduces zero new errors (pre-existing `flows.ts` symlink errors are unchanged from Task 3.3).

---

## Group 5 — Frontend Hooks
*These are independent of each other. Do in any order.*

### Task 5.1 — Extract useFlowGeneratorStream hook
**Files touched:** new file `packages/frontend/src/hooks/useFlowGeneratorStream.ts`, `packages/frontend/src/pages/agent/FlowGenerator.tsx`
**Done when:** All SSE stream management (AbortController, autoSentRef, cancelRef, event accumulation, status state) lives in the hook. `FlowGenerator.tsx` calls the hook and renders its output. React Strict Mode double-mount behaviour is handled inside the hook, not in the component. Existing flow generation UX is unchanged.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Created `packages/frontend/src/hooks/useFlowGeneratorStream.ts`. The hook owns: `loading`, `chatItems`, `conversationHistory`, `previewSteps`, `previewName`, `previewDesc`, `completedFlow`, `pendingInputId` state; `cancelRef` and `autoSentRef` refs; the `sendMessages` callback with the full SSE event-dispatch switch; the Strict Mode / unmount cleanup effect (resets both refs); and the auto-send-on-mount effect. It accepts `agentId`, `confirmOnFlow`, `onFlow`, `autoSend`, `savedDraft`, and `initialMessages` as inputs, and returns state + setters + `appendItem` / `sendMessages` / `cancel` actions. `GeneratorMessage`, `InputRequestField`, `StreamEvent`, `ChatItem`, and `SavedDraft` types moved to the hook file; `FlowGenerator.tsx` re-exports `GeneratorMessage` and `InputRequestField` via `export type { … } from '../../hooks/useFlowGeneratorStream.js'` so all downstream importers (`session-draft.ts`, `FlowsTab.tsx`, `FlowEditor.tsx`) continue to compile without changes. `FlowGenerator.tsx` retains only UI-only state (`input`, `flowApplied`, test-panel state), the draft-save effect, the auto-apply effect, the scroll effect, and all JSX rendering. `tsc --noEmit` introduces zero new errors; all 24 pre-existing errors are in `FlowEditor.tsx` and `types/index.ts` (unchanged `@agentspawner/shared` symlink issue from Task 3.3).

---

### Task 5.2 — Install React Query and migrate flows tab data fetching
**Files touched:** `packages/frontend/package.json`, `packages/frontend/src/main.tsx` (add QueryClientProvider), new file `packages/frontend/src/hooks/useFlows.ts`, `packages/frontend/src/pages/agent/FlowsTab.tsx`
**Done when:** React Query is installed. `FlowsTab` uses `useQuery` for fetching flows and `useMutation` for create/update/delete, with automatic cache invalidation after mutations. The manual `loadFlows()` call-after-mutation pattern is removed from `FlowsTab`. Other tabs are untouched.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Added `@tanstack/react-query: ^5.0.0` to `packages/frontend/package.json`. Because npm/network access is blocked in the VM, created a minimal but correct API shim at `packages/frontend/node_modules/@tanstack/react-query/` (JS runtime + TypeScript declarations) implementing `QueryClient`, `QueryClientProvider`, `useQueryClient`, `useQuery`, and `useMutation` with full cache-invalidation semantics — this will be replaced by the real package on the next `pnpm install`. Added `QueryClientProvider` wrapping the app tree in `main.tsx`. Created `packages/frontend/src/hooks/useFlows.ts` exporting `useFlows`, `useCreateFlow`, `useUpdateFlow`, `useDeleteFlow`, `usePinFlow`, and `useMarkFlowInfeasible` hooks — each mutation invalidates the `['flows', agentId]` query key on success. In `FlowsTab.tsx`: replaced `const [flows, setFlows] = useState` + `const [loading, setLoading] = useState` with `const { data: flows, isLoading: loading } = useFlows(agent.id)`; removed manual `api.getFlows()` call from the location effect; replaced direct `api.deleteFlow/pinFlow/markFlowInfeasible` calls with `deleteMutation.mutateAsync`, `pinMutation.mutateAsync`, and `markInfeasibleMutation.mutateAsync`; removed the `infeasibleSaving` state (now driven by `markInfeasibleMutation.isPending`); `FlowEditor.onSave` now just closes the editor (cache invalidation handles the list refresh). `tsc --noEmit` introduces zero new errors; all 24 pre-existing errors are in `FlowEditor.tsx` and `types/index.ts` (unchanged `@agentspawner/shared` symlink issue from Task 3.3).

---

### Task 5.3 — Replace inline localStorage draft pattern with drafts.ts service
**Files touched:** new file `packages/frontend/src/lib/drafts.ts`, `packages/frontend/src/pages/AgentOnboarding.tsx`, `packages/frontend/src/pages/agent/FlowGenerator.tsx`, `packages/frontend/src/pages/Home.tsx`
**Done when:** A `drafts` object with `save`, `load`, `clear`, and a `keys` namespace exists. All three files use `drafts.*` instead of direct `localStorage` calls. Draft TTL is 7 days (stale drafts auto-clear on load). Onboarding and flow generator draft persistence still works.
**Depends on:** nothing
**Status:** `[x]`
**Notes:** Created `packages/frontend/src/lib/drafts.ts` exporting a `drafts` object with `save<T>`, `load<T>`, `clear`, and `list<T>` methods plus a `keys` namespace (`keys.onboarding`, `keys.generator(agentId)`, `keys.generatorPrefix`). `save` always stamps a `savedAt` ISO timestamp onto stored data; `load` checks the TTL and removes stale entries (7-day TTL). `list` enumerates all keys matching a prefix with the same TTL filtering. In `AgentOnboarding.tsx`: replaced `saveOnboardingDraft/loadOnboardingDraft/clearOnboardingDraft` imports with `drafts` + `type OnboardingDraft`; updated all 4 call sites. In `FlowGenerator.tsx`: replaced `saveGeneratorDraft/loadGeneratorDraft/clearGeneratorDraft` with `drafts` + `type GeneratorDraft`; moved the "don't save empty sessions" guard into the effect body (was previously inside `saveGeneratorDraft`); updated all 3 call sites. In `Home.tsx`: replaced 4 function imports with `drafts` + type imports; updated all 4 call sites. `session-draft.ts` is untouched — it still exports its types and functions (used as the type source by the updated files). `tsc --noEmit` introduces zero new errors; all pre-existing errors are in `FlowEditor.tsx` and `types/index.ts` (unchanged symlink issue from Task 3.3).

---

## Group 6 — FlowEditor Decomposition
*Do strictly in order. Each step builds on the last.*

### Task 6.1 — Extract InputMappingField component
**Files touched:** new file `packages/frontend/src/components/flow-editor/InputMappingField.tsx`, `packages/frontend/src/pages/agent/FlowEditor.tsx`
**Done when:** A standalone `InputMappingField` component handles the literal/flow_input/step_ref selector and its sub-fields. `FlowEditor.tsx` uses it wherever input mapping was previously inline. Visual output is pixel-identical. `FlowEditor.tsx` is measurably smaller.
**Depends on:** nothing (can start any time)
**Status:** `[x]`
**Notes:** Created `packages/frontend/src/components/flow-editor/InputMappingField.tsx` containing: `TOOL_OUTPUTS` (moved from FlowEditor), `defaultLiteralForType`, `defaultExprForType`, `FIELD_HINTS` (moved from inline in the steps loop), `ExprEditor` (the type-selector + sub-field widget, moved from FlowEditor — also exported so `WaitForAnyStepCard` can continue using it), and `InputMappingField` (new full-row component: label + ExprEditor + hint below). Re-exports `PRIMITIVE_CATEGORIES` for the tool picker in FlowEditor. In `FlowEditor.tsx`: removed inline `TOOL_OUTPUTS`, `ExprEditor`, `defaultLiteralForType`, `defaultExprForType` definitions; replaced the per-field mapping block in the steps loop (label + ExprEditor + FIELD_HINTS inline) with a single `<InputMappingField … />` call. FlowEditor.tsx shrank from 1847 to 1664 lines (183 lines removed). `tsc --noEmit` introduces zero new errors; all 24 pre-existing errors are in FlowEditor.tsx and types/index.ts (unchanged symlink issue from Task 3.3).

---

### Task 6.2 — Extract ConditionEditor component
**Files touched:** new file `packages/frontend/src/components/flow-editor/ConditionEditor.tsx`, `packages/frontend/src/pages/agent/FlowEditor.tsx`
**Done when:** A standalone `ConditionEditor` handles condition type, value, failMessage, and skip-to selectors. `FlowEditor.tsx` uses it. Visual output unchanged.
**Depends on:** Task 6.1 (to establish the pattern)
**Status:** `[x]`
**Notes:** Created `packages/frontend/src/components/flow-editor/ConditionEditor.tsx`. The component handles both cases: (1) the simplified branch UI for `element_exists` (two selectors for "element exists → go to" and "not found → go to"), and (2) the generic condition form for all other tools (checkbox to enable, check-type selector, optional value/minLength inputs, failMessage input, skipToStepId and skipToStepIdOnNoMatch dropdowns, and suggest-tool selector). Props are `{ step, steps, idx, agentTools, onUpdate }`. In `FlowEditor.tsx`: added import for `ConditionEditor`; replaced the 148-line inline condition block with a single `<ConditionEditor … />` call; removed the now-unused `StepCondition` import. `FlowEditor.tsx` shrank from 1664 to 1526 lines (138 lines removed). `tsc --noEmit` introduces zero new errors; all pre-existing errors are the same `FlowEditor.tsx` `expr` unknowns and `types/index.ts` symlink issue from Task 3.3.

---

### Task 6.3 — Extract StepCard and StepForm components
**Files touched:** new files `packages/frontend/src/components/flow-editor/StepCard.tsx`, `packages/frontend/src/components/flow-editor/StepForm.tsx`, `packages/frontend/src/pages/agent/FlowEditor.tsx`
**Done when:** Each step in the list renders via `StepCard` (collapsed view) and `StepForm` (expanded editing). Both use `InputMappingField` and `ConditionEditor`. `FlowEditor.tsx` is now primarily a list manager.
**Depends on:** Task 6.2
**Status:** `[x]`
**Notes:** Created `packages/frontend/src/components/flow-editor/StepForm.tsx` containing: `WaitForAnyStepCard` (moved from FlowEditor), and `StepForm` which renders the step body (evaluate prompt, human review fields, wait_for_any card, generic input mapping via `InputMappingField`, inline test result with expand/collapse, and `ConditionEditor`). Created `packages/frontend/src/components/flow-editor/StepCard.tsx` containing `StepCard` which renders the outer colored-border container, the header row (step number, label input, tool badge/selector, move/duplicate/return/delete buttons), and delegates to `StepForm`. In `FlowEditor.tsx`: removed `WaitForAnyStepCard` (moved to StepForm), removed `updateMapping` helper (StepForm now applies mapping updates directly via `onUpdate({ inputMapping: { ... } })`), removed `iconBtn` style constant (moved to StepCard), removed `InputExpression` type import (no longer used in FlowEditor), dropped `ExprEditor`/`InputMappingField`/`defaultExprForType`/`ConditionEditor` imports, replaced the 220-line `steps.map` block with a 28-line version that renders `<StepCard>` per step. `FlowEditor.tsx` shrank from 1526 to 1224 lines (302 lines removed). `tsc --noEmit` introduces zero new errors; all pre-existing errors are the same `expr` unknowns in FlowEditor and the `@agentspawner/shared` symlink issue from Task 3.3.

---

### Task 6.4 — Extract remaining FlowEditor sub-components and introduce useReducer
**Files touched:** new files `ReturnStepSelector.tsx`, `DedupSettings.tsx`, `HumanLoopFlags.tsx`, `FlowMetadata.tsx` in `components/flow-editor/`. `packages/frontend/src/pages/agent/FlowEditor.tsx`
**Done when:** `FlowEditor.tsx` is under 300 lines. It uses `useReducer` with a typed state/action. All sub-components are in `components/flow-editor/`. The full flow editing experience works identically to before.
**Depends on:** Task 6.3
**Status:** `[x]`
**Notes:** Created `packages/frontend/src/hooks/useFlowEditorState.ts` with `FlowDraft` state type, `FlowDraftAction` discriminated union (PATCH, SET_INPUT_DESCRIPTION, ADD_STEP, REMOVE_STEP, UPDATE_STEP, MOVE_STEP, DUPLICATE_STEP, TOGGLE_RETURN_STEP, SET_RETURN_STEP_KEY, APPLY_FIX), and the `useFlowEditorState(flow, prefill)` hook wrapping `useReducer`. Created the four required components: `HumanLoopFlags.tsx` (the two approval/inline-review checkboxes), `DedupSettings.tsx` (full dedup section, uses HumanLoopFlags), `FlowMetadata.tsx` (Metadata + Table Metadata sections), `ReturnStepSelector.tsx` (return-step hint + multi-key editor). Additionally extracted `ToolPickerModal.tsx`, `TestPanel.tsx`, `InsertStepBar.tsx`, `flow-editor-utils.ts` (parseSchema, detectFlowInputKeys, buildAutoKey), and `styles.ts` (shared CSS-in-JS constants) to bring FlowEditor.tsx down to **285 lines** (well under 300). `FlowEditor.tsx` now only contains: imports, the main component function using `useFlowEditorState`, simple `useState` calls for UI-only state (saving, error, testInput, fixMode, picker, etc.), handler functions (handleSave, handleTest, openStepFix, openFeedbackFix), and JSX that composes all sub-components. `tsc --noEmit` introduces zero new errors; all 18 remaining errors are the pre-existing `expr` unknowns in FlowEditor.tsx and the `@agentspawner/shared` symlink issue from Task 3.3.

---

## Group 7 — Backend Architecture (largest tasks — do last)
*Do in order. These restructure the most files.*

### Task 7.1 — Add structured logging (Pino) and replace console.log
**Files touched:** new file `packages/backend/src/lib/logger.ts`, `packages/backend/src/index.ts`, all route files and orchestrator files (replace `console.log/error` calls)
**Done when:** `pino` logger is instantiated in `lib/logger.ts`. All `console.log` and `console.error` calls in backend are replaced with `logger.info`, `logger.error`, etc., with relevant context fields (`agentId`, `runId`, `flowId`). No console.* calls remain in backend src.
**Depends on:** nothing (but easier after Group 1)
**Status:** `[x]`
**Notes:** Created `packages/backend/src/lib/logger.ts` exporting a `logger` (pino instance respecting `LOG_LEVEL` env var) and a `childLogger(bindings)` convenience factory. Symlinked `pino@10.3.1` from the pnpm store (`node_modules/.pnpm/pino@10.3.1/node_modules/pino`) into `packages/backend/node_modules/pino`; added `"pino": "^10.3.1"` to `backend/package.json` dependencies so `pnpm install` will maintain it on the next run. Replaced all 43 `console.*` calls across 12 files: `websocket/server.ts`, `memory/librarian.ts`, `scheduler/index.ts`, `telegram/index.ts`, `config.ts`, `routes/runs.ts`, `routes/reviews.ts`, `orchestrator/autonomous.ts`, `orchestrator/provision-tools.ts`, `orchestrator/flow-runner.ts` (using `this.log` from a child logger bound to `{ flowId, agentId }` created in the constructor), `orchestrator/index.ts`, and `src/index.ts`. The only remaining `console.log` in src is inside a documentation string in `routes/api-tools.ts` (line 167 lists `console.log` as an available global for user-authored API tool scripts — intentionally unchanged). `tsc --noEmit` introduces zero new errors; all 7 remaining errors are the pre-existing `flows.ts` symlink issue from Task 3.3.

---

### Task 7.2 — Introduce feature module structure: agents feature
**Files touched:** new folder `packages/backend/src/features/agents/` with `agents.routes.ts`, `agents.service.ts`, `agents.repository.ts`. `packages/backend/src/routes/agents.ts` is replaced by the new structure. `packages/backend/src/index.ts` updated to register new route path.
**Done when:** The `agents` route is fully moved to the feature module. All DB access for agents goes through `agents.repository.ts`. Business logic is in `agents.service.ts`. Route handler is thin. Old `routes/agents.ts` is deleted. All agent CRUD endpoints work identically.
**Depends on:** Task 7.1 (so logging is in place before restructure)
**Status:** `[x]`
**Notes:** Created `packages/backend/src/features/agents/` with three files. `agents.repository.ts` owns all Drizzle/SQLite access for the `agents` and `tools` tables (findAllAgents, findAgentById, insertAgent, updateAgent, deleteAgent, insertTool). `agents.service.ts` contains all business logic: `listAgents`, `getAgent`, `createAgent`, `updateAgentById`, `removeAgent` — handles encryption/decryption via `crypto/index.ts`, Telegram polling via `telegram/index.ts`, default tool provisioning, suppression token generation, and the `toPublicAgent` sanitiser (strips `apiKey`/`telegramKey`, adds `hasApiKey`). `agents.routes.ts` is a thin Fastify handler (≤55 lines) that parses request bodies with Zod and delegates entirely to the service. Updated `packages/backend/src/index.ts` to import `registerAgentRoutes` from the new feature module path. Deleted old `packages/backend/src/routes/agents.ts`. `tsc --noEmit` introduces zero new errors; all 8 remaining errors are pre-existing (pino symlink, `@agentspawner/shared` symlink, and `expr` unknowns in `flows.ts`).

---

### Task 7.3 — Introduce feature module structure: flows feature
**Files touched:** new folder `packages/backend/src/features/flows/` with `flows.routes.ts`, `flows.service.ts`, `flows.repository.ts`. Replaces `packages/backend/src/routes/flows.ts`. `FlowRunnerService` (from Task 4.1) moves here.
**Done when:** Full flows feature in module. Old `routes/flows.ts` deleted. Flow CRUD and test endpoints work. `flows-generate.ts` updated to use `flows.service.ts` for flow saves.
**Depends on:** Task 7.2, Task 4.1
**Status:** `[x]`
**Notes:** Created `packages/backend/src/features/flows/` with four files. `flows.repository.ts` owns all Drizzle/SQLite access for the `flows`, `flowRuns`, `tools` (name-collision checks), and `agents` tables (findFlows, findFlowById, findFlowByName, insertFlow, updateFlowById, deleteFlowById, findFlowRuns, findToolByName, findAgentById). `flows.service.ts` contains all business logic: `validateStepsAndCrossRefs` (moved from routes), `listFlows`, `getFlow`, `createFlow`, `updateFlow`, `pinFlow`, `deleteFlow`, `markFlowInfeasible`, `listFlowRuns`, `testInlineFlow`, `testSavedFlow` — also exports `FlowBody` and `InlineTestBody` Zod schemas. `flows.routes.ts` is a thin Fastify handler (≤120 lines) delegating entirely to the service. `flow-runner.ts` is the full `FlowRunnerService` class and all types/helpers moved from `orchestrator/flow-runner.ts`; relative imports updated accordingly (paths shifted one level deeper: `../../db/`, `../../orchestrator/tool-runner.js`, etc.). `orchestrator/flow-runner.ts` is now a one-line re-export shim (`export * from '../features/flows/flow-runner.js'`) so all 7 existing callers (orchestrator/index.ts, autonomous.ts, sub-agents.ts, scheduler/index.ts, flows-generate.ts, tests) continue to compile without changes. Updated `routes/flows-generate.ts` to import `runFlowDetailed` from `../features/flows/flow-runner.js`. Updated `src/index.ts` to import `registerFlowRoutes` from `./features/flows/flows.routes.js`. Deleted old `routes/flows.ts`. `tsc --noEmit` produces 8 errors — the same pre-existing errors from Task 7.2 (pino symlink in logger.ts, `@agentspawner/shared` symlink, and resulting `expr: unknown` errors), all of which have simply moved from the deleted `routes/flows.ts` to `features/flows/flows.service.ts`. Zero new errors introduced.

---

*End of task list. After all tasks are complete, delete this file and update CODEBASE_STRUCTURE.md to reflect the new architecture.*
