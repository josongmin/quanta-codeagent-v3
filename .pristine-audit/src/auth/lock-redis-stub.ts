/**
 * ADR-0163 Phase D — Redis OAuth refresh lock STUB.
 *
 * Phase 1 posture: we do NOT ship a runtime Redis dependency (would inflate
 * the install footprint by ~5 MB and add a connection-management surface to
 * the auth layer). Instead, we ship a typed stub whose `tryAcquire` ALWAYS
 * returns `redis-error` and whose `release` is a no-op. Callers chain
 * fallbacks `(redis → file → memory)` and observe the typed `redis-error`
 * to know they should fall through.
 *
 * Phase 2 swaps in a real implementation that uses `SETNX key value EX ttl
 * NX` (atomic acquire-with-TTL) and a Lua `EVAL` release script (atomic
 * compare-holderId-and-delete). The port surface stays unchanged — Phase 2
 * is a single-file swap.
 *
 * The `redis-error` result name mirrors Cursor's
 * `MCP_O_AUTH_REFRESH_LOCK_REDIS_ERROR` telemetry verbatim so cross-tool
 * observability stays comparable.
 *
 * Plane-clean: imports only the port (sibling). No SDK, no `node:*`.
 */

import type { LockResult, OAuthRefreshLockPort } from "./oauth-refresh-lock"

export interface RedisStubOptions {
  /** Optional callback fired on every tryAcquire — lets bench harnesses
   *  count the "would have called Redis" events. Default no-op. */
  readonly onAcquireAttempt?: (key: string, holderId: string, ttlMs: number) => void
  /** Optional callback fired on every release — same observability hook. */
  readonly onReleaseAttempt?: (key: string, holderId: string) => void
}

export class RedisLockStub implements OAuthRefreshLockPort {
  private readonly onAcquireAttempt: (key: string, holderId: string, ttlMs: number) => void
  private readonly onReleaseAttempt: (key: string, holderId: string) => void

  constructor(options: RedisStubOptions = {}) {
    this.onAcquireAttempt = options.onAcquireAttempt ?? (() => {})
    this.onReleaseAttempt = options.onReleaseAttempt ?? (() => {})
  }

  async tryAcquire(key: string, holderId: string, ttlMs: number): Promise<LockResult> {
    if (ttlMs <= 0) throw new Error(`RedisLockStub.tryAcquire: ttlMs must be > 0 (got ${ttlMs})`)
    if (holderId.length === 0)
      throw new Error("RedisLockStub.tryAcquire: holderId must be non-empty")
    this.onAcquireAttempt(key, holderId, ttlMs)
    // Phase 1 — always return redis-error. Phase 2 wires real SETNX.
    return "redis-error"
  }

  async release(key: string, holderId: string): Promise<void> {
    this.onReleaseAttempt(key, holderId)
    // No-op in Phase 1.
  }
}

/**
 * Fallback chain helper — try each port in order, returning the FIRST
 *  non-error result. On `redis-error`, fall through to the next port; on
 *  `acquired` / `would-wait` / `would-acquire`, return immediately.
 *
 *  Release is broadcast to every port up to and including the one that
 *  acquired — this is a safety belt: if `redis-error` was a transient blip
 *  on the way IN but Redis returns by the time we release, we still clear
 *  the key (otherwise it would hang on for its full TTL).
 */
export class FallbackLock implements OAuthRefreshLockPort {
  private readonly ports: readonly OAuthRefreshLockPort[]

  constructor(ports: readonly OAuthRefreshLockPort[]) {
    if (ports.length === 0) throw new Error("FallbackLock requires at least one port")
    this.ports = ports
  }

  async tryAcquire(key: string, holderId: string, ttlMs: number): Promise<LockResult> {
    let lastResult: LockResult = "redis-error"
    for (const port of this.ports) {
      const result = await port.tryAcquire(key, holderId, ttlMs)
      if (result !== "redis-error") return result
      lastResult = result
    }
    return lastResult
  }

  async release(key: string, holderId: string): Promise<void> {
    // Broadcast — safe because every port's release is holder-scoped no-op
    // when the holder is wrong.
    for (const port of this.ports) {
      await port.release(key, holderId)
    }
  }
}
