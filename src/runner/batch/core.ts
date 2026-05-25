import { loadCorpus as defaultLoadCorpus, type Prediction, writePredictions } from "./corpus"
import { knobsForReport, resolveBenchKnobs } from "./eval/knobs-bench"
import { type BenchReportKnobs, buildReport, writeReport } from "./report"
import type { Instance, InstanceResult } from "./types"

export interface BatchArtifactMeta {
  model: string
  provider: string
  n: number
  /**
   * Optional pre-resolved knob telemetry. When provided, embedded verbatim
   * in the report. When omitted, `writeArtifacts` resolves the bench-surface
   * knob state from `process.env` at write time — matches the per-instance
   * resolution the driver does, so the report's `knobs` section reflects
   * the run's actual posture. Tests can inject a deterministic value here.
   */
  knobs?: BenchReportKnobs
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
}

export interface RunBatchResult {
  results: InstanceResult[]
  exitCode: number
}

const hasPath = (path: string | undefined): path is string => path !== undefined && path !== ""

/** Apply the optional id-substring filter + the limit slice. Filter runs
 *  BEFORE limit so selection stays byte-identical to the bench CLI. */
export const selectInstances = (
  all: readonly Instance[],
  filter: string | undefined,
  limit: number | null | undefined,
): Instance[] => {
  const filtered =
    filter !== undefined && filter !== ""
      ? all.filter((instance) => instance.id.includes(filter))
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

/** Exit code is 0 iff every selected instance passed and no degraded/env-prep verdict slipped in. */
export const computeExitCode = (results: readonly InstanceResult[]): number => {
  if (results.length === 0) return 0
  for (const result of results) {
    if (!result.passed) return 1
    if (result.verdict === "degraded" || result.verdict === "env_prep_failed") return 1
  }
  return 0
}

/** Run the selected instances serially and compute the canonical batch exit code. */
export const runBatch = async (opts: RunBatchOptions): Promise<RunBatchResult> => {
  const results: InstanceResult[] = []
  for (const instance of opts.instances) {
    results.push(await opts.runInstance(instance))
  }
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
    await writeReport(reportFile, buildReport({ ...meta, knobs }, [...results]))
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
  }
}
