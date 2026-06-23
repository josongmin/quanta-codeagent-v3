/**
 * REMOTE VERDICT PARSING (cohesive, PURE seam). Turn a fetched remote report.json
 * STRING into the four disjoint verdict id-sets the chunk result + box snapshot
 * are built from, plus the small pure predicates over a finished chunk (rate-limit
 * detection, covered-instance set, report-text classification). Touches no ssh /
 * no lifecycle / no IO, so it is unit-tested directly instead of only through a
 * full provision+grade round-trip.
 */

import { loadVerdicts } from "../../analyze/verdicts"
import type { FullRemoteResult, GradeChunkVerdicts, ReportTextStatus } from "./types"

/** Did the box run log show the shared-OAuth rate limit? The CANONICAL marker the
 *  runtime emits for a throttled login is `generation_error` (same class the
 *  sweep's TRANS_RE watches); "rate limit" / "too many requests" cover a raw
 *  provider error. PURE — testable.
 *
 *  NOTE: a BARE `429` is deliberately NOT matched — instance ids and turn counts
 *  routinely contain `429` (`psf__requests-429`, `turns=429`), so it would
 *  false-positive and waste a backoff on a perfectly clean chunk. Only a 429 in an
 *  http/status context counts. */
export const detectRateLimit = (logTail: string): boolean =>
  /generation_error|too many requests|rate[ _-]?limit|(?:http|status)[ /:]*429/i.test(logTail)

/** Every instance that earned ANY verdict in `r` — resolved / unresolved /
 *  errored / emptyPatch. The COMPLEMENT (an expected instance absent from all
 *  four) is a box-loss: spot reclaim or ssh-255 killed the box before that
 *  instance's verdict was written. A grade-concurrency pipeline spreads grading
 *  across the run, so a mid-run death leaves a PARTIAL report — exactly the case
 *  the old all-or-nothing empty-check missed (silent under-count). */
export const coveredInstances = (r: FullRemoteResult): Set<string> =>
  new Set<string>([
    ...(r.resolved ?? []),
    ...(r.unresolved ?? []),
    ...(r.errored ?? []),
    ...(r.emptyPatch ?? []),
  ])

export const emptyVerdicts = (): GradeChunkVerdicts => ({
  resolved: [],
  unresolved: [],
  errored: [],
  emptyPatch: [],
})

/** Parse a fetched remote report.json STRING into the four verdict id-sets.
 *  Tolerant: a missing/empty/invalid-JSON report yields {@link emptyVerdicts}
 *  (the run is then surfaced as a box-loss / no-verdict, never a crash). */
export const parseVerdicts = (reportText: string): GradeChunkVerdicts => {
  try {
    const v = loadVerdicts(JSON.parse(reportText))
    return {
      resolved: [...v.resolved],
      unresolved: [...v.unresolved],
      errored: [...v.errored],
      emptyPatch: [...v.emptyPatch],
    }
  } catch {
    return emptyVerdicts()
  }
}

export const classifyReportText = (reportText: string): ReportTextStatus => {
  if (reportText.trim() === "") return "empty"
  try {
    JSON.parse(reportText)
    return "ok"
  } catch {
    return "unparseable"
  }
}

/** Total instances that earned ANY verdict — 0 ⇒ the chunk produced nothing
 *  gradeable (drives the "no verdicts in report" diagnostics + box-loss path). */
export const verdictCount = (verdicts: GradeChunkVerdicts): number =>
  verdicts.resolved.length +
  verdicts.unresolved.length +
  verdicts.errored.length +
  verdicts.emptyPatch.length
