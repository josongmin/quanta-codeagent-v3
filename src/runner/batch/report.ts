/**
 * Baseline tracking artifact.
 *
 * A tiny, pure machine-readable report built from `InstanceResult[]` plus
 * run metadata. It is NOT official grading (that requires the Docker
 * harness — see swebench-dataset.ts): `resolved` here reflects the local
 * `testCmd` outcome, which is a no-op for the official-dataset path. The
 * report exists to track baseline runs over time alongside the official
 * `predictions.jsonl`.
 *
 * Knob telemetry: every report carries a `knobs` section recording the exact
 * registry state used for the run — active knob values + their source layer
 * (env / preset / config / cli / default), the optional `--knobs-preset`
 * name, and the registered-but-inactive ids. Operators reading the JSON
 * report can verify what configuration produced the resolved/total numbers,
 * which is the user-explicit requirement: a benchmark report MUST capture
 * its own knob posture so two runs are comparable. Empty registry (knob
 * files not yet imported) ⇒ all three subfields collapse to safe empties.
 */
import {
  aggregate,
  classify,
  type FailureBreakdown,
  type FailureClassification,
} from "./corpus/failure-classifier"
import { resolvedTotals } from "./observe"
import type {
  BenchInstanceBudget,
  BenchReproTestTelemetry,
  GradeBreakdown,
  InstanceResult,
} from "./types"

export interface BenchReportMeta {
  model: string
  provider: string
}

/** Knob telemetry — exact registry state for the run. Cheaply serialisable
 *  (plain JSON-friendly shapes, no Maps / classes). */
export interface BenchReportKnobs {
  /** id → { value, unit, display, source }. `unit`/`display` make the number
   *  self-describing ("5 turns", "on") so a bare "5" never appears. Only knobs
   *  whose layered resolution produced a non-undefined value appear here. */
  readonly resolved: Readonly<
    Record<string, { value: unknown; unit: string | undefined; display: string; source: string }>
  >
  /** Resolved `--knobs-preset` name (or `QUANTA_KNOBS_PRESET`). Absent when
   *  no preset was selected. */
  readonly preset?: string
  /** Registered-but-inactive knob ids (no value in any layer, no default).
   *  Sorted by registry iteration order for stability. */
  readonly inactive: readonly string[]
}

export interface PerInstanceReport {
  id: string
  passed: boolean
  turns: number
  patchBytes: number
  error?: string
  /** Structured failure classification. Omitted for passing runs. */
  failure?: FailureClassification
  /** Adaptive-timeout + retry budget. Omitted unless the driver applied the
   *  measurement-stability slice (default: omitted ⇒ byte-identical to the
   *  pre-feature JSON report shape). */
  budget?: BenchInstanceBudget
  /** Repro-test generation/install telemetry. Omitted when the knob was off. */
  reproTest?: BenchReproTestTelemetry
  /** jun-19 — official-grade regression-vs-didn't-fix breakdown (swebench only).
   *  Lets a run self-measure PASS_TO_PASS-break rate (regression-gate
   *  justification). Omitted for non-swebench / ungraded ⇒ byte-identical. */
  gradeBreakdown?: GradeBreakdown
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
   *  signals). Both are emitted in every report; empty objects when 0/n
   *  failed. */
  failureBreakdown: FailureBreakdown
  perInstance: PerInstanceReport[]
  /** Knob telemetry — recorded so two runs are comparable from the JSON
   *  alone. Always present (empty subfields when the registry is empty). */
  knobs: BenchReportKnobs
}

/** Build the report object from results + meta. Pure & deterministic given a
 *  fixed `timestamp` (defaults to now).
 *
 *  `knobs` is optional only because most legacy callers (and the entire
 *  knob-less codepath, including this worktree's empty registry) pass none.
 *  When omitted the report emits `{ resolved:{}, inactive:[] }` — a safe
 *  empty marker that distinguishes "no knobs section was wired" (impossible
 *  after this change) from "registry was empty for this run" (legitimate
 *  pre-knob baseline). */
export const buildReport = (
  meta: BenchReportMeta & { n: number; timestamp?: string; knobs?: BenchReportKnobs },
  results: InstanceResult[],
): BenchReport => {
  // C8: degraded-excluding denominator — the SAME source as observe.summarize
  // / summary.json. Never count a strict-degraded instance here.
  const { resolved, total } = resolvedTotals(results)
  const classifications = results.map((r) => classify(r))
  const failedClassifications = classifications.filter((c) => c.termination !== "passed")
  // `knobs` defaults to an empty marker so the JSON shape is stable across
  // runs even when the registry is empty (current worktree state).
  const knobs: BenchReportKnobs = meta.knobs ?? { resolved: {}, inactive: [] }
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
    failureBreakdown: aggregate(failedClassifications),
    perInstance: results.map((r, i) => {
      const c = classifications[i] ?? { termination: "unknown", signals: [] }
      return {
        id: r.id,
        passed: r.passed,
        turns: r.turns,
        patchBytes: Buffer.byteLength(r.patch, "utf8"),
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(c.termination !== "passed" ? { failure: c } : {}),
        ...(r.budget !== undefined ? { budget: r.budget } : {}),
        ...(r.reproTest !== undefined ? { reproTest: r.reproTest } : {}),
        ...(r.gradeBreakdown !== undefined ? { gradeBreakdown: r.gradeBreakdown } : {}),
      }
    }),
    knobs,
  }
}

/** Write the report as pretty JSON (trailing newline). */
export const writeReport = async (file: string, report: BenchReport): Promise<void> => {
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`)
}
