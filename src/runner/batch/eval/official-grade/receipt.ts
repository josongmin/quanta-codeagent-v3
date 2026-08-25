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
  OfficialGradeImageRef,
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
  /** Optional: omit and the receipt is byte-identical to before this existed. */
  readonly images?: readonly OfficialGradeImageRef[]
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

/**
 * The evaluator half. FAIL-CLOSED on a receipt that has no evaluator AT ALL.
 *
 * `meta` is typed, but this function sits on three paths that hand it UNTYPED
 * bytes — construction from an adapter, `parseOfficialGradeReceipt` over a
 * persisted document, and the box transport over whatever a grading box wrote.
 * An absent or null `evaluator` key therefore reached `meta.evaluatorId` and
 * threw a TypeError: the campaign crashed instead of producing the typed refusal
 * that the same document's every other defect produces, so an operator got a
 * stack trace where a `evaluator_meta_invalid` belonged.
 */
const validateEvaluator = (
  meta: OfficialGradeEvaluatorMeta,
): readonly OfficialGradeReceiptFailure[] => {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    return [
      {
        code: "evaluator_meta_invalid" as const,
        message:
          `evaluator metadata is ${meta === null ? "null" : `a ${Array.isArray(meta) ? "array" : typeof meta}`}, ` +
          "not a record — a receipt with no evaluator names no grader, so nothing about it is replayable",
      },
    ]
  }
  const bad =
    isBlank(meta.evaluatorId) ||
    isBlank(meta.upstreamCommit) ||
    isBlank(meta.evaluatorPath) ||
    // aug-23 audit: `evaluatorSha256` was the one identity field this guard did
    // NOT check, and it is the field that makes a receipt replayable at all — a
    // commit names a tree and a path names a location, but only the hash pins
    // the BYTES that produced these verdicts. A receipt could assert "here is
    // how to replay me" while naming no evaluator content, under a type that
    // declares the field required. The old message did not list it either, so
    // the omission read as deliberate rather than missed.
    isBlank(meta.evaluatorSha256) ||
    isBlank(meta.cwd) ||
    !Array.isArray(meta.argv) ||
    typeof meta.stdout !== "string" ||
    typeof meta.stderr !== "string"
  return bad
    ? [
        {
          code: "evaluator_meta_invalid" as const,
          message:
            "evaluator metadata is incomplete — id, commit, path, evaluator sha256, cwd, argv, " +
            "and raw streams are all required replay evidence",
        },
      ]
    : []
}

/**
 * Image pins fail CLOSED. A blank id, a blank name, or a digest that is not a
 * `repo@sha256:<64 hex>` reference is refused rather than recorded: a receipt
 * that names an unusable pin is worse than one that names none, because it
 * reads as provenance while being unreplayable.
 */
const IMAGE_DIGEST = /^[^\s@]+@sha256:[0-9a-f]{64}$/
const checkImages = (
  images: readonly OfficialGradeImageRef[] | undefined,
): OfficialGradeReceiptFailure[] => {
  if (images === undefined) return []
  const failures: OfficialGradeReceiptFailure[] = []
  const seen = new Set<string>()
  for (const image of images) {
    if (isBlank(image?.instanceId) || isBlank(image?.imageName)) {
      failures.push({
        code: "image_ref_invalid",
        message: `image pin names no instance or no image: ${JSON.stringify(image)}`,
      })
      continue
    }
    if (typeof image.repoDigest !== "string" || !IMAGE_DIGEST.test(image.repoDigest)) {
      failures.push({
        code: "image_ref_invalid",
        message:
          `image pin for ${image.instanceId} is not a repo digest ` +
          `(expected repo@sha256:<64 hex>): ${JSON.stringify(image.repoDigest)}`,
      })
      continue
    }
    if (seen.has(image.instanceId)) {
      failures.push({
        code: "image_ref_invalid",
        message: `image pin for ${image.instanceId} is declared more than once`,
      })
      continue
    }
    seen.add(image.instanceId)
  }
  return failures
}

/**
 * Build a receipt or refuse it. Duplicate dispositions, an unknown state or
 * reason, a state/reason disagreement, a declared-but-wrong `gradingValid`, and
 * a disposition for an unassigned id all FAIL CLOSED.
 */
export const buildOfficialGradeReceipt = (
  input: BuildOfficialGradeReceiptInput,
): OfficialGradeReceiptResult => {
  const failures: OfficialGradeReceiptFailure[] = [...checkImages(input.images)]
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
      // validated above by `checkImages`; omitted when the grader captured none
      ...(input.images !== undefined ? { images: Object.freeze([...input.images]) } : {}),
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
  readonly images?: readonly OfficialGradeImageRef[]
}

export const serializeOfficialGradeReceipt = (receipt: OfficialGradeReceipt): string => {
  const doc: OfficialGradeReceiptDocument = {
    schema_version: 1,
    assignedInstanceIds: receipt.assignedInstanceIds,
    dispositions: receipt.assignedInstanceIds
      .map((id) => receipt.dispositionsByInstanceId.get(id))
      .filter((d): d is OfficialGradeDisposition => d !== undefined),
    evaluator: receipt.evaluator,
    // omitted entirely when absent, so a grader that captures no provenance
    // still serializes to the pre-existing document shape
    ...(receipt.images !== undefined ? { images: receipt.images } : {}),
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
    // round-trip: a serialized pin must survive parse, or a re-read receipt
    // silently loses the provenance the original refused to grade without
    ...(Array.isArray(doc.images)
      ? { images: doc.images as readonly OfficialGradeImageRef[] }
      : {}),
  })
}
