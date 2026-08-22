/**
 * T-302 — GateDecision: the bidirectional commit-vs-verify gate.
 *
 * PURE decision over CHEAP STRUCTURAL signals (not a free-form "verify vibe",
 * not same-model self-critique). Two directions, both evidenced by the easy-tail
 * RCA:
 *   • under-verify (5 model-misses shipped blind) → verify when stakes/uncertainty
 *   • over-verify  (#9296 looped on a trivial known answer) → commit early when
 *     the issue hands you the fix and stakes are low.
 *
 * `verify` only names EXTERNAL evidence sources (repro / structure / hygiene).
 * If nothing external is available to verify with, it does not loop — it commits.
 */

export interface GateSignals {
  stakes: {
    patchFileCount: number
    crossFile: boolean
    destructive: boolean
  }
  uncertainty: {
    sampleDisagreement: boolean
    unresolvedSymbols: boolean
  }
  signal: {
    reproAvailable: boolean
    lspAvailable: boolean
  }
  commitFast: {
    issueProvidesFix: boolean
    highConfidenceSingleOwner: boolean
  }
}

export type GateSource = "repro" | "structure" | "hygiene"

export type GateDecision =
  | { action: "commit-now"; reason: string }
  | { action: "verify"; sources: GateSource[]; reason: string }

const highStakes = (s: GateSignals): boolean =>
  s.stakes.crossFile || s.stakes.destructive || s.stakes.patchFileCount >= 2

const uncertain = (s: GateSignals): boolean =>
  s.uncertainty.sampleDisagreement || s.uncertainty.unresolvedSymbols

export const decideGate = (s: GateSignals): GateDecision => {
  // ── commit-fast (anti over-verify) ──────────────────────────────────────
  // A reproducing repro is an execution RAIL the closure engine deliberately
  // built (baseValidatedRed). Running it is ONE cheap confirmation — not an
  // exploration loop (repair caps rounds) — so it overrides BOTH commit-fast
  // shortcuts: skipping it would waste the very rail the closure-driven runner
  // exists to verify. (The single-owner branch already encoded this with
  // `&& !reproAvailable`; the issue-provides-fix branch must be consistent.)
  if (!highStakes(s) && !uncertain(s) && !s.signal.reproAvailable) {
    if (s.commitFast.issueProvidesFix) {
      return {
        action: "commit-now",
        reason:
          "issue supplies the fix, single-file low-stakes, no execution rail — commit without exploration loop",
      }
    }
    if (s.commitFast.highConfidenceSingleOwner) {
      return {
        action: "commit-now",
        reason: "high-confidence single owner, no cheap external signal to add — commit",
      }
    }
  }

  // ── verify (anti under-verify) — only EXTERNAL sources ───────────────────
  // Compute the EXTERNAL sources first (repro / structure). Hygiene is a free,
  // always-applicable diff fact, so it is NOT external: a verify that names ONLY
  // hygiene, with no stakes and no uncertainty, is not worth an exploration loop
  // and collapses to commit-now. Any external source — or any stakes/uncertainty
  // — makes the verify worthwhile, in which case hygiene rides along.
  const external: GateSource[] = []
  if (s.signal.reproAvailable) external.push("repro")
  if (s.signal.lspAvailable && (s.uncertainty.unresolvedSymbols || s.stakes.crossFile)) {
    external.push("structure")
  }

  if (external.length === 0 && !highStakes(s) && !uncertain(s)) {
    return {
      action: "commit-now",
      reason: "low-stakes, certain, no execution/structure signal — commit with hygiene check only",
    }
  }

  const sources: GateSource[] = [...external, "hygiene"]
  const why = highStakes(s)
    ? "high stakes"
    : uncertain(s)
      ? "uncertain localization"
      : "external signal available"
  return {
    action: "verify",
    sources,
    reason: `${why} — ground on [${sources.join(", ")}] before commit`,
  }
}
