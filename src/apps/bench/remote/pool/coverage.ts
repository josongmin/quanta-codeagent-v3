/**
 * Chunk coverage accounting for the persistent full-remote box pool. A chunk's
 * grade may arrive in PIECES (box died after grading N of M, requeue recovers
 * the rest), so verdicts accumulate per runId and a chunk is "complete" only
 * when EVERY requested instance is covered. Split out of pool.ts to keep the
 * orchestrator thin; the accumulator type + helpers are pool-internal.
 */
import {
  mergeOfficialGradeReceipts,
  type OfficialGradeReceipt,
  type OfficialGradeReceiptFailure,
} from "@/runner/batch/eval/official-grade"
import {
  assertSafeArtifactSuffix,
  type ChunkPaths,
  coveredInstances,
  type FullRemoteResult,
} from "../box-session"
import { instancesCoveredByReceipts } from "../relaunch-coverage"
import { absorbFullRemoteResult } from "../verdict-buckets"
import type { PoolChunk } from "./types"

export interface ChunkCoverageAccumulator {
  readonly resolved: Set<string>
  readonly unresolved: Set<string>
  readonly errored: Set<string>
  readonly emptyPatch: Set<string>
  /** PMX-03/04 — every official-grade receipt this chunk's pieces produced, in
   *  arrival order. Kept as a LIST rather than folded on arrival so a duplicate
   *  disposition across two pieces fails closed at merge time instead of
   *  resolving itself by last-write-wins. */
  readonly officialGrades: OfficialGradeReceipt[]
  reportPath?: string
  rateLimited: boolean
}

export const createChunkCoverageAccumulator = (): ChunkCoverageAccumulator => ({
  resolved: new Set<string>(),
  unresolved: new Set<string>(),
  errored: new Set<string>(),
  emptyPatch: new Set<string>(),
  officialGrades: [],
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
  if (result.officialGrade !== undefined) acc.officialGrades.push(result.officialGrade)
  absorbFullRemoteResult(acc, result)
}

/**
 * The chunk's MERGED receipt, or the typed reason there is none.
 *
 * Two things this owes the chunk it belongs to:
 *
 *  - the DENOMINATOR. The chunk's declared instance set is unioned in, so a
 *    chunk that graded 2 of 3 and lost its box merges to a receipt that still
 *    says 3 assigned and names the third as missing. Without it the merged
 *    receipt shrank to whatever came back — the flattering denominator, on the
 *    artifact every downstream surface reads.
 *  - the FAILURE CODE. A refused merge (a duplicate disposition across two
 *    pieces, two evaluator builds) used to return `undefined`, which is exactly
 *    what a dead box returns. Two very different operator problems were byte-
 *    indistinguishable; the codes are carried out so the refusal can be read.
 */
const mergedChunkReceipt = (
  acc: ChunkCoverageAccumulator,
  chunk: PoolChunk,
):
  | { readonly receipt: OfficialGradeReceipt }
  | { readonly failures: readonly OfficialGradeReceiptFailure[] }
  | undefined => {
  if (acc.officialGrades.length === 0) return undefined
  const merged = mergeOfficialGradeReceipts({
    receipts: acc.officialGrades,
    ...(chunk.instanceIds !== undefined
      ? { additionalAssignedInstanceIds: chunk.instanceIds }
      : {}),
  })
  return merged.ok ? { receipt: merged.receipt } : { failures: merged.failures }
}

export const chunkCoverageResult = (
  acc: ChunkCoverageAccumulator,
  chunk: PoolChunk,
): FullRemoteResult => {
  const merged = mergedChunkReceipt(acc, chunk)
  return {
    ...(acc.reportPath !== undefined ? { reportPath: acc.reportPath } : {}),
    ...(acc.resolved.size > 0 ? { resolved: [...acc.resolved] } : {}),
    ...(acc.unresolved.size > 0 ? { unresolved: [...acc.unresolved] } : {}),
    ...(acc.errored.size > 0 ? { errored: [...acc.errored] } : {}),
    ...(acc.emptyPatch.size > 0 ? { emptyPatch: [...acc.emptyPatch] } : {}),
    ...(merged !== undefined && "receipt" in merged ? { officialGrade: merged.receipt } : {}),
    ...(merged !== undefined && "failures" in merged
      ? { officialGradeFailures: merged.failures }
      : {}),
    ...(acc.rateLimited ? { rateLimited: true } : {}),
  }
}

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
  passRate: `~/runs/${runId}/pass-rate.json`,
  boxGradePredictions: `~/runs/${runId}/preds.grader.json`,
})

/** Did this chunk's grade produce ANY verdict? An all-empty result means the box
 *  died (or produced no report) — the chunk should be re-queued. */
export const earnedVerdict = (r: FullRemoteResult): boolean =>
  (r.resolved?.length ?? 0) +
    (r.unresolved?.length ?? 0) +
    (r.errored?.length ?? 0) +
    (r.emptyPatch?.length ?? 0) >
    0 ||
  // PMX-03/04: a family graded by an OFFICIAL grader produces no legacy arrays at
  // all. Without this clause a fully-graded ProMax chunk reads as "the box died"
  // and is requeued forever.
  officialGradeCoverage(r).size > 0

/** Instances the chunk's official-grade receipt has a disposition for. */
const officialGradeCoverage = (r: FullRemoteResult): ReadonlySet<string> =>
  instancesCoveredByReceipts(r.officialGrade === undefined ? [] : [r.officialGrade])

/** #2: instances the chunk REQUESTED but that earned no verdict. Empty when the
 *  chunk declares no instance set (we then fall back to the any-verdict test).
 *
 *  PMX-03/04: coverage is the UNION of the legacy buckets and the official
 *  grader's dispositions. An `ambiguous` disposition has no legacy bucket, so a
 *  bucket-only subtraction would call it missing and requeue an instance the
 *  grader had already, deliberately, declined to decide. */
export const missingInstances = (r: FullRemoteResult, chunk: PoolChunk): string[] => {
  if (chunk.instanceIds === undefined || chunk.instanceIds.length === 0) return []
  const covered = coveredInstances(r)
  const byReceipt = officialGradeCoverage(r)
  return chunk.instanceIds.filter((id) => !covered.has(id) && !byReceipt.has(id))
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
): string[] => missingInstances(chunkCoverageResult(acc, chunk), chunk)

export const accumulatedCoverageComplete = (
  acc: ChunkCoverageAccumulator,
  chunk: PoolChunk,
): boolean => coverageComplete(chunkCoverageResult(acc, chunk), chunk)
