/**
 * ADR-0163 Phase D — in-memory OAuth refresh lock (single-process).
 *
 * Closed-port impl of {@link OAuthRefreshLockPort}. Mutual exclusion is
 * per-process — two processes that both hold their own `InMemoryLock` will
 * BOTH succeed. Use this when:
 *   - Single CLI instance per user (most common).
 *   - Tests (Map-based, deterministic, no I/O).
 *
 * Use {@link FileBasedLock} for cross-process same-machine; use the Phase 2
 * Redis impl for cross-machine.
 *
 * Clock is port-injected (DIP) so tests inject a deterministic clock without
 * `Date.now()`. The lock's internal Map holds the holderId + expiresAt; on
 * `tryAcquire` we reap any entry whose `expiresAt <= clock.now()` BEFORE
 * checking presence — this is the only mechanism for stale-lock recovery,
 * mirroring the negative invariant "no setTimeout reaping".
 *
 * Plane-clean: imports only the port (sibling). No SDK, no `node:*`.
 */

import type { ClockPort } from "../llm/oidc-federation"
import type { LockResult, OAuthRefreshLockPort } from "./oauth-refresh-lock"

interface LockEntry {
  readonly holderId: string
  readonly expiresAt: number
}

export class InMemoryLock implements OAuthRefreshLockPort {
  private readonly entries: Map<string, LockEntry> = new Map()
  private readonly clock: ClockPort

  constructor(clock: ClockPort) {
    this.clock = clock
  }

  async tryAcquire(key: string, holderId: string, ttlMs: number): Promise<LockResult> {
    // Defense: zero/negative TTL is a programmer bug — refuse rather than
    // silently insert an entry that reaps on the next tick. (No-heuristics
    // discipline: we do not pick a "sensible default" — the caller's intent
    // is malformed.)
    if (ttlMs <= 0) {
      throw new Error(`InMemoryLock.tryAcquire: ttlMs must be > 0 (got ${ttlMs})`)
    }
    if (holderId.length === 0) {
      throw new Error("InMemoryLock.tryAcquire: holderId must be non-empty")
    }

    const now = this.clock.now()

    // Reap stale entry (TTL elapsed) BEFORE presence check.
    const existing = this.entries.get(key)
    if (existing !== undefined && existing.expiresAt <= now) {
      this.entries.delete(key)
    }

    // Holder check after reaping.
    const current = this.entries.get(key)
    if (current === undefined) {
      this.entries.set(key, { holderId, expiresAt: now + ttlMs })
      return "acquired"
    }
    // Re-entrant: same holder is allowed to "re-acquire" → returns "acquired"
    // and EXTENDS the TTL. This is intentional — a single holder that
    // legitimately renews must not have to release-and-reacquire (which
    // would race against other contenders).
    if (current.holderId === holderId) {
      this.entries.set(key, { holderId, expiresAt: now + ttlMs })
      return "acquired"
    }
    // Different holder, lock live → would-wait.
    return "would-wait"
  }

  async release(key: string, holderId: string): Promise<void> {
    const current = this.entries.get(key)
    if (current === undefined) return // Unknown key — no-op (idempotent).
    if (current.holderId !== holderId) return // Wrong holder — no-op (safety).
    this.entries.delete(key)
  }
}
