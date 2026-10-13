/**
 * Nudge Registry
 *
 * Allows users to inject a message into an actively running autonomous session.
 * The autonomous orchestrator drains pending nudges at the top of each iteration
 * and adds them to the conversation so the agent can respond/redirect immediately.
 */

const pendingNudges = new Map<string, string[]>(); // agentId → queue of messages

export function pushNudge(agentId: string, message: string): void {
  const q = pendingNudges.get(agentId) ?? [];
  q.push(message);
  pendingNudges.set(agentId, q);
}

/** Drain all pending nudges for an agent and return them (clears the queue). */
export function drainNudges(agentId: string): string[] {
  const q = pendingNudges.get(agentId) ?? [];
  pendingNudges.delete(agentId);
  return q;
}
