/**
 * Observation kernel — the pure OwnerCritic (jul-6, Stream S1).
 * Design SSOT: docs/plans/jul-6-observation-providers/README.md §5.
 *
 * `makeOwnerCritic(refuter)` maps ENGINE FACTS (`GraphFacts` from an
 * `OwnerRefuter`) to the 3-way `RefuteResult`. It is a pure leaf: no @/llm, no
 * @/tool, no IO, no env reads. The only side-channel is the injected refuter,
 * which is itself a deterministic seam.
 *
 * HARD invariants (audit — tests pin all of these):
 *   1. 3-WAY only. `not_refuted` and `inconclusive` assert NOTHING. ONLY
 *      `refuted` carries a claim. A "could not refute" NEVER reads as "confirmed".
 *   2. `refuted` ONLY when the engine can PROVE wrongness: no callgraph path to
 *      the edited symbol, OR an override shadows it so the edited one never runs.
 *   3. Static INCOMPLETENESS (dynamic dispatch / reflection) ⇒ `inconclusive`,
 *      DOMINATING a would-be `refuted`. A static "no path" is only a proof when
 *      the engine had full visibility; otherwise a dynamic path may exist.
 *   4. NO facts for the target ⇒ `inconclusive` (absence of evidence claims
 *      nothing — never silently coerced to `not_refuted`).
 *
 * Reason phrasing (overtrust guard): `not_refuted`/`inconclusive` reasons state
 * ONLY what the engine could not do — never that the edit is confirmed/correct.
 */

import type { EditTarget, OwnerCritic, RefuteResult } from "../critic"
import type { TaskContext } from "../port"
import type { GraphFacts, OwnerRefuter } from "./refuter"

/**
 * Map one target's engine facts to a 3-way verdict. Pure; the ONLY producer of
 * `RefuteResult` in this module, so the invariant ordering lives in one place.
 *
 * Precedence (invariant 3 first — it VOIDS proofs):
 *   incomplete → inconclusive  (a would-be proof is not a proof without full visibility)
 *   shadowed   → refuted       (override runs instead ⇒ edited symbol never runs)
 *   !reachable → refuted       (no callgraph path ⇒ edited symbol never runs)
 *   otherwise  → not_refuted   (reached & plausible, but NOT an endorsement)
 */
const classify = (facts: GraphFacts): RefuteResult => {
  if (!facts.staticallyComplete) {
    const reasons = facts.incompletenessReasons ?? []
    const detail = reasons.length > 0 ? reasons.join(", ") : "static analysis incomplete"
    // NOTE: states only the engine's blind spot; asserts nothing about the edit.
    return {
      verdict: "inconclusive",
      reason: `static analysis is incomplete (${detail}); cannot prove or disprove this owner`,
    }
  }
  if (facts.shadowedByOverride) {
    const shadow = facts.shadowingSymbol ?? "an override"
    return {
      verdict: "refuted",
      reason: `edited symbol is shadowed by override ${shadow}, so it never runs on the reachable path`,
    }
  }
  if (!facts.reachableFromEntrypoints) {
    return {
      verdict: "refuted",
      reason: "no callgraph path reaches the edited symbol from any known entrypoint",
    }
  }
  // Reached, no shadow, full visibility: the engine could not refute — this is
  // merely the absence of a disproof, not a claim that the edit is right.
  return {
    verdict: "not_refuted",
    reason:
      "engine found no proof the edited symbol is wrong; absence of a disproof only — verify before editing",
  }
}

/**
 * Build a pure critic from an engine adapter. `refute` queries the refuter and
 * classifies; a `null` (no facts) query ⇒ `inconclusive` (invariant 4).
 */
export const makeOwnerCritic = (refuter: OwnerRefuter): OwnerCritic => ({
  refute: async (edited: EditTarget, ctx: TaskContext): Promise<RefuteResult> => {
    const facts = await refuter.query(edited, ctx)
    if (facts === null) {
      return {
        verdict: "inconclusive",
        reason: "no static facts available for the edited symbol; nothing proved either way",
      }
    }
    return classify(facts)
  },
})
