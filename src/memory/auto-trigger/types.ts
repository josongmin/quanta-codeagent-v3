/**
 * ADR-0281 — `TriggerPolicy` + named error shapes.
 *
 * Closed-set. `TriggerPolicy` fields are required (no OMIT slots — the
 * port consumer supplies a complete policy or accepts {@link DEFAULT_TRIGGER_POLICY}).
 * `TriggerError` carries a discriminated `reason` so callers can branch
 * on failure mode without `instanceof` chains.
 *
 * No I/O, no clock, no LLM — just shapes + a named class.
 */

/**
 * Per-host policy for {@link import("./port").MemoryAutoTrigger}.
 *
 * - `promoteThreshold` — minimum scorer output (range \[0, 1\] for the
 *   default lexical Jaccard adapter) required to promote a Stage 1
 *   entry. Default `0.7`. Edge cases: `0` ⇒ promote-all,
 *   `> 1` ⇒ promote-none for the default scorer.
 * - `minUsageCount` — minimum `usageCount` an entry needs before
 *   promotion is considered. Default `1` (any ever-used entry is
 *   eligible). `0` ⇒ usage gate disabled.
 *
 * Negative invariant: both fields are required. A partial policy
 * passed at construction time produces a type error — the operator
 * either accepts the default or supplies a complete one.
 */
export interface TriggerPolicy {
  readonly promoteThreshold: number
  readonly minUsageCount: number
}

/** Default policy — locked by HELL-MAT-21. */
export const DEFAULT_TRIGGER_POLICY: TriggerPolicy = Object.freeze({
  promoteThreshold: 0.7,
  minUsageCount: 1,
})

/**
 * Named error wrapping a Phase 1 / stage1.put / scorer failure inside
 * the no-throw `onSessionEnd` contract. The caller receives this as
 * `{kind:"error", error: TriggerError}` from the outcome union; the
 * underlying cause is preserved via `cause` (Error chain).
 *
 * `reason` is a closed enum so consumers can branch on failure mode
 * deterministically (no string compare on `message`).
 */
export class TriggerError extends Error {
  public readonly reason: TriggerErrorReason
  public override readonly cause?: unknown
  constructor(reason: TriggerErrorReason, message: string, cause?: unknown) {
    super(`memory auto-trigger failed (${reason}): ${message}`)
    this.name = "TriggerError"
    this.reason = reason
    if (cause !== undefined) this.cause = cause
  }
}

/** Closed enum of {@link TriggerError.reason}. */
export type TriggerErrorReason = "phase1_throw" | "stage1_put_throw" | "promote_throw"
