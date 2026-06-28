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
    // never called empty by the orchestrator (it guards length); stay NPE-safe.
    if (candidates.length === 0) return candidates[0] as RepairCandidateOutcome
    const accCandidates = candidates.map((c) => ({
      patch: c.run.patch,
      patchKey: normalizePatch(c.run.patch),
    }))
    const { selected } = await selectByAcceptance(accCandidates, oracles)
    // map the winning patch back to its outcome (first match — same patch ⇒ same
    // tree); fall back to the first candidate on a degenerate empty selection.
    const winner = candidates.find((c) => c.run.patch === selected.patch)
    return winner ?? (candidates[0] as RepairCandidateOutcome)
  }
}
