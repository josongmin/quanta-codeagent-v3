import { loadCorpus as defaultLoadCorpus, type Prediction, writePredictions } from "./corpus"
import { knobsForReport, resolveBenchKnobs } from "./eval/knobs-bench"
import type { RunHealthSummary } from "./report"
import { type BenchReportKnobs, buildReport, writeReport } from "./report"
import type { Instance, InstanceResult } from "./types"

export interface BatchArtifactMeta {
  model: string
  provider: string
  /** Dataset family (RFC jun-29 R4) — recorded in the report so verified/live/pro
   *  runs are distinguishable in the leaderboard SSOT (else a Pro resolved-rate is
   *  averaged into the Verified one). Absent ⇒ verified ⇒ byte-identical legacy report. */
  datasetFamily?: "verified" | "live" | "pro"
  n: number
  /**
   * Optional pre-resolved knob telemetry. When provided, embedded verbatim
   * in the report. When omitted, `writeArtifacts` resolves the bench-surface
   * knob state from `process.env` at write time — matches the per-instance
   * resolution the driver does, so the report's `knobs` section reflects
   * the run's actual posture. Tests can inject a deterministic value here.
   */
  knobs?: BenchReportKnobs
  /** Optional run-health verdict (early systemic-abort detector). When present
   *  AND non-healthy/aborted, embedded in the report's `runHealth` field;
   *  omitted for a plain healthy run (byte-identical report). */
  runHealth?: RunHealthSummary
}

export interface LoadSelectedInstancesOptions {
  corpus: string
  filter?: string
  limit?: number | null
  loadCorpus?: (root: string) => Promise<Instance[]>
}

export interface LoadSelectedInstancesResult {
  all: Instance[]
  instances: Instance[]
}

export interface RunBatchOptions {
  instances: readonly Instance[]
  runInstance: (instance: Instance) => Promise<InstanceResult>
  /**
   * Max instances processed concurrently. Default 1 ⇒ fully serial,
   * byte-identical to the pre-concurrency path (same order, one `runInstance`
   * in flight at a time). >1 ⇒ patch-gen overlaps across instances.
   *
   * SAFETY: this parallelises the WHOLE `runInstance` (patch-gen + grading).
   * patch-gen is LLM/network-bound and parallelises freely. The Docker GRADING
   * step is serialised independently by a process-global mutex in
   * `python-swebench.ts` (arm64 daemon wedges on concurrent large image pulls),
   * so a high `concurrency` overlaps patch-gen while grading stays one-at-a-time.
   * For genuinely parallel grading use an x86 backend (ADR-0536), not this knob.
   */
  concurrency?: number
}

export interface RunBatchResult {
  results: InstanceResult[]
  exitCode: number
}

const hasPath = (path: string | undefined): path is string => path !== undefined && path !== ""

/** Match an instance id against a `--instance` filter. The filter is a
 *  comma-separated list of substrings; an id matches if it contains ANY part.
 *  A single value (no comma) is plain substring match — byte-identical to the
 *  pre-2026-06-16 behavior. Comma support fixes multi-instance subset runs
 *  (full-remote passes `ids.join(",")`, which the old single-substring filter
 *  matched against zero ids — no id contains a literal comma). */
export const matchesInstanceFilter = (id: string, filter: string): boolean => {
  const parts = filter
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "")
  if (parts.length === 0) return true
  return parts.some((p) => id.includes(p))
}

/** Apply the optional id-substring filter + the limit slice. Filter runs
 *  BEFORE limit so selection stays byte-identical to the bench CLI. */
export const selectInstances = (
  all: readonly Instance[],
  filter: string | undefined,
  limit: number | null | undefined,
): Instance[] => {
  const filtered =
    filter !== undefined && filter !== ""
      ? all.filter((instance) => matchesInstanceFilter(instance.id, filter))
      : [...all]
  if (limit === null || limit === undefined) return filtered
  return filtered.slice(0, limit)
}

/** Shared corpus loader + selector for `agent:batch` and the custom-corpus bench path. */
export const loadSelectedInstances = async (
  opts: LoadSelectedInstancesOptions,
): Promise<LoadSelectedInstancesResult> => {
  const load = opts.loadCorpus ?? defaultLoadCorpus
  const all = await load(opts.corpus)
  return {
    all,
    instances: selectInstances(all, opts.filter, opts.limit),
  }
}

/** Exit code is 0 iff every selected instance passed with an ok verdict. */
export const computeExitCode = (results: readonly InstanceResult[]): number => {
  if (results.length === 0) return 0
  for (const result of results) {
    if (!result.passed) return 1
    if ((result.verdict ?? "ok") !== "ok") return 1
  }
  return 0
}

/** Order-preserving bounded-concurrency map. `results[i]` always corresponds to
 *  `items[i]` regardless of completion order. `limit<=1` ⇒ a single worker
 *  drains the queue in index order = byte-identical to a serial `for await`.
 *  Exported so both bench paths (custom-corpus `runBatch` + dataset-mode loop)
 *  share ONE concurrency primitive. */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i] as T, i)
    }
  }
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length || 1))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

/** Run the selected instances (serial by default; `opts.concurrency>1` overlaps
 *  patch-gen — grading stays serialised by the python-swebench mutex) and
 *  compute the canonical batch exit code. */
export const runBatch = async (opts: RunBatchOptions): Promise<RunBatchResult> => {
  const results = await mapWithConcurrency(opts.instances, opts.concurrency ?? 1, (instance) =>
    opts.runInstance(instance),
  )
  return { results, exitCode: computeExitCode(results) }
}

/** Shared predictions/report writer. Each path is optional; absent paths are skipped. */
export const writeArtifacts = async (
  predictionsFile: string | undefined,
  reportFile: string | undefined,
  results: readonly InstanceResult[],
  meta: BatchArtifactMeta,
): Promise<void> => {
  if (hasPath(predictionsFile)) {
    const predictions: Prediction[] = results.map((result) => ({
      instance_id: result.id,
      model_name_or_path: meta.model,
      model_patch: result.patch,
    }))
    await writePredictions(predictionsFile, predictions)
  }
  if (hasPath(reportFile)) {
    // Knob telemetry: pre-supplied (test seam) > resolved-from-env (default).
    // Always emitted into the report so the JSON carries the run's exact
    // knob posture for after-the-fact comparison. With an empty registry
    // the section is `{ resolved:{}, inactive:[] }` — a safe baseline marker.
    const knobs = meta.knobs ?? collectBenchKnobsTelemetry()
    await writeReport(
      reportFile,
      buildReport(
        { ...meta, knobs, ...(meta.runHealth !== undefined ? { runHealth: meta.runHealth } : {}) },
        [...results],
      ),
    )
  }
}

/** Collect the bench-surface knob state from `process.env` and project to
 *  the report's serialisable shape. Extracted here so `writeArtifacts` stays
 *  one concern (artifact I/O) and the resolver-to-projection wiring can be
 *  unit-tested as a single seam. */
export const collectBenchKnobsTelemetry = (): BenchReportKnobs => {
  const state = resolveBenchKnobs({ envVars: process.env })
  const resolved = knobsForReport(state)
  return {
    resolved,
    ...(state.preset !== undefined ? { preset: state.preset } : {}),
    inactive: state.inactive,
    // #5: surface present-but-rejected env knobs in the report SSOT so a typo'd
    // override is visible, never a silent default. Omitted when none rejected.
    ...(state.rejected.length > 0 ? { rejected: state.rejected } : {}),
  }
}
