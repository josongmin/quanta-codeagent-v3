/**
 * Leaf helpers lifted VERBATIM out of `run-main.ts` to keep that composition
 * root under the god-MODULE line gate. Two cohesive, downward-closed clusters
 * of pure/leaf scaffolding — none of these call back into the run-main pipeline
 * or read its module-private `exitFn`, so the move introduces no value cycle:
 *
 *  - observe / artifact I/O plumbing: `resolveObserve`, `attemptObs`,
 *    `withObserve`, `finalizeObserve`, `writeArtifacts`
 *  - SWE-bench dataset-task prep: `datasetFamily`, `readSwebenchTasks`,
 *    `filterSwebenchTasks`, `runPrepareImages`
 *
 * `ObserveCtx` / `RunCfg` live in `run-main.ts` and are pulled in here as
 * TYPE-ONLY imports (erased at runtime → no cycle).
 */
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { matchesInstanceFilter, writeArtifacts as writeBatchArtifacts } from "@/runner/batch/core"
import type { RunHealthSummary } from "@/runner/batch/report"
import { logger } from "@/shared"
import { benchRunDir, benchRunId, type SwebenchTask } from "./corpus"
import { type DatasetFamily, parseTasksForFamily, resolveDatasetFamily } from "./dataset-family"
import { finalizeRun } from "./eval"
import { prepareImages, resolveHarnessConfig } from "./harness"
import type { AttemptObservation } from "./observe"
import { argValue } from "./run-args"
import type { ObserveCtx, RunCfg } from "./run-main"
import type { InstanceResult } from "./types"

/** Resolve the observe root. Defaults to the PERSISTENT bench runs dir so
 *  trajectories survive across sessions (override with `--observe-dir` /
 *  `QUANTA_OBSERVE_DIR`). Always returns a handle (observe is on by default). */
export const resolveObserve = (): ObserveCtx | undefined => {
  const runId = benchRunId()
  const flag = argValue("--observe-dir") ?? process.env.QUANTA_OBSERVE_DIR
  const dir = flag ? resolve(process.cwd(), flag) : join(benchRunDir(runId), "observe")
  return { dir, runId }
}

/** Per-attempt observe handle for one instance (one file per attempt). */
export const attemptObs = (
  obs: ObserveCtx | undefined,
  attempt: number,
): AttemptObservation | undefined =>
  obs === undefined ? undefined : { dir: obs.dir, runId: obs.runId, attempt }

export const withObserve = (base: RunCfg, o: AttemptObservation | undefined): RunCfg =>
  o === undefined ? base : { ...base, observe: o }

/** `--prepare-images` worker: warm the Docker image pool for `instanceIds`
 *  via the official `prepare_images` harness, log the outcome, and return the
 *  process exit code (0 ok / 1 fail). The SOTA win: per-repo env image built
 *  once here, reused by every later instance of that repo. */
export const runPrepareImages = async (instanceIds: string[]): Promise<number> => {
  const result = await prepareImages({
    predictionsPath:
      argValue("--predictions") ?? join(benchRunDir(benchRunId()), "predictions.jsonl"),
    runId: benchRunId(),
    instanceIds,
    datasetName: argValue("--dataset-name") ?? "princeton-nlp/SWE-bench_Verified",
    config: resolveHarnessConfig(),
  })
  logger.info(
    `bench: prepare-images ${result.ok ? "OK" : "FAIL"} (preexisting env images: ${result.preexistingEnvImages})`,
  )
  if (!result.ok) logger.info(`prepare log tail:\n${result.log}`)
  return result.ok ? 0 : 1
}

/** Resolve the dataset family (verified|live|pro) from `--dataset-family` /
 *  QUANTA_SWEBENCH_DATASET_FAMILY. Default "verified" (byte-identical legacy). */
export const datasetFamily = (): DatasetFamily =>
  resolveDatasetFamily(argValue("--dataset-family"), process.env)

// REGRESSION FIX (jun-30): the god-MODULE split (11adab597) dropped the family-aware
// parse — Pro rows MUST be normalized (lowercase fail_to_pass + extra fields) or they
// degrade to the `testCmd:"true"` no-op. Verified/Live are the standard schema.
export const readSwebenchTasks = (datasetFile: string): SwebenchTask[] =>
  parseTasksForFamily(readFileSync(datasetFile, "utf8"), datasetFamily())

/** Apply the `--instance <substr>` filter to ALREADY-parsed tasks. Pure — no
 *  IO — so the dataset file is read + JSON-parsed exactly ONCE per run and the
 *  parsed corpus is threaded through (filter + empty-check + limit) instead of
 *  re-reading the same 500-row file three times. */
export const filterSwebenchTasks = (parsed: readonly SwebenchTask[]): SwebenchTask[] => {
  const instanceFilter = argValue("--instance")
  return instanceFilter !== undefined && instanceFilter !== ""
    ? parsed.filter((t) => matchesInstanceFilter(t.instanceId, instanceFilter))
    : [...parsed]
}

/** D-fix: shared `--predictions` / `--report` writer for both bench modes.
 *  Pure-by-signature (paths + results + meta are explicit args, no argv reads)
 *  so the contract is unit-testable without spawning the CLI. */
export const writeArtifacts = async (
  predictionsFile: string,
  reportFile: string,
  results: InstanceResult[],
  meta: { provider: string; model: string; n: number; runHealth?: RunHealthSummary },
): Promise<void> => {
  await writeBatchArtifacts(predictionsFile, reportFile, results, meta)
  logger.info(`wrote ${predictionsFile} (${results.length} prediction(s)) and ${reportFile}`)
}

/** Run end (RFC §8): write `<observeDir>/<runId>/{metrics,summary}.json` and
 *  log passed/total plus the official-harness split. No-op when observe is OFF. */
export const finalizeObserve = async (
  obs: ObserveCtx | undefined,
  results: InstanceResult[],
): Promise<void> => {
  if (obs === undefined) return
  const summary = await finalizeRun(obs, results)
  logger.info(
    `observe: ${join(obs.dir, obs.runId)} — passed ${summary.resolved}/${summary.total}` +
      ` | official_harness ${summary.score.officialHarness}/${summary.total}` +
      ` (${summary.degraded} degraded)`,
  )
}
