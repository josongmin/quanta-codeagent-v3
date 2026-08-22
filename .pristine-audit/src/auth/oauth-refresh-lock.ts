/**
 * ADR-0163 Phase D — distributed OAuth refresh lock (PORT).
 *
 * Cursor exposes `MCP_O_AUTH_REFRESH_LOCK_REDIS_ERROR / _WOULD_ACQUIRE /
 * _WOULD_WAIT` telemetry — evidence of a Redis-backed lock that prevents two
 * CLI instances on the same machine (or the same user across machines) from
 * racing to refresh an OAuth token. Without it: both refreshes succeed, the
 * loser's token is invalidated mid-stream, and the user sees a spurious 401.
 *
 * The {@link LockResult} discriminator names mirror the Cursor telemetry
 * verbatim so cross-tool observability stays comparable:
 *
 *   - `acquired`       — we hold the lock; safe to refresh.
 *   - `would-wait`     — someone else holds it; wait for their refresh result.
 *   - `would-acquire`  — we COULD acquire but chose not to (caller-side
 *                        backoff / no-op refresh). Reserved — currently
 *                        unused by the three impls but kept in the union so
 *                        Phase 2 Redis impl can surface "key absent, ACL
 *                        denied" without growing the union.
 *   - `redis-error`    — the Redis impl failed transiently; caller falls back
 *                        to the file lock OR the in-memory lock.
 *
 * Negative invariant (no heuristics): lock impls never `setTimeout` their
 * release. Release is EXPLICIT (`release(key, holderId)`); staleness is
 * detected at the next `tryAcquire` via mtime-based reaping. No daemons,
 * no global timers.
 *
 * Plane-clean: this is a leaf port module. No SDK, no `@/llm`,
 * no `node:*` direct touch.
 */

/** Closed result discriminator. Names mirror Cursor's telemetry verbatim. */
export type LockResult = "acquired" | "would-wait" | "would-acquire" | "redis-error"

/** Lock port surface. Two methods, both `Promise`-returning to permit the
 *  file-based and Redis impls. */
export interface OAuthRefreshLockPort {
  /**
   * Try to acquire `key` for `holderId` with `ttlMs` lease. Implementations
   * MUST satisfy:
   *   - mutual exclusion within the same lock scope (in-memory, same-file,
   *     same-Redis-cluster);
   *   - holder identity check (release with the WRONG holderId is a no-op);
   *   - TTL-based stale-lock reaping (an acquire whose ttlMs has elapsed
   *     since insertion is treated as released).
   */
  tryAcquire(key: string, holderId: string, ttlMs: number): Promise<LockResult>

  /**
   * Release a lock previously acquired by `holderId`. Holder mismatch is a
   * no-op (we never let a stale holder release someone else's lock). Calls
   * with an unknown key are no-ops.
   */
  release(key: string, holderId: string): Promise<void>
}
