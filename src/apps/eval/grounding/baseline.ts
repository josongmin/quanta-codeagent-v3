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
  const suite = runParamString(candidate, "suite")
  const corpus = runParamString(candidate, "corpus")
  const mode = runParamString(candidate, "mode")
  const probeProfile = runParamString(candidate, "probeProfile")
  const normalizationProfile = runParamString(candidate, "normalizationProfile")
  const harnessFingerprint = runParamString(candidate, "harnessFingerprint")
  const routeFingerprint = runParamString(candidate, "routeFingerprint")
  const executionContractFingerprint = runParamString(candidate, "executionContractFingerprint")
  const caseSetFingerprint = runParamString(candidate, "caseSetFingerprint")
  if (
    suite === undefined ||
    corpus === undefined ||
    mode === undefined ||
    probeProfile === undefined ||
    normalizationProfile === undefined ||
    harnessFingerprint === undefined ||
    routeFingerprint === undefined ||
    executionContractFingerprint === undefined ||
    caseSetFingerprint === undefined
  ) {
    return {
      status: "candidate_unverified",
      candidateRunId,
      reason: "candidate run summary is missing corpus/mode/profile or fingerprint fields",
      ...(suite !== undefined ? { suite } : {}),
      ...(corpus !== undefined ? { corpus } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(probeProfile !== undefined ? { probeProfile } : {}),
      ...(normalizationProfile !== undefined ? { normalizationProfile } : {}),
      ...(harnessFingerprint !== undefined ? { harnessFingerprint } : {}),
      ...(routeFingerprint !== undefined ? { routeFingerprint } : {}),
      ...(executionContractFingerprint !== undefined ? { executionContractFingerprint } : {}),
      ...(caseSetFingerprint !== undefined ? { caseSetFingerprint } : {}),
    }
  }
  const baseline = summaries.find((summary) => {
    if (summary.tier !== "grounding") return false
    if (summary.runId === candidateRunId) return false
    if (summary.status !== undefined && summary.status !== "finished") return false
    if (summary.ts >= candidate.ts) return false
    return (
      runParamString(summary, "suite") === suite &&
      runParamString(summary, "corpus") === corpus &&
      runParamString(summary, "mode") === mode &&
      runParamString(summary, "probeProfile") === probeProfile &&
      runParamString(summary, "normalizationProfile") === normalizationProfile &&
      runParamString(summary, "harnessFingerprint") === harnessFingerprint &&
      runParamString(summary, "routeFingerprint") === routeFingerprint &&
      runParamString(summary, "executionContractFingerprint") === executionContractFingerprint &&
      runParamString(summary, "caseSetFingerprint") === caseSetFingerprint
    )
  })
  if (baseline === undefined) {
    return {
      status: "not_found",
      candidateRunId,
      reason: "no prior finished grounding run matched corpus/mode/profiles and fingerprints",
      suite,
      corpus,
      mode,
      probeProfile,
      normalizationProfile,
      harnessFingerprint,
      routeFingerprint,
      executionContractFingerprint,
      caseSetFingerprint,
    }
  }
  return {
    status: "resolved",
    candidateRunId,
    baselineRunId: baseline.runId,
    reason: "resolved latest prior finished comparable grounding run",
    suite,
    corpus,
    mode,
    probeProfile,
    normalizationProfile,
    harnessFingerprint,
    routeFingerprint,
    executionContractFingerprint,
    caseSetFingerprint,
  }
}
