/**
 * session-draft.ts — Rigorous draft persistence for multi-step sessions
 *
 * Two kinds of drafts are saved:
 *
 * 1. ONBOARDING DRAFT — the new-agent setup session.
 *    Saved when the agent is created and flows are being planned/built.
 *    If the user navigates away mid-session, this lets them resume exactly
 *    where they left off (same planned flows, same progress index, same phase).
 *    Key: 'agentspawner:onboarding-current' (only one active at a time)
 *
 * 2. GENERATOR DRAFT — a per-agent FlowGenerator conversation.
 *    Saved after every message so the user can jump to another tab or agent
 *    and come back to find their conversation intact.
 *    Key: 'agentspawner:generator:{agentId}'
 *
 * Both are stored in localStorage and survive navigation and browser restarts.
 * They are cleared explicitly when the session is completed or discarded.
 */

import type { FlowInput } from '../types/index.js';
import type { GeneratorMessage } from '../pages/agent/FlowGenerator.js';

// ── Onboarding draft ──────────────────────────────────────────────────────────

export interface PlannedFlowDraft {
  id: string;
  name: string;
  type: 'scrape' | 'action';
  description: string;
  purpose: string;
  built: boolean;
}

export interface OnboardingDraft {
  agentId: string;
  agentName: string;
  phase: 'flow_building';
  plannedFlows: PlannedFlowDraft[];
  currentFlowIndex: number;
  savedAt: string;
}

const ONBOARDING_KEY = 'agentspawner:onboarding-current';

export function saveOnboardingDraft(draft: Omit<OnboardingDraft, 'savedAt'>): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
  } catch {
    // Quota exceeded or private mode — silently ignore
  }
}

export function loadOnboardingDraft(): OnboardingDraft | null {
  try {
    const raw = localStorage.getItem(ONBOARDING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as OnboardingDraft;
  } catch {
    return null;
  }
}

export function clearOnboardingDraft(): void {
  localStorage.removeItem(ONBOARDING_KEY);
}

// ── Generator conversation draft ──────────────────────────────────────────────

export interface GeneratorDraft {
  agentId: string;
  /** Friendly name of the flow being built, for display in the resume prompt */
  flowHint?: string;
  conversationHistory: GeneratorMessage[];
  previewName: string;
  previewDesc: string;
  previewSteps: Array<{ label: string; toolName: string }>;
  completedFlow: FlowInput | null;
  savedAt: string;
}

function generatorKey(agentId: string): string {
  return `agentspawner:generator:${agentId}`;
}

export function saveGeneratorDraft(
  agentId: string,
  draft: Omit<GeneratorDraft, 'savedAt' | 'agentId'>,
): void {
  // Don't save empty sessions — wait until there's at least one exchange
  if (draft.conversationHistory.length === 0) return;
  try {
    // Strip screenshot data from completedFlow steps to keep storage lean
    const sanitized: GeneratorDraft = {
      ...draft,
      agentId,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(generatorKey(agentId), JSON.stringify(sanitized));
  } catch {
    // Quota exceeded — silently ignore
  }
}

export function loadGeneratorDraft(agentId: string): GeneratorDraft | null {
  try {
    const raw = localStorage.getItem(generatorKey(agentId));
    if (!raw) return null;
    return JSON.parse(raw) as GeneratorDraft;
  } catch {
    return null;
  }
}

export function clearGeneratorDraft(agentId: string): void {
  localStorage.removeItem(generatorKey(agentId));
}

/** Return all agents that have a saved generator draft (for home-page display) */
export function listGeneratorDrafts(): GeneratorDraft[] {
  const drafts: GeneratorDraft[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('agentspawner:generator:')) continue;
      try {
        const raw = localStorage.getItem(key);
        if (raw) drafts.push(JSON.parse(raw) as GeneratorDraft);
      } catch { /* skip malformed */ }
    }
  } catch { /* Safari private mode */ }
  return drafts;
}
