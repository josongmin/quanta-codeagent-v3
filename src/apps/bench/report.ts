/**
 * Baseline tracking artifact.
 *
 * A tiny, pure machine-readable report built from `InstanceResult[]` plus
 * run metadata. It is NOT official grading (that requires the Docker
 * harness — see swebench-dataset.ts): `resolved` here reflects the local
 * `testCmd` outcome, which is a no-op for the official-dataset path. The
 * report exists to track baseline runs over time alongside the official
 * `predictions.jsonl`.
 */
import {
  aggregate,
  classify,
  type FailureBreakdown,
  type FailureClassification,
} from "./failure-classifier"
import { resolvedTotals } from "./observe"
import type { InstanceResult } from "./types"

export interface BenchReportMeta {
  model: string
  provider: string
}

export interface PerInstanceReport {
  id: string
  passed: boolean
  turns: number
  patchBytes: number
  error?: string
  /** Structured failure classification. Omitted for passing runs. */
  failure?: FailureClassification
}

export interface BenchReport {
  timestamp: string
  model: string
  provider: string
  n: number
  totals: {
    total: number
    resolved: number
    resolvedPct: number
  }
  /** Aggregated failure counts across results. `byTermination` is a covering
   *  partition; `bySignal` is non-exclusive (one failure can carry multiple
<<<<<<< Updated upstream
   *  signals). Empty objects when 0/n failed. */
=======
   *  signals). Both are emitted in every report; empty objects when 0/n
   *  failed. */
>>>>>>> Stashed changes
  failureBreakdown: FailureBreakdown
  perInstance: PerInstanceReport[]
}

/** Build the report object from results + meta. Pure & deterministic given a
 *  fixed `timestamp` (defaults to now). */
export const buildReport = (
  meta: BenchReportMeta & { n: number; timestamp?: string },
  results: InstanceResult[],
): BenchReport => {
  // C8: degraded-excluding denominator — the SAME source as observe.summarize
  // / summary.json. Never count a strict-degraded instance here.
  const { resolved, total } = resolvedTotals(results)
  const classifications = results.map((r) => classify(r))
<<<<<<< Updated upstream
  const failed = classifications.filter((c) => c.termination !== "passed")
=======
  const failedClassifications = classifications.filter((c) => c.termination !== "passed")
>>>>>>> Stashed changes
  return {
    timestamp: meta.timestamp ?? new Date().toISOString(),
    model: meta.model,
    provider: meta.provider,
    n: meta.n,
    totals: {
      total,
      resolved,
      resolvedPct: total === 0 ? 0 : Math.round((resolved / total) * 100),
    },
<<<<<<< Updated upstream
    failureBreakdown: aggregate(failed),
=======
    failureBreakdown: aggregate(failedClassifications),
>>>>>>> Stashed changes
    perInstance: results.map((r, i) => {
      const c = classifications[i] ?? { termination: "unknown", signals: [] }
      return {
        id: r.id,
        passed: r.passed,
        turns: r.turns,
        patchBytes: Buffer.byteLength(r.patch, "utf8"),
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(c.termination !== "passed" ? { failure: c } : {}),
      }
    }),
  }
}

/** Write the report as pretty JSON (trailing newline). */
export const writeReport = async (file: string, report: BenchReport): Promise<void> => {
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`)
}
