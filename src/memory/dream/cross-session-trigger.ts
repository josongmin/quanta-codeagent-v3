/**
 * H16 — `CrossSessionDreamTrigger`.
 *
 * The GLUE for cross-session memory consolidation ("auto-dream"). It owns a
 * tiny persisted counter/clock and fires the EXISTING consolidate pipeline
 * (injected via {@link DreamConsolidatePort}) when enough sessions OR hours
 * have elapsed since the last dream. It NEVER reimplements consolidation.
 *
 * Pipeline (`onSessionEnd`):
 *
 *   onSessionEnd
 *     ├─ feature OFF (no policy)            → return without touching state
 *     ├─ read persisted DreamState
 *     ├─ sessionsSince += 1 ; persist        (counter advances every session)
 *     ├─ threshold crossed? (sessions OR hours)
 *     │    └─ no  → {kind:"below_threshold", ...}                  (telemetry: skipped)
 *     ├─ tryAcquire(dream-lock)
 *     │    └─ would-wait → {kind:"locked"}                         (telemetry: skipped)
 *     ├─ FIRE  (telemetry: fired) — run in background (don't burn a live turn)
 *     │    ├─ consolidate()  (the EXISTING pipeline)
 *     │    │    ├─ throw → {kind:"error"}  (counter NOT reset)     (telemetry: skipped)
 *     │    │    └─ no_op → reset counter, record  {kind:"no_op"}   (telemetry: completed)
 *     │    └─ writeTarget.write(content)  (team/ target, NOT MEMORY.md)
 *     │         ├─ throw → {kind:"error"} (counter NOT reset)      (telemetry: skipped)
 *     │         └─ ok    → reset counter, record  {kind:"completed"} (telemetry: completed)
 *     └─ finally: release(dream-lock)
 *
 * Determinism: the clock is INJECTED (`now`) — no `Date.now()`. The "hours
 * since" math uses the injected clock only. Default-OFF: with no policy the
 * counter never advances and no state is read or written (byte-identical).
 *
 * No-throw: every side-effect is wrapped; the slice never throws out of
 * `onSessionEnd` / `dream` (an `AbortError` from the injected consolidate
 * port propagates, mirroring the auto-trigger contract).
 */

import { errMessage, isAbortError } from "@/shared/errors"
import type { DreamConsolidatePort, DreamStatePort, DreamWriteTargetPort } from "./port"
import {
  DREAM_LOCK_KEY,
  DREAM_LOCK_TTL_MS,
  DreamError,
  type DreamErrorReason,
  type DreamOutcome,
  type DreamOutcomeKind,
  type DreamPolicy,
  type DreamState,
} from "./types"

const MS_PER_HOUR = 60 * 60 * 1000

/** Structural lock seam. The codebase's `OAuthRefreshLockPort`
 *  (in-memory / file-based impls) satisfies this shape — the composition
 *  root passes one of those instances. Defined locally so `@/memory` stays
 *  plane-clean (no `@/auth` import). */
export interface DreamLockPort {
  tryAcquire(
    key: string,
    holderId: string,
    ttlMs: number,
  ): Promise<"acquired" | "would-wait" | "would-acquire" | "redis-error">
  release(key: string, holderId: string): Promise<void>
}

/** Telemetry sink — mirrors Claude's `tengu_auto_dream_{fired,completed,
 *  skipped}` trio. Best-effort; a throwing sink MUST NOT derail the dream.
 *  No content crosses this seam — counts + the cross-session keys only. */
export interface DreamTelemetryPort {
  /** Emitted when the threshold is crossed and a pass is attempted. */
  recordFired(event: { readonly sessionsSince: number; readonly hoursSince: number | null }): void
  /** Emitted when the pass produced a write OR a no-op (we DID dream). */
  recordCompleted(event: {
    readonly outcome: "completed" | "no_op"
    readonly bytesWritten: number
  }): void
  /** Emitted when the pass did NOT run (below threshold / locked / error). */
  recordSkipped(event: { readonly reason: "below_threshold" | "locked" | "error" }): void
}

/** No-op telemetry — the structural Default-OFF binding. Frozen so a caller
 *  cannot silently swap the methods. */
export const noopDreamTelemetry: DreamTelemetryPort = Object.freeze({
  recordFired: (): void => {},
  recordCompleted: (): void => {},
  recordSkipped: (): void => {},
})

export interface CrossSessionDreamTriggerOpts {
  /** Persisted counter/clock store. */
  readonly state: DreamStatePort
  /** The EXISTING consolidate pipeline adapter (reused, not reimplemented). */
  readonly consolidate: DreamConsolidatePort
  /** Shared `team/`-style write target (NOT MEMORY.md). */
  readonly writeTarget: DreamWriteTargetPort
  /** Cross-process dream-lock (reuses the codebase lock primitive). */
  readonly lock: DreamLockPort
  /** Injected clock — `Date.now` in production, fixed in tests. */
  readonly now: () => number
  /**
   * Threshold policy. ABSENT ⇒ feature OFF: the counter never advances, no
   * state is read or written, no consolidate fires (byte-identical default).
   * The composition root supplies a policy ONLY when `QUANTA_AUTO_DREAM=1`.
   */
  readonly policy?: DreamPolicy
  /** Stable holder id for the lock (process-scoped). Defaults to a fixed
   *  string; production passes a per-process unique id. */
  readonly holderId?: string
  /** Telemetry sink. Defaults to a no-op. */
  readonly telemetry?: DreamTelemetryPort
  /** Diagnostic sink for swallowed failures. Defaults to no-op. */
  readonly logWarn?: (msg: string) => void
}

export class CrossSessionDreamTrigger {
  private readonly state: DreamStatePort
  private readonly consolidatePort: DreamConsolidatePort
  private readonly writeTarget: DreamWriteTargetPort
  private readonly lock: DreamLockPort
  private readonly now: () => number
  private readonly policy: DreamPolicy | undefined
  private readonly holderId: string
  private readonly telemetry: DreamTelemetryPort | undefined
  private readonly logWarn: (msg: string) => void

  constructor(opts: CrossSessionDreamTriggerOpts) {
    this.state = opts.state
    this.consolidatePort = opts.consolidate
    this.writeTarget = opts.writeTarget
    this.lock = opts.lock
    this.now = opts.now
    this.policy = opts.policy
    this.holderId = opts.holderId ?? "auto-dream"
    this.telemetry = opts.telemetry
    this.logWarn = opts.logWarn ?? ((): void => {})
  }

  /** True iff the feature is enabled (a policy is present). */
  get enabled(): boolean {
    return this.policy !== undefined
  }

  /** The resolved team-target path (for `dream status`). */
  get targetPath(): string {
    return this.writeTarget.targetPath
  }

  /** Read the persisted state without mutating it (for `dream status`). When
   *  the feature is OFF we still expose the persisted state read-only so the
   *  status surface can show "feature off" alongside any prior bookkeeping. */
  readState(): DreamState {
    return this.state.read()
  }

  /** Hours elapsed since the last completed dream per the injected clock, or
   *  `null` when no dream has ever run. */
  hoursSinceLastDream(state: DreamState = this.readState()): number | null {
    if (state.lastDreamAtMs === null) return null
    const delta = this.now() - state.lastDreamAtMs
    return delta < 0 ? 0 : delta / MS_PER_HOUR
  }

  /**
   * Cross-session hook — call at the END of every session. Advances the
   * persisted counter and fires the consolidate pass when the threshold is
   * crossed. Default-OFF ⇒ no-op (returns `below_threshold` with the
   * unchanged session count, touching NO state).
   */
  async onSessionEnd(opts: { readonly signal?: AbortSignal } = {}): Promise<DreamOutcome> {
    // Default-OFF: no policy ⇒ no counter, no read, no write, no fire.
    if (this.policy === undefined) {
      return { kind: "below_threshold", sessionsSinceLastDream: 0, hoursSinceLastDream: null }
    }

    // Advance the persisted counter (one session observed). State-port
    // failures collapse to a recorded error — the dream is best-effort and a
    // disk hiccup must not crash the session-end path.
    let advanced: DreamState
    try {
      const prev = this.state.read()
      advanced = { ...prev, sessionsSinceLastDream: prev.sessionsSinceLastDream + 1 }
      this.state.write(advanced)
    } catch (e) {
      return this.recordError("state_throw", e)
    }

    const hoursSince = this.hoursSinceLastDream(advanced)
    const sessionsCrossed = advanced.sessionsSinceLastDream >= this.policy.sessionsThreshold
    const hoursCrossed = hoursSince !== null && hoursSince >= this.policy.hoursThreshold

    if (!sessionsCrossed && !hoursCrossed) {
      this.telemetry?.recordSkipped({ reason: "below_threshold" })
      return {
        kind: "below_threshold",
        sessionsSinceLastDream: advanced.sessionsSinceLastDream,
        hoursSinceLastDream: hoursSince,
      }
    }

    // Threshold crossed → fire (subject to the dream-lock).
    return this.fire(advanced, hoursSince, opts.signal)
  }

  /**
   * Manual trigger (`dream` CLI). Bypasses the threshold gate but STILL
   * honours the dream-lock + the feature flag. When OFF, returns
   * `below_threshold` (nothing to do).
   */
  async dream(opts: { readonly signal?: AbortSignal } = {}): Promise<DreamOutcome> {
    if (this.policy === undefined) {
      return { kind: "below_threshold", sessionsSinceLastDream: 0, hoursSinceLastDream: null }
    }
    let state: DreamState
    try {
      state = this.state.read()
    } catch (e) {
      return this.recordError("state_throw", e)
    }
    return this.fire(state, this.hoursSinceLastDream(state), opts.signal)
  }

  /** Acquire the lock, run the consolidate + team write, reset the counter on
   *  success. Releases the lock in a `finally`. */
  private async fire(
    state: DreamState,
    hoursSince: number | null,
    signal: AbortSignal | undefined,
  ): Promise<DreamOutcome> {
    // Dream-lock: a second concurrent process observes `would-wait` and skips.
    let lockResult: Awaited<ReturnType<DreamLockPort["tryAcquire"]>>
    try {
      lockResult = await this.lock.tryAcquire(DREAM_LOCK_KEY, this.holderId, DREAM_LOCK_TTL_MS)
    } catch (e) {
      // A lock-infra fault is treated as "could not run" — skip, do not crash.
      this.logWarn(`auto-dream: lock acquire failed: ${errMessage(e)}`)
      this.telemetry?.recordSkipped({ reason: "locked" })
      return { kind: "locked" }
    }
    if (lockResult !== "acquired") {
      this.telemetry?.recordSkipped({ reason: "locked" })
      return { kind: "locked" }
    }

    this.telemetry?.recordFired({
      sessionsSince: state.sessionsSinceLastDream,
      hoursSince,
    })

    try {
      // Run the EXISTING consolidate pipeline. Abort propagates unchanged.
      let result: Awaited<ReturnType<DreamConsolidatePort["consolidate"]>>
      try {
        result = await this.consolidatePort.consolidate(signal !== undefined ? { signal } : {})
      } catch (e) {
        if (isAbortError(e)) throw e
        return this.recordError("consolidate_throw", e)
      }

      if (result.kind === "no_op") {
        // We DID dream; there was just nothing to consolidate. Reset the
        // counter + stamp the clock so the cadence restarts.
        this.persistCompleted(state, "no_op")
        this.telemetry?.recordCompleted({ outcome: "no_op", bytesWritten: 0 })
        return { kind: "no_op" }
      }

      // Write the consolidated knowledge to the TEAM target (not MEMORY.md).
      const content = result.content ?? ""
      let bytesWritten: number
      try {
        bytesWritten = await this.writeTarget.write(content)
      } catch (e) {
        if (isAbortError(e)) throw e
        return this.recordError("write_throw", e)
      }

      this.persistCompleted(state, "completed")
      this.telemetry?.recordCompleted({ outcome: "completed", bytesWritten })
      return { kind: "completed", bytesWritten }
    } finally {
      // Always release — holder-checked so a re-entrant call is safe.
      try {
        await this.lock.release(DREAM_LOCK_KEY, this.holderId)
      } catch (e) {
        this.logWarn(`auto-dream: lock release failed: ${errMessage(e)}`)
      }
    }
  }

  /** Persist a COMPLETED/NO-OP dream: reset the session counter + stamp the
   *  clock. State-write failure is logged but not surfaced (we already did the
   *  work; next session re-stamps). */
  private persistCompleted(prev: DreamState, outcome: DreamOutcomeKind): void {
    try {
      this.state.write({
        sessionsSinceLastDream: 0,
        lastDreamAtMs: this.now(),
        lastOutcome: outcome,
      })
    } catch (e) {
      // Counter persist failed AFTER a successful dream — log only. The next
      // session will advance from the stale counter; the consolidate is
      // idempotent enough (it reads the store fresh) that this is benign.
      this.logWarn(
        `auto-dream: state persist after ${outcome} failed: ${errMessage(prev)}; ${errMessage(e)}`,
      )
    }
  }

  /** Record an error outcome: stamp `lastOutcome="error"` WITHOUT resetting
   *  the counter (so the dream retries next session) + emit skipped telemetry. */
  private recordError(reason: DreamErrorReason, cause: unknown): DreamOutcome {
    const err = new DreamError(reason, errMessage(cause), cause)
    this.logWarn(err.message)
    // Best-effort: stamp lastOutcome="error" but keep the counter so the
    // threshold stays crossed and the next session retries.
    try {
      const cur = this.state.read()
      this.state.write({ ...cur, lastOutcome: "error" })
    } catch {
      /* swallow — already on the error path */
    }
    this.telemetry?.recordSkipped({ reason: "error" })
    return { kind: "error", error: err }
  }
}
