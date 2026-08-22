/**
 * BFND-02 — the Terminal-Bench product builder.
 *
 * Terminal-Bench is a benchmark SUITE, not a fourth SWE dataset family. Its run
 * artifact is therefore its own branch of {@link CanonicalBenchReport}: explicit
 * identity (suite + version + pinned dataset ref), lossless per-trial Harbor
 * receipts, and precomputed official-shaped metrics — persisted through the SAME
 * canonical writer as a SWE report.
 *
 * This module owns ONLY the envelope assembly. Reading the Harbor result tree and
 * deduping relaunches of the same task stay with the Harbor-facing tool; what
 * arrives here is already the run's final trial set, and it is preserved verbatim.
 */
import type {
  TerminalBenchReport,
  TerminalBenchVersion,
  TerminalTrialReceipt,
} from "./report-envelope"
import { TERMINAL_BENCH_VERSION } from "./report-envelope"

/** One graded Harbor trial as handed to the builder. */
export interface TerminalTrialInput {
  readonly id: string
  readonly passed: boolean
  readonly durationMs: number
  /** Harbor's reward tree carries no turn count (trajectory-only) ⇒ 0. */
  readonly turns?: number
  readonly error?: { readonly kind: "agent-timeout" | "agent-crash" }
}

export interface TerminalBenchReportMeta {
  /** The pinned Harbor dataset ref. REQUIRED: identity is never inferred. */
  readonly datasetRef: string
  readonly timestamp: string
  /** Never fabricated — an unknown model stays undefined (P3-A). */
  readonly model: string | undefined
  readonly preset: string
  readonly arm?: "baseline" | "levers"
  /** Provenance of the verdicts. Defaults to the Harbor grader. */
  readonly source?: string
}

const DEFAULT_SOURCE = "terminal-bench-harbor"

/**
 * OFFICIAL-shaped denominator: EVERY trial counts, and a trial that did not earn
 * a reward is a miss — crashes included.
 *
 * This deliberately does NOT apply quanta's internal D1 convention (RFC jul-3),
 * which drops an agent-CRASH as a "re-runnable measurement hole". D1 is a
 * defensible *diagnostic* — an auth death is not a capability miss — but it is
 * not what the field is called and not what the dashboard headline claims.
 * Upstream Terminal-Bench 2.1 is unambiguous, and it was verified against the
 * pinned `leaderboard/src/leaderboard/core/metrics.py` executed as a live oracle
 * (TB21-04): a trial with no reward is `is_success(null) === false`, i.e. it
 * scores zero and STAYS in the denominator. The ticket states the same rule as
 * non-negotiable — "errored trials carry reward 0; they are not removed from the
 * denominator. Diagnostic taxonomy does not authorize denominator removal."
 *
 * Excluding crashes here inflated the headline: a run that crashed on half its
 * tasks reported the accuracy of the half that survived. That is the same
 * false-receipt shape as reporting a reasoning effort the provider never got.
 *
 * NOTHING is lost by this: `perInstance[].error.kind` is persisted on every
 * receipt, so a consumer that wants the D1 infra-hole view can derive it from
 * the taxonomy — which is exactly the ticket's split between a diagnostic and a
 * denominator.
 */
const officialShapedTotals = (
  trials: readonly TerminalTrialInput[],
): TerminalBenchReport["totals"] => {
  const resolved = trials.filter((trial) => trial.passed).length
  const total = trials.length
  return { total, resolved, resolvedPct: total === 0 ? 0 : Math.round((resolved / total) * 100) }
}

const toReceipt = (trial: TerminalTrialInput): TerminalTrialReceipt => ({
  id: trial.id,
  passed: trial.passed,
  turns: trial.turns ?? 0,
  durationMs: trial.durationMs,
  ...(trial.error !== undefined ? { error: trial.error } : {}),
})

/**
 * Build the canonical Terminal-Bench run report. Pure and deterministic given a
 * fixed timestamp. Fails closed on a missing dataset ref — a report that cannot
 * say WHICH dataset produced its rewards must not exist.
 */
export const buildTerminalBenchReport = (
  trials: readonly TerminalTrialInput[],
  meta: TerminalBenchReportMeta,
): TerminalBenchReport => {
  if (meta.datasetRef.trim() === "") {
    throw new Error(
      "terminal-bench report requires an explicit datasetRef — identity is never inferred or fabricated",
    )
  }
  const benchmarkVersion: TerminalBenchVersion = TERMINAL_BENCH_VERSION
  return {
    benchmarkSuite: "terminal-bench",
    benchmarkVersion,
    datasetRef: meta.datasetRef,
    timestamp: meta.timestamp,
    model: meta.model,
    source: meta.source ?? DEFAULT_SOURCE,
    ...(meta.arm !== undefined ? { arm: meta.arm } : {}),
    knobs: { preset: meta.preset, resolved: {}, inactive: [] },
    totals: officialShapedTotals(trials),
    perInstance: trials.map(toReceipt),
  }
}
