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
import { isRecord } from "@/shared"

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
  /**
   * Re-runnable measurement-holes — a SUBSET of `errored` (it is intentionally
   * NOT removed from `errored`, so `diff.ts`'s `bUnmeasured = errored ∪
   * emptyPatch` stays correct). These are the terminations that are our-fault /
   * infra and re-runnable, so they must be EXCLUDED from the leaderboard
   * solve-rate denominator rather than counted as a capability miss:
   *   - `throttled`      (rate-limit / 429 / usage-limit)
   *   - `harness_error`  (grading/runner infra failure)
   *   - `grader_invalid` (grader produced no usable verdict)
   * Genuine misses that STAY counted (NOT here): `timeout`, `hung_stream`,
   * `generation_error`, `emptyPatch`, plain `unresolved` (wrong fix).
   * For the swebench HARNESS report shape, `error_ids` are infra/grading
   * errors by convention (distinct from `unresolved_ids`) → all re-runnable.
   */
  readonly reRunnable: ReadonlySet<string>
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

type VerdictStatus =
  | "resolved"
  | "localStructural"
  | "researchContaminated"
  | "unresolved"
  | "errored"
  | "emptyPatch"

const VERDICT_STRENGTH: Record<VerdictStatus, number> = {
  emptyPatch: 0,
  errored: 1,
  unresolved: 2,
  researchContaminated: 3,
  localStructural: 4,
  resolved: 5,
}

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
  "throttled",
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

// Re-runnable measurement-holes among the errored terminations: throttle
// (our-fault / infra), grading/runner infra, grader output failures. These are
// EXCLUDED from the leaderboard solve-rate. `timeout` / `hung_stream` /
// `generation_error` are deliberately NOT here — they are genuine misses.
const RE_RUNNABLE_TERMINATIONS = new Set(["throttled", "harness_error", "grader_invalid"])

const rowTermination = (row: Record<string, unknown>): string | undefined => {
  const failure = row.failure
  return isRecord(failure) && typeof failure.termination === "string"
    ? failure.termination
    : undefined
}

const rowScoreLabel = (
  row: Record<string, unknown>,
): "official_harness" | "local_structural" | "research_contaminated" | undefined => {
  const raw = row.scoreLabel
  return raw === "official_harness" || raw === "local_structural" || raw === "research_contaminated"
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

const countDistinctIds = (
  perInstance: readonly unknown[],
  predicate: (row: Record<string, unknown>) => boolean,
): number => {
  const ids = new Set<string>()
  for (const raw of perInstance) {
    if (!isRecord(raw) || !predicate(raw)) continue
    const id = raw.id
    if (typeof id === "string" && id.length > 0) ids.add(id)
  }
  return ids.size
}

const hasOwn = (row: Record<string, unknown>, key: string): boolean => Object.hasOwn(row, key)

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

const verdictStatusOf = (row: Record<string, unknown>): VerdictStatus => {
  if (row.passed === true) {
    const label = rowScoreLabel(row)
    if (label === "research_contaminated") return "researchContaminated"
    if (label === "local_structural") return "localStructural"
    return rowIsOfficialHarnessResolved(row) ? "resolved" : "localStructural"
  }
  if (rowIsErrored(row)) return "errored"
  if (rowIsEmptyPatch(row)) return "emptyPatch"
  return "unresolved"
}

interface CanonicalPerInstanceRow {
  readonly id: string
  readonly row: Record<string, unknown>
  readonly verdict: VerdictStatus
}

const canonicalPerInstanceRows = (
  perInstance: readonly unknown[],
): readonly CanonicalPerInstanceRow[] => {
  const canonical = new Map<
    string,
    { row: Record<string, unknown>; verdict: VerdictStatus; order: number }
  >()
  for (const [order, raw] of perInstance.entries()) {
    if (!isRecord(raw)) continue
    const id = raw.id
    if (typeof id !== "string" || id.length === 0) continue
    const verdict = verdictStatusOf(raw)
    const existing = canonical.get(id)
    if (
      existing === undefined ||
      VERDICT_STRENGTH[verdict] > VERDICT_STRENGTH[existing.verdict] ||
      (VERDICT_STRENGTH[verdict] === VERDICT_STRENGTH[existing.verdict] && order > existing.order)
    ) {
      canonical.set(id, { row: raw, verdict, order })
    }
  }
  return [...canonical.entries()].map(([id, entry]) => ({
    id,
    row: entry.row,
    verdict: entry.verdict,
  }))
}

const reportTotalsFromOurReport = (args: {
  report: Record<string, unknown>
  perInstance: readonly unknown[]
  telemetryPresenceRows: readonly unknown[]
  proofMissingCount: number
  infraBlockedCount: number
  contractOnlyBlockedCount: number
  contractOnlySubmittedCount: number
}): RunReportTotals => {
  const proofTotals = isRecord(args.report.proofTotals) ? args.report.proofTotals : undefined
  const llmEvidenceTotals = isRecord(args.report.llmEvidenceTotals)
    ? args.report.llmEvidenceTotals
    : undefined
  const perInstanceProofTelemetry = hasPerInstanceProofTelemetry(args.telemetryPresenceRows)
  return {
    submittedWithProof:
      asCount(proofTotals?.submittedWithProof) ??
      (perInstanceProofTelemetry
        ? countDistinctIds(args.perInstance, (row) => row.submittedCandidateProof === true)
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
    packetizedGenerationCount: asCount(llmEvidenceTotals?.packetizedGenerationCount) ?? null,
    packetizedRepairCount: asCount(llmEvidenceTotals?.packetizedRepairCount) ?? null,
    packetizedSelectionExplanationCount:
      asCount(llmEvidenceTotals?.packetizedSelectionExplanationCount) ?? null,
  }
}

const fromOurReport = (
  report: Record<string, unknown>,
  perInstance: readonly unknown[],
): RunVerdicts => {
  const canonicalRows = canonicalPerInstanceRows(perInstance)
  const canonicalTelemetryRows = canonicalRows.map(({ row }) => row)
  const proofMissing = new Set<string>()
  const infraBlocked = new Set<string>()
  const contractOnlyBlocked = new Set<string>()
  const contractOnlySubmitted = new Set<string>()
  for (const { id, row } of canonicalRows) {
    if (row.proofRequiredMissing === true) proofMissing.add(id)
    if (row.envPrepFailed === true || row.proofState === "infra_blocked") infraBlocked.add(id)
    if (row.contractOnlyBlocked === true) contractOnlyBlocked.add(id)
    if (row.contractOnlySubmitted === true) contractOnlySubmitted.add(id)
  }
  const resolved = new Set<string>()
  const localStructural = new Set<string>()
  const researchContaminated = new Set<string>()
  const unresolved = new Set<string>()
  const errored = new Set<string>()
  const emptyPatch = new Set<string>()
  const reRunnable = new Set<string>()
  for (const { id, verdict, row } of canonicalRows) {
    if (verdict === "resolved") resolved.add(id)
    else if (verdict === "localStructural") localStructural.add(id)
    else if (verdict === "researchContaminated") researchContaminated.add(id)
    else if (verdict === "unresolved") unresolved.add(id)
    else if (verdict === "errored") {
      errored.add(id)
      const t = rowTermination(row)
      if (t !== undefined && RE_RUNNABLE_TERMINATIONS.has(t)) reRunnable.add(id)
    } else emptyPatch.add(id)
  }
  const reportTotals = reportTotalsFromOurReport({
    report,
    perInstance: canonicalTelemetryRows,
    telemetryPresenceRows: perInstance,
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
    reRunnable,
    reportTotals,
  }
}

const fromHarnessReport = (r: Record<string, unknown>): RunVerdicts => {
  const verdictById = new Map<string, VerdictStatus>()
  const remember = (ids: readonly string[], verdict: VerdictStatus): void => {
    for (const id of ids) {
      const existing = verdictById.get(id)
      if (existing === undefined || VERDICT_STRENGTH[verdict] > VERDICT_STRENGTH[existing]) {
        verdictById.set(id, verdict)
      }
    }
  }
  remember(strArray(r.empty_patch_ids), "emptyPatch")
  remember(strArray(r.error_ids), "errored")
  remember(strArray(r.unresolved_ids), "unresolved")
  remember(strArray(r.resolved_ids), "resolved")
  const resolved = new Set<string>()
  const unresolved = new Set<string>()
  const errored = new Set<string>()
  const emptyPatch = new Set<string>()
  for (const [id, verdict] of verdictById) {
    if (verdict === "resolved") resolved.add(id)
    else if (verdict === "unresolved") unresolved.add(id)
    else if (verdict === "errored") errored.add(id)
    else if (verdict === "emptyPatch") emptyPatch.add(id)
  }
  return {
    resolved,
    localStructural: new Set<string>(),
    researchContaminated: new Set<string>(),
    proofMissing: new Set<string>(),
    infraBlocked: new Set<string>(),
    contractOnlyBlocked: new Set<string>(),
    contractOnlySubmitted: new Set<string>(),
    unresolved,
    errored,
    emptyPatch,
    // swebench `error_ids` = harness/grading infra failures (distinct from
    // `unresolved_ids` real misses) → re-runnable. The shape carries no
    // per-instance termination, so the whole errored set is re-runnable here.
    reRunnable: new Set<string>(errored),
  }
}

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
