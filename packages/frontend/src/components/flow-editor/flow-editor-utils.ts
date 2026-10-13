import type { FlowStep } from '../../types/index.js';

export function parseSchema(json: string): Record<string, { type?: string; description?: string }> {
  try {
    const s = JSON.parse(json) as { properties?: Record<string, { type?: string; description?: string }> };
    return s.properties ?? {};
  } catch { return {}; }
}

export function detectFlowInputKeys(steps: FlowStep[]): string[] {
  const keys = new Set<string>();
  for (const step of steps) {
    for (const expr of Object.values(step.inputMapping)) {
      if ((expr as { type: string }).type === 'flow_input' && (expr as { key: string }).key?.trim())
        keys.add((expr as { key: string }).key.trim());
      if ((expr as { type: string }).type === 'literal' && typeof (expr as { value: unknown }).value === 'string') {
        for (const m of ((expr as { value: string }).value).matchAll(/\{\{(\w+)\}\}/g)) keys.add(m[1]);
      }
    }
  }
  return [...keys].sort();
}

export function buildAutoKey(id: string, steps: FlowStep[], returnStepKeys: Record<string, string>): string {
  return returnStepKeys[id] ?? steps.find((s) => s.id === id)?.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') ?? id.slice(0, 8);
}
