import { createHash } from "node:crypto"
import { isRecord } from "@/shared"
import { readFileSync } from "node:fs"
import { filesFromPatch } from "@/runner/batch/eval/selection-paths"
import { loadVerdicts, type RunVerdicts } from "./verdicts"

export const ANSWER_KEY_CLEAN_AFTER = "2026-06-22T14:14:55+09:00"

const ANSWER_KEY_CLEAN_AFTER_MS = Date.parse(ANSWER_KEY_CLEAN_AFTER)

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key)

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined

const parsedTimestampMs = (value: unknown): number | undefined => {
  const timestamp = asNonEmptyString(value)
  if (timestamp === undefined) return undefined
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) ? ms : undefined
}

const datasetShapedPredictionRow = (row: Record<string, unknown>): boolean =>
  hasOwn(row, "base_commit") ||
  hasOwn(row, "baseCommit") ||
  hasOwn(row, "FAIL_TO_PASS") ||
  hasOwn(row, "PASS_TO_PASS")

const predictionPatchOf = (row: Record<string, unknown>): string | undefined => {
  const snake = asNonEmptyString(row.model_patch)
  if (snake !== undefined) return snake
  return asNonEmptyString(row.modelPatch)
}

const predictionInstanceIdOf = (row: Record<string, unknown>): string | undefined =>
  asNonEmptyString(row.instance_id) ?? asNonEmptyString(row.instanceId)

export function assertWave2BenchReportProvenance(
  reportJson: unknown,
  sourceLabel = "report",
): asserts reportJson is Record<string, unknown> {
  if (!isRecord(reportJson) || !Array.isArray(reportJson.perInstance)) {
    throw new Error(
      `${sourceLabel}: wave2 analysis requires a bench report carrying perInstance provenance`,
    )
  }
  const timestampMs = parsedTimestampMs(reportJson.timestamp)
  if (timestampMs === undefined) {
    throw new Error(`${sourceLabel}: missing/invalid timestamp; refuse wave2 analysis input`)
  }
  const knobs = isRecord(reportJson.knobs) ? reportJson.knobs : undefined
  const preset = knobs !== undefined ? asNonEmptyString(knobs.preset) : undefined
  if (preset === undefined) {
    throw new Error(`${sourceLabel}: missing knobs.preset; refuse underspecified wave2 report`)
  }
  if (timestampMs < ANSWER_KEY_CLEAN_AFTER_MS) {
    throw new Error(
      `${sourceLabel}: timestamp ${String(
        reportJson.timestamp,
      )} predates answer-key-clean-after ${ANSWER_KEY_CLEAN_AFTER}`,
    )
  }
}

export const loadWave2VerdictsFromFile = (
  path: string,
): { readonly report: Record<string, unknown>; readonly verdicts: RunVerdicts } => {
  const report: unknown = JSON.parse(readFileSync(path, "utf8"))
  assertWave2BenchReportProvenance(report, path)
  return { report, verdicts: loadVerdicts(report) }
}

const parsePredictionArtifact = (text: string): readonly Record<string, unknown>[] | undefined => {
  const trimmed = text.trim()
  if (trimmed === "") return undefined
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return isRecord(parsed) ? [parsed] : undefined
    } catch {
      // Multi-line JSONL also starts with "{" — fall through to per-line parse.
    }
  }
  const rows: Record<string, unknown>[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (line === "") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return undefined
    }
    if (!isRecord(parsed)) return undefined
    rows.push(parsed)
  }
  return rows.length > 0 ? rows : undefined
}

export const modelPatchFromPredictionArtifact = (args: {
  readonly artifactPath: string
  readonly instanceId: string
}): string => {
  const text = readFileSync(args.artifactPath, "utf8")
  const trimmed = text.trimStart()
  if (
    trimmed.startsWith("diff --git ") ||
    trimmed.startsWith("--- ") ||
    trimmed.startsWith("+++ ")
  ) {
    return text
  }
  const rows = parsePredictionArtifact(text)
  if (rows === undefined) return text
  let sawPredictionRow = false
  for (const row of rows) {
    if (datasetShapedPredictionRow(row)) {
      throw new Error(
        `${args.artifactPath}: dataset-shaped row supplied where predictions/model_patch were required`,
      )
    }
    const patch = predictionPatchOf(row)
    if (patch === undefined) continue
    sawPredictionRow = true
    const rowInstanceId = asNonEmptyString(row.instance_id) ?? asNonEmptyString(row.instanceId)
    if (rowInstanceId === args.instanceId) return patch
  }
  if (sawPredictionRow) {
    throw new Error(`${args.artifactPath}: instance "${args.instanceId}" not found in predictions`)
  }
  throw new Error(
    `${args.artifactPath}: prediction artifact must carry model_patch/modelPatch; dataset rows are rejected`,
  )
}

export interface Wave2PredictionRow {
  readonly instanceId: string
  readonly modelPatch: string
  readonly modelPatchDigest: string
  readonly touchedFiles: readonly string[]
}

export const loadWave2PredictionsFromFile = (
  path: string,
): ReadonlyMap<string, Wave2PredictionRow> => {
  const text = readFileSync(path, "utf8")
  const trimmed = text.trimStart()
  if (
    trimmed.startsWith("diff --git ") ||
    trimmed.startsWith("--- ") ||
    trimmed.startsWith("+++ ")
  ) {
    throw new Error(`${path}: expected predictions.jsonl/json, got a raw patch file`)
  }
  const rows = parsePredictionArtifact(text)
  if (rows === undefined) {
    throw new Error(`${path}: unreadable predictions artifact`)
  }
  const byInstance = new Map<string, Wave2PredictionRow>()
  for (const row of rows) {
    if (datasetShapedPredictionRow(row)) {
      throw new Error(
        `${path}: dataset-shaped row supplied where predictions/model_patch were required`,
      )
    }
    const instanceId = predictionInstanceIdOf(row)
    const modelPatch = predictionPatchOf(row)
    if (instanceId === undefined || modelPatch === undefined) {
      throw new Error(
        `${path}: each prediction row must carry instance_id/instanceId and model_patch/modelPatch`,
      )
    }
    if (byInstance.has(instanceId)) {
      throw new Error(`${path}: duplicate prediction row for instance "${instanceId}"`)
    }
    byInstance.set(instanceId, {
      instanceId,
      modelPatch,
      modelPatchDigest: createHash("sha256").update(modelPatch, "utf8").digest("hex"),
      touchedFiles: filesFromPatch(modelPatch),
    })
  }
  return byInstance
}
