/**
 * Unit tests for extension disconnection resilience.
 *
 * OPERATION CONVERGENCE — Task 13
 *
 * Verifies that browser tool calls fail fast (immediately) when the extension
 * is not connected, rather than hanging for up to 30 seconds before timing out.
 *
 * This was introduced in Task 6 of OPERATION CONVERGENCE: the executeExtensionTool
 * function now does a pre-flight isExtensionConnected() check and rejects the
 * promise immediately when no extension is present.
 *
 * Tests:
 *   1. executeExtensionTool with no active socket → immediate rejection, not a timeout
 *   2. Error message is actionable (tells the agent what to do)
 *   3. The flow runner propagates the fast-fail error cleanly when an extension
 *      tool is called with no extension connected
 */

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { FlowRecord } from '../orchestrator/flow-runner.js';

// ══════════════════════════════════════════════════════════════════════════════
// Suite A: executeExtensionTool directly (no mocking of websocket/server)
//
// The active socket is null by default (module-level variable in server.ts),
// so isExtensionConnected() returns false and the function rejects immediately.
// ══════════════════════════════════════════════════════════════════════════════

describe('executeExtensionTool — fast failure when disconnected', () => {
  // Import the actual module (not mocked) so we test real behaviour
  let executeExtensionTool: (
    toolName: string,
    input: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<unknown>;

  before(async () => {
    const mod = await import('../websocket/server.js');
    executeExtensionTool = mod.executeExtensionTool;
  });

  it('rejects immediately (no timeout delay) when extension is not connected', async () => {
    // Record the start time.  The call should reject well under 100 ms;
    // a 30-second timeout would obviously blow that budget.
    const start = Date.now();

    await assert.rejects(
      () => executeExtensionTool('click', { selector: '#button' }),
      (err: Error) => {
        assert.ok(err instanceof Error, 'rejection should be an Error');
        return true;
      },
    );

    const elapsed = Date.now() - start;
    assert.ok(
      elapsed < 500,
      `fast-fail should complete in <500 ms; took ${elapsed} ms (would be 30 000 ms if it timed out)`,
    );
  });

  it('includes an actionable error message that explains why and what to do', async () => {
    await assert.rejects(
      () => executeExtensionTool('screenshot', {}),
      (err: Error) => {
        // Must say the extension is not connected
        assert.ok(
          err.message.includes('Extension not connected') ||
          err.message.includes('extension') ||
          err.message.includes('disconnected'),
          `error should explain the extension is unavailable; got: "${err.message}"`,
        );
        // Must guide the agent toward a resolution
        assert.ok(
          err.message.includes('unavailable') ||
          err.message.includes('reconnect') ||
          err.message.includes('alternatives'),
          `error should suggest what the agent can do next; got: "${err.message}"`,
        );
        return true;
      },
    );
  });

  it('rejects for any tool name — this is not tool-specific', async () => {
    const toolNames = ['click', 'navigate', 'list_tabs', 'type', 'screenshot'];

    await Promise.all(
      toolNames.map((name) =>
        assert.rejects(
          () => executeExtensionTool(name, {}),
          (err: Error) => {
            assert.ok(err instanceof Error);
            return true;
          },
        ),
      ),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Suite B: flow runner propagates extension fast-fail through step execution
//
// Uses the same mock infrastructure as flow-runner.test.ts but sets
// executeExtensionTool to throw the "Extension not connected" error to simulate
// a disconnected state without needing the real WebSocket layer.
// ══════════════════════════════════════════════════════════════════════════════

let _db: unknown = {};
const _runToolQueue: string[] = [];

function makeDb() {
  const MOCK_TOOL = {
    id: 'ext-tool-1',
    agentId: 'agent-1',
    name: 'click_button',
    toolType: 'extension',
    code: '',
  };
  const toolRows = [MOCK_TOOL];

  function whereResult() {
    return Object.assign(Promise.resolve(toolRows), {
      limit: () => Promise.resolve([]),
      orderBy: () =>
        Object.assign(Promise.resolve([]), {
          limit: () => Promise.resolve([]),
        }),
    });
  }

  function selectFieldsResult() {
    return { from: () => ({ where: whereResult }) };
  }

  function syncWhereResult() {
    return {
      orderBy: () => ({ limit: () => ({ all: () => [] }) }),
      limit: () => ({ all: () => [] }),
      all: () => [],
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

await mock.module('../db/index.js', {
  namedExports: { getDb: () => _db },
});

// The tool-runner for extension tools calls runExtensionTool which calls
// executeExtensionTool.  Mock runTool to simulate the extension-disconnected
// fast-fail path.
await mock.module('../orchestrator/tool-runner.js', {
  namedExports: {
    runTool: (_tool: unknown) => {
      const next = _runToolQueue.shift();
      return Promise.resolve(next ?? '{}');
    },
  },
});

// Mock the WebSocket server with isExtensionConnected = false
await mock.module('../websocket/server.js', {
  namedExports: {
    executeExtensionTool: () =>
      Promise.reject(
        new Error(
          'Extension not connected. Browser tools are unavailable. ' +
          'Use non-browser alternatives or wait for the extension to reconnect.',
        ),
      ),
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

const { runFlowDetailed } = (await import(
  '../orchestrator/flow-runner.js'
)) as typeof import('../orchestrator/flow-runner.js');

function makeInlineFlow(overrides: Partial<FlowRecord> = {}): FlowRecord {
  return {
    id: 'flow-ext',
    agentId: 'agent-1',
    name: '__inline_test__',
    description: 'Extension tool test',
    inputSchema: '{}',
    steps: '[]',
    returnStepId: null,
    returnSteps: null,
    reasoningModel: null,
    reasoningPrompt: null,
    resultMessage: null,
    flowType: null,
    stepDelayMs: 0,
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

describe('flow runner — extension disconnection propagates as step error', () => {
  beforeEach(() => {
    _db = makeDb();
    _runToolQueue.length = 0;
  });

  it('records an extension error in the step trace when the tool is unavailable', async () => {
    // Tool-1 is an extension-type tool.  When the extension is disconnected
    // the tool-runner returns a JSON error object (not a thrown exception),
    // which the flow runner stores in stepResults.
    _runToolQueue.push(
      JSON.stringify({ error: 'Extension not connected. Browser tools are unavailable. Use non-browser alternatives or wait for the extension to reconnect.' }),
    );

    const flow = makeInlineFlow({
      steps: JSON.stringify([
        {
          id: 'step-click',
          toolId: 'ext-tool-1',
          label: 'Click button',
          inputMapping: {},
        },
      ]),
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    assert.ok(result.ok, 'flow runner should not throw — error is captured in step trace');
    const stepResult = result.stepResults['step-click'] as { error?: string } | undefined;
    // The step result is either a raw error string or an object with .error
    const errorText =
      typeof stepResult === 'string'
        ? stepResult
        : typeof stepResult === 'object' && stepResult !== null
          ? JSON.stringify(stepResult)
          : '';

    assert.ok(
      errorText.includes('Extension') || errorText.includes('not connected') || errorText.includes('unavailable'),
      `step trace should describe the disconnection; got: ${errorText}`,
    );
  });

  it('completes the remaining steps after an extension step error', async () => {
    // step-click fails, step-cleanup runs regardless (no condition on it)
    _runToolQueue.push(
      JSON.stringify({ error: 'Extension not connected. Browser tools are unavailable.' }),
    );
    // step-cleanup succeeds
    _runToolQueue.push(JSON.stringify({ cleaned: true }));

    const flow = makeInlineFlow({
      steps: JSON.stringify([
        {
          id: 'step-click',
          toolId: 'ext-tool-1',
          label: 'Click',
          inputMapping: {},
        },
        {
          id: 'step-cleanup',
          toolId: 'ext-tool-1',
          label: 'Cleanup',
          inputMapping: {},
        },
      ]),
      returnStepId: 'step-cleanup',
    });

    const result = await runFlowDetailed(flow, {}, 'agent-1');

    assert.ok(result.ok);
    // step-cleanup should have run and returned its result
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(result.stepResults['step-cleanup'])),
      { cleaned: true },
      'step after the failed extension step should still execute',
    );
  });
});
