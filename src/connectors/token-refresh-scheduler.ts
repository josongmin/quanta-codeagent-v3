/**
 * Proactive token-refresh scheduler (ADR-0460).
 *
 * WHY THIS EXISTS
 * ───────────────
 * Today token rotation (`./token-rotation.ts` `TokenRotator.rotate`) is
 * CALLER-DRIVEN only: a connector refreshes its access token when a caller
 * explicitly invokes `rotate()`, typically reactively AFTER a wire call already
 * came back 401. That means a long task can hit an expired token mid-flight,
 * eat a 401, and only then refresh — friction on the hot path.
 *
 * This scheduler removes that friction by refreshing BEFORE expiry on a
 * clock-driven timer. On fire it calls the SAME `TokenRotator.rotate(id, refresh)`
 * path — it does NOT duplicate the rotator's in-flight mutex or atomic persist.
 * A scheduled fire and a manual `rotate()` for the same connector coalesce onto
 * the rotator's single in-flight promise (no double refresh).
 *
 * DESIGN INVARIANTS
 * ─────────────────
 *   - Closed-port DI: clock + timer + rotator are injected. No real timers and
 *     no `Date.now()` leak — deterministic under a fake clock/timer in tests.
 *   - Default-OFF: connectors that never construct a scheduler are byte-identical
 *     (rotation stays purely caller-driven). This file exports a factory only;
 *     nothing constructs it implicitly.
 *   - No-expiry tokens are NEVER scheduled (no-op). A token with no `expiresAt`
 *     has no deadline to anticipate.
 *   - No unhandled rejection: the timer callback NEVER throws or rejects out of
 *     the timer. All failures route to the injected `onError` and a bounded
 *     backoff retry. No tight loop — a failed refresh waits a growing delay.
 *   - No timer leak: at most ONE pending timer per connector. `stop()` clears
 *     every pending timer; re-`schedule()` of the same id clears the prior one.
 *
 * Mirrors the in-flight-dedup discipline of
 * `src/auth/chatgpt-oauth/refresh.ts` `RefreshCoordinator`, generalized over the
 * connectors `TokenRotator`.
 */

import type { TokenRotator } from "./token-rotation"
import type { ClockPort, TokenRecord } from "./types"

/**
 * Opaque timer handle. We do NOT bind to `ReturnType<typeof setTimeout>` so the
 * port stays decoupled from the Node/Bun global timer types — a fake timer in
 * tests can hand back any token and we treat it as opaque.
 */
export type TimerHandle = unknown

/**
 * Injected timer surface — a `setTimeout`/`clearTimeout` pair. Tests inject a
 * fake that records callbacks and fires them on demand; prod wires the globals.
 * The contract: `set(cb, ms)` returns a handle that `clear(handle)` cancels.
 */
export interface TimerPort {
  set(callback: () => void, delayMs: number): TimerHandle
  clear(handle: TimerHandle): void
}

/**
 * Structural lead margin: refresh `LEAD_MS` BEFORE the token's `expiresAt`.
 *
 * This is a MARGIN, not a tuned heuristic. The value bounds the clock-skew +
 * refresh-round-trip window during which a token could expire on the wire while
 * a refresh is in flight: if we fired exactly at `expiresAt`, the refresh
 * network round-trip itself would straddle the expiry boundary and a concurrent
 * call could still see an expired token. 60s is a conservative upper bound on
 * (refresh RTT + tolerated client/server clock skew) — large enough that the
 * new token is in hand before the old one lapses, small enough that we are not
 * refreshing wastefully far ahead of need. It is deliberately a single named
 * constant (not per-connector configurable) so the margin is uniform and
 * auditable; tunability would invite cargo-cult drift.
 */
export const LEAD_MS = 60_000

/**
 * Backoff for a FAILED scheduled refresh. Structural, bounded, documented:
 * a refresh failure must neither tight-loop (hammering the issuer) nor give up
 * silently. We retry with exponential backoff capped at {@link BACKOFF_MAX_MS}.
 * These are not tunables — they bound retry pressure on the issuer.
 */
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_MAX_MS = 5 * 60_000

/** Compute the nth backoff delay (n=0 → base), capped. Pure. */
const backoffDelayMs = (attempt: number): number => {
  const raw = BACKOFF_BASE_MS * 2 ** attempt
  return Math.min(raw, BACKOFF_MAX_MS)
}

export interface TokenRefreshSchedulerConfig {
  readonly rotator: TokenRotator
  readonly clockPort: ClockPort
  readonly timerPort: TimerPort
  /**
   * The refresh callback handed to `rotator.rotate(id, refresh)` — owns the
   * network shape (RFC 6749 §6 refresh_token, PKCE, etc). SAME signature the
   * caller-driven path uses, so the scheduler reuses the rotator verbatim.
   */
  readonly refresh: (current: TokenRecord | undefined) => Promise<TokenRecord>
  /**
   * Surface for scheduled-refresh failures. Invoked with the connector id and
   * the error. NEVER thrown out of the timer — failures route here and trigger
   * a bounded backoff retry. Best-effort: if `onError` itself throws it is
   * swallowed (a faulty observer must not crash the scheduler).
   */
  readonly onError?: (connectorId: string, error: unknown) => void
}

export interface TokenRefreshScheduler {
  /**
   * Schedule a proactive refresh for `connectorId` based on `record.expiresAt`.
   * Clears any prior pending timer for the same id first (idempotent — at most
   * one pending timer per connector). A record with no `expiresAt` is a no-op.
   * A deadline already in the past (or within LEAD_MS) fires on the next tick
   * (delay clamped to 0) rather than scheduling in the past.
   */
  schedule(connectorId: string, record: TokenRecord): void
  /** Cancel the pending timer for one connector (idempotent). */
  cancel(connectorId: string): void
  /** Cancel ALL pending timers. Call on session end — guarantees no leak. */
  stop(): void
  /** Test/observability: number of pending timers currently held. */
  pendingCount(): number
}

export const createTokenRefreshScheduler = (
  config: TokenRefreshSchedulerConfig,
): TokenRefreshScheduler => {
  // At most ONE pending timer per connector id — re-scheduling clears the prior.
  const pending = new Map<string, TimerHandle>()

  const reportError = (connectorId: string, error: unknown): void => {
    if (config.onError === undefined) return
    try {
      config.onError(connectorId, error)
    } catch {
      // Best-effort: a throwing observer must never poison the scheduler or
      // surface as an unhandled rejection from the timer callback.
    }
  }

  const cancel = (connectorId: string): void => {
    const handle = pending.get(connectorId)
    if (handle === undefined) return
    config.timerPort.clear(handle)
    pending.delete(connectorId)
  }

  const stop = (): void => {
    for (const handle of pending.values()) config.timerPort.clear(handle)
    pending.clear()
  }

  /**
   * Arm a timer that fires after `delayMs` and runs `onFire`. The fired handle
   * is removed from `pending` BEFORE running the body so the slot never leaks
   * and a re-schedule from within the body installs cleanly.
   */
  const arm = (connectorId: string, delayMs: number, onFire: () => void): void => {
    // Clear any prior pending timer first → exactly one timer per id, no leak.
    cancel(connectorId)
    const handle = config.timerPort.set(() => {
      pending.delete(connectorId)
      onFire()
    }, delayMs)
    pending.set(connectorId, handle)
  }

  // Forward declaration so the timer body can re-schedule from the new token.
  let scheduleFrom: (connectorId: string, expiresAt: number) => void

  /**
   * Run one scheduled refresh. NEVER throws/rejects out of the timer: the async
   * IIFE owns its own try/catch and nothing can escape the try. On success it
   * re-schedules from the new token's expiry; on failure it routes to `onError`
   * and re-arms a bounded backoff retry (no tight loop, no give-up).
   */
  const fireRefresh = (connectorId: string, attempt: number): void => {
    void (async (): Promise<void> => {
      try {
        // SAME rotator path as the caller-driven 401 flow → reuses the in-flight
        // mutex + atomic persist. A concurrent manual rotate() coalesces here.
        const next = await config.rotator.rotate(connectorId, config.refresh)
        if (next.expiresAt !== undefined) {
          // Re-schedule the steady-state proactive refresh from the new expiry.
          scheduleFrom(connectorId, next.expiresAt)
        }
        // No expiry on the fresh token ⇒ nothing more to schedule (no-op).
      } catch (error) {
        reportError(connectorId, error)
        // Bounded exponential backoff retry — never tight-loop, never give up
        // silently. Re-arm with a growing delay; success resets the cadence.
        arm(connectorId, backoffDelayMs(attempt), () => fireRefresh(connectorId, attempt + 1))
      }
    })()
  }

  scheduleFrom = (connectorId: string, expiresAt: number): void => {
    const fireAt = expiresAt - LEAD_MS
    // Clamp to 0: a deadline already past (or within LEAD_MS) fires next tick
    // rather than being scheduled in the past or being dropped.
    const delay = Math.max(0, fireAt - config.clockPort.now())
    arm(connectorId, delay, () => fireRefresh(connectorId, 0))
  }

  const schedule = (connectorId: string, record: TokenRecord): void => {
    if (record.expiresAt === undefined) {
      // No deadline to anticipate → no-op. Also drop any stale prior timer so a
      // re-schedule with a now-expiry-less token does not keep firing.
      cancel(connectorId)
      return
    }
    scheduleFrom(connectorId, record.expiresAt)
  }

  return {
    schedule,
    cancel,
    stop,
    pendingCount: () => pending.size,
  }
}
