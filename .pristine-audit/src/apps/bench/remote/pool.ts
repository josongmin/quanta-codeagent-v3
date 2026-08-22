/**
 * Persistent full-remote box pool (jun-20 box-lifecycle plan, Phase 2).
 *
 * The old sweep paid the FULL bootstrap tax (boot + cloud-init + rsync + bun
 * install + phantom deps + swebench/uvx warm + pyright) on EVERY wave because each
 * wave spun a fresh box via {@link createFullRemoteBackend}. This pool provisions
 * ONE box (or a small fixed number of workers) via {@link provisionBox} and feeds
 * it a QUEUE of chunks through {@link gradeChunkOnBox} — bootstrap once, grade
 * many. The binding limit is the shared OAuth login rate, not box count, so a
 * single box with high per-box patch-gen concurrency is the right shape.
 *
 * Invariants this module owns:
 *   - bootstrap runs ONCE per worker box, not once per chunk;
 *   - each chunk re-injects a FRESH stripped token (a long-lived run never grades
 *     on a stale access_token) and writes to a runId-SCOPED box dir, so chunks
 *     never collide on the shared `~/report.json` / `~/instances.jsonl`;
 *   - a chunk whose box DIED (spot reclaim / ssh-255) is RE-QUEUED on a fresh box
 *     (bounded), never silently lost;
 *   - the box is ALWAYS terminated when its worker drains (even on error).
 *
 * Everything routes through the injected SpawnFn (via {@link provisionBox} /
 * {@link gradeChunkOnBox}), so the whole pool is unit-testable offline.
 *
 * This file is the THIN orchestrator (runPool + its preflight/guard helpers).
 * The bulk — coverage accounting, launch-window gating, the worker loop, and the
 * public types — lives in ./pool/* and is re-exported below so importers stay
 * byte-compatible.
 */
import { errMessage } from "@/shared"
import { resolveBenchRunConfig } from "../run-config"
import {
  assertDatasetGradeableForFamily,
  assertRemoteDatasetLaunchable,
  assertRemoteDatasetSelectionExists,
  assertRemoteStrictGroundingSupported,
} from "./box-session"
import type { ChunkCoverageAccumulator } from "./pool/coverage"
import { assertUniqueChunkRunIds } from "./pool/coverage"
import { awaitPoolPreflightLaunchWindow } from "./pool/launch-window"
import type { PoolChunk, PoolChunkResult, PoolConfig } from "./pool/types"
import { ChunkQueue, mergeWorkerRunErrors, runWorker } from "./pool/worker"
import { acquireSingleBoxGuard, type SingleBoxGuard } from "./single-box-guard"

export {
  assertUniqueChunkRunIds,
  chunkBoxPaths,
  coverageComplete,
  missingInstances,
} from "./pool/coverage"
export type { PoolChunk, PoolChunkResult, PoolConfig } from "./pool/types"

const acquirePoolSingleBoxGuard = async (
  chunks: readonly PoolChunk[],
  cfg: PoolConfig,
): Promise<SingleBoxGuard | undefined> => {
  if (cfg.allowExtraBoxes === true) return undefined
  const first = chunks[0]?.runId ?? "empty"
  const label = `pool:${first}${chunks.length > 1 ? `+${chunks.length - 1}` : ""}`
  return acquireSingleBoxGuard({
    label,
    ...(cfg.singleBoxGuardDir !== undefined ? { dir: cfg.singleBoxGuardDir } : {}),
    wait: cfg.waitForIdle === true,
    ...(cfg.waitForIdle === true ? { waitMs: cfg.waitForIdleTimeoutMs } : {}),
    ...(cfg.waitForIdlePollMs !== undefined ? { pollMs: cfg.waitForIdlePollMs } : {}),
    ...(cfg.now !== undefined ? { now: cfg.now } : {}),
    ...(cfg.sleep !== undefined ? { sleep: cfg.sleep } : {}),
    ...(cfg.onLog !== undefined ? { onLog: cfg.onLog } : {}),
  })
}

/** Per-chunk launchability preflight — dataset reachable, selection non-empty,
 *  and strict-grounding supported for the configured preset. Throws on any gap. */
const assertPoolChunksLaunchable = (chunks: readonly PoolChunk[], cfg: PoolConfig): void => {
  // T2 — read the TYPED family off the box provision config (previously dropped
  // argv). Falls back to env only when the typed field is unset. Resolved ONCE
  // for the whole chunk list: every preflight below decodes through THIS family's
  // reader, so a chunk cannot be validated by one family's parser and then run by
  // another's.
  const family = resolveBenchRunConfig({
    argvFamily: cfg.provision.swebenchDatasetFamily,
    env: process.env,
  }).datasetFamily
  for (const chunk of chunks) {
    assertRemoteDatasetLaunchable({
      datasetPath: chunk.datasetPath,
      surface: `pool chunk ${chunk.runId}`,
      family,
    })
    assertDatasetGradeableForFamily({
      datasetPath: chunk.datasetPath,
      ...(chunk.instanceIds !== undefined ? { instanceIds: chunk.instanceIds } : {}),
      surface: `pool chunk ${chunk.runId}`,
      family,
    })
    assertRemoteDatasetSelectionExists({
      datasetPath: chunk.datasetPath,
      ...(chunk.instanceIds !== undefined ? { instanceIds: chunk.instanceIds } : {}),
      surface: `pool chunk ${chunk.runId}`,
      family,
    })
    assertRemoteStrictGroundingSupported({
      preset: cfg.preset,
      datasetPath: chunk.datasetPath,
      ...(chunk.instanceIds !== undefined ? { instanceIds: chunk.instanceIds } : {}),
      surface: `pool chunk ${chunk.runId}`,
      family,
    })
  }
}

/** Normalize + gate the requested worker count: parallel workers can launch
 *  parallel boxes, so multi-worker runs require BOTH explicit opt-ins. */
const resolvePoolWorkerCount = (cfg: PoolConfig): number => {
  const workers = Math.max(1, Math.trunc(cfg.workers) || 1)
  if (workers > 1 && cfg.allowExtraWorkers !== true) {
    throw new Error(
      `[pool] refusing workers=${workers} without explicit opt-in (allowExtraWorkers=true)`,
    )
  }
  if (workers > 1 && cfg.allowExtraBoxes !== true) {
    throw new Error(
      `[pool] refusing workers=${workers} without explicit extra-box opt-in ` +
        "(allowExtraBoxes=true): parallel workers can launch parallel boxes",
    )
  }
  return workers
}

/** Reconcile the single-box guard release with the run's primary error: a
 *  release failure is folded into the primary error when one exists, else it
 *  becomes the thrown error; otherwise the run's result/primary error stands. */
const settlePoolOutcome = (
  result: PoolChunkResult[] | undefined,
  primaryErr: unknown,
  guardReleaseErr: unknown,
): PoolChunkResult[] => {
  if (guardReleaseErr !== undefined) {
    if (primaryErr !== undefined) {
      throw new Error(
        `[pool] failed to release the single-box guard after ${errMessage(primaryErr)}: ${errMessage(guardReleaseErr)}`,
      )
    }
    throw guardReleaseErr
  }
  if (primaryErr !== undefined) throw primaryErr
  if (result !== undefined) return result
  throw new Error("[pool] run completed without a result or error")
}

/**
 * Run all `chunks` through a persistent pool of `cfg.workers` boxes. Returns one
 * {@link PoolChunkResult} per chunk (keyed back to its runId), preserving the
 * input order. Bootstrap is paid ONCE per worker box, not per chunk.
 */
export const runPool = async (
  chunks: readonly PoolChunk[],
  cfg: PoolConfig,
): Promise<PoolChunkResult[]> => {
  assertUniqueChunkRunIds(chunks)
  if (chunks.length === 0) return []
  assertPoolChunksLaunchable(chunks, cfg)
  const workers = resolvePoolWorkerCount(cfg)
  const guard = await acquirePoolSingleBoxGuard(chunks, cfg)
  let result: PoolChunkResult[] | undefined
  let primaryErr: unknown
  try {
    await awaitPoolPreflightLaunchWindow(cfg)
    const queue = new ChunkQueue(chunks)
    const attemptsByRun = new Map<string, number>()
    const out = new Map<string, PoolChunkResult>()
    const coverageByRun = new Map<string, ChunkCoverageAccumulator>()
    const workerRuns = Array.from({ length: workers }, (_unused, i) => ({
      workerId: i + 1,
      promise: runWorker(i + 1, queue, cfg, attemptsByRun, out, coverageByRun),
    }))
    const settled = await Promise.allSettled(workerRuns.map((worker) => worker.promise))
    const workerErrors = settled.flatMap((result, idx) =>
      result.status === "rejected"
        ? [{ workerId: workerRuns[idx]?.workerId ?? idx + 1, error: result.reason }]
        : [],
    )
    if (workerErrors.length > 0) {
      throw mergeWorkerRunErrors(workerErrors)
    }

    // Preserve input order; a chunk with no recorded result (should not happen —
    // every path records one) is surfaced as lost rather than dropped.
    result = chunks.map(
      (chunk) =>
        out.get(chunk.runId) ?? {
          chunk,
          result: {},
          attempts: attemptsByRun.get(chunk.runId) ?? 0,
          lost: true,
        },
    )
  } catch (err) {
    primaryErr = err
  }

  let guardReleaseErr: unknown
  try {
    await guard?.release()
  } catch (err) {
    guardReleaseErr = err
  }

  return settlePoolOutcome(result, primaryErr, guardReleaseErr)
}
