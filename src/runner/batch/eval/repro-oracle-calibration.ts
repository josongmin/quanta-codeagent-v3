/**
 * Repro-oracle gold calibration (verify-and-select — the false-NEGATIVE guard).
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

const UNAVAILABLE: ReproOracleCalibration = {
  goldCalibrated: false,
  falseNegative: false,
  available: false,
  goldVotes: null,
  goldK: null,
}

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
}): Promise<ReproOracleCalibration> => {
  if (args.goldPatch === undefined || args.goldPatch.trim() === "") return UNAVAILABLE
  // Wrap the probe so a `null` verdict (no decisive repro outcome) is
  // distinguishable from "gold did not apply" (withCandidatePatch → null).
  const wrapped = await withCandidatePatch({
    sandbox: args.sandbox,
    patch: args.goldPatch,
    baseCommit: args.baseCommit,
    timeoutMs: args.timeoutMs,
    probe: async (sb) => {
      try {
        return { verdict: await args.resolvedProbe(sb) }
      } catch {
        return { verdict: null } // a thrown probe vouches for nothing on gold
      }
    },
  })
  if (wrapped === null) return UNAVAILABLE // gold did not materialize → no claim
  const verdict = wrapped.verdict
  const goldCalibrated = verdict !== null && verdict.votes >= verdict.k
  return {
    goldCalibrated,
    // Gold applied but the oracle did not confirm resolution on a known-correct
    // fix ⇒ confirmed false negative (untrustworthy for rejecting candidates).
    falseNegative: !goldCalibrated,
    available: true,
    goldVotes: verdict?.votes ?? null,
    goldK: verdict?.k ?? null,
  }
}
