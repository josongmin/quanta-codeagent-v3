/**
 * ADR-0281 — resolved session-end promotion policy.
 *
 * `TriggerPolicy` fields are required (no OMIT slots — the composition root
 * supplies a complete policy or accepts {@link DEFAULT_TRIGGER_POLICY}).
 * No I/O, no clock, no LLM — just the resolved policy shape.
 */

/**
 * Policy consumed by the live session-end consolidator.
 *
 * - `promoteThreshold` — minimum lexical-overlap score (range \[0, 1\])
 *   required to promote a Stage 1 entry once prior summaries exist. The first
 *   durable entry has no corpus to compare and is eligible by construction.
 *   Default `0.7`; `0` ⇒ promote-all; `> 1` ⇒ promote-none.
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
