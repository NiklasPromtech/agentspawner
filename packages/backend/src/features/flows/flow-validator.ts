/**
 * flow-validator.ts
 * OPERATION CONVERGENCE — Task 5
 *
 * Standalone validation for flow definitions. Catches structural problems at
 * save time or load time instead of letting them surface deep in execution
 * with unhelpful error messages.
 *
 * Two modes:
 *   - 'strict'  — returns errors; callers should reject the flow.
 *   - 'warn'    — returns errors for logging only; flow still runs.
 *
 * Strict mode is used for:  save (create/update), AI-generated flows.
 * Warn mode is used for:    loading pre-existing flows created before this
 *                           validation existed (grandfathered by createdAt).
 */

import type { FlowStep, InputExpression } from './flow-runner.js';

// ── Known sentinel step types ────────────────────────────────────────────────

const BUILTIN_SENTINELS = new Set([
  '__evaluate__',
  '__screenshot__',
  '__transform__',
  '__query_action_log__',
  '__query_memory__',
  '__query_database__',
  '__hydrate__',
  '__generate__',
]);

// ── Known model identifiers ──────────────────────────────────────────────────
// This isn't exhaustive — new models appear — but it catches obvious typos.

const KNOWN_MODELS = new Set([
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  // Older model strings that may still be in use
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20241022',
]);

/** Returns true if the string looks like a plausible model identifier. */
function isPlausibleModel(model: string): boolean {
  if (KNOWN_MODELS.has(model)) return true;
  // Accept anything that starts with 'claude-' as likely valid
  if (/^claude-[\w.-]+$/.test(model)) return true;
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface FlowValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Minimal flow-level metadata needed for cross-cutting validations
 * (e.g. requiresApproval ↔ dedupKeyField).
 */
export interface FlowMeta {
  requiresApproval?: boolean | null;
  dedupKeyField?: string | null;
  inputSchema?: string | null;
  flowType?: string | null;
}

/**
 * Validate a parsed flow definition.
 *
 * @param steps   The parsed FlowStep[] array (already JSON.parse'd).
 * @param meta    Optional flow-level metadata for cross-cutting checks.
 * @returns       `{ valid: true, errors: [] }` or `{ valid: false, errors: [...] }`.
 */
export function validateFlow(
  steps: FlowStep[],
  meta?: FlowMeta,
): FlowValidationResult {
  const errors: string[] = [];

  // Build index of step IDs and their positions for ordering checks
  const stepIdSet = new Set<string>();
  const stepIdOrder = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    stepIdSet.add(step.id);
    stepIdOrder.set(step.id, i);
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const loc = `Step ${i} ("${step.label || step.id}")`;

    // ── 1. Every step must have a toolId and id ────────────────────────────
    if (!step.id) {
      errors.push(`${loc}: missing required field "id".`);
    }
    if (!step.toolId) {
      errors.push(`${loc}: missing required field "toolId".`);
    }

    // ── 2. No __human_review__ steps ───────────────────────────────────────
    if (step.toolId === '__human_review__') {
      errors.push(
        `${loc}: __human_review__ steps are no longer supported. ` +
        `Set requiresApproval: true on the flow instead.`,
      );
    }

    // ── 3. step_ref existence — every step_ref must reference an existing step
    if (step.inputMapping) {
      for (const [field, expr] of Object.entries(step.inputMapping)) {
        const typedExpr = expr as InputExpression;
        if (typedExpr.type === 'step_ref') {
          if (!stepIdSet.has(typedExpr.stepId)) {
            errors.push(
              `${loc}: inputMapping.${field} references unknown step ID "${typedExpr.stepId}".`,
            );
          }

          // ── 4. No forward references ─────────────────────────────────────
          const refIndex = stepIdOrder.get(typedExpr.stepId);
          if (refIndex !== undefined && refIndex >= i) {
            errors.push(
              `${loc}: inputMapping.${field} references step "${typedExpr.stepId}" ` +
              `which comes at or after the current step (index ${refIndex} >= ${i}). ` +
              `step_ref can only reference earlier steps.`,
            );
          }
        }
      }
    }

    // ── 5. Condition skipToStepId / skipToStepIdOnNoMatch must reference existing steps
    if (step.condition) {
      if (step.condition.skipToStepId && !stepIdSet.has(step.condition.skipToStepId)) {
        errors.push(
          `${loc}: condition.skipToStepId references unknown step ID "${step.condition.skipToStepId}".`,
        );
      }
      if (step.condition.skipToStepIdOnNoMatch && !stepIdSet.has(step.condition.skipToStepIdOnNoMatch)) {
        errors.push(
          `${loc}: condition.skipToStepIdOnNoMatch references unknown step ID "${step.condition.skipToStepIdOnNoMatch}".`,
        );
      }
    }

    // ── 6. stepModel validation ────────────────────────────────────────────
    if (step.stepModel && !isPlausibleModel(step.stepModel)) {
      errors.push(
        `${loc}: stepModel "${step.stepModel}" does not look like a valid model identifier. ` +
        `Expected a string like "claude-sonnet-4-6" or "claude-haiku-4-5-20251001".`,
      );
    }
  }

  // ── 7. If __generate__ exists, __hydrate__ must come before it ──────────
  const generateIndex = steps.findIndex((s) => s.toolId === '__generate__');
  if (generateIndex >= 0) {
    const hydrateIndex = steps.findIndex((s) => s.toolId === '__hydrate__');
    if (hydrateIndex < 0) {
      errors.push(
        `Flow has a __generate__ step but no __hydrate__ step. ` +
        `A __hydrate__ step must precede __generate__ to provide hydrated context.`,
      );
    } else if (hydrateIndex >= generateIndex) {
      errors.push(
        `__hydrate__ step (index ${hydrateIndex}) must come before __generate__ step (index ${generateIndex}).`,
      );
    }
  }

  // ── 8. Cross-cutting: requiresApproval → must have dedupKeyField ───────
  if (meta?.requiresApproval && !meta.dedupKeyField) {
    errors.push(
      `Flow has requiresApproval: true but no dedupKeyField. ` +
      `A dedupKeyField is required for the approval system to identify duplicate actions.`,
    );
  }

  // ── 9. Cross-cutting: dedupKeyField must reference a field in inputSchema
  if (meta?.dedupKeyField && meta.inputSchema) {
    try {
      const schema = JSON.parse(meta.inputSchema) as {
        type?: string;
        properties?: Record<string, unknown>;
        [key: string]: unknown;
      };
      // inputSchema is stored as a JSON Schema object: { type: "object", properties: { field: {...} }, required: [...] }
      // Check schema.properties first (JSON Schema format); fall back to flat-object format for compatibility.
      if (typeof schema === 'object' && schema !== null && !Array.isArray(schema)) {
        const properties: Record<string, unknown> =
          schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
            ? schema.properties
            : schema;
        if (!(meta.dedupKeyField in properties)) {
          errors.push(
            `dedupKeyField "${meta.dedupKeyField}" does not exist in the flow's inputSchema. ` +
            `Available fields: ${Object.keys(properties).join(', ') || '(none)'}.`,
          );
        }
      }
    } catch {
      // If inputSchema isn't valid JSON, skip this check — Zod validation will catch it
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ── Cutoff date for warn vs strict mode ──────────────────────────────────────
// Flows created before this date are validated in 'warn' mode (log but don't
// throw). Flows created on or after this date get 'strict' mode.
// Set to the date this validation was deployed.

const VALIDATION_CUTOFF = new Date('2026-03-27T00:00:00Z');

/**
 * Determine validation mode based on when the flow was created.
 * Pre-existing flows get 'warn'; new flows get 'strict'.
 */
export function getValidationMode(createdAt: string | null | undefined): 'warn' | 'strict' {
  if (!createdAt) return 'warn'; // No date → treat as pre-existing
  try {
    const date = new Date(createdAt);
    return date >= VALIDATION_CUTOFF ? 'strict' : 'warn';
  } catch {
    return 'warn';
  }
}
