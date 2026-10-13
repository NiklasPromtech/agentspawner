/**
 * Unit tests for packages/backend/src/orchestrator/flow-runner.ts
 *
 * Run via: pnpm test  (or node --import tsx/esm --experimental-test-module-mocks --test src/__tests__/flow-runner.test.ts)
 *
 * Strategy:
 *  - Use flow.name === '__inline_test__' for most tests so finalize() is a no-op
 *    (skips DB writes, keeping tests hermetic).
 *  - Module mocks are registered via node:test mock.module() BEFORE dynamically
 *    importing the module under test, so flow-runner.ts picks up the fakes.
 *  - Mock state is controlled via module-level variables reset in beforeEach.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { FlowRecord } from '../orchestrator/flow-runner.js';
// Note: dynamic import of flow-runner happens AFTER mock.module() calls below

// ── Mock state ─────────────────────────────────────────────────────────────────
// These variables are read by the mock functions registered below.
// Each test sets them in its body or via beforeEach.

let _db: unknown = {};
/** Queue of JSON strings returned by runTool(), one per call (FIFO). */
const _runToolQueue: string[] = [];

// ── Mock DB factory ───────────────────────────────────────────────────────────

interface MockDbOptions {
  /** Rows returned when the code does `await db.select().from(tools).where(...)`. */
  toolRows?: unknown[];
  /** Rows returned when the code does `db.select()...where(...).limit(1)` (action-log dedup). */
  actionLogRows?: unknown[];
}

function makeDb(opts: MockDbOptions = {}) {
  const { toolRows = [], actionLogRows = [] } = opts;

  /**
   * Returns an object that satisfies multiple usage patterns:
   *   - `const [t] = await db.select().from(table).where(...)` (tools lookup — direct await)
   *   - `await db.select().from(table).where(...).limit(1)`    (old dedup — .limit chain)
   *   - `await db.select({...}).from(table).where(...).orderBy(...).limit(1)` (new dedup — .orderBy chain)
   */
  function whereResult() {
    // Extend a resolved Promise with .limit() and .orderBy() so all patterns work.
    return Object.assign(Promise.resolve(toolRows), {
      limit: () => Promise.resolve(actionLogRows),
      orderBy: () =>
        Object.assign(Promise.resolve(actionLogRows), {
          limit: () => Promise.resolve(actionLogRows),
        }),
    });
  }

  // partial select({...}) also needs the same chain
  function selectFieldsResult() {
    return {
      from: () => ({ where: whereResult }),
    };
  }

  // ── Synchronous chain used inside db.transaction() callbacks ──────────────
  // The flow runner's dedup guard wraps SELECT + INSERT in a synchronous SQLite
  // transaction (using .all() and .run() instead of await).  The mock must
  // provide the same interface so the callback can execute without throwing.
  function syncWhereResult() {
    return {
      orderBy: () => ({
        limit: () => ({ all: () => actionLogRows }),
      }),
      limit: () => ({ all: () => actionLogRows }),
      all: () => actionLogRows,
    };
  }

  function syncSelectFieldsResult() {
    return {
      from: () => ({ where: () => syncWhereResult() }),
    };
  }

  const syncTx = {
    select: (fields?: unknown) =>
      fields ? syncSelectFieldsResult() : { from: () => ({ where: () => syncWhereResult() }) },
    insert: () => ({ values: () => ({ run: () => undefined }) }),
    update: () => ({ set: () => ({ where: () => ({ run: () => undefined }) }) }),
  };

  return {
    select: (fields?: unknown) => (fields ? selectFieldsResult() : { from: () => ({ where: whereResult }) }),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    transaction: (fn: (tx: typeof syncTx) => unknown) => fn(syncTx),
  };
}

// ── Minimal mock tool record ──────────────────────────────────────────────────

const MOCK_TOOL = {
  id: 'tool-1',
  agentId: 'agent-1',
  name: 'mock_tool',
  type: 'api',
  url: 'https://example.com',
  method: 'POST',
  headers: '{}',
  bodyTemplate: '{}',
  apiKeySecretId: null,
  createdAt: new Date().toISOString(),
};

// ── Register module mocks BEFORE importing the module under test ──────────────
// IMPORTANT: mock.module() must be called before `import('../orchestrator/flow-runner.js')`
// so that when flow-runner.ts loads its dependencies, it gets the fakes.

await mock.module('../db/index.js', {
  namedExports: {
    getDb: () => _db,
  },
});

await mock.module('../orchestrator/tool-runner.js', {
  namedExports: {
    runTool: (_tool: unknown, _input: unknown, _agentId: unknown) => {
      const next = _runToolQueue.shift();
      return Promise.resolve(next ?? '{}');
    },
  },
});

await mock.module('../websocket/server.js', {
  namedExports: {
    executeExtensionTool: () => Promise.resolve('[]'),
    isExtensionConnected: () => false,
    sendReviewTab: () => undefined,
  },
});

await mock.module('../crypto/index.js', {
  namedExports: {
    encrypt: (x: string) => x,
    decrypt: (x: string) => x,
  },
});

// ── Import module under test AFTER mocks are in place ────────────────────────

const { runFlowDetailed } = (await import(
  '../orchestrator/flow-runner.js'
)) as typeof import('../orchestrator/flow-runner.js');

// ── Flow builder helpers ──────────────────────────────────────────────────────

/** Creates a minimal FlowRecord using '__inline_test__' to skip DB writes. */
function makeFlow(overrides: Partial<FlowRecord> = {}): FlowRecord {
  return {
    id: 'flow-1',
    agentId: 'agent-1',
    name: '__inline_test__',
    description: 'test',
    inputSchema: '{}',
    steps: '[]',
    returnStepId: null,
    returnSteps: null,
    reasoningModel: null,
    reasoningPrompt: null,
    resultMessage: null,
    flowType: null,
    stepDelayMs: 0,           // no inter-step delay in tests
    dedupKeyField: null,
    dedupBreakType: null,
    dedupIntervalHours: null,
    dedupBlockMessage: null,
    requiresApproval: null,
    requiresHumanReview: null,
    infeasible: null,
    infeasibleReason: null,
    expectedOutput: null,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Test suites
// ══════════════════════════════════════════════════════════════════════════════

describe('input resolution — literal', () => {
  beforeEach(() => {
    _db = makeDb();            // no tool rows needed for transform-only flows
    _runToolQueue.length = 0;  // clear queue
  });

  it('passes a literal value unchanged', async () => {
    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: '__transform__',
          label: 'Literal',
          inputMapping: { x: { type: 'literal', value: 99 } },
          transform: { script: 'return input.x;' },
        },
      ]),
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    assert.ok(result.ok);
    assert.strictEqual(result.stepResults['step-a'], 99);
  });

  it('interpolates {{key}} placeholders in literal strings', async () => {
    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: '__transform__',
          label: 'Template',
          inputMapping: {
            greeting: { type: 'literal', value: 'Hello, {{name}}!' },
          },
          transform: { script: 'return input.greeting;' },
        },
      ]),
    });

    const result = await runFlowDetailed(flow, { name: 'World' }, 'agent-1');

    assert.ok(result.ok);
    assert.strictEqual(result.stepResults['step-a'], 'Hello, World!');
  });
});

describe('input resolution — flow_input', () => {
  beforeEach(() => {
    _db = makeDb();
    _runToolQueue.length = 0;
  });

  it('reads a value from flowInput by key', async () => {
    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: '__transform__',
          label: 'FlowInput',
          inputMapping: { userId: { type: 'flow_input', key: 'user_id' } },
          transform: { script: 'return input.userId;' },
        },
      ]),
    });

    const result = await runFlowDetailed(flow, { user_id: 'usr-123' }, 'agent-1');

    assert.ok(result.ok);
    assert.strictEqual(result.stepResults['step-a'], 'usr-123');
  });
});

describe('input resolution — step_ref', () => {
  beforeEach(() => {
    _db = makeDb();
    _runToolQueue.length = 0;
  });

  it('passes a prior step result to the next step via step_ref', async () => {
    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: '__transform__',
          label: 'Producer',
          inputMapping: {},
          transform: { script: 'return { items: ["x", "y", "z"] };' },
        },
        {
          id: 'step-b',
          toolId: '__transform__',
          label: 'Consumer',
          inputMapping: {
            list: { type: 'step_ref', stepId: 'step-a', path: 'items' },
          },
          transform: { script: 'return input.list;' },
        },
      ]),
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    assert.ok(result.ok);
    // Normalise through JSON because transform steps run in vm.createContext,
    // so their returned arrays/objects have a different prototype than the
    // main-context equivalents; deepStrictEqual checks Object.getPrototypeOf.
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(result.stepResults['step-b'])),
      ['x', 'y', 'z'],
    );
  });

  it('surfaces step_ref path-not-found error in the step trace', async () => {
    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: '__transform__',
          label: 'Producer',
          inputMapping: {},
          transform: { script: 'return { foo: "bar" };' },
        },
        {
          id: 'step-b',
          toolId: '__transform__',
          label: 'Consumer',
          inputMapping: {
            val: { type: 'step_ref', stepId: 'step-a', path: 'nonexistent.deep.path' },
          },
          transform: { script: 'return input.val;' },
        },
      ]),
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    // The transform sentinel catches the error; step trace has the details.
    const stepB = result.stepResults['step-b'] as { error: string };
    assert.ok(stepB, 'step-b result should exist');
    assert.ok(typeof stepB.error === 'string', 'step-b should have an error field');
    assert.ok(
      stepB.error.includes('nonexistent.deep.path'),
      `error should mention the bad path; got: ${stepB.error}`,
    );
    assert.ok(
      stepB.error.includes('step-a'),
      `error should mention the source step; got: ${stepB.error}`,
    );
  });
});

describe('conditions — min_array_length', () => {
  beforeEach(() => {
    _db = makeDb({ toolRows: [MOCK_TOOL] });
    _runToolQueue.length = 0;
  });

  it('passes when array meets minLength', async () => {
    _runToolQueue.push(JSON.stringify(['a', 'b', 'c']));

    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: 'tool-1',
          label: 'List fetcher',
          inputMapping: {},
          condition: {
            check: 'min_array_length',
            minLength: 2,
            failMessage: 'Not enough items',
          },
        },
      ]),
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    assert.ok(result.ok);
    // Condition did not fire — final result is the tool output
    assert.deepStrictEqual(result.stepResults['step-a'], ['a', 'b', 'c']);
  });

  it('fails when array is below minLength and returns failMessage', async () => {
    _runToolQueue.push(JSON.stringify(['a'])); // only 1 item

    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: 'tool-1',
          label: 'List fetcher',
          inputMapping: {},
          condition: {
            check: 'min_array_length',
            minLength: 3,
            failMessage: 'Need at least 3 items',
          },
        },
      ]),
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    assert.ok(result.ok);
    assert.strictEqual(result.result, 'Need at least 3 items');
  });
});

describe('conditions — skipToStepId cleanup', () => {
  beforeEach(() => {
    _db = makeDb({ toolRows: [MOCK_TOOL] });
    _runToolQueue.length = 0;
  });

  it('runs cleanup steps starting from skipToStepId when condition fires', async () => {
    // step-a → condition fires (empty array, minLength 1)
    // step-b → should be skipped (between step-a and cleanup)
    // step-c → cleanup step reached via skipToStepId
    _runToolQueue.push(JSON.stringify([]));                     // step-a: empty array
    _runToolQueue.push(JSON.stringify({ cleaned: true }));      // step-c (cleanup)

    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: 'tool-1',
          label: 'Fetch data',
          inputMapping: {},
          condition: {
            check: 'min_array_length',
            minLength: 1,
            failMessage: 'No data found',
            skipToStepId: 'step-c',
          },
        },
        {
          id: 'step-b',
          toolId: 'tool-1',
          label: 'Should be skipped',
          inputMapping: {},
        },
        {
          id: 'step-c',
          toolId: 'tool-1',
          label: 'Cleanup',
          inputMapping: {},
        },
      ]),
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    assert.ok(result.ok);
    assert.strictEqual(result.result, 'No data found');
    // Cleanup step ran
    assert.deepStrictEqual(result.stepResults['step-c'], { cleaned: true });
    // step-b was never reached
    assert.strictEqual(result.stepResults['step-b'], undefined);
  });
});

describe('deduplication', () => {
  it('blocks on hard dedup when an action-log row already exists', async () => {
    const existingRow = {
      status: 'executed',
      blockedReason: null,
      createdAt: new Date().toISOString(),
    };
    _db = makeDb({ actionLogRows: [existingRow] });
    _runToolQueue.length = 0;

    const flow = makeFlow({
      id: 'flow-real',
      name: 'send_email',           // NOT __inline_test__ → finalize() runs
      flowType: 'action',
      dedupKeyField: 'user_id',
      dedupBreakType: 'hard',
      dedupIntervalHours: null,
      dedupBlockMessage: 'Email already sent to this user.',
    });

    const result = await runFlowDetailed(flow, { user_id: 'user-42' }, 'agent-1');

    assert.ok(result.ok);
    assert.ok(
      result.result?.startsWith('⛔ Hard stop:'),
      `result should be a hard stop message; got: ${result.result}`,
    );
    assert.ok(
      result.result?.includes('Email already sent to this user.'),
      `result should include dedupBlockMessage; got: ${result.result}`,
    );
  });

  it('blocks on soft dedup when within interval and returns a descriptive message', async () => {
    const existingRow = {
      status: 'executed',
      blockedReason: null,
      createdAt: new Date().toISOString(), // just now — within any interval
    };
    _db = makeDb({ actionLogRows: [existingRow] });
    _runToolQueue.length = 0;

    const flow = makeFlow({
      id: 'flow-soft',
      name: 'weekly_report',
      flowType: 'action',
      dedupKeyField: 'user_id',
      dedupBreakType: 'soft',
      dedupIntervalHours: 24,
      dedupBlockMessage: null,      // use generated default message
    });

    const result = await runFlowDetailed(flow, { user_id: 'user-99' }, 'agent-1');

    assert.ok(result.ok);
    assert.ok(
      result.result?.startsWith('⏳ Soft stop:'),
      `result should be a soft stop message; got: ${result.result}`,
    );
    assert.ok(
      result.result?.includes('user-99'),
      `result should mention the key value; got: ${result.result}`,
    );
    assert.ok(
      result.result?.includes('24h'),
      `result should mention the interval; got: ${result.result}`,
    );
  });

  it('throws a hard error when an action flow has no dedupKeyField', async () => {
    _db = makeDb();
    _runToolQueue.length = 0;

    const flow = makeFlow({
      id: 'flow-no-key',
      name: 'bad_action',
      flowType: 'action',
      dedupKeyField: null,    // missing!
      dedupBreakType: null,
    });

    await assert.rejects(
      () => runFlowDetailed(flow, { user_id: 'u1' }, 'agent-1'),
      (err: Error) => err.message.includes('no dedupKeyField'),
    );
  });

  it('blocks on pending_review status when action already in review queue', async () => {
    const existingRow = {
      status: 'pending_review',
      blockedReason: null,
      createdAt: new Date().toISOString(),
    };
    _db = makeDb({ actionLogRows: [existingRow] });
    _runToolQueue.length = 0;

    const flow = makeFlow({
      id: 'flow-pr',
      name: 'send_dm',
      flowType: 'action',
      dedupKeyField: 'handle',
      dedupBreakType: 'hard',
      dedupIntervalHours: null,
      dedupBlockMessage: null,
    });

    const result = await runFlowDetailed(flow, { handle: '@niklas' }, 'agent-1');

    assert.ok(result.ok);
    assert.ok(
      result.result?.startsWith('⏳ Already in review:'),
      `result should be an "in review" message; got: ${result.result}`,
    );
  });

  it('blocks on failed status when prior attempt errored', async () => {
    const existingRow = {
      status: 'failed',
      blockedReason: null,
      createdAt: new Date().toISOString(),
    };
    _db = makeDb({ actionLogRows: [existingRow] });
    _runToolQueue.length = 0;

    const flow = makeFlow({
      id: 'flow-fail',
      name: 'post_comment',
      flowType: 'action',
      dedupKeyField: 'post_url',
      dedupBreakType: 'hard',
      dedupIntervalHours: null,
      dedupBlockMessage: null,
    });

    const result = await runFlowDetailed(flow, { post_url: 'https://example.com/post' }, 'agent-1');

    assert.ok(result.ok);
    assert.ok(
      result.result?.startsWith('⚠ Previously failed:'),
      `result should be a "previously failed" message; got: ${result.result}`,
    );
  });
});

describe('result assembly — returnSteps', () => {
  beforeEach(() => {
    _db = makeDb();
    _runToolQueue.length = 0;
  });

  it('merges multiple step outputs into a single object keyed by returnSteps config', async () => {
    const flow = makeFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: '__transform__',
          label: 'Step A',
          inputMapping: {},
          transform: { script: 'return { count: 5 };' },
        },
        {
          id: 'step-b',
          toolId: '__transform__',
          label: 'Step B',
          inputMapping: {},
          transform: { script: 'return { status: "ok" };' },
        },
      ]),
      returnSteps: JSON.stringify([
        { key: 'stats', stepId: 'step-a' },
        { key: 'state', stepId: 'step-b' },
      ]),
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    assert.ok(result.ok);
    const parsed = JSON.parse(result.result!) as unknown;
    assert.deepStrictEqual(parsed, {
      stats: { count: 5 },
      state: { status: 'ok' },
    });
  });
});
