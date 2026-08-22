/**
 * PMX-03 — fail-closed construction, derivation, and round-tripping of the
 * official-grade receipt.
 *
 * Failures ACCUMULATE rather than short-circuit: an operator debugging a bad
 * grading run should see every defect at once, and one loud defect must never
 * mask a quieter one.
 *
 * `missing` is computed HERE and only here.
 */
import type {
  OfficialEvaluatorSideSummary,
  OfficialEvaluatorSummary,
  OfficialGradeDisposition,
  OfficialGradeEvaluatorMeta,
  OfficialGradeReceipt,
  OfficialGradeReceiptFailure,
  OfficialGradeReceiptFailureCode,
  OfficialGradeReceiptResult,
  OfficialGradeSummary,
  RawArtifactRef,
} from "./types"
import {
  GRADING_VALID_BY_STATE,
  isOfficialGradeReason,
  isOfficialGradeState,
  OFFICIAL_GRADE_STATE_BY_REASON,
} from "./types"

export interface BuildOfficialGradeReceiptInput {
  readonly assignedInstanceIds: readonly string[]
  readonly dispositions: readonly OfficialGradeDisposition[]
  readonly evaluator: OfficialGradeEvaluatorMeta
}

const isBlank = (value: unknown): boolean => typeof value !== "string" || value.trim() === ""

const rate = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator

/**
 * The verdict half: state and reason must both be members of their closed
 * unions, must agree with each other, and `gradingValid` must equal what the
 * state DERIVES rather than whatever the caller asserted.
 */
const validateVerdict = (d: OfficialGradeDisposition): readonly OfficialGradeReceiptFailure[] => {
  const out: OfficialGradeReceiptFailure[] = []
  const id = d.instanceId
  const stateKnown = isOfficialGradeState(d.state)
  if (!stateKnown) {
    out.push({
      code: "state_unknown",
      message: `instance "${id}" has unknown state "${String(d.state)}"`,
    })
  }
  if (!isOfficialGradeReason(d.reason)) {
    out.push({
      code: "reason_unknown",
      message: `instance "${id}" has unknown reason "${String(d.reason)}"`,
    })
  } else if (stateKnown && OFFICIAL_GRADE_STATE_BY_REASON[d.reason] !== d.state) {
    out.push({
      code: "state_reason_mismatch",
      message:
        `instance "${id}" declares state "${d.state}" but reason "${d.reason}" belongs to ` +
        `"${OFFICIAL_GRADE_STATE_BY_REASON[d.reason]}"`,
    })
  }
  if (!stateKnown) return out

  const expected = GRADING_VALID_BY_STATE[d.state]
  if (d.gradingValid !== expected) {
    out.push({
      code: "grading_valid_mismatch",
      message:
        `instance "${id}" declares gradingValid=${String(d.gradingValid)} but state "${d.state}" ` +
        `derives ${String(expected)} — grading validity is derived, not asserted`,
    })
  }
  if (d.rawArtifact === null && d.state !== "infra_invalid") {
    out.push({
      code: "raw_artifact_missing",
      message: `instance "${id}" is "${d.state}" with no raw artifact — a scored outcome must cite evidence`,
    })
  }
  return out
}

/** The evidence half: a present artifact ref must be a real, digestible pointer. */
const validateArtifact = (d: OfficialGradeDisposition): readonly OfficialGradeReceiptFailure[] => {
  const a = d.rawArtifact
  if (a === null || a === undefined) return []
  if (!isBlank(a.path) && /^[0-9a-f]{64}$/.test(a.sha256) && Number.isInteger(a.byteLength)) {
    return []
  }
  return [
    {
      code: "raw_artifact_invalid",
      message: `instance "${d.instanceId}" has a raw artifact ref with a blank path, non-sha256 digest, or non-integer length`,
    },
  ]
}

/**
 * Validate ONE disposition against the closed unions and the derived-field
 * rules. Returns every defect it found so the caller can accumulate.
 */
const validateDisposition = (
  d: OfficialGradeDisposition,
  assigned: ReadonlySet<string>,
  seen: Set<string>,
): readonly OfficialGradeReceiptFailure[] => {
  const failures: OfficialGradeReceiptFailure[] = []
  const add = (code: OfficialGradeReceiptFailureCode, message: string): void => {
    failures.push({ code, message })
  }
  const id = d.instanceId

  if (isBlank(id)) {
    add("instance_id_invalid", `disposition has an absent or blank instance_id: ${String(id)}`)
    return failures
  }
  if (seen.has(id)) {
    add(
      "disposition_duplicated",
      `instance "${id}" has more than one disposition — a grader result must be single-valued`,
    )
  }
  seen.add(id)
  if (!assigned.has(id)) {
    add(
      "disposition_unassigned",
      `instance "${id}" was graded but never assigned — the campaign denominator does not contain it`,
    )
  }

  for (const f of validateVerdict(d)) failures.push(f)
  for (const f of validateArtifact(d)) failures.push(f)

  return failures
}

const validateEvaluator = (
  meta: OfficialGradeEvaluatorMeta,
): readonly OfficialGradeReceiptFailure[] => {
  const bad =
    isBlank(meta.evaluatorId) ||
    isBlank(meta.upstreamCommit) ||
    isBlank(meta.evaluatorPath) ||
    isBlank(meta.cwd) ||
    !Array.isArray(meta.argv) ||
    typeof meta.stdout !== "string" ||
    typeof meta.stderr !== "string"
  return bad
    ? [
        {
          code: "evaluator_meta_invalid" as const,
          message:
            "evaluator metadata is incomplete — id, commit, path, cwd, argv, and raw streams are all required replay evidence",
        },
      ]
    : []
}

/**
 * Build a receipt or refuse it. Duplicate dispositions, an unknown state or
 * reason, a state/reason disagreement, a declared-but-wrong `gradingValid`, and
 * a disposition for an unassigned id all FAIL CLOSED.
 */
export const buildOfficialGradeReceipt = (
  input: BuildOfficialGradeReceiptInput,
): OfficialGradeReceiptResult => {
  const failures: OfficialGradeReceiptFailure[] = []
  const assigned: string[] = []
  const assignedSet = new Set<string>()

  for (const id of input.assignedInstanceIds) {
    if (isBlank(id)) {
      failures.push({
        code: "assigned_id_invalid",
        message: `assigned instance id is absent or blank: ${JSON.stringify(id)}`,
      })
      continue
    }
    if (assignedSet.has(id)) {
      failures.push({
        code: "assigned_id_duplicated",
        message: `assigned instance id "${id}" appears more than once`,
      })
      continue
    }
    assignedSet.add(id)
    assigned.push(id)
  }

  failures.push(...validateEvaluator(input.evaluator))

  const seen = new Set<string>()
  const dispositions = new Map<string, OfficialGradeDisposition>()
  for (const d of input.dispositions) {
    const defects = validateDisposition(d, assignedSet, seen)
    failures.push(...defects)
    if (defects.length === 0) dispositions.set(d.instanceId, d)
  }

  if (failures.length > 0) return { ok: false, failures }
  return {
    ok: true,
    receipt: Object.freeze({
      assignedInstanceIds: Object.freeze([...assigned]),
      dispositionsByInstanceId: dispositions,
      evaluator: input.evaluator,
    }),
  }
}

/**
 * THE derivation of `missing`. Assigned ids with no disposition, in assigned
 * order. Nothing else in the codebase may compute this.
 */
export const deriveMissingInstanceIds = (receipt: OfficialGradeReceipt): readonly string[] =>
  receipt.assignedInstanceIds.filter((id) => !receipt.dispositionsByInstanceId.has(id))

/** The PMX-03 score contract, computed in one place from one receipt. */
export const summarizeOfficialGrade = (receipt: OfficialGradeReceipt): OfficialGradeSummary => {
  let resolved = 0
  let modelMiss = 0
  let infraInvalid = 0
  let ambiguous = 0
  for (const id of receipt.assignedInstanceIds) {
    const d = receipt.dispositionsByInstanceId.get(id)
    if (d === undefined) continue
    if (d.state === "resolved") resolved += 1
    else if (d.state === "model_miss") modelMiss += 1
    else if (d.state === "infra_invalid") infraInvalid += 1
    else ambiguous += 1
  }
  const assigned = receipt.assignedInstanceIds.length
  const missing = assigned - (resolved + modelMiss + infraInvalid + ambiguous)
  const gradingValid = resolved + modelMiss
  return {
    assigned,
    resolved,
    modelMiss,
    infraInvalid,
    ambiguous,
    missing,
    gradingValid,
    officialValidRate: rate(resolved, gradingValid),
    coverage: rate(gradingValid, assigned),
    rawRate: rate(resolved, assigned),
  }
}

/** On-disk/on-wire document shape. Plain JSON — a `Map` does not survive. */
interface OfficialGradeReceiptDocument {
  readonly schema_version: 1
  readonly assignedInstanceIds: readonly string[]
  readonly dispositions: readonly OfficialGradeDisposition[]
  readonly evaluator: OfficialGradeEvaluatorMeta
}

export const serializeOfficialGradeReceipt = (receipt: OfficialGradeReceipt): string => {
  const doc: OfficialGradeReceiptDocument = {
    schema_version: 1,
    assignedInstanceIds: receipt.assignedInstanceIds,
    dispositions: receipt.assignedInstanceIds
      .map((id) => receipt.dispositionsByInstanceId.get(id))
      .filter((d): d is OfficialGradeDisposition => d !== undefined),
    evaluator: receipt.evaluator,
  }
  return JSON.stringify(doc, null, 2)
}

const asSide = (value: unknown): OfficialEvaluatorSideSummary | null => {
  if (value === null || typeof value !== "object") return null
  const r = value as Record<string, unknown>
  return {
    finalResult: typeof r.finalResult === "string" ? r.finalResult : "",
    rawReason: typeof r.rawReason === "string" ? r.rawReason : "",
    returncode: typeof r.returncode === "number" ? r.returncode : null,
    scriptExitCode: typeof r.scriptExitCode === "number" ? r.scriptExitCode : null,
  }
}

const asSummary = (value: unknown): OfficialEvaluatorSummary => {
  const r = (value ?? {}) as Record<string, unknown>
  return {
    passed: typeof r.passed === "boolean" ? r.passed : null,
    model: asSide(r.model),
    golden: asSide(r.golden),
  }
}

const asArtifact = (value: unknown): RawArtifactRef | null => {
  if (value === null || typeof value !== "object") return null
  const r = value as Record<string, unknown>
  if (typeof r.path !== "string" || typeof r.sha256 !== "string") return null
  return {
    path: r.path,
    sha256: r.sha256,
    byteLength: typeof r.byteLength === "number" ? r.byteLength : 0,
  }
}

/**
 * Parse a serialized receipt back, re-running the SAME fail-closed validation
 * as construction. A document that drifted (unknown state, stray instance)
 * is refused on the way in, not absorbed.
 */
export const parseOfficialGradeReceipt = (value: unknown): OfficialGradeReceiptResult => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      failures: [{ code: "receipt_unparseable", message: "receipt document is not a JSON object" }],
    }
  }
  const doc = value as Record<string, unknown>
  if (!Array.isArray(doc.assignedInstanceIds) || !Array.isArray(doc.dispositions)) {
    return {
      ok: false,
      failures: [
        {
          code: "receipt_unparseable",
          message: "receipt document lacks `assignedInstanceIds` and `dispositions` arrays",
        },
      ],
    }
  }
  const dispositions = doc.dispositions.map((raw): OfficialGradeDisposition => {
    const r = (raw ?? {}) as Record<string, unknown>
    const empty = r.predictionEmpty
    return {
      instanceId: typeof r.instanceId === "string" ? r.instanceId : "",
      state: r.state as OfficialGradeDisposition["state"],
      reason: r.reason as OfficialGradeDisposition["reason"],
      gradingValid: r.gradingValid === true,
      rawArtifact: asArtifact(r.rawArtifact),
      evaluator: asSummary(r.evaluator),
      ...(typeof empty === "boolean" ? { predictionEmpty: empty } : {}),
    }
  })
  return buildOfficialGradeReceipt({
    assignedInstanceIds: doc.assignedInstanceIds as readonly string[],
    dispositions,
    evaluator: doc.evaluator as OfficialGradeEvaluatorMeta,
  })
}
