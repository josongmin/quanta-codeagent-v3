/**
 * H16 — CROSS-SESSION memory consolidation ("auto-dream") types.
 *
 * Closed-set shapes for the cross-session dream trigger. This slice is the
 * GLUE that sits ON TOP of the existing session-end consolidate pipeline
 * (ADR-0068 `runPhase2`, ADR-0281 auto-trigger): a small persisted
 * counter/clock that fires the EXISTING consolidator when enough sessions
 * OR hours have elapsed since the last dream.
 *
 * Reference (Claude): `tengu_auto_dream_{fired,completed,skipped}` keyed on
 * `hours_since` / `sessions_since`; writes to a `team/`-style shared target;
 * NEVER mutates the user's live `MEMORY.md`.
 *
 * No I/O, no clock, no LLM here — just shapes + a named error. The clock and
 * every side effect are injected via ports (see `./port.ts`).
 */

/**
 * Threshold policy for the cross-session dream. The trigger fires when
 * EITHER bound is crossed (OR semantics — a chatty day fires on sessions,
 * a quiet long gap fires on hours).
 *
 * - `sessionsThreshold` — number of session-ends since the last completed
 *   dream that, when reached, fires a pass. Must be a positive integer.
 * - `hoursThreshold` — wall-clock hours since the last completed dream that,
 *   when crossed, fires a pass. Must be a positive finite number.
 *
 * Negative invariant: both fields are required. No "sensible default"
 * baked in here — the operator supplies the policy from the runtime-config
 * knobs (`QUANTA_AUTO_DREAM_SESSIONS` / `QUANTA_AUTO_DREAM_HOURS`) or accepts
 * {@link DEFAULT_DREAM_POLICY}. Thresholds are CONFIG, never magic numbers.
 */
export interface DreamPolicy {
  readonly sessionsThreshold: number
  readonly hoursThreshold: number
}

/**
 * Default cross-session dream policy. Mirrors Claude's observed cadence:
 * a dream every ~5 sessions or once a day, whichever comes first. These are
 * the documented defaults the runtime-config knobs fall back to when the
 * operator does not override — they are NOT applied unless the feature is
 * enabled (`QUANTA_AUTO_DREAM=1`).
 */
export const DEFAULT_DREAM_POLICY: DreamPolicy = Object.freeze({
  sessionsThreshold: 5,
  hoursThreshold: 24,
})

/**
 * Persisted cross-session dream bookkeeping. This is the small counter/clock
 * the trigger reads + writes. It survives across process runs (the state
 * port persists it) so a dream that should fire "every 5 sessions" counts
 * sessions across separate CLI invocations.
 *
 * - `sessionsSinceLastDream` — count of session-ends observed since the last
 *   COMPLETED dream. Reset to 0 on a completed pass.
 * - `lastDreamAtMs` — wall-clock ms of the last COMPLETED dream, or `null`
 *   when no dream has ever run (first-ever fire is gated only by sessions).
 * - `lastOutcome` — terminal kind of the most recent dream attempt, for the
 *   `dream status` surface. `null` when none has run.
 */
export interface DreamState {
  readonly sessionsSinceLastDream: number
  readonly lastDreamAtMs: number | null
  readonly lastOutcome: DreamOutcomeKind | null
}

/** Initial persisted state — no sessions counted, never dreamed. */
export const INITIAL_DREAM_STATE: DreamState = Object.freeze({
  sessionsSinceLastDream: 0,
  lastDreamAtMs: null,
  lastOutcome: null,
})

/** Terminal outcome bucket of a dream attempt. Mirrors the Claude telemetry
 *  trio (`fired`→{completed|skipped}). `fired` is the intent; the others are
 *  resolutions. */
export type DreamOutcomeKind =
  /** Threshold NOT crossed (or feature off) — nothing ran, counter advanced. */
  | "below_threshold"
  /** Threshold crossed but the dream-lock was held by another process. */
  | "locked"
  /** Consolidate ran and wrote the team target. Counter reset. */
  | "completed"
  /** Consolidate ran but produced no write (e.g. no new entries). Counter
   *  reset (we DID dream; there was just nothing to consolidate). */
  | "no_op"
  /** Consolidate threw. Recorded, counter NOT reset (retry next session). */
  | "error"

/**
 * Discriminated outcome of {@link import("./cross-session-trigger").CrossSessionDreamTrigger.onSessionEnd}
 * and `dream()`. Never throws (abort propagates upstream of this slice).
 */
export type DreamOutcome =
  | {
      readonly kind: "below_threshold"
      readonly sessionsSinceLastDream: number
      readonly hoursSinceLastDream: number | null
    }
  | { readonly kind: "locked" }
  | { readonly kind: "completed"; readonly bytesWritten: number }
  | { readonly kind: "no_op" }
  | { readonly kind: "error"; readonly error: DreamError }

/** Closed enum of {@link DreamError.reason}. */
export type DreamErrorReason = "consolidate_throw" | "write_throw" | "state_throw"

/**
 * Named error wrapping a consolidate / team-write / state-persist failure
 * inside the no-throw dream contract. The caller receives this as
 * `{kind:"error", error: DreamError}`; the underlying cause is preserved
 * via `cause`.
 */
export class DreamError extends Error {
  public readonly reason: DreamErrorReason
  public override readonly cause?: unknown
  constructor(reason: DreamErrorReason, message: string, cause?: unknown) {
    super(`auto-dream failed (${reason}): ${message}`)
    this.name = "DreamError"
    this.reason = reason
    if (cause !== undefined) this.cause = cause
  }
}

/** Lock scope key for the dream-lock. Stable so two processes contend on the
 *  same key. */
export const DREAM_LOCK_KEY = "memory-auto-dream"

/** Default dream-lock lease in ms. A dream pass that crashes without
 *  releasing is reaped after this window (the lock port's TTL semantics). */
export const DREAM_LOCK_TTL_MS = 10 * 60 * 1000
