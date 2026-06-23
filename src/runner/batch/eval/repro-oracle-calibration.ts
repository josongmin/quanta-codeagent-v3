/**
 * Repro-oracle gold calibration (verify-and-select — the false-NEGATIVE guard).
 *
 * ⚠️ CLASSIFICATION — EVAL-ONLY DIAGNOSTIC, *not* a production solving capability.
 * It needs the dataset GOLD patch as ground truth; live tasks have no gold, so this
 * gate is inert outside the bench (returns `UNAVAILABLE`). Its job is to (a) MEASURE
 * the repro oracle's per-instance false-negative rate and (b) stop a proven-broken
 * oracle from DISCARDING a correct candidate on the leaderboard. It does NOT make
 * quanta solve more real issues — it de-noises the bench score + tells you whether
 * the production lever is "fix the oracle" vs "improve the agent".
 *
 * ── The problem this measures + mitigates ────────────────────────────────────
 * The patched-resolved oracle (re-run the reproducing repro set on a candidate's
 * tree, majority-vote "Issue resolved") is the signal that decides "did this
 * candidate actually FIX it?". It is a NOISY oracle: a CORRECT fix can print
 * output the repro classifies as still-reproduced / other-error, so the oracle
 * says "not resolved" on a genuinely-correct patch — a FALSE NEGATIVE that makes
 * the resolved gate REJECT a correct candidate. Convergent measurement
 * (jun-20: 75–79% of our failures are "right place, wrong/unrecognized fix")
 * puts this oracle's reliability — not regression-gating — at the bottleneck.
 *
 * ── The calibration ──────────────────────────────────────────────────────────
 * Ground-truth the noisy oracle: run the SAME resolved-probe on the GOLD-patched
 * tree (the reference patch DEFINITELY resolves the issue). If the probe does
 * NOT report resolved on gold, the oracle is a CONFIRMED false negative for this
 * instance — its verdict on candidate patches is untrustworthy.
 *
 * North-star ("no single noisy oracle holds global verdict authority"): a
 * resolved gate built on a `falseNegative` oracle MUST fail-open (never reject a
 * candidate on that oracle), and the per-instance `falseNegative` rate is the
 * direct readout of the oracle's correctness — the thing to drive down.
 *
 * ⚠️ ASYMMETRIC LIMITATION: failing open only stops the oracle from DISCARDING a
 * correct candidate — it gives NO positive selection signal. With `resolvedKofN`
 * nulled, selection degrades to the weak `minimality`+`ownerCoverage` soft scores,
 * so the right candidate can still lose to a wrong sibling. "Don't discard the
 * correct fix" ≠ "pick the correct fix". This guard removes a false-RED; it does
 * NOT add a true-GREEN.
 *
 * ── Composition (zero coupling) ──────────────────────────────────────────────
 * The resolved-probe is INJECTED (`(sandbox) => {votes,k}|null`) — exactly the
 * shape {@link makePatchedResolvedConsensus} produces — so this module composes
 * with the patched-resolved gate without importing it. Gold materialization
 * reuses {@link withCandidatePatch} (reset → apply gold → probe → reset).
 * EVAL-ONLY: `goldPatch` is the dataset reference patch, the same eval-only
 * boundary the closure oracle's gold files use — never handed to the agent loop.
 */

import type { ReproOracleCalibration } from "../types"
import { withCandidatePatch } from "./rematerialize"

export type { ReproOracleCalibration }

const UNAVAILABLE_REPRO_ORACLE_CALIBRATION: Readonly<ReproOracleCalibration> = {
  goldCalibrated: false,
  falseNegative: false,
  available: false,
  goldVotes: null,
  goldK: null,
  baseResolved: false,
  vacuous: false,
  baseVotes: null,
  baseK: null,
}

export const unavailableReproOracleCalibration = (): ReproOracleCalibration => ({
  ...UNAVAILABLE_REPRO_ORACLE_CALIBRATION,
})

/**
 * Calibrate a patched-resolved oracle against the gold patch. Returns
 * {@link UNAVAILABLE} (no claim) when gold is absent or does not apply; otherwise
 * `goldCalibrated`/`falseNegative` reflect whether the probe recognized the
 * known-correct fix. Never throws — a thrown probe is treated as "no verdict on
 * gold" ⇒ `falseNegative` (the oracle could not vouch for a correct fix).
 */
export const calibrateReproOracle = async (args: {
  /** The patched-resolved probe under test (e.g. makePatchedResolvedConsensus). */
  resolvedProbe: (sandbox: string) => Promise<{ votes: number; k: number } | null>
  /** Dataset reference patch (EVAL-ONLY). Absent/empty ⇒ unavailable. */
  goldPatch: string | undefined
  sandbox: string
  baseCommit: string | undefined
  timeoutMs: number
  /** SWE-bench `owner/name` slug. Forwarded into `withCandidatePatch` so the
   *  GOLD-patched probe builds under the SAME P0 build-env materialization the
   *  candidate proof exec uses (e.g. astropy's `extension-helpers`) — otherwise
   *  gold itself would fail to build and the oracle would read as a spurious
   *  false-negative. Undefined ⇒ no materialization (byte-identical). */
  repo?: string
}): Promise<ReproOracleCalibration> => {
  if (args.goldPatch === undefined || args.goldPatch.trim() === "") {
    return unavailableReproOracleCalibration()
  }
  // P3 metamorphic non-vacuity: probe the canonical oracle on the BASE (un-patched)
  // tree FIRST. The sandbox arrives at base (calibration runs before candidate gen,
  // and leaves it at base). A SOUND oracle reports NOT-resolved here (the repro is
  // RED — it reproduces the bug). If it reports RESOLVED on base, its "green" is
  // meaningless (it would false-GREEN any candidate) ⇒ VACUOUS. Never throws —
  // a thrown base probe vouches for nothing (treated as not-resolved, not vacuous).
  let baseVerdict: { votes: number; k: number } | null = null
  try {
    baseVerdict = await args.resolvedProbe(args.sandbox)
  } catch {
    baseVerdict = null
  }
  const baseResolved =
    baseVerdict !== null && baseVerdict.k >= 1 && baseVerdict.votes >= baseVerdict.k
  // Wrap the probe so a `null` verdict (no decisive repro outcome) is
  // distinguishable from "gold did not apply" (withCandidatePatch → null).
  // "Never throws" contract (adversarial audit jun-20): the probe's own try/catch
  // only covers `resolvedProbe`. `withCandidatePatch` ITSELF can throw OUTSIDE it —
  // `Bun.write` (ENOSPC / read-only sandbox on a giant goldPatch), the bash
  // `Bun.spawn` (missing `bash`), or the `finally` resetToBase. Catch the whole
  // materialize+probe so a thrown calibration degrades to UNAVAILABLE (no claim)
  // instead of killing the instance with a harness-level error.
  let wrapped: { verdict: { votes: number; k: number } | null } | null
  try {
    wrapped = await withCandidatePatch({
      sandbox: args.sandbox,
      patch: args.goldPatch,
      baseCommit: args.baseCommit,
      timeoutMs: args.timeoutMs,
      ...(args.repo !== undefined ? { repo: args.repo } : {}),
      probe: async (sb) => {
        try {
          return { verdict: await args.resolvedProbe(sb) }
        } catch {
          return { verdict: null } // a thrown probe vouches for nothing on gold
        }
      },
    })
  } catch {
    return unavailableReproOracleCalibration() // materialize/reset threw ⇒ no calibration claim
  }
  if (wrapped === null) return unavailableReproOracleCalibration() // gold did not materialize → no claim
  const verdict = wrapped.verdict
  // `k >= 1` guard: a degenerate `{votes:0, k:0}` verdict must NOT read as
  // calibrated (`0 >= 0`). The production probe guarantees `k >= 1` (vote.ts), but
  // the injected-probe contract is type-only — defend it here so a `{0,0}` verdict
  // can't false-positive into goldCalibrated.
  const goldCalibrated = verdict !== null && verdict.k >= 1 && verdict.votes >= verdict.k
  return {
    goldCalibrated,
    // Gold applied but the oracle did not confirm resolution on a known-correct
    // fix ⇒ confirmed false negative (untrustworthy for rejecting candidates).
    falseNegative: !goldCalibrated,
    available: true,
    goldVotes: verdict?.votes ?? null,
    goldK: verdict?.k ?? null,
    // P3 non-vacuity: RESOLVED on the un-patched base ⇒ vacuous (meaningless green).
    baseResolved,
    vacuous: baseResolved,
    baseVotes: baseVerdict?.votes ?? null,
    baseK: baseVerdict?.k ?? null,
  }
}
