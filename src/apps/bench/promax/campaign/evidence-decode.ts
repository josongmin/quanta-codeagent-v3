/**
 * PMX-06 — decoding gate EVIDENCE from bytes, fail-closed.
 *
 * The gates are pure predicates over typed evidence. This module is what lets
 * that evidence come off DISK, which is the only way the gates check anything
 * real: inside one process a gate re-checks data the same process just built,
 * and the artefacts of a campaign genuinely travel between machines and sit on
 * disk while the results are produced.
 *
 * Every decode goes through the OWNING parser — `parseOfficialGradeReceipt`
 * (PMX-03) and `parseProMaxImageFreezeReceipt` (PMX-04) — so this module cannot
 * invent a receipt that those parsers would refuse. That is the same discipline
 * PMX-04's remote transport was given: *"remote has no way to MAKE a receipt
 * except by parsing one."*
 *
 * Pure: values in, typed evidence or a list of problems out.
 */
import { parseProMaxImageFreezeReceipt } from "@/apps/bench/harness/promax"
import type { OfficialGradeState } from "@/runner/batch/eval/official-grade"
import { isOfficialGradeState, parseOfficialGradeReceipt } from "@/runner/batch/eval/official-grade"
import type {
  ProMaxArmEvidence,
  ProMaxChunkEvidence,
  ProMaxGateFailureCode,
  ProMaxGateId,
  ProMaxGateResult,
  ProMaxLeakageCheckId,
  ProMaxModelStageEvidence,
  ProMaxPairedRow,
  ProMaxStageEvidence,
} from "./gates"
import { PROMAX_GATE_FAILURE_CODES, PROMAX_GATE_ORDER, PROMAX_LEAKAGE_CHECK_IDS } from "./gates"

export type ProMaxDecode<T> =
  | { readonly ok: true; readonly evidence: T }
  | { readonly ok: false; readonly problems: readonly string[] }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

export const decodeProMaxStageEvidence = (value: unknown): ProMaxDecode<ProMaxStageEvidence> => {
  const problems: string[] = []
  if (!isRecord(value)) return { ok: false, problems: ["evidence document is not a JSON object"] }

  const frozenRecordSha256 = str(value.frozenRecordSha256)
  if (frozenRecordSha256 === null) {
    problems.push(
      "`frozenRecordSha256` is absent — evidence that cites no frozen campaign record cannot be gated",
    )
  }
  const observedAt = str(value.observedAt)
  if (observedAt === null) {
    problems.push(
      "`observedAt` is absent — a gate cannot tell whether the rule predates the results",
    )
  }
  const quanta = value.quanta
  const sha = isRecord(quanta) ? str(quanta.sha) : null
  const dirty = isRecord(quanta) ? quanta.dirty : undefined
  if (sha === null || typeof dirty !== "boolean") {
    problems.push("`quanta` must carry a non-blank `sha` and a boolean `dirty`")
  }

  const receipt = parseOfficialGradeReceipt(value.receipt)
  if (!receipt.ok) {
    problems.push(
      `\`receipt\` is not an official-grade receipt: ${receipt.failures.map((f) => f.code).join(", ")}`,
    )
  }
  // The image-freeze parser owns BYTES (it is the remote transport boundary), so
  // the value is re-serialized rather than hand-validated here — one parser, one
  // verdict, no second spelling of what an image receipt is.
  const imageFreeze = parseProMaxImageFreezeReceipt(JSON.stringify(value.imageFreeze) ?? "")
  if (!imageFreeze.ok) {
    problems.push(
      `\`imageFreeze\` is not an image-freeze receipt: ${imageFreeze.failures.map((f) => f.code).join(", ")}`,
    )
  }

  if (problems.length > 0 || !receipt.ok || !imageFreeze.ok) {
    return { ok: false, problems }
  }
  return {
    ok: true,
    evidence: {
      frozenRecordSha256: String(frozenRecordSha256),
      observedAt: String(observedAt),
      quanta: { sha: String(sha), dirty: dirty === true },
      receipt: receipt.receipt,
      imageFreeze: imageFreeze.receipt,
    },
  }
}

/**
 * The enabled leakage-check ids named by a stage document, appending every rejection
 * reason to `problems`.
 *
 * A unit because the three checks are one question — "is this a check list the gate can
 * act on?" — and they must run together: a caller that validated the shape but skipped
 * the unknown-id sweep would admit ids no check is registered for, and the gate would
 * then silently enforce fewer checks than the document claims.
 */
const decodeLeakageCheckIds = (raw: unknown, problems: string[]): string[] => {
  if (!Array.isArray(raw)) {
    problems.push("`leakageChecks` must be an array of enabled leakage-check ids")
  }
  const ids = (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === "string")
  const known = new Set<string>(PROMAX_LEAKAGE_CHECK_IDS)
  for (const id of ids) {
    if (!known.has(id)) problems.push(`\`leakageChecks\` names unknown check "${id}"`)
  }
  return ids
}

export const decodeProMaxModelStageEvidence = (
  value: unknown,
): ProMaxDecode<ProMaxModelStageEvidence> => {
  const base = decodeProMaxStageEvidence(value)
  if (!base.ok) return base
  const problems: string[] = []
  const record = value as Record<string, unknown>

  const preset = str(record.preset)
  if (preset === null)
    problems.push("`preset` is absent — a model run must name the preset it used")

  const model = record.model
  const provider = isRecord(model) ? str(model.provider) : null
  const modelName = isRecord(model) ? str(model.model) : null
  const effort = isRecord(model) ? model.reasoningEffortDelivered : undefined
  if (provider === null || modelName === null) {
    problems.push("`model` must carry a non-blank `provider` and `model`")
  }
  if (effort !== null && typeof effort !== "string") {
    problems.push(
      "`model.reasoningEffortDelivered` must be the DELIVERED effort or null — never absent, so a " +
        "run cannot omit the field to avoid the comparison",
    )
  }

  // The budget fields are read as a SET: a document carrying two of the three
  // would otherwise decode with the third silently absent, and the gate would
  // then compare `undefined` against a frozen number.
  const rawBudgets = isRecord(record.budgets) ? record.budgets : null
  const budgetFields = ["maxTurns", "maxTokens", "wallClockMs"] as const
  const budgetValues = budgetFields.map((field) =>
    rawBudgets === null ? null : num(rawBudgets[field]),
  )
  if (budgetValues.some((value) => value === null)) {
    problems.push(
      "`budgets` must carry numeric maxTurns, maxTokens and wallClockMs — a run that does not report " +
        "the budgets it ran under cannot be compared with the campaign that froze them",
    )
  }

  const leakageChecks = decodeLeakageCheckIds(record.leakageChecks, problems)

  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    evidence: {
      ...base.evidence,
      preset: String(preset),
      model: {
        provider: String(provider),
        model: String(modelName),
        reasoningEffortDelivered: typeof effort === "string" ? effort : null,
      },
      budgets: {
        maxTurns: Number(budgetValues[0]),
        maxTokens: Number(budgetValues[1]),
        wallClockMs: Number(budgetValues[2]),
      },
      leakageChecks: leakageChecks as readonly ProMaxLeakageCheckId[],
    },
  }
}

const decodePairedRow = (value: unknown, problems: string[]): ProMaxPairedRow | null => {
  if (!isRecord(value)) {
    problems.push("a paired row is not an object")
    return null
  }
  const instanceId = str(value.instanceId)
  if (instanceId === null) {
    problems.push("a paired row names no instance")
    return null
  }
  const state = value.state
  const known: boolean = state === "missing" || isOfficialGradeState(state)
  if (!known) {
    problems.push(`paired row "${instanceId}" has unknown state "${String(state)}"`)
    return null
  }
  return {
    instanceId,
    state: state as OfficialGradeState | "missing",
    // NaN / absent survive as NaN on purpose: the gate refuses them with
    // `paired_metric_missing` rather than this decoder inventing a zero.
    costUsd: num(value.costUsd) ?? Number.NaN,
    turns: num(value.turns) ?? Number.NaN,
    wallMs: num(value.wallMs) ?? Number.NaN,
  }
}

export const decodeProMaxArmEvidence = (value: unknown): ProMaxDecode<ProMaxArmEvidence> => {
  if (!isRecord(value)) return { ok: false, problems: ["arm evidence is not a JSON object"] }
  const problems: string[] = []
  const armName = str(value.armName)
  const preset = str(value.preset)
  if (armName === null) problems.push("an arm names no `armName`")
  if (preset === null) problems.push("an arm names no `preset`")
  const stage = decodeProMaxModelStageEvidence(value.evidence)
  if (!stage.ok) problems.push(...stage.problems)
  const rawRows = value.rows
  if (!Array.isArray(rawRows)) problems.push("`rows` must be an array of paired rows")
  const rows = (Array.isArray(rawRows) ? rawRows : [])
    .map((row) => decodePairedRow(row, problems))
    .filter((row): row is ProMaxPairedRow => row !== null)
  if (problems.length > 0 || !stage.ok) return { ok: false, problems }
  return {
    ok: true,
    evidence: { armName: String(armName), preset: String(preset), evidence: stage.evidence, rows },
  }
}

export const decodeProMaxChunks = (
  value: unknown,
): ProMaxDecode<readonly ProMaxChunkEvidence[]> => {
  if (!Array.isArray(value)) return { ok: false, problems: ["`chunks` is not an array"] }
  const problems: string[] = []
  const chunks: ProMaxChunkEvidence[] = []
  for (const raw of value) {
    if (!isRecord(raw)) {
      problems.push("a chunk is not an object")
      continue
    }
    const chunkId = str(raw.chunkId)
    const ids = raw.assignedInstanceIds
    const attempts = num(raw.attempts)
    if (
      chunkId === null ||
      !Array.isArray(ids) ||
      attempts === null ||
      typeof raw.delivered !== "boolean"
    ) {
      problems.push(
        "a chunk must carry chunkId, assignedInstanceIds, an integer attempts and a boolean delivered",
      )
      continue
    }
    chunks.push({
      chunkId,
      assignedInstanceIds: ids.filter((id): id is string => typeof id === "string"),
      attempts,
      delivered: raw.delivered,
    })
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, evidence: chunks }
}

const GATE_IDS = new Set<string>(PROMAX_GATE_ORDER)
const FAILURE_CODES = new Set<string>(PROMAX_GATE_FAILURE_CODES)

/** Decode a previously WRITTEN gate result receipt. Gate 6 reads these, so the
 *  "gates 1-5 passed" claim is checked against artefacts, not a caller's word. */
export const decodeProMaxGateResults = (
  value: unknown,
): ProMaxDecode<readonly ProMaxGateResult[]> => {
  if (!Array.isArray(value)) return { ok: false, problems: ["gate results must be an array"] }
  const problems: string[] = []
  const results: ProMaxGateResult[] = []
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.ok !== "boolean" || !GATE_IDS.has(String(raw.gate))) {
      problems.push("a gate result must carry a known `gate` id and a boolean `ok`")
      continue
    }
    const failures = Array.isArray(raw.failures) ? raw.failures : []
    const decodedFailures = failures.flatMap((f) => {
      if (!isRecord(f) || !FAILURE_CODES.has(String(f.code))) {
        problems.push(`gate "${String(raw.gate)}" carries a failure with an unknown code`)
        return []
      }
      return [
        {
          gate: raw.gate as ProMaxGateId,
          code: f.code as ProMaxGateFailureCode,
          message: String(f.message ?? ""),
        },
      ]
    })
    // SELF-CONSISTENCY. The producer computes `ok` as `failures.length === 0`,
    // so a receipt claiming to pass while naming its own refusals never came out
    // of a gate. Gate 6 reads `ok` to decide whether the expensive Full-170 run
    // is allowed, which makes this the one flag worth cross-checking against the
    // rest of the document it travels in.
    if (raw.ok !== (failures.length === 0)) {
      problems.push(
        `gate "${String(raw.gate)}" claims ok=${String(raw.ok)} while carrying ${failures.length} ` +
          "failure(s) — a gate result is ok if and only if it names no failure; REFUSING a receipt " +
          "that contradicts itself",
      )
      continue
    }
    const continuation = raw.continuation
    results.push({
      gate: raw.gate as ProMaxGateId,
      ok: raw.ok,
      failures: decodedFailures,
      summary: null,
      ...(isRecord(continuation)
        ? {
            continuation: {
              pairedInstances: num(continuation.pairedInstances) ?? Number.NaN,
              resolvedDelta: num(continuation.resolvedDelta) ?? Number.NaN,
              costUsdDelta: num(continuation.costUsdDelta) ?? Number.NaN,
              continue: continuation.continue === true,
            },
          }
        : {}),
    })
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, evidence: results }
}
