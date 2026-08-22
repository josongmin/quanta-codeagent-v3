/**
 * T-501 — post-localization commit rail + no-patch-exhausted verdict.
 *
 * The over-verify / over-exploration side of the bidirectional gate (the #9296
 * class: 60 turns, zero edits). PURE decision over budget state — NOT a new idle
 * heuristic. One-shot: at the force-commit fraction with no edit yet, tell the
 * loop to commit its best edit; at budget end with still no edit, emit the
 * `no_patch_exhausted` verdict (distinct from a model-miss).
 */

export interface NoPatchDecisionInput {
  turnsUsed: number
  maxTurns: number
  /** Has the agent made at least one mutating edit this run? */
  hasMutatingEdit: boolean
  /** Fraction of the turn budget after which "no edit yet" forces a commit. */
  forceCommitAtFraction?: number
}

export type NoPatchDecision =
  | { action: "continue" }
  | { action: "commit-now"; reason: string }
  | { action: "exhausted"; reason: string }

const DEFAULT_FORCE_FRACTION = 0.8

export const decideNoPatch = (input: NoPatchDecisionInput): NoPatchDecision => {
  // Any edit exists ⇒ not a no-patch case; the rail does nothing.
  if (input.hasMutatingEdit) return { action: "continue" }

  const frac = input.forceCommitAtFraction ?? DEFAULT_FORCE_FRACTION
  const cap = input.maxTurns > 0 ? input.maxTurns : 1

  if (input.turnsUsed >= cap) {
    return {
      action: "exhausted",
      reason: `no mutating edit after ${input.turnsUsed}/${cap} turns — no_patch_exhausted (not a model-miss)`,
    }
  }
  if (input.turnsUsed >= Math.floor(cap * frac)) {
    return {
      action: "commit-now",
      reason: `${input.turnsUsed}/${cap} turns spent with no edit — commit best candidate before exhaustion`,
    }
  }
  return { action: "continue" }
}
