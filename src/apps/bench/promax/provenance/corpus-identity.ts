/**
 * PMX-00 corpus identity — extract ONLY what provenance needs to prove.
 *
 * LEAK BOUNDARY (invariant 3): required dataset fields are checked for their
 * primitive TYPE and then discarded. `patch`, `test_patch`, `problem_statement`,
 * and `eval_script` values are never returned, logged, or embedded in a failure
 * message — {@link describeValue} reports a length, not a body. The only things
 * that leave this module are instance ids and language counts.
 *
 * Field spec matches REAL upstream, verified 2026-08-22 against all 170 rows:
 *  - `created_at` is an INTEGER, not a string;
 *  - `pull_number` (104/170) and `issue_numbers` (3/170) are SPARSE, so rows are
 *    not key-uniform and neither field may be required.
 * A validator that got either wrong would reject the real corpus.
 */
import { createFailureSink, describeValue, isRecord } from "./json"
import type { ProMaxFailure, ProMaxFailureCode } from "./types"

/** Present on all 170 rows and required to be a string. */
export const REQUIRED_STRING_FIELDS = [
  "instance_id",
  "repo",
  "base_commit",
  "environment_setup_commit",
  "language",
  "image_name",
  "working_dir",
  "problem_statement",
  "hints_text",
  "patch",
  "test_patch",
] as const

/** Present on all 170 rows and required to be a number. */
export const REQUIRED_NUMBER_FIELDS = ["created_at"] as const

/** Identity-only view. Deliberately carries NO row content. */
export interface CorpusIdentity {
  readonly ids: readonly string[]
  readonly languageCounts: Readonly<Record<string, number>>
}

export type CorpusParse =
  | { readonly ok: true; readonly identity: CorpusIdentity }
  | { readonly ok: false; readonly failures: readonly ProMaxFailure[] }

export type EvalParse =
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly failures: readonly ProMaxFailure[] }

const checkRowFields = (
  row: Record<string, unknown>,
  where: string,
  sink: ReturnType<typeof createFailureSink>,
): void => {
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = row[field]
    if (typeof value !== "string") {
      sink.add(
        "dataset_field_invalid",
        `${where}: field \`${field}\` must be a string (got ${describeValue(value)})`,
      )
    }
  }
  for (const field of REQUIRED_NUMBER_FIELDS) {
    const value = row[field]
    if (typeof value !== "number" || !Number.isFinite(value)) {
      sink.add(
        "dataset_field_invalid",
        `${where}: field \`${field}\` must be a finite number (got ${describeValue(value)})`,
      )
    }
  }
}

/** Shared JSON preamble: syntax errors become a typed refusal, never a throw. */
type JsonBytesParse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: ProMaxFailure }

const parseJsonBytes = (raw: string, code: ProMaxFailureCode, label: string): JsonBytesParse => {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (err) {
    return {
      ok: false,
      failure: {
        code,
        message: `${label} bytes are not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  }
}

/** Parse dataset TEXT into ids + language counts, refusing malformed rows. */
export const parseDatasetIdentity = (raw: string): CorpusParse => {
  const json = parseJsonBytes(raw, "dataset_unparseable", "dataset")
  if (!json.ok) return { ok: false, failures: [json.failure] }
  const parsed = json.value
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      failures: [
        {
          code: "dataset_unparseable",
          message: `dataset must be a JSON array of row objects (got ${describeValue(parsed)})`,
        },
      ],
    }
  }

  const sink = createFailureSink()
  const ids: string[] = []
  const seen = new Set<string>()
  const languageCounts: Record<string, number> = {}

  parsed.forEach((row, index) => {
    const where = `dataset row #${index}`
    if (!isRecord(row)) {
      sink.add("dataset_unparseable", `${where} is not an object (got ${describeValue(row)})`)
      return
    }
    checkRowFields(row, where, sink)

    const id = row.instance_id
    if (typeof id !== "string") {
      sink.add("instance_id_invalid", `${where}: instance_id is ${describeValue(id)}`)
      return
    }
    if (id.trim() === "") {
      sink.add("instance_id_invalid", `${where}: instance_id is blank`)
    }
    if (seen.has(id)) {
      sink.add("instance_id_duplicated", `${where}: instance_id "${id}" already appeared`)
    }
    seen.add(id)
    ids.push(id)

    const language = row.language
    if (typeof language === "string") {
      languageCounts[language] = (languageCounts[language] ?? 0) + 1
    }
  })

  const failures = sink.drain()
  if (failures.length > 0) return { ok: false, failures }
  return { ok: true, identity: { ids, languageCounts } }
}

/**
 * The ONE data/eval ID-SET equality rule, in both directions.
 *
 * Extracted (PMX-02) so the bundle verifier and the corpus ADAPTER cannot
 * disagree about what "the id sets are exactly equal" means: a dataset row with
 * no eval record would be an ungradeable instance, and an eval record with no
 * dataset row would silently widen the denominator.
 */
export const idSetEqualityFailures = (
  datasetIds: readonly string[],
  evalIds: readonly string[],
): readonly ProMaxFailure[] => {
  const datasetSet = new Set(datasetIds)
  const evalSet = new Set(evalIds)
  const out: ProMaxFailure[] = []
  for (const id of datasetSet) {
    if (!evalSet.has(id)) {
      out.push({
        code: "id_set_unequal",
        message: `instance "${id}" is in the dataset but has NO eval record`,
      })
    }
  }
  for (const id of evalSet) {
    if (!datasetSet.has(id)) {
      out.push({
        code: "id_set_unequal",
        message: `instance "${id}" has an eval record but is NOT in the dataset`,
      })
    }
  }
  return out
}

/** Check ONE eval record against its map key. */
const checkEvalRecord = (
  key: string,
  record: unknown,
  sink: ReturnType<typeof createFailureSink>,
): void => {
  if (!isRecord(record)) {
    sink.add("eval_unparseable", `eval record "${key}" is not an object`)
    return
  }
  const declared = record.instance_id
  if (declared !== key) {
    sink.add(
      "eval_key_mismatch",
      `eval key "${key}" disagrees with its record instance_id (${describeValue(declared)})`,
    )
  }
  const script = record.eval_script
  if (typeof script !== "string" || script.trim() === "") {
    // NOTE: the script BODY is grader-only and is never echoed here — only its
    // type/length reaches the refusal message.
    const shape =
      typeof script === "string" ? `blank string(${script.length} chars)` : describeValue(script)
    sink.add(
      "eval_script_missing",
      `eval record "${key}" has an absent or blank eval_script (${shape})`,
    )
  }
}

/**
 * Parse eval TEXT. Upstream ships eval metadata as an OBJECT keyed by
 * instance id (verified 2026-08-22), so the key is authoritative and a record
 * whose `instance_id` disagrees with its key is a refusal, not a preference.
 */
export const parseEvalIdentity = (raw: string): EvalParse => {
  const json = parseJsonBytes(raw, "eval_unparseable", "eval")
  if (!json.ok) return { ok: false, failures: [json.failure] }
  const parsed = json.value
  if (!isRecord(parsed)) {
    return {
      ok: false,
      failures: [
        {
          code: "eval_unparseable",
          message: `eval must be a JSON object keyed by instance id (got ${describeValue(parsed)})`,
        },
      ],
    }
  }

  const sink = createFailureSink()
  const ids: string[] = []
  for (const [key, record] of Object.entries(parsed)) {
    ids.push(key)
    checkEvalRecord(key, record, sink)
  }

  const failures = sink.drain()
  if (failures.length > 0) return { ok: false, failures }
  return { ok: true, ids }
}
