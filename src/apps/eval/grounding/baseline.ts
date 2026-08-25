import type { RunSummaryRecord } from "../storage"

export type GroundingBaselineStatus =
  | "resolved"
  | "candidate_missing"
  | "candidate_unverified"
  | "not_found"

export interface GroundingBaselineResolution {
  status: GroundingBaselineStatus
  candidateRunId: string
  baselineRunId?: string
  reason: string
  suite?: string
  corpus?: string
  mode?: string
  probeProfile?: string
  normalizationProfile?: string
  harnessFingerprint?: string
  routeFingerprint?: string
  executionContractFingerprint?: string
  caseSetFingerprint?: string
}

const runParamString = (summary: RunSummaryRecord, key: string): string | undefined => {
  const value = summary.params?.[key]
  return typeof value === "string" ? value : undefined
}

/** The run params that decide whether two grounding runs may be compared at
 *  all. Every use of this list — extraction, the completeness gate, and the
 *  equality test — MUST iterate this one array; the bug this replaces was the
 *  same nine names spelled out four times, so adding a tenth field meant
 *  editing four places and silently comparing on eight if you missed one. */
const COMPARABILITY_FIELDS = [
  "suite",
  "corpus",
  "mode",
  "probeProfile",
  "normalizationProfile",
  "harnessFingerprint",
  "routeFingerprint",
  "executionContractFingerprint",
  "caseSetFingerprint",
] as const

type ComparabilityField = (typeof COMPARABILITY_FIELDS)[number]
/** Partial because a run summary written by an older build can be missing any
 *  of them; keys are inserted in `COMPARABILITY_FIELDS` order so spreading
 *  this into a resolution reproduces the field order the readers expect. */
type PartialComparability = { [K in ComparabilityField]?: string }
type Comparability = Record<ComparabilityField, string>

/** Reads the comparability params off one summary. Absent / non-string values
 *  leave the key OUT (not `undefined`) so the result can be spread directly
 *  into a resolution under `exactOptionalPropertyTypes`. */
const readComparability = (summary: RunSummaryRecord): PartialComparability => {
  const out: PartialComparability = {}
  for (const field of COMPARABILITY_FIELDS) {
    const value = runParamString(summary, field)
    if (value !== undefined) out[field] = value
  }
  return out
}

/** Completeness gate AND type narrowing in one: downstream code needs every
 *  field to be a definite `string` to compare against and to report. */
const isComplete = (fields: PartialComparability): fields is Comparability =>
  COMPARABILITY_FIELDS.every((field) => fields[field] !== undefined)

/** A prior summary is a usable baseline only when it is a DIFFERENT, finished,
 *  strictly-earlier grounding run whose comparability params all match. Kept
 *  as its own unit so the four structural gates and the field comparison read
 *  as one rule instead of a closure buried in a `.find`. */
const isComparableBaseline = (
  summary: RunSummaryRecord,
  candidateRunId: string,
  candidateTs: number,
  want: Comparability,
): boolean => {
  if (summary.tier !== "grounding") return false
  if (summary.runId === candidateRunId) return false
  if (summary.status !== undefined && summary.status !== "finished") return false
  if (summary.ts >= candidateTs) return false
  return COMPARABILITY_FIELDS.every((field) => runParamString(summary, field) === want[field])
}

export const resolveGroundingBaseline = (
  candidateRunId: string,
  summaries: readonly RunSummaryRecord[],
): GroundingBaselineResolution => {
  const candidate = summaries.find(
    (summary) => summary.tier === "grounding" && summary.runId === candidateRunId,
  )
  if (candidate === undefined) {
    return {
      status: "candidate_missing",
      candidateRunId,
      reason: "candidate run summary not found",
    }
  }
  const fields = readComparability(candidate)
  if (!isComplete(fields)) {
    return {
      status: "candidate_unverified",
      candidateRunId,
      reason: "candidate run summary is missing corpus/mode/profile or fingerprint fields",
      ...fields,
    }
  }
  const baseline = summaries.find((summary) =>
    isComparableBaseline(summary, candidateRunId, candidate.ts, fields),
  )
  if (baseline === undefined) {
    return {
      status: "not_found",
      candidateRunId,
      reason: "no prior finished grounding run matched corpus/mode/profiles and fingerprints",
      ...fields,
    }
  }
  return {
    status: "resolved",
    candidateRunId,
    baselineRunId: baseline.runId,
    reason: "resolved latest prior finished comparable grounding run",
    ...fields,
  }
}
