/**
 * Unit tests for packages/backend/src/features/flows/flow-validator.ts
 *
 * OPERATION CONVERGENCE — Task 13
 *
 * validateFlow() is a pure function — no module mocks needed.
 * Each test imports it directly and exercises a specific validation rule.
 *
 * Run via: npm test  (or see package.json for the full node command)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlow, getValidationMode } from '../features/flows/flow-validator.js';
import type { FlowStep } from '../orchestrator/flow-runner.js';

// ── Step builder ─────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<FlowStep> = {}): FlowStep {
  return {
    id: 'step-a',
    toolId: '__transform__',
    label: 'Test step',
    inputMapping: {},
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Rule 2 — No __human_review__ steps
// ══════════════════════════════════════════════════════════════════════════════

describe('validateFlow — __human_review__ rejection', () => {
  it('rejects a flow containing a __human_review__ step', () => {
    const steps = [makeStep({ id: 'step-a', toolId: '__human_review__' })];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('__human_review__')),
      `errors should mention __human_review__; got: ${JSON.stringify(result.errors)}`,
    );
    assert.ok(
      result.errors.some((e) => e.includes('requiresApproval')),
      `errors should suggest requiresApproval instead; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('accepts a flow that uses requiresApproval instead of __human_review__', () => {
    const steps = [makeStep()];
    const result = validateFlow(steps, {
      requiresApproval: true,
      dedupKeyField: 'user_id',
    });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Rule 3/4 — step_ref must reference an existing prior step
// ══════════════════════════════════════════════════════════════════════════════

describe('validateFlow — broken step_ref', () => {
  it('rejects a step_ref referencing an unknown step ID', () => {
    const steps = [
      makeStep({
        id: 'step-a',
        inputMapping: {
          val: { type: 'step_ref', stepId: 'step-does-not-exist', path: 'data' },
        },
      }),
    ];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('step-does-not-exist')),
      `errors should name the unknown step ID; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('accepts a step_ref that correctly references a prior step', () => {
    const steps = [
      makeStep({ id: 'step-a' }),
      makeStep({
        id: 'step-b',
        inputMapping: {
          val: { type: 'step_ref', stepId: 'step-a', path: 'data' },
        },
      }),
    ];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });
});

describe('validateFlow — forward references rejected', () => {
  it('rejects a step_ref pointing to a step that comes later in the flow', () => {
    const steps = [
      makeStep({
        id: 'step-a',
        inputMapping: {
          // step-b hasn't run yet when step-a is executing
          val: { type: 'step_ref', stepId: 'step-b', path: 'data' },
        },
      }),
      makeStep({ id: 'step-b' }),
    ];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('step-b') && (e.includes('step-a') || e.includes('index'))),
      `errors should describe the forward-reference violation; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('accepts a step_ref pointing to a step at the same index (self-reference edge case produces error)', () => {
    // Self-reference: step-a references itself — also a forward/same-index error
    const steps = [
      makeStep({
        id: 'step-a',
        inputMapping: {
          val: { type: 'step_ref', stepId: 'step-a', path: 'data' },
        },
      }),
    ];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Rule 8 — requiresApproval requires dedupKeyField
// ══════════════════════════════════════════════════════════════════════════════

describe('validateFlow — requiresApproval ↔ dedupKeyField', () => {
  it('rejects requiresApproval: true with no dedupKeyField', () => {
    const steps = [makeStep()];
    const result = validateFlow(steps, {
      requiresApproval: true,
      dedupKeyField: null,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('requiresApproval') && e.includes('dedupKeyField')),
      `errors should explain the requiresApproval ↔ dedupKeyField contract; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('accepts requiresApproval: true when dedupKeyField is set', () => {
    const steps = [makeStep()];
    const result = validateFlow(steps, {
      requiresApproval: true,
      dedupKeyField: 'post_url',
    });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  it('accepts requiresApproval: false without a dedupKeyField', () => {
    const steps = [makeStep()];
    const result = validateFlow(steps, {
      requiresApproval: false,
      dedupKeyField: null,
    });
    assert.strictEqual(result.valid, true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Rule 7 — __generate__ requires a preceding __hydrate__
// ══════════════════════════════════════════════════════════════════════════════

describe('validateFlow — __generate__ / __hydrate__ ordering', () => {
  it('rejects a __generate__ step with no __hydrate__ step in the flow', () => {
    const steps = [makeStep({ id: 'step-a', toolId: '__generate__' })];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('__hydrate__')),
      `errors should mention __hydrate__; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('rejects __hydrate__ that comes AFTER __generate__', () => {
    const steps = [
      makeStep({ id: 'step-a', toolId: '__generate__' }),
      makeStep({ id: 'step-b', toolId: '__hydrate__' }),
    ];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, false);
    assert.ok(
      result.errors.some((e) => e.includes('__hydrate__') && e.includes('__generate__')),
      `errors should describe the ordering violation; got: ${JSON.stringify(result.errors)}`,
    );
  });

  it('accepts __hydrate__ followed by __generate__', () => {
    const steps = [
      makeStep({ id: 'step-a', toolId: '__hydrate__' }),
      makeStep({ id: 'step-b', toolId: '__generate__' }),
    ];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Empty steps array (edge case)
// ══════════════════════════════════════════════════════════════════════════════

describe('validateFlow — edge cases', () => {
  it('accepts an empty steps array', () => {
    const result = validateFlow([]);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
  });

  it('rejects a step that has no id', () => {
    const steps = [{ toolId: '__transform__', label: 'No ID', inputMapping: {} } as unknown as FlowStep];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"id"')));
  });

  it('rejects a step that has no toolId', () => {
    const steps = [{ id: 'step-a', label: 'No toolId', inputMapping: {} } as unknown as FlowStep];
    const result = validateFlow(steps);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('"toolId"')));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getValidationMode
// ══════════════════════════════════════════════════════════════════════════════

describe('getValidationMode', () => {
  it('returns "strict" for dates on or after the 2026-03-27 cutoff', () => {
    assert.strictEqual(getValidationMode('2026-03-27T00:00:00Z'), 'strict');
    assert.strictEqual(getValidationMode('2026-04-01T12:00:00Z'), 'strict');
  });

  it('returns "warn" for dates before the cutoff (grandfathered flows)', () => {
    assert.strictEqual(getValidationMode('2026-03-26T23:59:59Z'), 'warn');
    assert.strictEqual(getValidationMode('2025-01-01T00:00:00Z'), 'warn');
  });

  it('returns "warn" when createdAt is null or undefined', () => {
    assert.strictEqual(getValidationMode(null), 'warn');
    assert.strictEqual(getValidationMode(undefined), 'warn');
  });
});
