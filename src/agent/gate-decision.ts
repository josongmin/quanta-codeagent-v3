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
  if (!highStakes(s) && !uncertain(s)) {
    if (s.commitFast.issueProvidesFix) {
      return { action: "commit-now", reason: "issue supplies the fix, single-file low-stakes — commit without exploration loop" }
    }
    if (s.commitFast.highConfidenceSingleOwner && !s.signal.reproAvailable) {
      return { action: "commit-now", reason: "high-confidence single owner, no cheap external signal to add — commit" }
    }
  }

  // ── verify (anti under-verify) — only EXTERNAL sources ───────────────────
  const sources: GateSource[] = []
  if (s.signal.reproAvailable) sources.push("repro")
  if (s.signal.lspAvailable && (s.uncertainty.unresolvedSymbols || s.stakes.crossFile)) {
    sources.push("structure")
  }
  sources.push("hygiene") // free + deterministic diff facts always apply

  // a verify with only hygiene and no stakes/uncertainty is not worth a loop
  if (sources.length === 1 && !highStakes(s) && !uncertain(s)) {
    return { action: "commit-now", reason: "low-stakes, certain, no execution/structure signal — commit with hygiene check only" }
  }

  const why = highStakes(s) ? "high stakes" : uncertain(s) ? "uncertain localization" : "external signal available"
  return { action: "verify", sources, reason: `${why} — ground on [${sources.join(", ")}] before commit` }
}
