import type { RateLimitSnapshot } from "./parse"

/**
 * The SAME ceiling B3's reactive backoff clamps to (`MAX_SERVER_DELAY_MS`,
 * `src/agent/retry.ts`). One bounded maximum — no second magic constant. A
 * hostile/huge server reset can never sleep a turn unboundedly.
 */
export const MAX_PROACTIVE_DELAY_MS = 60_000

/**
 * Server-anchored proactive backoff (Phase 1: empty-bucket ONLY).
 *
 * Returns the ms to wait BEFORE the next request, derived ENTIRELY from the
 * provider's own signal:
 *   - Back off ONLY when a window the provider reports is OUT (`remaining <= 0`).
 *     This is NOT a quanta-invented "80% of quota" threshold — it is the
 *     provider literally telling us the bucket is empty (the same measured
 *     signal B3 honors AFTER a 429, just consulted BEFORE the request).
 *   - The wait is the server-advertised reset of the EMPTY window(s); when both
 *     windows are empty, the tightest (min) reset wins. A non-empty window's
 *     reset is IGNORED (it is not the binding cap).
 *   - No reset known ⇒ 0 (nothing to wait on; fall back to reactive 429-retry).
 *   - Clamped to {@link MAX_PROACTIVE_DELAY_MS}.
 *
 * Pure — no clock read (the snapshot already carries server-relative reset ms).
 */
export const proactiveDelayMs = (s: RateLimitSnapshot): number => {
  const tokensEmpty = s.tokensRemaining !== undefined && s.tokensRemaining <= 0
  const requestsEmpty = s.requestsRemaining !== undefined && s.requestsRemaining <= 0
  if (!tokensEmpty && !requestsEmpty) return 0

  // Consult ONLY the empty window's reset — a window with headroom is not the
  // binding cap and must not shorten (or lengthen) the wait.
  let resetMs = Number.POSITIVE_INFINITY
  if (tokensEmpty && s.tokensResetMs !== undefined) {
    resetMs = Math.min(resetMs, s.tokensResetMs)
  }
  if (requestsEmpty && s.requestsResetMs !== undefined) {
    resetMs = Math.min(resetMs, s.requestsResetMs)
  }
  if (!Number.isFinite(resetMs)) return 0

  return Math.min(Math.max(0, resetMs), MAX_PROACTIVE_DELAY_MS)
}
