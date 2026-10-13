import { useReducer } from 'react';
import type { Flow, FlowInput, FlowStep, ReturnStepConfig } from '../types/index.js';

// ── State ─────────────────────────────────────────────────────────────────────

export interface FlowDraft {
  name: string;
  description: string;
  inputDescriptions: Record<string, string>;
  steps: FlowStep[];
  returnStepIds: string[];
  returnStepKeys: Record<string, string>;
  reasoningModel: string | null;
  reasoningPrompt: string;
  resultMessage: string;
  flowType: 'scrape' | 'action' | null;
  dedupKeyField: string;
  dedupBreakType: 'hard' | 'soft' | null;
  dedupIntervalHours: string;
  dedupBlockMessage: string;
  readsFrom: string;
  writesTo: string;
  updatesFields: string;
  requiresApproval: boolean;
  requiresHumanReview: boolean;
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type FlowDraftAction =
  | { type: 'PATCH'; patch: Partial<FlowDraft> }
  | { type: 'SET_INPUT_DESCRIPTION'; key: string; value: string }
  | { type: 'ADD_STEP'; step: FlowStep; insertAt: number | null }
  | { type: 'REMOVE_STEP'; idx: number }
  | { type: 'UPDATE_STEP'; idx: number; patch: Partial<FlowStep> }
  | { type: 'MOVE_STEP'; idx: number; dir: -1 | 1 }
  | { type: 'DUPLICATE_STEP'; idx: number }
  | { type: 'TOGGLE_RETURN_STEP'; stepId: string }
  | { type: 'SET_RETURN_STEP_KEY'; stepId: string; key: string }
  | { type: 'APPLY_FIX'; def: FlowInput }
  | { type: 'REINIT'; flow: Flow };

// ── Reducer ───────────────────────────────────────────────────────────────────

function reducer(state: FlowDraft, action: FlowDraftAction): FlowDraft {
  switch (action.type) {
    case 'PATCH':
      return { ...state, ...action.patch };

    case 'SET_INPUT_DESCRIPTION':
      return { ...state, inputDescriptions: { ...state.inputDescriptions, [action.key]: action.value } };

    case 'ADD_STEP': {
      const next = [...state.steps];
      if (action.insertAt === null) {
        next.push(action.step);
      } else {
        next.splice(action.insertAt, 0, action.step);
      }
      return { ...state, steps: next };
    }

    case 'REMOVE_STEP': {
      const removed = state.steps[action.idx];
      const steps = state.steps.filter((_, i) => i !== action.idx);
      const returnStepIds = removed
        ? state.returnStepIds.filter((id) => id !== removed.id)
        : state.returnStepIds;
      return { ...state, steps, returnStepIds };
    }

    case 'UPDATE_STEP':
      return {
        ...state,
        steps: state.steps.map((s, i) => (i === action.idx ? { ...s, ...action.patch } : s)),
      };

    case 'MOVE_STEP': {
      const next = [...state.steps];
      const swap = action.idx + action.dir;
      if (swap < 0 || swap >= next.length) return state;
      [next[action.idx], next[swap]] = [next[swap]!, next[action.idx]!];
      return { ...state, steps: next };
    }

    case 'DUPLICATE_STEP': {
      const original = state.steps[action.idx];
      if (!original) return state;
      const copy: FlowStep = { ...original, id: crypto.randomUUID(), label: `${original.label} (copy)` };
      const next = [...state.steps];
      next.splice(action.idx + 1, 0, copy);
      return { ...state, steps: next };
    }

    case 'TOGGLE_RETURN_STEP': {
      const ids = state.returnStepIds.includes(action.stepId)
        ? state.returnStepIds.filter((id) => id !== action.stepId)
        : [...state.returnStepIds, action.stepId];
      return { ...state, returnStepIds: ids };
    }

    case 'SET_RETURN_STEP_KEY':
      return {
        ...state,
        returnStepKeys: { ...state.returnStepKeys, [action.stepId]: action.key },
      };

    case 'REINIT':
      return initDraft(action.flow, undefined);

    case 'APPLY_FIX': {
      const def = action.def;
      const patch: Partial<FlowDraft> = {};
      if (def.name) patch.name = def.name;
      if (def.description) patch.description = def.description;
      if (def.steps) patch.steps = def.steps;
      if (def.returnSteps) {
        try {
          const rs = JSON.parse(def.returnSteps) as ReturnStepConfig[];
          patch.returnStepIds = rs.map((r) => r.stepId);
          patch.returnStepKeys = Object.fromEntries(rs.map((r) => [r.stepId, r.key]));
        } catch { /* ignore */ }
      } else if ('returnStepId' in def) {
        patch.returnStepIds = def.returnStepId ? [def.returnStepId] : [];
        patch.returnStepKeys = {};
      }
      if (def.inputSchema) {
        try {
          const s = JSON.parse(def.inputSchema) as { properties?: Record<string, unknown> };
          const descs: Record<string, string> = {};
          for (const [k, v] of Object.entries(s.properties ?? {})) {
            if (typeof v === 'object' && v !== null && 'description' in v) {
              descs[k] = String((v as { description?: string }).description ?? '');
            }
          }
          patch.inputDescriptions = descs;
        } catch { /* ignore */ }
      }
      return { ...state, ...patch };
    }

    default:
      return state;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractDescriptions(schemaJson: string): Record<string, string> {
  try {
    const s = JSON.parse(schemaJson) as { properties?: Record<string, unknown> };
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      if (typeof v === 'object' && v !== null && 'description' in v) {
        result[k] = String((v as { description?: string }).description ?? '');
      }
    }
    return result;
  } catch { return {}; }
}

function parseSteps(json: string): FlowStep[] {
  try { return JSON.parse(json) as FlowStep[]; } catch { return []; }
}

function initDraft(flow: Flow | null, seed: FlowInput | undefined): FlowDraft {
  const returnStepIds: string[] = (() => {
    const rs = flow?.returnSteps ?? seed?.returnSteps;
    if (rs) { try { return (JSON.parse(rs) as ReturnStepConfig[]).map((r) => r.stepId); } catch { /* */ } }
    const single = flow?.returnStepId ?? seed?.returnStepId;
    return single ? [single] : [];
  })();

  const returnStepKeys: Record<string, string> = (() => {
    const rs = flow?.returnSteps ?? seed?.returnSteps;
    if (rs) { try { return Object.fromEntries((JSON.parse(rs) as ReturnStepConfig[]).map((r) => [r.stepId, r.key])); } catch { /* */ } }
    return {};
  })();

  return {
    name: flow?.name ?? seed?.name ?? '',
    description: flow?.description ?? seed?.description ?? '',
    inputDescriptions: extractDescriptions(flow?.inputSchema ?? seed?.inputSchema ?? '{}'),
    steps: flow ? parseSteps(flow.steps) : (seed?.steps ?? []),
    returnStepIds,
    returnStepKeys,
    reasoningModel: flow?.reasoningModel ?? null,
    reasoningPrompt: flow?.reasoningPrompt ?? '',
    resultMessage: flow?.resultMessage ?? '',
    flowType: flow?.flowType ?? null,
    dedupKeyField: flow?.dedupKeyField ?? '',
    dedupBreakType: flow?.dedupBreakType ?? null,
    dedupIntervalHours: flow?.dedupIntervalHours?.toString() ?? '',
    dedupBlockMessage: flow?.dedupBlockMessage ?? '',
    readsFrom: flow?.readsFrom ?? '',
    writesTo: flow?.writesTo ?? '',
    updatesFields: flow?.updatesFields
      ? (() => { try { return (JSON.parse(flow.updatesFields!) as string[]).join(', '); } catch { return ''; } })()
      : '',
    requiresApproval: flow?.requiresApproval ?? false,
    requiresHumanReview: flow?.requiresHumanReview ?? false,
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useFlowEditorState(flow: Flow | null, prefill?: FlowInput) {
  const seed = flow === null && prefill ? prefill : undefined;
  return useReducer(reducer, undefined, () => initDraft(flow, seed));
}
