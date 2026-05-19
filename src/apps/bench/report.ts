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
  perInstance: PerInstanceReport[]
}

/** Build the report object from results + meta. Pure & deterministic given a
 *  fixed `timestamp` (defaults to now). */
export const buildReport = (
  meta: BenchReportMeta & { n: number; timestamp?: string },
  results: InstanceResult[],
): BenchReport => {
  const total = results.length
  const resolved = results.filter((r) => r.passed).length
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
    perInstance: results.map((r) => ({
      id: r.id,
      passed: r.passed,
      turns: r.turns,
      patchBytes: Buffer.byteLength(r.patch, "utf8"),
      ...(r.error !== undefined ? { error: r.error } : {}),
    })),
  }
}

/** Write the report as pretty JSON (trailing newline). */
export const writeReport = async (file: string, report: BenchReport): Promise<void> => {
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`)
}
