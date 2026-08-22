/**
 * jun-28 SOTA++ Phase-A — the SINGLE toggle seam (RFC §4.5 "배선 1지점").
 *
 * `maybeAcceptanceSelector` is the ONE gated decision point: the opt-in OFF ⇒
 * `undefined` ⇒ the repair orchestrator keeps its legacy validator-rank selection
 * (byte-identical default-OFF); ON ⇒ a `selectCandidates` port built from the
 * injected sandbox oracle runners. The driver computes this once at the repair
 * setup and spreads it into the orchestrator args — no acceptance condition is
 * sprinkled anywhere else.
 *
 * `buildSandboxAcceptanceOracles` is the thin bridge from PATCH→verdict runners
 * (the driver wires these to `withCandidatePatch` + the repro/regression executors)
 * to the candidate-shaped {@link AcceptanceOracles}. All sandbox I/O lives in the
 * injected runners, so both functions are hermetic + pure-compositional.
 */

import { buildAcceptanceSelector } from "./acceptance-adapter"
import type {
  AcceptanceLlmRerank,
  AcceptanceOracles,
  AcceptanceSelectionObserver,
} from "./acceptance-select"
import type { RepairCandidateOutcome } from "./repair/types"

/** Low-level sandbox runners (driver-supplied). Each applies the candidate patch to
 *  a fresh tree and runs one acceptance oracle. Both OPTIONAL — presence turns on
 *  the matching rerank guard. */
export interface SandboxAcceptanceDeps {
  /** Apply patch + run the reproduction test ⇒ did the issue RESOLVE (boolean). */
  readonly runReproOnPatch?: (patch: string) => Promise<boolean>
  /** Apply patch + run the selected regression set ⇒ COUNT of failed tests. */
  readonly runRegressionOnPatch?: (patch: string) => Promise<number>
}

/** Bridge patch-runners → candidate-shaped oracles (forwards `candidate.patch`). */
export const buildSandboxAcceptanceOracles = (deps: SandboxAcceptanceDeps): AcceptanceOracles => {
  const { runReproOnPatch, runRegressionOnPatch } = deps
  return {
    ...(runReproOnPatch !== undefined
      ? { runRepro: (c: { patch: string }) => runReproOnPatch(c.patch) }
      : {}),
    ...(runRegressionOnPatch !== undefined
      ? { runRegression: (c: { patch: string }) => runRegressionOnPatch(c.patch) }
      : {}),
  }
}

export interface AcceptanceWireDeps extends SandboxAcceptanceDeps {
  /** The `acceptance` opt-in (`benchOptIns().acceptance`). OFF ⇒ undefined selector. */
  readonly enabled: boolean
  /** Optional AST-canonical vote-key normalizer (defaults to trimmed raw patch). */
  readonly normalizePatch?: (patch: string) => string
  /** Optional LLM soft-reranker over the admissible survivors (chooser/reviewer).
   *  Absent ⇒ deterministic vote only (byte-identical). Fail-open / never-veto. */
  readonly llmRerank?: AcceptanceLlmRerank
  /** OBSERVE-ONLY tier-readout sink (operator selection telemetry). Absent ⇒ no
   *  telemetry (byte-identical); present ⇒ called per round with the winning tier. */
  readonly onSelection?: AcceptanceSelectionObserver
}

/**
 * The single toggle seam. OFF ⇒ `undefined` (legacy selection, byte-identical).
 * ON ⇒ the acceptance `selectCandidates` port (score-once + rerank) over the
 * sandbox oracles. With NEITHER runner the selector degrades to a pure patch
 * majority vote (still SOTA-shaped, never a per-round re-vote).
 */
export const maybeAcceptanceSelector = (
  deps: AcceptanceWireDeps,
):
  | ((candidates: readonly RepairCandidateOutcome[]) => Promise<RepairCandidateOutcome>)
  | undefined => {
  if (!deps.enabled) return undefined
  const oracles = buildSandboxAcceptanceOracles(deps)
  return buildAcceptanceSelector(oracles, deps.normalizePatch, deps.llmRerank, deps.onSelection)
}
