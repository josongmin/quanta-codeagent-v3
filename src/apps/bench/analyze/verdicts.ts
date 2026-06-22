/**
 * ADR-0536 P0 — bench ANALYSIS layer (PURE).
 *
 * Normalises the two report shapes the bench world produces into one
 * `RunVerdicts` value (six disjoint-ish sets of instance ids):
 *
 *   1. OUR bench `report.json` (built by `@/runner/batch/report` →
 *      `src/apps/bench/index.ts writeArtifacts`):
 *        { perInstance:[{ id, passed, patchBytes?, failure?:{termination,signals} }] }
 *
 *   2. The official swebench HARNESS report json (remote grading):
 *        { resolved_ids:[], unresolved_ids:[], error_ids:[], empty_patch_ids:[] }
 *
 * Detection is structural (presence of `perInstance` vs `resolved_ids`), never
 * by a version field — both shapes are produced by tools we don't control the
 * versioning of.
 *
 * No I/O beyond reading the file in `loadVerdictsFromFile`; the core
 * `loadVerdicts` is a pure unknown→value transform.
 */

import { readFileSync } from "node:fs"

export interface RunVerdicts {
  readonly resolved: ReadonlySet<string>
  readonly localStructural: ReadonlySet<string>
  readonly researchContaminated: ReadonlySet<string>
  readonly proofMissing: ReadonlySet<string>
  readonly infraBlocked: ReadonlySet<string>
  readonly contractOnlyBlocked: ReadonlySet<string>
  readonly contractOnlySubmitted: ReadonlySet<string>
  readonly unresolved: ReadonlySet<string>
  readonly errored: ReadonlySet<string>
  readonly emptyPatch: ReadonlySet<string>
  /** Bench-report-only aggregate telemetry. Absent for harness-only report shapes. */
  readonly reportTotals?: RunReportTotals
}

export type RunReportCount = number | null

export interface RunReportTotals {
  readonly submittedWithProof: RunReportCount
  readonly blockedProofMissing: RunReportCount
  readonly blockedEnvFailed: RunReportCount
  readonly contractOnlyBlocked: RunReportCount
  readonly contractOnlySubmitted: RunReportCount
  readonly packetizedGenerationCount: RunReportCount
  readonly packetizedRepairCount: RunReportCount
  readonly packetizedSelectionExplanationCount: RunReportCount
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Best-effort string-array coercion. Accepts a real array of strings OR a
 *  JSON-encoded string array (some swebench exports double-encode the id
 *  arrays). Anything else → []. */
const strArray = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0)
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v)
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      }
    } catch {
      // not JSON — fall through
    }
  }
  return []
}

/** A `perInstance` row carries an empty patch when the report explicitly says
 *  `patchBytes === 0` OR the structured failure classifier tagged an
 *  `empty_patch` signal (covers the case where patchBytes is absent/legacy). */
const rowIsEmptyPatch = (row: Record<string, unknown>): boolean => {
  if (typeof row.patchBytes === "number" && row.patchBytes === 0) return true
  const failure = row.failure
  if (isRecord(failure)) {
    const signals = failure.signals
    if (Array.isArray(signals) && signals.includes("empty_patch")) return true
  }
  return false
}

// Some typed terminal failures still carry patchBytes=0 / empty_patch because
// no prediction was emitted; error authority must win over the empty-patch
// convenience bucket or provider/harness failures get flattened away.
const ERRORED_TERMINATIONS = new Set([
  "harness_error",
  "generation_error",
  "timeout",
  "hung_stream",
  "grader_invalid",
])

const rowIsErrored = (row: Record<string, unknown>): boolean => {
  const failure = row.failure
  if (
    isRecord(failure) &&
    typeof failure.termination === "string" &&
    ERRORED_TERMINATIONS.has(failure.termination)
  ) {
    return true
  }
  return false
}

const rowScoreLabel = (
  row: Record<string, unknown>,
): "official_harness" | "local_structural" | "research_contaminated" | undefined => {
  const raw = row.scoreLabel
  return raw === "official_harness" ||
    raw === "local_structural" ||
    raw === "research_contaminated"
    ? raw
    : undefined
}

const rowIsOfficialHarnessResolved = (row: Record<string, unknown>): boolean => {
  const label = rowScoreLabel(row)
  if (label !== undefined) return label === "official_harness"
  const breakdown = row.gradeBreakdown
  return isRecord(breakdown) && breakdown.resolved === true
}

const asCount = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined

const countRows = (
  perInstance: readonly unknown[],
  predicate: (row: Record<string, unknown>) => boolean,
): number =>
  perInstance.reduce<number>(
    (total: number, raw) => (isRecord(raw) && predicate(raw) ? total + 1 : total),
    0,
  )

const hasOwn = (row: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(row, key)

const hasPerInstanceProofTelemetry = (perInstance: readonly unknown[]): boolean =>
  perInstance.some(
    (raw) =>
      isRecord(raw) &&
      (hasOwn(raw, "submittedCandidateProof") ||
        hasOwn(raw, "proofRequiredMissing") ||
        hasOwn(raw, "envPrepFailed") ||
        raw.proofState === "infra_blocked" ||
        hasOwn(raw, "contractOnlyBlocked") ||
        hasOwn(raw, "contractOnlySubmitted")),
  )

const reportTotalsFromOurReport = (args: {
  report: Record<string, unknown>
  perInstance: readonly unknown[]
  proofMissingCount: number
  infraBlockedCount: number
  contractOnlyBlockedCount: number
  contractOnlySubmittedCount: number
}): RunReportTotals => {
  const proofTotals = isRecord(args.report.proofTotals) ? args.report.proofTotals : undefined
  const llmEvidenceTotals = isRecord(args.report.llmEvidenceTotals) ? args.report.llmEvidenceTotals : undefined
  const perInstanceProofTelemetry = hasPerInstanceProofTelemetry(args.perInstance)
  return {
    submittedWithProof:
      asCount(proofTotals?.submittedWithProof) ??
      (perInstanceProofTelemetry
        ? countRows(args.perInstance, (row) => row.submittedCandidateProof === true)
        : null),
    blockedProofMissing:
      asCount(proofTotals?.blockedProofMissing) ??
      (perInstanceProofTelemetry ? args.proofMissingCount : null),
    blockedEnvFailed:
      asCount(proofTotals?.blockedEnvFailed) ??
      (perInstanceProofTelemetry ? args.infraBlockedCount : null),
    contractOnlyBlocked:
      asCount(proofTotals?.contractOnlyBlocked) ??
      (perInstanceProofTelemetry ? args.contractOnlyBlockedCount : null),
    contractOnlySubmitted:
      asCount(proofTotals?.contractOnlySubmitted) ??
      (perInstanceProofTelemetry ? args.contractOnlySubmittedCount : null),
    packetizedGenerationCount:
      asCount(llmEvidenceTotals?.packetizedGenerationCount) ?? null,
    packetizedRepairCount:
      asCount(llmEvidenceTotals?.packetizedRepairCount) ?? null,
    packetizedSelectionExplanationCount:
      asCount(llmEvidenceTotals?.packetizedSelectionExplanationCount) ?? null,
  }
}

const fromOurReport = (report: Record<string, unknown>, perInstance: readonly unknown[]): RunVerdicts => {
  const resolved = new Set<string>()
  const localStructural = new Set<string>()
  const researchContaminated = new Set<string>()
  const proofMissing = new Set<string>()
  const infraBlocked = new Set<string>()
  const contractOnlyBlocked = new Set<string>()
  const contractOnlySubmitted = new Set<string>()
  const unresolved = new Set<string>()
  const errored = new Set<string>()
  const emptyPatch = new Set<string>()
  for (const raw of perInstance) {
    if (!isRecord(raw)) continue
    const id = raw.id
    if (typeof id !== "string" || id.length === 0) continue
    if (raw.proofRequiredMissing === true) proofMissing.add(id)
    if (raw.envPrepFailed === true || raw.proofState === "infra_blocked") infraBlocked.add(id)
    if (raw.contractOnlyBlocked === true) contractOnlyBlocked.add(id)
    if (raw.contractOnlySubmitted === true) contractOnlySubmitted.add(id)
    if (raw.passed === true) {
      const label = rowScoreLabel(raw)
      if (label === "research_contaminated") researchContaminated.add(id)
      else if (label === "local_structural") localStructural.add(id)
      else if (rowIsOfficialHarnessResolved(raw)) resolved.add(id)
      else localStructural.add(id)
      continue
    }
    // A failed instance can be BOTH errored and empty-patch-ish; classify it
    // into the most specific failure bucket first (errored > emptyPatch >
    // unresolved) so each id lands in exactly one set.
    if (rowIsErrored(raw)) {
      errored.add(id)
    } else if (rowIsEmptyPatch(raw)) {
      emptyPatch.add(id)
    } else {
      unresolved.add(id)
    }
  }
  const reportTotals = reportTotalsFromOurReport({
    report,
    perInstance,
    proofMissingCount: proofMissing.size,
    infraBlockedCount: infraBlocked.size,
    contractOnlyBlockedCount: contractOnlyBlocked.size,
    contractOnlySubmittedCount: contractOnlySubmitted.size,
  })
  return {
    resolved,
    localStructural,
    researchContaminated,
    proofMissing,
    infraBlocked,
    contractOnlyBlocked,
    contractOnlySubmitted,
    unresolved,
    errored,
    emptyPatch,
    reportTotals,
  }
}

const fromHarnessReport = (r: Record<string, unknown>): RunVerdicts => ({
  resolved: new Set(strArray(r.resolved_ids)),
  localStructural: new Set<string>(),
  researchContaminated: new Set<string>(),
  proofMissing: new Set<string>(),
  infraBlocked: new Set<string>(),
  contractOnlyBlocked: new Set<string>(),
  contractOnlySubmitted: new Set<string>(),
  unresolved: new Set(strArray(r.unresolved_ids)),
  errored: new Set(strArray(r.error_ids)),
  emptyPatch: new Set(strArray(r.empty_patch_ids)),
})

export const loadVerdicts = (reportJson: unknown): RunVerdicts => {
  if (!isRecord(reportJson)) {
    throw new Error("loadVerdicts: report is not an object")
  }
  if (Array.isArray(reportJson.perInstance)) {
    return fromOurReport(reportJson, reportJson.perInstance)
  }
  if (
    "resolved_ids" in reportJson ||
    "unresolved_ids" in reportJson ||
    "error_ids" in reportJson ||
    "empty_patch_ids" in reportJson
  ) {
    return fromHarnessReport(reportJson)
  }
  throw new Error(
    "loadVerdicts: unrecognised report shape (no `perInstance` and no `*_ids` fields)",
  )
}

export const loadVerdictsFromFile = (path: string): RunVerdicts =>
  loadVerdicts(JSON.parse(readFileSync(path, "utf8")))
