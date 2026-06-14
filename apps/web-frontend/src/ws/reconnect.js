/**
 * Pure reconnect-backoff math. Extracted from `client.ts` so it can be
 * tested without a WebSocket / fake-timer harness.
 *
 * Policy:
 *   - exponential: base 500ms, multiplier 2
 *   - cap: 30000ms (30s)
 *   - attempt 0 should never reach this function; attempt 1 is the first
 *     retry after the initial connect failure (delay = 500ms)
 *   - we deliberately do NOT add jitter — the surface is single-tenant
 *     (one daemon, one frontend per machine) so synchronized retries from
 *     1000 clients hammering 1 backend isn't a failure mode here.
 *     Adding jitter would also make the test surface non-deterministic.
 */
const BASE_MS = 500;
const CAP_MS = 30_000;
const MULTIPLIER = 2;
export const computeRetryDelayMs = (attempt) => {
    if (!Number.isFinite(attempt) || attempt < 1)
        return BASE_MS;
    // attempt 1 → 500 * 2^0 = 500
    // attempt 2 → 500 * 2^1 = 1000
    // attempt 3 → 500 * 2^2 = 2000
    // ... attempt 7 → 32000 → capped at 30000
    const expo = BASE_MS * MULTIPLIER ** (attempt - 1);
    return Math.min(CAP_MS, expo);
};
export const RECONNECT_BACKOFF_CONSTANTS = {
    baseMs: BASE_MS,
    capMs: CAP_MS,
    multiplier: MULTIPLIER,
};
