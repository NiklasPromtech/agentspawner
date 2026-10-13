/**
 * Unit tests for the dedup guard in the flow runner.
 *
 * OPERATION CONVERGENCE — Task 13
 *
 * Specifically tests the interaction between requiresApproval: true and the
 * dedup system:
 *   - First run with a new key → queued as pending_review
 *   - Second run with same key, prior entry still in pending_review → blocked
 *   - Run with different key (no prior entry) → queued as a fresh pending_review
 *   - Run with skipDedup: true → bypasses queue, executes steps immediately
 *
 * Uses the same mock infrastructure as flow-runner.test.ts.
 * The mock DB must support both async (await) and sync (.all()/.run()) queries
 * because the dedup guard uses a synchronous SQLite transaction internally.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { FlowRecord } from '../orchestrator/flow-runner.js';

// ── Mock state ────────────────────────────────────────────────────────────────

let _db: unknown = {};

interface MockActionLogRow {
  status: string;
  blockedReason: string | null;
  createdAt: string;
}

interface MockDbOptions {
  actionLogRows?: MockActionLogRow[];
}

// ── Mock DB factory (supports both async and sync query patterns) ──────────────

function makeDb(opts: MockDbOptions = {}) {
  const { actionLogRows = [] } = opts;

  // Async chain — used for top-level `await db.select()...` calls
  function whereResult() {
    return Object.assign(Promise.resolve([]), {
      limit: () => Promise.resolve(actionLogRows),
      orderBy: () =>
        Object.assign(Promise.resolve(actionLogRows), {
          limit: () => Promise.resolve(actionLogRows),
        }),
    });
  }

  function selectFieldsResult() {
    return { from: () => ({ where: whereResult }) };
  }

  // Sync chain — used inside db.transaction() callbacks (.all(), .run())
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
    return { from: () => ({ where: () => syncWhereResult() }) };
  }

  const syncTx = {
    select: (fields?: unknown) =>
      fields ? syncSelectFieldsResult() : { from: () => ({ where: () => syncWhereResult() }) },
    insert: () => ({ values: () => ({ run: () => undefined }) }),
    update: () => ({ set: () => ({ where: () => ({ run: () => undefined }) }) }),
  };

  return {
    select: (fields?: unknown) =>
      fields ? selectFieldsResult() : { from: () => ({ where: whereResult }) },
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    transaction: (fn: (tx: typeof syncTx) => unknown) => fn(syncTx),
  };
}

// ── Register mocks BEFORE importing the module under test ────────────────────

await mock.module('../db/index.js', {
  namedExports: { getDb: () => _db },
});

await mock.module('../orchestrator/tool-runner.js', {
  namedExports: {
    runTool: () => Promise.resolve('{}'),
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

// ── Import after mocks ────────────────────────────────────────────────────────

const { runFlowDetailed } = (await import(
  '../orchestrator/flow-runner.js'
)) as typeof import('../orchestrator/flow-runner.js');

// ── Flow builder ──────────────────────────────────────────────────────────────

function makeActionFlow(overrides: Partial<FlowRecord> = {}): FlowRecord {
  return {
    id: 'flow-approval',
    agentId: 'agent-1',
    name: 'post_comment',          // NOT __inline_test__ → dedup + approval logic runs
    description: 'Post a comment',
    inputSchema: '{"post_url": "URL of the post to comment on"}',
    steps: '[]',
    returnStepId: null,
    returnSteps: null,
    reasoningModel: null,
    reasoningPrompt: null,
    resultMessage: null,
    flowType: 'action',
    stepDelayMs: 0,
    dedupKeyField: 'post_url',
    dedupBreakType: 'hard',
    dedupIntervalHours: null,
    dedupBlockMessage: null,
    requiresApproval: true,
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

describe('dedup guard — requiresApproval flows', () => {
  beforeEach(() => {
    _db = makeDb({ actionLogRows: [] });
  });

  it('queues a new key as pending_review and returns the queue message', async () => {
    // No prior entry → dedup passes → flow queued for review
    const flow = makeActionFlow();
    const result = await runFlowDetailed(flow, { post_url: 'https://example.com/new' }, 'agent-1');

    assert.ok(result.ok);
    assert.ok(
      result.result?.startsWith('⏸ Queued for review:'),
      `should return a "Queued for review" message; got: ${result.result}`,
    );
    assert.ok(
      result.result?.includes('post_comment'),
      `message should include the flow name; got: ${result.result}`,
    );
  });

  it('blocks a second run with the same key already in pending_review', async () => {
    // Prior entry exists with status 'pending_review' → dedup blocks
    _db = makeDb({
      actionLogRows: [
        {
          status: 'pending_review',
          blockedReason: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const flow = makeActionFlow();
    const result = await runFlowDetailed(
      flow,
      { post_url: 'https://example.com/already-queued' },
      'agent-1',
    );

    assert.ok(result.ok);
    assert.ok(
      result.result?.startsWith('⏳ Already in review:'),
      `should return an "already in review" block message; got: ${result.result}`,
    );
    assert.ok(
      result.result?.includes('https://example.com/already-queued'),
      `message should include the key value; got: ${result.result}`,
    );
  });

  it('queues a fresh pending_review for a different (unseen) key', async () => {
    // Different key = no prior entry → another queue message
    _db = makeDb({ actionLogRows: [] });

    const flow = makeActionFlow();
    const result = await runFlowDetailed(
      flow,
      { post_url: 'https://example.com/totally-new' },
      'agent-1',
    );

    assert.ok(result.ok);
    assert.ok(
      result.result?.startsWith('⏸ Queued for review:'),
      `different key should also queue as pending_review; got: ${result.result}`,
    );
  });

  it('blocks when the same key has been hard-stopped (status: executed)', async () => {
    _db = makeDb({
      actionLogRows: [
        {
          status: 'executed',
          blockedReason: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    const flow = makeActionFlow({ dedupBreakType: 'hard' });
    const result = await runFlowDetailed(
      flow,
      { post_url: 'https://example.com/already-done' },
      'agent-1',
    );

    assert.ok(result.ok);
    assert.ok(
      result.result?.startsWith('⛔ Hard stop:'),
      `should return a hard-stop block; got: ${result.result}`,
    );
  });
});

describe('dedup guard — skipDedup bypasses the approval queue', () => {
  beforeEach(() => {
    _db = makeDb({ actionLogRows: [] });
  });

  it('executes the flow immediately when skipDedup: true, regardless of requiresApproval', async () => {
    // With skipDedup: true, the flow runner skips the dedup check AND the
    // requiresApproval queue — so the flow executes and returns a real result.
    const flow = makeActionFlow({
      steps: JSON.stringify([
        {
          id: 'step-a',
          toolId: '__transform__',
          label: 'Echo',
          inputMapping: { url: { type: 'flow_input', key: 'post_url' } },
          transform: { script: 'return "executed: " + input.url;' },
        },
      ]),
    });

    const result = await runFlowDetailed(
      flow,
      { post_url: 'https://example.com/play-endpoint' },
      'agent-1',
      { skipDedup: true },
    );

    assert.ok(result.ok);
    assert.ok(
      result.result?.includes('executed: https://example.com/play-endpoint'),
      `skipDedup should bypass the queue and run steps; got: ${result.result}`,
    );
    // Must NOT return a "Queued for review" message
    assert.ok(
      !result.result?.includes('Queued for review'),
      `skipDedup must not queue for review; got: ${result.result}`,
    );
  });
});
