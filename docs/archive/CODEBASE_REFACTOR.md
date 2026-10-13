# AgentSpawner — Refactor Recommendations

> An opinionated guide to restructuring the codebase for 10,000× better maintainability, reliability, and scalability.
>
> This document covers: what hurts right now, what to do about it, and in what order.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Priority 1 — Fix the Foundations](#priority-1--fix-the-foundations)
   - [1.1 Split the monolith routes into feature modules](#11-split-the-monolith-routes-into-feature-modules)
   - [1.2 Replace the "SSE on a raw HTTP route" pattern](#12-replace-the-sse-on-a-raw-http-route-pattern)
   - [1.3 Move the database to a proper migration system](#13-move-the-database-to-a-proper-migration-system)
   - [1.4 Encrypt agent secrets](#14-encrypt-agent-secrets)
   - [1.5 Introduce a shared types package](#15-introduce-a-shared-types-package)
3. [Priority 2 — Tame the Flow System](#priority-2--tame-the-flow-system)
   - [2.1 Parse and validate flows at write-time, not run-time](#21-parse-and-validate-flows-at-write-time-not-run-time)
   - [2.2 Replace eval-based transforms with a sandboxed VM](#22-replace-eval-based-transforms-with-a-sandboxed-vm)
   - [2.3 Extract the flow runner into a standalone service](#23-extract-the-flow-runner-into-a-standalone-service)
   - [2.4 Build a proper step-input resolution layer](#24-build-a-proper-step-input-resolution-layer)
4. [Priority 3 — Frontend Architecture](#priority-3--frontend-architecture)
   - [3.1 Break FlowEditor.tsx into smaller components](#31-break-floweditor-tsx-into-smaller-components)
   - [3.2 Introduce a data-fetching layer (React Query)](#32-introduce-a-data-fetching-layer-react-query)
   - [3.3 Replace localStorage drafts with a proper draft system](#33-replace-localstorage-drafts-with-a-proper-draft-system)
   - [3.4 Centralise SSE event handling](#34-centralise-sse-event-handling)
5. [Priority 4 — Reliability & Observability](#priority-4--reliability--observability)
   - [4.1 Add structured logging](#41-add-structured-logging)
   - [4.2 Add a job queue for runs](#42-add-a-job-queue-for-runs)
   - [4.3 Write tests for the flow runner](#43-write-tests-for-the-flow-runner)
   - [4.4 Health check + graceful shutdown](#44-health-check--graceful-shutdown)
6. [Priority 5 — Scalability](#priority-5--scalability)
   - [5.1 Swap SQLite for Postgres (when ready)](#51-swap-sqlite-for-postgres-when-ready)
   - [5.2 Replace WebSocket tool bridge with a message broker](#52-replace-websocket-tool-bridge-with-a-message-broker)
   - [5.3 Introduce a proper auth layer](#53-introduce-a-proper-auth-layer)
7. [What to Leave Alone](#what-to-leave-alone)
8. [Recommended Migration Order](#recommended-migration-order)

---

## Executive Summary

AgentSpawner has a solid product vision and works end-to-end. The core abstractions (flows, steps, input expressions, dedup, human-in-the-loop) are well-designed. However, the implementation has accumulated several **dangerous shortcuts** and **structural bottlenecks** that will increasingly slow development and create subtle bugs.

The biggest issues, in order of severity:

1. **Giant files masquerading as components** (`FlowEditor.tsx` at 94KB, `FlowGenerator.tsx` at 39KB) — hard to reason about, impossible to test in isolation.
2. **No Zod validation at write-time** — malformed flows crash at run-time in production, often silently.
3. **`new Function()` for transforms** — arbitrary code execution on the server with no sandbox.
4. **Inline database migration code** — 19+ `ALTER TABLE` statements in `db/index.ts` that run on every startup.
5. **Agent secrets stored in plaintext** — the only table without encryption.
6. **No tests on the flow runner** — the most critical code path.
7. **Frontend state mixed between local state, API calls, and localStorage** with no consistent pattern.

Each section below identifies the problem, explains why it matters, and gives a concrete refactor path.

---

## Priority 1 — Fix the Foundations

### 1.1 Split the monolith routes into feature modules

**Problem**

The backend `routes/` folder is 16 flat files, each doing: validation, business logic, and DB access inline. There's no service layer. A change to how flows are executed requires touching routes, the orchestrator, and the flow runner simultaneously, with no clear boundary.

**What it causes**
- Logic duplication (e.g., "load agent by ID" pattern repeated in every route)
- Impossible to unit test business logic without standing up a full Fastify server
- Easy to accidentally introduce circular dependencies

**The fix — feature-based folder structure**

```
packages/backend/src/
  features/
    agents/
      agents.routes.ts      # HTTP handlers only — parse, validate, delegate, respond
      agents.service.ts     # Business logic (create, update, delete with side effects)
      agents.repository.ts  # All DB queries for agents
    flows/
      flows.routes.ts
      flows.service.ts
      flows.repository.ts
    runs/
      runs.routes.ts
      runs.service.ts
      runs.repository.ts
    ...
  lib/
    db.ts                   # Database singleton
    errors.ts               # Typed application errors
    logger.ts               # Structured logger
```

The route handler becomes thin:

```typescript
// flows.routes.ts
fastify.post('/', async (req, reply) => {
  const input = createFlowSchema.parse(req.body); // Zod validation
  const flow = await flowsService.create(req.params.agentId, input);
  return reply.status(201).send(flow);
});
```

All logic lives in `flows.service.ts`, all DB access in `flows.repository.ts`. This makes every layer independently testable.

---

### 1.2 Replace the "SSE on a raw HTTP route" pattern

**Problem**

The current SSE implementation writes directly to `reply.raw` (the underlying Node.js `http.ServerResponse`). This bypasses Fastify's lifecycle hooks, error handling, and serialisation. It also requires manually setting headers and managing the `clientDisconnected` flag.

```typescript
// Current — fragile
reply.raw.setHeader('Content-Type', 'text/event-stream');
let clientDisconnected = false;
reply.raw.on('close', () => { clientDisconnected = true; });
reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
```

**The fix — use a proper SSE abstraction**

Create a `SseStream` class:

```typescript
// lib/sse-stream.ts
export class SseStream {
  private closed = false;
  constructor(private reply: FastifyReply) {
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.on('close', () => { this.closed = true; });
  }
  get isOpen() { return !this.closed; }
  send(event: unknown) {
    if (this.closed) return;
    this.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  end() { this.reply.raw.end(); }
}
```

Now every SSE route simply does:
```typescript
const stream = new SseStream(reply);
// Pass stream.send to orchestrator; check stream.isOpen in loops
```

No more `clientDisconnected` flags scattered through orchestrator code.

---

### 1.3 Move the database to a proper migration system

**Problem**

`packages/backend/src/db/index.ts` contains 19+ `ALTER TABLE IF NOT EXISTS` statements that run on **every startup**. This is:
- Slow (each is a DB query)
- Dangerous (no rollback, no versioning)
- Untrackable (no migration history)
- A lie — migrations should run once, not every time

**The fix — Drizzle migrations**

Drizzle ORM already supports proper migration files. Run:

```bash
pnpm db:generate   # Generates SQL migration from schema diff
pnpm db:migrate    # Applies pending migrations once
```

The generated migrations go in `packages/backend/src/db/migrations/`, each named `0001_init.sql`, `0002_add_agent_secrets.sql`, etc. A `__drizzle_migrations` table tracks what's been applied.

Remove all the `ALTER TABLE` code from `db/index.ts`. The startup file becomes:

```typescript
export async function initDb() {
  const db = drizzle(sqlite(config.dbPath));
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  return db;
}
```

---

### 1.4 Encrypt agent secrets

**Problem**

`agentSecrets` stores API keys, passwords, and tokens used by script-type API tools. Unlike `agents.apiKeyEncrypted`, these values are stored in plaintext. Anyone with read access to the SQLite file has all credentials.

**The fix**

Apply the same pattern already used for `agents.apiKeyEncrypted`:

```typescript
// agentSecrets.repository.ts
async create(agentId: string, key: string, value: string) {
  const encrypted = encrypt(value);  // AES-256 via crypto/index.ts
  return db.insert(agentSecrets).values({ agentId, key, value: encrypted });
}

async getDecrypted(agentId: string, key: string): Promise<string | null> {
  const row = await db.select()...
  return row ? decrypt(row.value) : null;
}
```

The `api-tool-runner.ts` already calls `decrypt()` for `agents.apiKeyEncrypted` — apply the same to secrets.

This is a two-line fix with a one-line migration. Do it first.

---

### 1.5 Introduce a shared types package

**Problem**

TypeScript types are duplicated between backend and frontend. `packages/frontend/src/types/index.ts` manually re-declares everything from `packages/backend/src/db/schema.ts`. When a schema column is added, both files must be updated and they often drift.

**The fix — `packages/shared`**

```
packages/shared/
  src/
    types/
      agent.ts
      flow.ts
      run.ts
      ...
    schemas/          # Zod schemas for validation + type inference
      flow.schema.ts
      step.schema.ts
    index.ts
```

Both backend and frontend depend on `@agentspawner/shared`. Types are the single source of truth. Zod schemas double as validation on the server and as form schemas on the client (e.g., with `react-hook-form + zod`).

**`pnpm-workspace.yaml` update:**
```yaml
packages:
  - 'packages/*'
```

Both packages add `"@agentspawner/shared": "workspace:*"` to their `package.json`.

---

## Priority 2 — Tame the Flow System

### 2.1 Parse and validate flows at write-time, not run-time

**Problem**

Flows are stored as JSON strings. They are parsed and assumed-valid at run-time in `flow-runner.ts`. A missing field, wrong type, or typo in a `step_ref` path will only be discovered when the flow actually runs — possibly hours later in an autonomous loop.

**The fix — Zod schema validation on write**

Define the authoritative flow schema in `packages/shared`:

```typescript
// shared/src/schemas/flow.schema.ts
import { z } from 'zod';

export const InputExpressionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('literal'), value: z.unknown() }),
  z.object({ type: z.literal('flow_input'), key: z.string().min(1) }),
  z.object({ type: z.literal('step_ref'), stepId: z.string().uuid(), path: z.string() }),
]);

export const FlowStepSchema = z.object({
  id: z.string().uuid(),
  toolId: z.string().min(1),
  label: z.string().min(1),
  inputMapping: z.record(InputExpressionSchema),
  condition: z.object({
    check: z.enum(['min_array_length', 'non_empty', 'result_equals', 'result_not_equals', 'has_error', 'no_error']),
    minLength: z.number().optional(),
    value: z.string().optional(),
    failMessage: z.string(),
    skipToStepId: z.string().uuid().optional(),
    skipToStepIdOnNoMatch: z.string().uuid().optional(),
  }).optional(),
  evaluate: z.object({
    prompt: z.string().min(1),
    screenshotStepId: z.string().uuid().optional(),
  }).optional(),
  transform: z.object({ script: z.string().min(1) }).optional(),
});

export const FlowSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(1),
  inputSchema: z.string(),  // JSON Schema string
  steps: z.array(FlowStepSchema).min(1),
  returnStepId: z.string().uuid().nullable().optional(),
  // ...etc
});
```

In `flows.service.ts`:

```typescript
async create(agentId: string, input: unknown) {
  const parsed = FlowSchema.parse(input);  // throws ZodError with field-level messages
  // Also validate: step_ref stepIds reference real steps in the flow
  validateStepRefs(parsed.steps);
  return flowsRepository.create(agentId, parsed);
}
```

Now **bad flows are rejected at the API boundary** with a clear error message, not silently at midnight in an autonomous run.

---

### 2.2 Replace eval-based transforms with a sandboxed VM

**Problem**

`__transform__` steps execute arbitrary JavaScript via `new Function(script)(input)`. This runs code directly in the Node.js process, with access to `require`, `process`, `fs`, the database, etc. If an AI generates a bad transform (or a user pastes malicious code), it can do anything.

**The fix — Node.js `vm` module with a context**

```typescript
// lib/sandbox.ts
import { createContext, runInContext } from 'vm';

export function runTransform(script: string, input: unknown): unknown {
  const sandbox = {
    input,
    console: { log: () => {} },  // no-op console
    result: undefined as unknown,
  };
  const context = createContext(sandbox);
  const wrapped = `result = (function(input) { ${script} })(input);`;
  runInContext(wrapped, context, {
    timeout: 2000,             // 2s max
    breakOnSigint: true,
  });
  return sandbox.result;
}
```

`vm.createContext` isolates the script: no `require`, no `process`, no file system. The `timeout` option kills infinite loops. This is a 30-line fix that eliminates a critical security gap.

---

### 2.3 Extract the flow runner into a standalone service

**Problem**

`flow-runner.ts` is imported by the orchestrator, the test routes, the schedule runner, and the generate route. It has grown to handle dedup, human approval, human review, evaluation, transform, logging, and result assembly — all in one file. Adding a new step type or changing the dedup logic touches everything.

**The fix — dedicated `FlowRunner` class**

```typescript
// features/flows/flow-runner.service.ts
export class FlowRunnerService {
  constructor(
    private tools: ToolService,
    private apiTools: ApiToolService,
    private actionLog: ActionLogRepository,
    private flowRuns: FlowRunsRepository,
    private pendingActions: PendingActionsRepository,
    private humanReviews: HumanReviewsRepository,
  ) {}

  async run(flow: Flow, input: Record<string, unknown>, context: RunContext): Promise<FlowResult> {
    await this.checkDedup(flow, input);
    const stepResults = await this.executeSteps(flow.steps, input, context);
    const output = this.assembleResult(flow, stepResults);
    await this.postRun(flow, input, output, context);
    return { output, stepResults };
  }

  private async executeSteps(steps: FlowStep[], input, context): Promise<StepResults> { ... }
  private resolveInput(expr: InputExpression, flowInput, stepResults): unknown { ... }
  private async checkDedup(flow, input): Promise<void> { ... }
  private async postRun(flow, input, output, context): Promise<void> { ... }
}
```

Benefits:
- Each method is independently testable
- Dependency injection makes it easy to mock tools in tests
- Adding a new step type is a single `case` in `executeSteps`

---

### 2.4 Build a proper step-input resolution layer

**Problem**

`step_ref` resolution uses `getByDotPath(result, path)`. If the prior step returns a plain string (e.g., a URL) but `path = "url"`, the result is `undefined` — and no error is thrown. This is the root cause of the `web_fetch requires a "url" string parameter` bug seen in the previous session.

The resolution logic is also duplicated in the flow runner and in parts of the editor.

**The fix — a typed resolver with validation**

```typescript
// lib/input-resolver.ts
export function resolveInputExpression(
  expr: InputExpression,
  flowInput: Record<string, unknown>,
  stepResults: Record<string, unknown>,
): { value: unknown; error?: string } {
  if (expr.type === 'literal') return { value: expr.value };

  if (expr.type === 'flow_input') {
    if (!(expr.key in flowInput)) return { value: undefined, error: `flow_input key '${expr.key}' not found` };
    return { value: flowInput[expr.key] };
  }

  if (expr.type === 'step_ref') {
    const stepResult = stepResults[expr.stepId];
    if (stepResult === undefined) return { value: undefined, error: `step '${expr.stepId}' has no result yet` };

    if (expr.path === '' || expr.path === '.') return { value: stepResult };

    const resolved = getByDotPath(stepResult, expr.path);
    if (resolved === undefined) {
      // Surface the actual type to make debugging easy
      return {
        value: undefined,
        error: `step_ref path '${expr.path}' not found in result of type '${typeof stepResult}': ${JSON.stringify(stepResult).slice(0, 100)}`
      };
    }
    return { value: resolved };
  }
}
```

Now any `step_ref` resolution that produces `undefined` gives a clear error message in the step trace instead of silently passing `undefined` to the next tool.

---

## Priority 3 — Frontend Architecture

### 3.1 Break FlowEditor.tsx into smaller components

**Problem**

`FlowEditor.tsx` is 94KB and handles everything: flow metadata, step list, individual step editing, input mapping, conditions, evaluation, dedup, return step, human review flags, infeasibility, and pinning. It is effectively a mini-application stuffed into a single React component. Adding a new step type or input mapping mode requires navigating 3,000+ lines of JSX.

**The fix — component decomposition**

```
components/flow-editor/
  FlowEditor.tsx              # 200 lines — orchestrates sub-components, holds top-level state
  FlowMetadata.tsx            # name, description, flowType, dedupSettings
  StepList.tsx                # sortable list, add/remove/reorder
  StepCard.tsx                # individual step (collapsed/expanded)
  StepForm.tsx                # toolId, label, inputMapping, condition, evaluate
  InputMappingField.tsx       # single input expression editor (literal/flow_input/step_ref)
  ConditionEditor.tsx         # condition type, value, skip-to selector
  EvaluateBlock.tsx           # vision prompt, screenshotStepId
  ReturnStepSelector.tsx      # single / multi-return
  DedupSettings.tsx           # keyField, breakType, interval
  HumanLoopFlags.tsx          # requiresApproval, requiresHumanReview
```

The top-level `FlowEditor` uses `useReducer` with a typed `FlowEditorState` and `FlowEditorAction` to manage state, passing down only what each sub-component needs.

Each sub-component is under 200 lines, testable with Vitest + React Testing Library, and independently importable in Storybook.

---

### 3.2 Introduce a data-fetching layer (React Query)

**Problem**

Every page/tab does its own `useEffect + useState + fetch` pattern. This means:
- No caching (every tab mount re-fetches everything)
- No background revalidation
- Stale data after mutations (must manually call `loadFlows()` after creating a flow)
- Loading/error states duplicated in every component

**The fix — React Query (TanStack Query)**

```typescript
// hooks/useFlows.ts
export function useFlows(agentId: string) {
  return useQuery({
    queryKey: ['flows', agentId],
    queryFn: () => api.getFlows(agentId),
    staleTime: 30_000,
  });
}

// hooks/useCreateFlow.ts
export function useCreateFlow(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (flow: FlowInput) => api.createFlow(agentId, flow),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['flows', agentId] }),
  });
}
```

The components become:

```typescript
const { data: flows, isLoading } = useFlows(agentId);
const { mutate: createFlow } = useCreateFlow(agentId);
```

No more manual refetch calls, no more stale lists after mutations. The polling for autonomous run status (currently every 8s with `setInterval`) becomes:

```typescript
useQuery({ queryKey: ['autonomous-status', agentId], refetchInterval: 8000 });
```

---

### 3.3 Replace localStorage drafts with a proper draft system

**Problem**

Draft persistence for onboarding and flow generation uses ad-hoc `localStorage` key patterns like `${agentId}-flow-${index}`. This has several issues:
- Keys are constructed inline, not in a central place
- No TTL — drafts accumulate forever
- No cross-tab sync
- Implementation details (key naming) leak into components

**The fix — a draft service**

```typescript
// lib/drafts.ts
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface Draft<T> { data: T; savedAt: number; }

export const drafts = {
  save<T>(key: string, data: T) {
    localStorage.setItem(key, JSON.stringify({ data, savedAt: Date.now() } satisfies Draft<T>));
  },
  load<T>(key: string): T | null {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const draft: Draft<T> = JSON.parse(raw);
    if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return draft.data;
  },
  clear(key: string) { localStorage.removeItem(key); },

  // Named keys — one place
  keys: {
    onboarding: (agentId: string) => `onboarding:${agentId}`,
    flowGenerator: (agentId: string, flowIndex: number) => `flow-gen:${agentId}:${flowIndex}`,
  },
};
```

Components use `drafts.save(drafts.keys.flowGenerator(agentId, index), state)` — the naming is never duplicated.

---

### 3.4 Centralise SSE event handling

**Problem**

`FlowGenerator.tsx` contains a full in-component implementation of SSE event parsing, `AbortController` management, `autoSentRef`, and reconnection logic. It's been the source of the React Strict Mode bugs, the "Thinking..." hang, and the "stream dies silently" bugs from the previous session.

**The fix — `useFlowGeneratorStream` hook**

```typescript
// hooks/useFlowGeneratorStream.ts
export function useFlowGeneratorStream(agentId: string) {
  const [events, setEvents] = useState<GeneratorEvent[]>([]);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'done' | 'error'>('idle');
  const cancelRef = useRef<() => void>(null);

  const send = useCallback((messages: Message[]) => {
    cancelRef.current?.(); // cancel any in-flight stream
    setEvents([]);
    setStatus('streaming');

    const controller = new AbortController();
    cancelRef.current = () => controller.abort();

    api.generateFlowStream(agentId, messages, (event) => {
      setEvents(prev => [...prev, event]);
      if (event.type === 'done' || event.type === 'complete') setStatus('done');
      if (event.type === 'error') setStatus('error');
    }, controller.signal);
  }, [agentId]);

  const cancel = useCallback(() => {
    cancelRef.current?.();
    setStatus('idle');
  }, []);

  // Cleanup on unmount
  useEffect(() => () => cancelRef.current?.(), []);

  return { events, status, send, cancel };
}
```

`FlowGenerator.tsx` shrinks dramatically — it just calls `useFlowGeneratorStream` and renders `events`. All the fragile ref and abort logic lives in one tested place.

---

## Priority 4 — Reliability & Observability

### 4.1 Add structured logging

**Problem**

`console.log` and `console.error` calls are scattered throughout the codebase with no level control, no context (agentId, runId, etc.), and no machine-readable format. In production, it's impossible to search logs for a specific agent's errors.

**The fix — Pino (already Fastify's default logger)**

```typescript
// lib/logger.ts
import pino from 'pino';
export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
```

In route handlers:
```typescript
req.log.info({ agentId, runId }, 'starting run');
```

In services:
```typescript
logger.child({ agentId }).error({ error: e.message }, 'flow failed');
```

Replace all `console.log/error` with structured logger calls. This also makes it trivial to forward logs to Datadog, Logtail, etc. later.

---

### 4.2 Add a job queue for runs

**Problem**

When a run is created, `runOrchestrator` is called immediately in the request handler and the SSE stream is tied to that HTTP connection. If the connection drops, the run keeps executing but the client gets no events. There's also no back-pressure: 10 simultaneous autonomous agents can all start heavy Claude loops at once.

**The fix — BullMQ or a simple SQLite-backed queue**

For local-first use, a simple in-process queue is enough:

```typescript
// lib/run-queue.ts
import { Queue, Worker } from 'bullmq';  // or a simple p-queue

const runQueue = new Queue('runs');
const worker = new Worker('runs', async (job) => {
  const { runId, agentId } = job.data;
  await runOrchestrator(runId, agentId, ...);
}, { concurrency: 3 });  // max 3 simultaneous orchestrators
```

The SSE stream connects to a **separate event bus** (e.g., a simple `EventEmitter` keyed by runId) that the orchestrator publishes to. This decouples the run lifecycle from the HTTP connection.

The client can reconnect and replay missed events from the `messages` table.

---

### 4.3 Write tests for the flow runner

**Problem**

The flow runner (`flow-runner.ts`) is the most critical code path in the entire system — every flow execution passes through it. It currently has **zero tests**. The dedup logic, condition evaluation, multi-return assembly, and input resolution are all complex enough to have subtle edge cases that only appear in production.

**The fix — Vitest unit tests**

```typescript
// features/flows/__tests__/flow-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { FlowRunnerService } from '../flow-runner.service';

describe('input resolution', () => {
  it('resolves literal values', async () => { ... });
  it('resolves flow_input keys', async () => { ... });
  it('resolves step_ref with dot path', async () => { ... });
  it('returns clear error when step_ref path not found', async () => { ... });
  it('returns clear error when step_ref stepId not found', async () => { ... });
});

describe('deduplication', () => {
  it('hard blocks repeated action within any time window', async () => { ... });
  it('soft blocks within interval, allows after interval', async () => { ... });
  it('does not dedup scrape flows', async () => { ... });
});

describe('conditions', () => {
  it('min_array_length passes when array is long enough', async () => { ... });
  it('min_array_length fails and returns failMessage', async () => { ... });
  it('skipToStepId jumps to cleanup step', async () => { ... });
});

describe('multi-return', () => {
  it('assembles object from returnSteps', async () => { ... });
});
```

Aim for 80% coverage on the flow runner before adding new features. This alone will eliminate most production bugs.

---

### 4.4 Health check + graceful shutdown

**Problem**

There's no `/health` endpoint, making it impossible to use with any load balancer, container orchestrator, or uptime monitor. There's also no graceful shutdown — if the process is killed while an autonomous run is in progress, the run is left in `'running'` state (which the startup code already tries to fix, but only for the happy path).

**The fix**

```typescript
// routes/health.ts
fastify.get('/health', async () => ({
  status: 'ok',
  db: await db.get('SELECT 1').then(() => 'ok').catch(() => 'error'),
  extension: wsServer.isConnected() ? 'connected' : 'disconnected',
  runningRuns: runRegistry.count(),
}));
```

```typescript
// index.ts
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await runRegistry.stopAll();    // mark all running runs as 'stopped'
  await fastify.close();
  process.exit(0);
});
```

---

## Priority 5 — Scalability

### 5.1 Swap SQLite for Postgres (when ready)

**Problem**

SQLite is excellent for local-first development. It becomes a bottleneck when:
- Multiple users share the server
- Multiple autonomous agents run simultaneously (SQLite serialises writes)
- The database is on a separate machine from the app

The current schema is Drizzle-based, so the migration is mostly mechanical. The main obstacle is that **the additive migration pattern in `db/index.ts` needs to be converted to proper Drizzle migrations first** (see Priority 1.3).

**The path**

1. Complete Priority 1.3 (proper migration system)
2. Add `DATABASE_URL` env var detection in `config.ts`
3. Switch `drizzle(sqlite(...))` to `drizzle(postgres(...))` when `DATABASE_URL` starts with `postgres://`
4. Run `pnpm db:generate` to produce Postgres-compatible migration SQL
5. All business logic is unchanged — Drizzle handles the dialect difference

---

### 5.2 Replace WebSocket tool bridge with a message broker

**Problem**

The current architecture is: `backend WebSocket server ↔ Chrome extension`. This is a direct, fragile connection. If the WebSocket drops mid-execution, tool calls fail with no retry. If the backend restarts, the extension must reconnect and pending tool calls are lost.

**The longer-term fix**

For single-user local deployment, the current approach is fine. But if multiple users or multiple browser instances are involved:

Use **Redis pub/sub** (or a simple SQLite queue) as the intermediary:

```
Backend: enqueue EXECUTE_TOOL to Redis stream
Extension: poll Redis stream, execute, enqueue TOOL_RESULT
Backend: await TOOL_RESULT from Redis stream (with timeout)
```

This decouples the extension from the backend lifecycle. The extension can reconnect, check for pending work, and resume. Tool calls get automatic timeout + retry logic.

For the current single-user scenario, add a **reconnection loop** to the extension background service worker:
```typescript
// extension/background/index.ts
function connect() {
  ws = new WebSocket('ws://localhost:3001');
  ws.onclose = () => setTimeout(connect, 3000);  // auto-reconnect
}
```

---

### 5.3 Introduce a proper auth layer

**Problem**

There is currently **no authentication**. Any process with network access to port 3001 can read all agents, all secrets, all conversation history, and execute flows. This is acceptable for a local tool but must be addressed before any hosted deployment.

**The fix — API key auth (simplest viable approach)**

```typescript
// lib/auth.ts
fastify.addHook('preHandler', async (req, reply) => {
  if (req.url.startsWith('/health')) return;  // public
  const key = req.headers['x-api-key'];
  if (key !== config.adminApiKey) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
});
```

For multi-user: JWT + user table. For SSO: a simple OAuth2 provider like Clerk or Auth0 can be integrated in a day. But even a single static API key is infinitely better than no auth.

---

## What to Leave Alone

Some things are well-designed and should not be changed:

**The flow data model** — The `FlowStep + InputExpression + condition` structure is elegant. It cleanly separates data wiring from execution logic. Don't replace it.

**The suppression token pattern** — Elegant, simple, and effective. Keep it.

**The dedup guard design** — The `hard / soft` dedup types on `actionLog` are well thought out. Just add tests.

**The tone learning loop** — `toneEdits → toneGuide` feedback loop is a good idea. Formalize it with a proper training pipeline later, but the concept is sound.

**The `persistDraftForAgent` draft system** — The concept is right (per-agent, per-flow-index keys). Just extract it into the `drafts.ts` service described above.

**The autonomous meta-prompt structure** — The ORIENT → QUEUE → GOALS → RECALL → ACT → BUILD cycle is a solid design. Don't rewrite it; just make the orchestrator more robust around it.

**The Chrome extension architecture** — Background → Offscreen → Content is the right approach for Manifest v3. The three-layer design is correct; just add the reconnection loop.

---

## Recommended Migration Order

Work through these in order. Each step delivers standalone value without requiring the next.

**Week 1 — Security & foundations**
1. Encrypt `agentSecrets` (30 min, zero risk)
2. Migrate `db/index.ts` to Drizzle migrations (2-3 hours)
3. Add `SseStream` class (1 hour)
4. Add health check + graceful shutdown (1 hour)

**Week 2 — Type safety**
5. Add `packages/shared` with Zod schemas
6. Add Zod validation to all flow write routes
7. Fix `step_ref` path resolution with clear error messages

**Week 3 — Flow runner hardening**
8. Extract `FlowRunner` class with dependency injection
9. Replace `new Function()` with `vm.createContext`
10. Write unit tests for flow runner (target: 80% coverage)

**Week 4 — Frontend**
11. Install React Query; replace first two tabs' data fetching
12. Extract `useFlowGeneratorStream` hook
13. Begin decomposing `FlowEditor.tsx`

**Week 5+ — Architecture**
14. Introduce feature module structure for backend
15. Add structured logging
16. Add job queue for runs

**When needed — Scale**
17. SQLite → Postgres
18. Add auth layer
19. WebSocket → message broker

Following this order, the codebase improves meaningfully at each step, with no long "nothing works" periods mid-refactor.
