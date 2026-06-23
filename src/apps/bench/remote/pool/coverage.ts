/**
 * Chunk coverage accounting for the persistent full-remote box pool. A chunk's
 * grade may arrive in PIECES (box died after grading N of M, requeue recovers
 * the rest), so verdicts accumulate per runId and a chunk is "complete" only
 * when EVERY requested instance is covered. Split out of pool.ts to keep the
 * orchestrator thin; the accumulator type + helpers are pool-internal.
 */
import {
  assertSafeArtifactSuffix,
  type ChunkPaths,
  coveredInstances,
  type FullRemoteResult,
} from "../box-session"
import { absorbFullRemoteResult } from "../verdict-buckets"
import type { PoolChunk } from "./types"

export interface ChunkCoverageAccumulator {
  readonly resolved: Set<string>
  readonly unresolved: Set<string>
  readonly errored: Set<string>
  readonly emptyPatch: Set<string>
  reportPath?: string
  rateLimited: boolean
}

export const createChunkCoverageAccumulator = (): ChunkCoverageAccumulator => ({
  resolved: new Set<string>(),
  unresolved: new Set<string>(),
  errored: new Set<string>(),
  emptyPatch: new Set<string>(),
  rateLimited: false,
})

export const chunkCoverageAccumulatorFor = (
  coverageByRun: Map<string, ChunkCoverageAccumulator>,
  runId: string,
): ChunkCoverageAccumulator => {
  let acc = coverageByRun.get(runId)
  if (acc !== undefined) return acc
  acc = createChunkCoverageAccumulator()
  coverageByRun.set(runId, acc)
  return acc
}

export const accumulateChunkCoverage = (
  acc: ChunkCoverageAccumulator,
  result: FullRemoteResult,
): void => {
  if (result.reportPath !== undefined) acc.reportPath = result.reportPath
  if (result.rateLimited === true) acc.rateLimited = true
  absorbFullRemoteResult(acc, result)
}

export const chunkCoverageResult = (acc: ChunkCoverageAccumulator): FullRemoteResult => ({
  ...(acc.reportPath !== undefined ? { reportPath: acc.reportPath } : {}),
  ...(acc.resolved.size > 0 ? { resolved: [...acc.resolved] } : {}),
  ...(acc.unresolved.size > 0 ? { unresolved: [...acc.unresolved] } : {}),
  ...(acc.errored.size > 0 ? { errored: [...acc.errored] } : {}),
  ...(acc.emptyPatch.size > 0 ? { emptyPatch: [...acc.emptyPatch] } : {}),
  ...(acc.rateLimited ? { rateLimited: true } : {}),
})

export const assertUniqueChunkRunIds = (chunks: readonly PoolChunk[]): void => {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const chunk of chunks) {
    // Defense-in-depth at the EARLIEST boundary (chunk-list construction): a
    // runId flows unquoted into remote ssh paths (`mkdir -p ~/runs/<runId>/...`
    // at the pool's pre-grade sink, BEFORE gradeChunkOnBox's own guard). Validate
    // the charset here so a traversal/injection suffix can never reach any box
    // command. Redundant-but-belt-and-suspenders with the gradeChunkOnBox guard.
    assertSafeArtifactSuffix(chunk.runId)
    if (seen.has(chunk.runId)) dup.add(chunk.runId)
    seen.add(chunk.runId)
  }
  if (dup.size > 0) {
    throw new Error(
      `[pool] duplicate chunk runId(s): ${[...dup].sort().join(", ")} — every chunk must have a unique runId`,
    )
  }
}

/** runId-scoped box paths so concurrent/sequential chunks on one box never
 *  collide on the shared fixed paths. `trajectory` uses `$HOME` (not `~`) because
 *  it is interpolated inside double quotes in the record env (see box-session.ts). */
export const chunkBoxPaths = (runId: string): ChunkPaths => ({
  dataset: `~/runs/${runId}/instances.jsonl`,
  preds: `~/runs/${runId}/preds.jsonl`,
  report: `~/runs/${runId}/report.json`,
  runLog: `~/runs/${runId}/run.log`,
  observeDir: `~/runs/${runId}/observe`,
  trajectory: `$HOME/runs/${runId}/trajectory.jsonl`,
})

/** Did this chunk's grade produce ANY verdict? An all-empty result means the box
 *  died (or produced no report) — the chunk should be re-queued. */
export const earnedVerdict = (r: FullRemoteResult): boolean =>
  (r.resolved?.length ?? 0) +
    (r.unresolved?.length ?? 0) +
    (r.errored?.length ?? 0) +
    (r.emptyPatch?.length ?? 0) >
  0

/** #2: instances the chunk REQUESTED but that earned no verdict. Empty when the
 *  chunk declares no instance set (we then fall back to the any-verdict test). */
export const missingInstances = (r: FullRemoteResult, chunk: PoolChunk): string[] => {
  if (chunk.instanceIds === undefined || chunk.instanceIds.length === 0) return []
  const covered = coveredInstances(r)
  return chunk.instanceIds.filter((id) => !covered.has(id))
}

/** #2: a chunk is DONE only when it covered EVERY requested instance. A strict
 *  subset (box died after grading N of M, spot reclaim, ssh-255 mid-grade) must
 *  NOT be recorded as a clean completion — the uncovered instances would silently
 *  vanish (counted as neither resolved nor lost). When the chunk declares no
 *  instance set, fall back to "earned any verdict" (legacy behavior). */
export const coverageComplete = (r: FullRemoteResult, chunk: PoolChunk): boolean =>
  chunk.instanceIds === undefined || chunk.instanceIds.length === 0
    ? earnedVerdict(r)
    : missingInstances(r, chunk).length === 0

export const accumulatedMissingInstances = (
  acc: ChunkCoverageAccumulator,
  chunk: PoolChunk,
): string[] => missingInstances(chunkCoverageResult(acc), chunk)

export const accumulatedCoverageComplete = (
  acc: ChunkCoverageAccumulator,
  chunk: PoolChunk,
): boolean => coverageComplete(chunkCoverageResult(acc), chunk)
