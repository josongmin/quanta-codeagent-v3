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

import {
  type RerankCandidate,
  type RerankResult,
  rerankSelect,
  selectAdmissible,
} from "./acceptance-rerank"
import type { CandidateLocationFocus } from "./location-set-fanout"

export interface AcceptanceCandidate {
  /** The patch we would submit if this candidate wins. */
  readonly patch: string
  /** Normalized vote key (AST-canonical upstream; raw patch an acceptable fallback). */
  readonly patchKey: string
  /** Optional structural tie-break priority carried from the breadth candidate.
   *  Higher is better; used only when vote counts tie. */
  readonly structuralPriority?: number
  /** jun-30 SOTA++ per-candidate execution evidence for the LLM soft-reranker
   *  (optional). The agent's last verification command. Absent ⇒ not forwarded. */
  readonly verifyCmd?: string
  /** REDACTED tail of this candidate's validator failure output (already passed
   *  through {@link redactReviewerEvidence} by the adapter — this orchestrator
   *  only forwards it). Absent ⇒ not forwarded. */
  readonly failureOutput?: string
  /** REDACTED agent action trace (already bounded+redacted by the adapter — this
   *  orchestrator only forwards it). Absent ⇒ not forwarded. */
  readonly actionSummary?: string
  /** Typed lead-file/lead-symbol focus this candidate was seeded from. Optional:
   *  only breadth-location fanout candidates carry it. */
  readonly locationFocus?: CandidateLocationFocus
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
  /** jun-30 SOTA++ per-candidate execution evidence, carried through from the
   *  input candidate so the LLM soft-reranker can see it. Optional. */
  readonly verifyCmd?: string
  /** REDACTED failure-output tail (see {@link AcceptanceCandidate.failureOutput}). */
  readonly failureOutput?: string
  /** REDACTED agent action trace (see {@link AcceptanceCandidate.actionSummary}). */
  readonly actionSummary?: string
  /** Typed candidate-local breadth focus (lead file / symbol), if any. */
  readonly locationFocus?: CandidateLocationFocus
}

export interface AcceptanceResult {
  readonly selected: RerankResult
  /** Per-candidate verdicts (score-once), in input order — for report / RCA. */
  readonly scored: readonly AcceptanceScored[]
  /** Set when an injected LLM soft-reranker overrode the deterministic vote winner
   *  (the chosen `index` into `scored`). Absent ⇒ deterministic selection stood. */
  readonly llmChosenIndex?: number
}

/**
 * jun-30 SOTA++ — OBSERVE-ONLY selection telemetry for the operator readout. The
 * single fact that tells whether the acceptance ladder did real work: `tier`. On a
 * thin oracle (F2P median 1) a `regression_only`/`repro_and_regression` tier means
 * an oracle actually filtered candidates; `all_patches` means the ladder fell
 * through to a pure majority vote (NO real selection — the synthesis arm is inert
 * for that round). Carries no patch content (no-leak). Emitted via an injected
 * callback so the deterministic selection path is never perturbed.
 */
export interface AcceptanceSelectionTelemetry {
  /** Which rerank tier produced the winner. */
  readonly tier: RerankResult["tier"]
  /** The winning patch's vote count. */
  readonly votes: number
  /** How many candidates the selector scored this round. */
  readonly candidateCount: number
  /** True iff an injected LLM soft-rerank overrode the deterministic winner. */
  readonly llmOverrode: boolean
}

/** OBSERVE-ONLY sink for {@link AcceptanceSelectionTelemetry}. Wrapped in a swallow
 *  at the call site (a telemetry write must never sink a repair round). */
export type AcceptanceSelectionObserver = (t: AcceptanceSelectionTelemetry) => void

/**
 * Optional LLM soft-reranker. Given the ADMISSIBLE scored candidates (the tier
 * survivors — never the full pool, so it cannot resurrect an inadmissible patch),
 * returns the chosen candidate's `index` (into the full `scored` array) or null to
 * keep the deterministic vote winner. FAIL-OPEN: null / throw ⇒ deterministic.
 */
export type AcceptanceLlmRerank = (
  admissible: readonly AcceptanceScored[],
) => Promise<number | null>

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
  llmRerank?: AcceptanceLlmRerank,
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
      ...(candidate.structuralPriority !== undefined
        ? { structuralPriority: candidate.structuralPriority }
        : {}),
      reproPass,
      regressionFailures,
      ...(candidate.verifyCmd !== undefined ? { verifyCmd: candidate.verifyCmd } : {}),
      ...(candidate.failureOutput !== undefined ? { failureOutput: candidate.failureOutput } : {}),
      ...(candidate.actionSummary !== undefined ? { actionSummary: candidate.actionSummary } : {}),
      ...(candidate.locationFocus !== undefined ? { locationFocus: candidate.locationFocus } : {}),
    })
    index += 1
  }
  const opts = {
    regression: oracles.runRegression !== undefined,
    reproduction: oracles.runRepro !== undefined,
  }
  const selected = rerankSelect(scored, opts)

  // Optional LLM soft-rerank over the ADMISSIBLE survivors only (never-veto). Runs
  // only with ≥2 admissible candidates (a single survivor has nothing to choose).
  // FAIL-OPEN: a null / out-of-set / thrown result keeps the deterministic winner.
  if (llmRerank !== undefined && selected.tier !== "none") {
    const admissibleIds = selectAdmissible(scored, opts).ids
    if (admissibleIds.length >= 2) {
      const admissible = admissibleIds.map((i) => scored[i] as AcceptanceScored)
      const admissibleSet = new Set(admissibleIds)
      let chosen: number | null = null
      try {
        chosen = await llmRerank(admissible)
      } catch {
        chosen = null
      }
      if (chosen !== null && admissibleSet.has(chosen)) {
        const winner = scored[chosen] as AcceptanceScored
        // `votes` reports the chosen patch's OWN vote count (candidates sharing its
        // patchKey), not the deterministic winner's — so the result stays honest
        // about what was submitted. `llmChosenIndex` flags that the LLM overrode.
        const votes = scored.filter((s) => s.patchKey === winner.patchKey).length
        return {
          selected: { patch: winner.patch, tier: selected.tier, votes },
          scored,
          llmChosenIndex: chosen,
        }
      }
    }
  }
  return { selected, scored }
}
