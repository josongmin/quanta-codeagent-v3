/**
 * Phase A — acceptance orchestrator (SOTA++ keystone seam).
 *
 * Composes the pure cores — `acceptance-rerank` (patch vote + 3-tier fallback
 * ladder) and the per-candidate acceptance ORACLES — into the ONE gated seam the
 * driver calls when the Phase-A opt-in is on. The oracles are injected ports
 * (production wires them to the sandbox repro/regression runners; tests use
 * fakes), so this orchestrator is hermetic-by-injection and the AVAILABLE oracles
 * decide the rerank mode:
 *   runRepro + runRegression ⇒ dual-guard
 *   runRepro only            ⇒ repro-only
 *   neither                  ⇒ pure patch majority (tier 3)
 *
 * Each candidate is scored EXACTLY ONCE (the anti-pattern this replaces re-voted
 * the whole repro set every repair round). `scored[]` carries the per-candidate
 * verdicts so the report / A1 artifacts can explain why a candidate won or lost.
 *
 * Toggle discipline: this is the SINGLE non-pure export of the Phase-A path. It
 * runs only when the driver's selection seam routes here behind the opt-in; off ⇒
 * never called ⇒ no repro/regression exec ⇒ byte-identical. No hidden field read.
 */

import { type RerankCandidate, type RerankResult, rerankSelect } from "./acceptance-rerank"

export interface AcceptanceCandidate {
  /** The patch we would submit if this candidate wins. */
  readonly patch: string
  /** Normalized vote key (AST-canonical upstream; raw patch an acceptable fallback). */
  readonly patchKey: string
}

/** Injected acceptance oracles. Each is OPTIONAL — its presence turns on the
 *  corresponding rerank guard. Both run against the candidate's PATCHED tree. */
export interface AcceptanceOracles {
  /** Reproduction test on the patched tree → did the issue resolve. */
  readonly runRepro?: (candidate: AcceptanceCandidate) => Promise<boolean>
  /** Selected regression set on the patched tree → COUNT of failed tests. */
  readonly runRegression?: (candidate: AcceptanceCandidate) => Promise<number>
}

export interface AcceptanceScored extends RerankCandidate {
  /** Position in the input candidate list (stable join key for telemetry). */
  readonly index: number
}

export interface AcceptanceResult {
  readonly selected: RerankResult
  /** Per-candidate verdicts (score-once), in input order — for report / RCA. */
  readonly scored: readonly AcceptanceScored[]
}

/**
 * Score each candidate ONCE through the available oracles, then select via the
 * Agentless-faithful rerank ladder. Sequential await keeps it deterministic; a
 * batching oracle port may parallelise internally.
 */
/** DEGRADE-don't-abort: a single candidate's oracle failure (sandbox crash /
 *  timeout) must NOT reject the whole selection — that would crash the repair round
 *  on one flaky fork, where the legacy validator-rank selector never throws. A
 *  thrown repro ⇒ `false` (didn't resolve); a thrown regression ⇒ `+Infinity`
 *  failures (loses the min-regression bar). The candidate simply loses. */
const safeRepro = async (
  run: NonNullable<AcceptanceOracles["runRepro"]> | undefined,
  c: AcceptanceCandidate,
): Promise<boolean> => {
  if (run === undefined) return false
  try {
    return await run(c)
  } catch {
    return false
  }
}
const safeRegression = async (
  run: NonNullable<AcceptanceOracles["runRegression"]> | undefined,
  c: AcceptanceCandidate,
): Promise<number> => {
  if (run === undefined) return 0
  try {
    return await run(c)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export const selectByAcceptance = async (
  candidates: readonly AcceptanceCandidate[],
  oracles: AcceptanceOracles,
): Promise<AcceptanceResult> => {
  const scored: AcceptanceScored[] = []
  let index = 0
  for (const candidate of candidates) {
    const reproPass = await safeRepro(oracles.runRepro, candidate)
    const regressionFailures = await safeRegression(oracles.runRegression, candidate)
    scored.push({
      index,
      patch: candidate.patch,
      patchKey: candidate.patchKey,
      reproPass,
      regressionFailures,
    })
    index += 1
  }
  const selected = rerankSelect(scored, {
    regression: oracles.runRegression !== undefined,
    reproduction: oracles.runRepro !== undefined,
  })
  return { selected, scored }
}
