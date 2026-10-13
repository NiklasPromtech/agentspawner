/**
 * Shared AbortController registry — used by both the regular orchestrator and
 * the autonomous orchestrator so that the /runs/:runId/stop endpoint can abort
 * either kind of run.
 */

const controllers = new Map<string, AbortController>();

export function registerAbort(runId: string, ac: AbortController): void {
  controllers.set(runId, ac);
}

export function abortRun(runId: string): void {
  controllers.get(runId)?.abort();
}

export function unregisterAbort(runId: string): void {
  controllers.delete(runId);
}
