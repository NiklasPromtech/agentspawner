/**
 * Secret Rate Limiter
 *
 * In-memory per-secret request queue that enforces requestsPerMinute limits.
 * Each secret key gets its own token bucket. When a caller wants to make an
 * API call using a secret, it calls `acquireSlot()` which resolves when it's
 * safe to proceed — spacing requests to stay within the configured rate.
 *
 * Usage:
 *   const release = await acquireSlot(agentId, secretKey, requestsPerMinute);
 *   try { await runApiTool(...) } finally { release(); }
 *
 * If requestsPerMinute is null/undefined/0, acquireSlot resolves immediately
 * (no throttling). Buckets are cleaned up after 5 minutes of inactivity.
 */

interface Bucket {
  /** Timestamps of recent requests (within the last 60s window) */
  timestamps: number[];
  /** Queue of waiters — each is a resolve callback */
  queue: Array<() => void>;
  /** Drain timer handle */
  drainTimer: ReturnType<typeof setTimeout> | null;
  /** Cleanup timer — removes the bucket after inactivity */
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  /** Configured max requests per minute */
  rpm: number;
}

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 60_000;       // 1 minute sliding window
const CLEANUP_MS = 5 * 60_000;  // Remove idle buckets after 5 min

function bucketKey(agentId: string, secretKey: string): string {
  return `${agentId}:${secretKey}`;
}

function getBucket(key: string, rpm: number): Bucket {
  let bucket = buckets.get(key);
  if (bucket) {
    // Update rpm if it changed
    bucket.rpm = rpm;
    return bucket;
  }
  bucket = {
    timestamps: [],
    queue: [],
    drainTimer: null,
    cleanupTimer: null,
    rpm,
  };
  buckets.set(key, bucket);
  return bucket;
}

function pruneWindow(bucket: Bucket): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (bucket.timestamps.length > 0 && bucket.timestamps[0] < cutoff) {
    bucket.timestamps.shift();
  }
}

function tryDrain(bucket: Bucket): void {
  pruneWindow(bucket);

  while (bucket.queue.length > 0 && bucket.timestamps.length < bucket.rpm) {
    const next = bucket.queue.shift()!;
    bucket.timestamps.push(Date.now());
    next();
  }

  // If there are still waiters, schedule a drain when the oldest timestamp expires
  if (bucket.queue.length > 0 && bucket.timestamps.length > 0) {
    const waitUntil = bucket.timestamps[0] + WINDOW_MS - Date.now() + 50; // +50ms buffer
    if (bucket.drainTimer) clearTimeout(bucket.drainTimer);
    bucket.drainTimer = setTimeout(() => {
      bucket.drainTimer = null;
      tryDrain(bucket);
    }, Math.max(waitUntil, 100));
  }
}

function resetCleanup(key: string, bucket: Bucket): void {
  if (bucket.cleanupTimer) clearTimeout(bucket.cleanupTimer);
  bucket.cleanupTimer = setTimeout(() => {
    // Only clean up if no waiters
    if (bucket.queue.length === 0) {
      if (bucket.drainTimer) clearTimeout(bucket.drainTimer);
      buckets.delete(key);
    }
  }, CLEANUP_MS);
}

/**
 * Acquire a slot to make a request using a rate-limited secret.
 * Resolves when it's safe to proceed. Returns a release function (currently a no-op
 * but available for future concurrency control).
 *
 * @param agentId  - Agent ID
 * @param secretKey - The secret key name (e.g. "NEWSAPI_KEY")
 * @param requestsPerMinute - Max RPM for this secret. null/0 = no limit.
 */
export function acquireSlot(
  agentId: string,
  secretKey: string,
  requestsPerMinute: number | null | undefined,
): Promise<() => void> {
  // No limit configured — pass through immediately
  if (!requestsPerMinute || requestsPerMinute <= 0) {
    return Promise.resolve(() => {});
  }

  const key = bucketKey(agentId, secretKey);
  const bucket = getBucket(key, requestsPerMinute);
  resetCleanup(key, bucket);

  // Check if we can go immediately
  pruneWindow(bucket);
  if (bucket.timestamps.length < bucket.rpm && bucket.queue.length === 0) {
    bucket.timestamps.push(Date.now());
    return Promise.resolve(() => {});
  }

  // Otherwise queue up
  return new Promise<() => void>((resolve) => {
    bucket.queue.push(() => resolve(() => {}));
    tryDrain(bucket);
  });
}

/**
 * Get the current queue depth for a secret (useful for diagnostics / UI).
 */
export function getQueueDepth(agentId: string, secretKey: string): number {
  const bucket = buckets.get(bucketKey(agentId, secretKey));
  return bucket ? bucket.queue.length : 0;
}

/**
 * Get estimated wait time in seconds for a new request to this secret.
 */
export function estimateWaitSeconds(agentId: string, secretKey: string): number {
  const bucket = buckets.get(bucketKey(agentId, secretKey));
  if (!bucket || bucket.timestamps.length < bucket.rpm) return 0;
  pruneWindow(bucket);
  if (bucket.timestamps.length < bucket.rpm) return 0;
  // Estimate: when does the oldest timestamp fall out of the window?
  const oldestExpiry = bucket.timestamps[0] + WINDOW_MS;
  return Math.max(0, Math.ceil((oldestExpiry - Date.now()) / 1000));
}
