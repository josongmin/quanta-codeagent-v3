/**
 * jun-28 SOTA++ Phase-A — acceptance selector ADAPTER.
 *
 * Bridges the orchestrator's `RepairCandidateOutcome[]` to the acceptance world:
 * maps each candidate's cumulative patch into an AcceptanceCandidate, scores ONCE
 * via the injected oracles, rerank-selects, and maps the winner BACK to its
 * `RepairCandidateOutcome` (so the orchestrator can `.adopt()` it). The returned
 * function IS the `selectCandidates` port the driver injects behind the
 * `acceptance` opt-in — keeping the orchestrator fenced (it never runs the oracle).
 *
 * `acceptance-adapter` lives in the eval slice (NOT the fenced repair slice), so it
 * may import `repair/types` (RepairCandidateOutcome) and the acceptance orchestrator.
 * Pure-compositional: all I/O is in the injected oracles.
 */

import { type AcceptanceOracles, selectByAcceptance } from "./acceptance-select"
import type { RepairCandidateOutcome } from "./repair/types"

/** Default vote key: the trimmed raw patch (Agentless `deduplicate=off`). The
 *  driver may inject an AST-canonical normalizer for stronger dedup. */
const trimKey = (patch: string): string => patch.trim()

/**
 * Build the `selectCandidates` port from acceptance oracles. The winner is chosen
 * by score-once + rerank (Agentless-faithful) over the candidates' cumulative
 * patches, then mapped back to the owning `RepairCandidateOutcome`.
 */
export const buildAcceptanceSelector = (
  oracles: AcceptanceOracles,
  normalizePatch: (patch: string) => string = trimKey,
): ((candidates: readonly RepairCandidateOutcome[]) => Promise<RepairCandidateOutcome>) => {
  return async (candidates) => {
    // The orchestrator guards `candidates.length > 0` before calling this port, so
    // an empty list is a contract violation — throw loudly rather than return a
    // cast-masked `undefined` that would NPE later at `winner.adopt()`.
    if (candidates.length === 0) {
      throw new Error("buildAcceptanceSelector: empty candidate list")
    }
    const accCandidates = candidates.map((c) => ({
      patch: c.run.patch,
      patchKey: normalizePatch(c.run.patch),
    }))
    const { selected } = await selectByAcceptance(accCandidates, oracles)
    // Map the winning patch back to its outcome. Distinct candidates with the SAME
    // patch are equivalent (adopt re-applies the diff ⇒ identical tree; deterministic
    // validation ⇒ identical verdict), so the first match is correct. `selected.patch`
    // is always one of the inputs unless tier === "none" (all empty) ⇒ first candidate.
    const winner = candidates.find((c) => c.run.patch === selected.patch)
    return winner ?? (candidates[0] as RepairCandidateOutcome)
  }
}
