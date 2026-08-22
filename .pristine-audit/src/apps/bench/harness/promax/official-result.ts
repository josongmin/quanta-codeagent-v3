/**
 * PMX-03 — the pinned evaluator's OUTPUT SCHEMA, transcribed (not reimplemented)
 * from upstream `test_run.py` at commit
 * `77041028bc4e2135644b63b504aa961a68aafbb6`.
 *
 * We may invoke and classify that script. We may not copy, patch, or port its
 * logic. What lives here is only the shape of the JSON it writes, plus a
 * fail-closed parser for it.
 *
 * Ground truth for the seven states is upstream's `_REASON_TO_FINAL_RESULT`:
 *
 * ```python
 * "SUCCESS": "success", "APPLY_FAILED": "apply_failed",
 * "TEST_PATCH_APPLY_FAILED": "test_patch_apply_failed",
 * "TIMEOUT_APPLY": "timeout_apply", "TIMEOUT_EVAL": "timeout_eval",
 * "NON_ZERO_EXIT": "non zero exit", "NEED_HUMAN_REVIEW": "need_human_review",
 * ```
 *
 * `"non zero exit"` really does contain SPACES upstream while every other value
 * uses underscores. That asymmetry is pinned semantics; normalizing it here
 * would silently stop matching the file we are reading.
 *
 * Upstream also has an UNLISTED fallback: an unmapped reason becomes
 * `reason.lower().replace(" ", "_")`, and an absent reason becomes the literal
 * `"not run"`. Neither is a verdict we can score, so both fall through the type
 * guard into `schema_invalid` — fail closed, exactly like any other drift.
 */

/** Every `final_result` the pinned evaluator is documented to write. */
export const OFFICIAL_FINAL_RESULTS = [
  "success",
  "apply_failed",
  "test_patch_apply_failed",
  "timeout_apply",
  "timeout_eval",
  "non zero exit",
  "need_human_review",
] as const

export type OfficialFinalResult = (typeof OFFICIAL_FINAL_RESULTS)[number]

const FINAL_RESULT_SET: ReadonlySet<string> = new Set<string>(OFFICIAL_FINAL_RESULTS)

export const isOfficialFinalResult = (value: unknown): value is OfficialFinalResult =>
  typeof value === "string" && FINAL_RESULT_SET.has(value)

/** One `model` / `golden` sub-object of a `pass_rate.json` row. */
export interface OfficialSideRecord {
  readonly finalResult: OfficialFinalResult
  readonly rawReason: string
  readonly returncode: number | null
  readonly scriptExitCode: number | null
}

/** A side that parsed structurally but whose verdict string is unrecognized. */
export interface OfficialSideDrift {
  /** kept VERBATIM so an operator can see exactly what upstream wrote. */
  readonly finalResult: string
  readonly rawReason: string
  readonly returncode: number | null
  readonly scriptExitCode: number | null
}

export interface OfficialRowAccepted {
  readonly ok: true
  readonly instanceId: string
  readonly language: string
  /** upstream's top-level flag. AUDIT ONLY — the classifier never reads it. */
  readonly passed: boolean
  readonly model: OfficialSideRecord
  readonly golden: OfficialSideRecord
}

export interface OfficialRowDrifted {
  readonly ok: false
  /** `null` when the row cannot be attributed to an instance at all. */
  readonly instanceId: string | null
  readonly passed: boolean | null
  readonly model: OfficialSideDrift | null
  readonly golden: OfficialSideDrift | null
  readonly detail: string
}

export type OfficialRowParse = OfficialRowAccepted | OfficialRowDrifted

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const asNumberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

/** Structural read of one side. Never throws; unknown verdicts survive verbatim. */
const readSide = (value: unknown): OfficialSideDrift | null => {
  const r = asRecord(value)
  if (r === null) return null
  return {
    finalResult: typeof r.final_result === "string" ? r.final_result : "",
    rawReason: typeof r.raw_reason === "string" ? r.raw_reason : "",
    returncode: asNumberOrNull(r.returncode),
    scriptExitCode: asNumberOrNull(r.script_exit_code),
  }
}

const narrowSide = (side: OfficialSideDrift): OfficialSideRecord | null =>
  isOfficialFinalResult(side.finalResult) ? { ...side, finalResult: side.finalResult } : null

type NarrowedSides =
  | { readonly detail: string; readonly sides?: undefined }
  | {
      readonly detail: null
      readonly sides: { readonly model: OfficialSideRecord; readonly golden: OfficialSideRecord }
    }

const unknownVerdict = (which: string, got: string): string =>
  `${which}.final_result "${got}" is not one of the ${OFFICIAL_FINAL_RESULTS.length} pinned evaluator states`

/** Both sides present AND both verdicts pinned, or the first reason they are not. */
const narrowSides = (
  model: OfficialSideDrift | null,
  golden: OfficialSideDrift | null,
): NarrowedSides => {
  if (model === null) return { detail: "row is missing its `model` object" }
  if (golden === null) return { detail: "row is missing its `golden` object" }
  const narrowedModel = narrowSide(model)
  if (narrowedModel === null) return { detail: unknownVerdict("model", model.finalResult) }
  const narrowedGolden = narrowSide(golden)
  if (narrowedGolden === null) return { detail: unknownVerdict("golden", golden.finalResult) }
  return { detail: null, sides: { model: narrowedModel, golden: narrowedGolden } }
}

/**
 * Parse ONE row. A structurally readable row with an unrecognized verdict is
 * `ok: false` but still carries its instance id and its verbatim strings, so
 * the adapter can attribute a `schema_invalid` disposition to the right
 * instance instead of losing it.
 */
export const parseOfficialPassRateRow = (value: unknown): OfficialRowParse => {
  const row = asRecord(value)
  if (row === null) {
    return {
      ok: false,
      instanceId: null,
      passed: null,
      model: null,
      golden: null,
      detail: "row is not a JSON object",
    }
  }
  const instanceId =
    typeof row.instance_id === "string" && row.instance_id.trim() !== "" ? row.instance_id : null
  const model = readSide(row.model)
  const golden = readSide(row.golden)
  const passed = typeof row.passed === "boolean" ? row.passed : null
  const base = { instanceId, passed, model, golden } as const

  if (instanceId === null) {
    return { ok: false, ...base, detail: "row has no usable `instance_id`" }
  }
  const narrowed = narrowSides(model, golden)
  if (narrowed.detail !== null) return { ok: false, ...base, detail: narrowed.detail }
  if (passed === null) {
    return { ok: false, ...base, detail: "row `passed` is absent or not a boolean" }
  }
  return {
    ok: true,
    instanceId,
    language: typeof row.language === "string" ? row.language : "",
    passed,
    model: narrowed.sides.model,
    golden: narrowed.sides.golden,
  }
}

export interface OfficialDocumentAccepted {
  readonly ok: true
  readonly rows: readonly OfficialRowParse[]
}

export interface OfficialDocumentRejected {
  readonly ok: false
  readonly detail: string
}

export type OfficialDocumentParse = OfficialDocumentAccepted | OfficialDocumentRejected

/**
 * Parse a whole `pass_rate.json`. Upstream ALWAYS writes a JSON array
 * (`json.dump(results_list, …)`), so anything else is evaluator-level schema
 * drift, not a per-row problem.
 */
export const parseOfficialPassRateDocument = (text: string): OfficialDocumentParse => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    return {
      ok: false,
      detail: `evaluator output is not parseable JSON: ${(error as Error).message}`,
    }
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      detail: "evaluator output is not a JSON array — the pinned evaluator always writes a list",
    }
  }
  return { ok: true, rows: parsed.map(parseOfficialPassRateRow) }
}
