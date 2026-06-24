import { readFileSync } from "node:fs"
import { byteCompare } from "@/shared/byte-compare"
import { filesFromPatch } from "@/runner/batch/eval/selection-paths"
import type { BenchReport, PerInstanceReport } from "@/runner/batch/report"
import {
  assertWave2BenchReportProvenance,
  loadWave2PredictionsFromFile,
  type Wave2PredictionRow,
} from "./wave2-guards"

export type Wave2CoverageClass =
  | "same-files wrong-fix"
  | "partial overlap"
  | "disjoint localization"

interface DatasetRow {
  readonly instanceId: string
  readonly goldFiles: readonly string[]
}

export interface Wave2Snapshot {
  readonly instanceId: string
  readonly row: PerInstanceReport
  readonly goldFiles: readonly string[]
  readonly touchedFiles: readonly string[]
  readonly overlapFiles: readonly string[]
  readonly coverageClass: Wave2CoverageClass | undefined
  readonly officialResolved: boolean
  readonly regression: boolean
  readonly emptyPatch: boolean
  readonly nonEmptyUnresolved: boolean
  readonly oracleFailure: string | undefined
}

export interface Wave2AbArmSummary {
  readonly reportPath: string
  readonly preset: string
  readonly model: string
  readonly compared: number
  readonly officialResolved: number
  readonly regressions: number
  readonly emptyPatch: number
  readonly nonEmptyUnresolved: number
}

export interface Wave2AbRailSummary {
  readonly control: Wave2AbArmSummary
  readonly treatment: Wave2AbArmSummary
  readonly regressionReduction: number
  readonly emptyPatchDelta: number
  readonly nonEmptyUnresolvedDelta: number
}

export interface Wave2CoverageEntry {
  readonly instanceId: string
  readonly goldFiles: readonly string[]
  readonly touchedFiles: readonly string[]
  readonly overlapFiles: readonly string[]
  readonly coverageClass: Wave2CoverageClass
}

export interface Wave2CoverageCensus {
  readonly reportPath: string
  readonly eligibleCases: number
  readonly sameFilesWrongFix: number
  readonly partialOverlap: number
  readonly disjointLocalization: number
  readonly entries: readonly Wave2CoverageEntry[]
}

export interface Wave2BacklogArtifact {
  readonly reportPath: string
  readonly multiSiteCompleteness: readonly Wave2CoverageEntry[]
  readonly generationAccuracy: readonly Wave2CoverageEntry[]
  readonly oracleQuality: readonly {
    readonly instanceId: string
    readonly reason: string
  }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseReport = (path: string): BenchReport => {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  assertWave2BenchReportProvenance(parsed, path)
  return parsed as unknown as BenchReport
}

const datasetRows = (datasetPath: string): ReadonlyMap<string, DatasetRow> => {
  const byId = new Map<string, DatasetRow>()
  const text = readFileSync(datasetPath, "utf8")
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed) || typeof parsed.instance_id !== "string") continue
    const goldPatch = typeof parsed.patch === "string" ? parsed.patch : ""
    byId.set(parsed.instance_id, {
      instanceId: parsed.instance_id,
      goldFiles: filesFromPatch(goldPatch),
    })
  }
  return byId
}

const cleanList = (items: readonly string[]): string[] => {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const v = item.trim()
    if (v === "" || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

const setEq = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  const bs = new Set(b)
  return a.every((value) => bs.has(value))
}

const overlapOf = (a: readonly string[], b: readonly string[]): string[] => {
  const bs = new Set(b)
  return a.filter((value) => bs.has(value))
}

const officialResolved = (row: PerInstanceReport): boolean =>
  row.scoreLabel === "official_harness" || row.gradeBreakdown?.resolved === true

const regression = (row: PerInstanceReport): boolean => (row.gradeBreakdown?.passToPassFailed ?? 0) > 0

const emptyPatch = (row: PerInstanceReport): boolean =>
  row.patchBytes === 0 || row.failure?.signals.includes("empty_patch") === true

const oracleFailureReason = (row: PerInstanceReport): string | undefined => {
  if (row.envPrepFailed === true) return "env_prep_failed"
  if (row.reproTest?.installed === false) return `repro_${row.reproTest.reason}`
  if (row.proofState === "infra_blocked") return "proof_infra_blocked"
  if (row.reproOracleCalibration?.available === false) return "oracle_calibration_unavailable"
  if (row.failure?.termination === "grader_invalid") return "grader_invalid"
  return undefined
}

const touchedFilesOf = (
  row: PerInstanceReport,
  prediction: Wave2PredictionRow | undefined,
  sourceLabel: string,
): readonly string[] => {
  const reportTouched = cleanList(row.touchedFiles ?? [])
  if (prediction !== undefined) {
    if (row.modelPatchDigest !== undefined && row.modelPatchDigest !== prediction.modelPatchDigest) {
      throw new Error(
        `${sourceLabel}: report/predictions patch digest mismatch for instance "${row.id}"`,
      )
    }
    const predictionTouched = cleanList(prediction.touchedFiles)
    if (reportTouched.length > 0 && !setEq(reportTouched, predictionTouched)) {
      throw new Error(
        `${sourceLabel}: report/predictions touchedFiles mismatch for instance "${row.id}"`,
      )
    }
    return predictionTouched
  }
  return reportTouched
}

const coverageClassOf = (
  goldFiles: readonly string[],
  touchedFiles: readonly string[],
): Wave2CoverageClass | undefined => {
  if (goldFiles.length < 2 || touchedFiles.length === 0) return undefined
  if (setEq(goldFiles, touchedFiles)) return "same-files wrong-fix"
  return overlapOf(goldFiles, touchedFiles).length > 0 ? "partial overlap" : "disjoint localization"
}

export const loadWave2Snapshots = (args: {
  readonly datasetPath: string
  readonly reportPath: string
  readonly predictionsPath: string
}): readonly Wave2Snapshot[] => {
  const dataset = datasetRows(args.datasetPath)
  const report = parseReport(args.reportPath)
  const predictions = loadWave2PredictionsFromFile(args.predictionsPath)
  const snapshots: Wave2Snapshot[] = []
  for (const row of report.perInstance) {
    const datasetRow = dataset.get(row.id)
    if (datasetRow === undefined) continue
    const touchedFiles = touchedFilesOf(row, predictions.get(row.id), args.reportPath)
    const overlapFiles = overlapOf(datasetRow.goldFiles, touchedFiles)
    snapshots.push({
      instanceId: row.id,
      row,
      goldFiles: datasetRow.goldFiles,
      touchedFiles,
      overlapFiles,
      coverageClass: coverageClassOf(datasetRow.goldFiles, touchedFiles),
      officialResolved: officialResolved(row),
      regression: regression(row),
      emptyPatch: emptyPatch(row),
      nonEmptyUnresolved: !officialResolved(row) && row.patchBytes > 0,
      oracleFailure: oracleFailureReason(row),
    })
  }
  return snapshots
}

const armSummary = (
  reportPath: string,
  report: BenchReport,
  rows: readonly PerInstanceReport[],
): Wave2AbArmSummary => ({
  reportPath,
  preset: report.knobs.preset ?? "unknown",
  model: report.model,
  compared: rows.length,
  officialResolved: rows.filter(officialResolved).length,
  regressions: rows.filter(regression).length,
  emptyPatch: rows.filter(emptyPatch).length,
  nonEmptyUnresolved: rows.filter((row) => !officialResolved(row) && row.patchBytes > 0).length,
})

export const buildWave2AbRail = (args: {
  readonly controlReportPath: string
  readonly controlPredictionsPath: string
  readonly treatmentReportPath: string
  readonly treatmentPredictionsPath: string
}): Wave2AbRailSummary => {
  const controlReport = parseReport(args.controlReportPath)
  const treatmentReport = parseReport(args.treatmentReportPath)
  // The rail summary is report-driven, but the predictions artifacts are part
  // of the provenance contract: reject dataset-shaped or inconsistent artifacts.
  const controlPredictions = loadWave2PredictionsFromFile(args.controlPredictionsPath)
  const treatmentPredictions = loadWave2PredictionsFromFile(args.treatmentPredictionsPath)
  const controlRows = new Map(controlReport.perInstance.map((row) => [row.id, row] as const))
  const treatmentRows = new Map(treatmentReport.perInstance.map((row) => [row.id, row] as const))
  for (const row of controlReport.perInstance) {
    touchedFilesOf(row, controlPredictions.get(row.id), args.controlReportPath)
  }
  for (const row of treatmentReport.perInstance) {
    touchedFilesOf(row, treatmentPredictions.get(row.id), args.treatmentReportPath)
  }
  const sharedIds = [...controlRows.keys()].filter((id) => treatmentRows.has(id)).sort()
  const controlComparable = sharedIds.flatMap((id) => {
    const row = controlRows.get(id)
    return row === undefined ? [] : [row]
  })
  const treatmentComparable = sharedIds.flatMap((id) => {
    const row = treatmentRows.get(id)
    return row === undefined ? [] : [row]
  })
  const control = armSummary(args.controlReportPath, controlReport, controlComparable)
  const treatment = armSummary(args.treatmentReportPath, treatmentReport, treatmentComparable)
  return {
    control,
    treatment,
    regressionReduction: control.regressions - treatment.regressions,
    emptyPatchDelta: treatment.emptyPatch - control.emptyPatch,
    nonEmptyUnresolvedDelta: treatment.nonEmptyUnresolved - control.nonEmptyUnresolved,
  }
}

const renderWave2AbArm = (label: string, arm: Wave2AbArmSummary): string =>
  `| ${label} | ${arm.preset} | ${arm.compared} | ${arm.officialResolved} | ${arm.regressions} | ${arm.emptyPatch} | ${arm.nonEmptyUnresolved} |`

export const renderWave2AbMarkdown = (summary: Wave2AbRailSummary): string =>
  [
    "## Wave2 A/B Rail",
    "",
    "| arm | preset | compared | official resolved | regressions | empty patch | non-empty unresolved |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    renderWave2AbArm("control", summary.control),
    renderWave2AbArm("treatment", summary.treatment),
    "",
    `Regression reduction (treatment better when positive): ${summary.regressionReduction}`,
    `Empty-patch delta (treatment - control): ${summary.emptyPatchDelta}`,
    `Non-empty unresolved delta (treatment - control): ${summary.nonEmptyUnresolvedDelta}`,
  ].join("\n")

const coverageEntries = (
  snapshots: readonly Wave2Snapshot[],
  limit: number | undefined,
): readonly Wave2CoverageEntry[] => {
  const sorted = [...snapshots]
    .filter(
      (snapshot): snapshot is Wave2Snapshot & { coverageClass: Wave2CoverageClass } =>
        snapshot.goldFiles.length > 1 &&
        snapshot.oracleFailure === undefined &&
        !snapshot.officialResolved &&
        snapshot.coverageClass !== undefined,
    )
    .sort((a, b) => byteCompare(a.instanceId, b.instanceId))
  const chosen = limit !== undefined ? sorted.slice(0, limit) : sorted
  return chosen.map((snapshot) => ({
    instanceId: snapshot.instanceId,
    goldFiles: snapshot.goldFiles,
    touchedFiles: snapshot.touchedFiles,
    overlapFiles: snapshot.overlapFiles,
    coverageClass: snapshot.coverageClass,
  }))
}

export const buildWave2CoverageCensus = (args: {
  readonly datasetPath: string
  readonly reportPath: string
  readonly predictionsPath: string
  readonly minCases?: number
  readonly limit?: number
}): Wave2CoverageCensus => {
  const entries = coverageEntries(loadWave2Snapshots(args), args.limit)
  const minCases = args.minCases ?? 5
  if (entries.length < minCases) {
    throw new Error(
      `${args.reportPath}: need at least ${minCases} oracle-healthy multi-file cases; found ${entries.length}`,
    )
  }
  return {
    reportPath: args.reportPath,
    eligibleCases: entries.length,
    sameFilesWrongFix: entries.filter((entry) => entry.coverageClass === "same-files wrong-fix")
      .length,
    partialOverlap: entries.filter((entry) => entry.coverageClass === "partial overlap").length,
    disjointLocalization: entries.filter(
      (entry) => entry.coverageClass === "disjoint localization",
    ).length,
    entries,
  }
}

export const renderWave2CoverageMarkdown = (census: Wave2CoverageCensus): string =>
  [
    "## Wave2 Coverage Census",
    "",
    `Eligible oracle-healthy multi-file cases: ${census.eligibleCases}`,
    `same-files wrong-fix: ${census.sameFilesWrongFix}`,
    `partial overlap: ${census.partialOverlap}`,
    `disjoint localization: ${census.disjointLocalization}`,
    "",
    "| instance | gold files | our files | overlap | class |",
    "| --- | ---: | ---: | --- | --- |",
    ...census.entries.map(
      (entry) =>
        `| ${entry.instanceId} | ${entry.goldFiles.length} | ${entry.touchedFiles.length} | ${entry.overlapFiles.join(", ") || "-"} | ${entry.coverageClass} |`,
    ),
  ].join("\n")

export const buildWave2BacklogArtifact = (args: {
  readonly datasetPath: string
  readonly reportPath: string
  readonly predictionsPath: string
}): Wave2BacklogArtifact => {
  const snapshots = loadWave2Snapshots(args)
  const coverage = coverageEntries(snapshots, undefined)
  const completenessIds = new Set(
    coverage
      .filter((entry) => entry.coverageClass === "partial overlap")
      .map((entry) => entry.instanceId),
  )
  const generationIds = new Set(
    coverage
      .filter((entry) => entry.coverageClass !== "partial overlap")
      .map((entry) => entry.instanceId),
  )
  const singleFileGeneration = snapshots
    .filter(
      (snapshot) =>
        snapshot.goldFiles.length <= 1 &&
        snapshot.oracleFailure === undefined &&
        !snapshot.officialResolved &&
        snapshot.touchedFiles.length > 0,
    )
    .map((snapshot) => ({
      instanceId: snapshot.instanceId,
      goldFiles: snapshot.goldFiles,
      touchedFiles: snapshot.touchedFiles,
      overlapFiles: snapshot.overlapFiles,
      coverageClass: snapshot.coverageClass ?? "same-files wrong-fix",
    }))
  return {
    reportPath: args.reportPath,
    multiSiteCompleteness: coverage.filter((entry) => completenessIds.has(entry.instanceId)),
    generationAccuracy: [
      ...coverage.filter((entry) => generationIds.has(entry.instanceId)),
      ...singleFileGeneration,
    ].sort((a, b) => byteCompare(a.instanceId, b.instanceId)),
    oracleQuality: snapshots
      .filter((snapshot) => snapshot.oracleFailure !== undefined)
      .map((snapshot) => ({
        instanceId: snapshot.instanceId,
        reason: snapshot.oracleFailure ?? "unknown",
      }))
      .sort((a, b) => byteCompare(a.instanceId, b.instanceId)),
  }
}

export const renderWave2BacklogMarkdown = (artifact: Wave2BacklogArtifact): string => {
  const renderCoverageSection = (
    title: string,
    entries: readonly Wave2CoverageEntry[],
  ): readonly string[] => [
    `### ${title}`,
    entries.length === 0
      ? "(none)"
      : "| instance | gold files | our files | overlap | class |\n| --- | ---: | ---: | --- | --- |\n" +
          entries
            .map(
              (entry) =>
                `| ${entry.instanceId} | ${entry.goldFiles.length} | ${entry.touchedFiles.length} | ${entry.overlapFiles.join(", ") || "-"} | ${entry.coverageClass} |`,
            )
            .join("\n"),
  ]
  const renderOracleSection = (
    entries: readonly { readonly instanceId: string; readonly reason: string }[],
  ): readonly string[] => [
    "### Oracle-Quality Failures",
    entries.length === 0
      ? "(none)"
      : "| instance | reason |\n| --- | --- |\n" +
          entries.map((entry) => `| ${entry.instanceId} | ${entry.reason} |`).join("\n"),
  ]
  return [
    "## Wave2 Follow-on Backlog",
    "",
    ...renderCoverageSection("Multi-Site / Completeness Failures", artifact.multiSiteCompleteness),
    "",
    ...renderCoverageSection("Generation-Accuracy Failures", artifact.generationAccuracy),
    "",
    ...renderOracleSection(artifact.oracleQuality),
  ].join("\n")
}
