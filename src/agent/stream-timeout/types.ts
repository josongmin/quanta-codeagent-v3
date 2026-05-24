/**
 * ADR-0200 — Stream idle/total timeout watchdog types.
 *
 * Closed-union timeout policy + typed error classes. Plane-clean: imports
 * NO siblings (types only).
 */

import type { SnoozeController } from "./snooze"

/** What the watchdog does when a timeout fires.
 *
 *  - `abort` (default-flavour): typed throw → existing recovery FSM treats
 *    it as a transient stream error and triggers same-turn retry.
 *  - `degrade`: graceful early termination — the wrapped iterator returns
 *    `done` instead of throwing, so the caller keeps whatever it already
 *    yielded (partial results stay actionable).
 *  - `prompt-user`: today behaves like `abort` but is labelled distinctly
 *    on the telemetry attr. Reserved for a future HITL "still working?"
 *    surface (Phase 2). */
export type TimeoutAction = "abort" | "degrade" | "prompt-user"

/** Watchdog policy. ALL fields optional except `action`. When BOTH
 *  `idleMs` and `totalMs` are absent, the watchdog is a strict
 *  pass-through (byte-identical to no wrap). */
export interface TimeoutPolicy {
  /** Max ms between two consecutive yields from the source. Resets on
   *  every yield. Absent ⇒ no idle gate. */
  readonly idleMs?: number
  /** Max ms from the FIRST `next()` call to completion. Absent ⇒ no
   *  total cap. Checked AFTER each yield so a long-running stream that
   *  pulses fast can still trip total. */
  readonly totalMs?: number
  /** What to do when a timeout fires. */
  readonly action: TimeoutAction
  /** Optional snooze controller. When `isPaused()` returns true the idle
   *  counter is parked — the watchdog polls every 50ms until resume.
   *  Total cap is NOT paused by snooze (would defeat the purpose). */
  readonly snooze?: SnoozeController
}

/** Thrown when the source goes silent longer than `policy.idleMs`. */
export class StreamIdleError extends Error {
  public readonly idleMs: number
  constructor(idleMs: number) {
    super(`stream idle ${idleMs}ms`)
    this.idleMs = idleMs
    this.name = "StreamIdleError"
  }
}

/** Thrown when the total elapsed time exceeds `policy.totalMs`. */
export class StreamTotalError extends Error {
  public readonly totalMs: number
  constructor(totalMs: number) {
    super(`stream total ${totalMs}ms exceeded`)
    this.totalMs = totalMs
    this.name = "StreamTotalError"
  }
}

/** Thrown when the external `AbortSignal` fires before/during a wait. */
export class StreamAbortError extends Error {
  constructor(message = "stream aborted") {
    super(message)
    this.name = "StreamAbortError"
  }
}
