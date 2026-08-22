/**
 * Observation kernel — the localization CRITIC port (jul-6, SOTA++ lever).
 * Design SSOT: `docs/plans/jul-6-observation-providers/README.md` (§5).
 *
 * The critic is the SAFEST use of the static engine: it does NOT seed an owner
 * (no injection ⇒ no overtrust risk), it REFUTES the owner the model already
 * chose. Feed-forward hints anchor; a refuter only fires when the model is about
 * to edit something the engine can prove is wrong.
 *
 * HARD invariant (audit A1/C4): the result is 3-WAY. A static engine is
 * INCOMPLETE (dynamic dispatch / reflection are invisible), so "could not
 * refute" is NOT "confirmed". `not_refuted` and `inconclusive` assert NOTHING —
 * only `refuted` carries a claim, and only when the engine can PROVE unreachability
 * (e.g. no callgraph path, an override shadows the edited symbol).
 */

import type { TaskContext } from "./port"

/** A concrete edit the critic evaluates (the symbol/file the model is about to change). */
export interface EditTarget {
  readonly file: string
  readonly symbol?: string
}

/** 3-way verdict. NEVER collapse to boolean — `not_refuted !== confirmed`. */
export type RefuteResult =
  | { readonly verdict: "refuted"; readonly reason: string }
  | { readonly verdict: "not_refuted"; readonly reason?: string }
  | { readonly verdict: "inconclusive"; readonly reason: string }

export interface OwnerCritic {
  /** Try to REFUTE that `edited` is the true owner, using engine evidence
   *  (callgraph reachability / def-use). Proves-wrong ⇒ `refuted`. Cannot prove
   *  either way (incompleteness) ⇒ `inconclusive`. Reached-and-plausible but no
   *  proof ⇒ `not_refuted` (still NOT an endorsement). */
  refute(edited: EditTarget, ctx: TaskContext): Promise<RefuteResult>
}
