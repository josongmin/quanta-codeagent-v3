/**
 * PMX-02 — TRUSTED PREPARATION: the official ProMax JSON array → two views.
 *
 * ## Where this may run
 *
 * This is the ONLY module in the codebase that is allowed to hold a ProMax row
 * with its gold still attached, and it runs during trusted campaign preparation
 * — never inside an agent process. Its whole job is to split that row in two and
 * never hand the halves to the same consumer again.
 *
 * ## Why validation is delegated
 *
 * PMX-00 already owns "is this a well-formed ProMax corpus?" — required field
 * types (including the two upstream facts a naive reader breaks on: `created_at`
 * is an INTEGER and rows are NOT key-uniform), duplicate ids, the eval map's
 * key/record agreement, non-blank eval scripts, and the data/eval id-set
 * equality rule. Re-deriving any of that here would create a second, drifting
 * schema — the exact failure the provenance module was written to prevent.
 *
 * So this module VALIDATES THROUGH `parseDatasetIdentity` / `parseEvalIdentity` /
 * `idSetEqualityFailures`, refuses if any of them refuses, and only then reads
 * the same bytes a second time to PROJECT. The second read is deliberate and
 * cheap (170 rows, preparation-time only) and it buys a hard property: there is
 * no code path that reaches projection without having passed the owner's checks.
 *
 * The one rule this module adds on top is a PROJECTION requirement rather than a
 * provenance one: a required public/grader string must also be NON-BLANK. PMX-00
 * types `image_name` as a string; `""` is a string. An instance with a blank
 * image is not gradeable, and an instance with a blank repo/base_commit is not
 * checkoutable, so both are refused here — reusing the owner's
 * `dataset_field_invalid` code rather than widening the closed failure union.
 */
import { errMessage } from "@/shared"
import {
  createFailureSink,
  idSetEqualityFailures,
  isRecord,
  type ProMaxFailure,
  parseDatasetIdentity,
  parseEvalIdentity,
} from "../provenance"
import type { PromaxAgentTaskView, PromaxGraderTaskView } from "./types"

export interface ProMaxCorpusBytes {
  readonly datasetText: string
  readonly evalText: string
}

export interface ProMaxDecodedCorpus {
  readonly ok: true
  /** Agent-visible views, in DATASET order. */
  readonly agentTasks: readonly PromaxAgentTaskView[]
  /** Grader-only views, in the SAME order (index i is the same instance). */
  readonly graderTasks: readonly PromaxGraderTaskView[]
  /** Instance ids in dataset order. */
  readonly instanceIds: readonly string[]
  readonly languageCounts: Readonly<Record<string, number>>
}

export interface ProMaxRejectedCorpus {
  readonly ok: false
  readonly failures: readonly ProMaxFailure[]
}

export type ProMaxCorpusDecode = ProMaxDecodedCorpus | ProMaxRejectedCorpus

/** Public fields a ProMax row must carry non-blank to be RUNNABLE. */
const REQUIRED_PUBLIC_STRINGS = ["repo", "base_commit", "problem_statement", "language"] as const
/** Grader fields a ProMax row must carry non-blank to be GRADEABLE. */
const REQUIRED_GRADER_STRINGS = [
  "patch",
  "test_patch",
  "image_name",
  "working_dir",
  "environment_setup_commit",
] as const

const nonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== ""

/**
 * The blank-string refusal. Deliberately reports the field NAME and the offending
 * value's LENGTH only — never a body, because `patch` / `test_patch` are in this
 * list and a refusal message is a log line.
 */
const blankFailure = (instanceId: string, field: string, value: unknown): ProMaxFailure => ({
  code: "dataset_field_invalid",
  message:
    `instance "${instanceId}": field \`${field}\` must be a NON-BLANK string ` +
    `(got ${typeof value === "string" ? `blank string(${value.length} chars)` : typeof value})`,
})

/** JSON.parse that turns a syntax error into a typed refusal. */
const parseJson = (
  raw: string,
  label: string,
  code: ProMaxFailure["code"],
): unknown | ProMaxFailure => {
  try {
    return JSON.parse(raw)
  } catch (err) {
    return {
      code,
      message: `${label} bytes are not valid JSON: ${errMessage(err)}`,
    }
  }
}

const isFailure = (v: unknown): v is ProMaxFailure =>
  isRecord(v) && typeof v.code === "string" && typeof v.message === "string"

const reject = (failures: readonly ProMaxFailure[]): ProMaxRejectedCorpus => ({
  ok: false,
  failures,
})

/** The eval script for an instance, or `undefined` when the eval map has none. */
const evalScriptFor = (evalValue: Record<string, unknown>, instanceId: string): unknown => {
  const record = evalValue[instanceId]
  return isRecord(record) ? record.eval_script : undefined
}

/** The PROJECTION requirement PMX-00 does not cover: required strings must be
 *  non-BLANK, on both the public and the grader side, plus a non-blank eval
 *  script. Accumulates into the capping sink so one bad field cannot hide another
 *  field's code. */
const checkNonBlankFields = (
  raw: Record<string, unknown>,
  instanceId: string,
  evalScript: unknown,
  sink: ReturnType<typeof createFailureSink>,
): void => {
  for (const field of [...REQUIRED_PUBLIC_STRINGS, ...REQUIRED_GRADER_STRINGS]) {
    if (!nonBlank(raw[field])) {
      sink.add(...failureArgs(blankFailure(instanceId, field, raw[field])))
    }
  }
  if (!nonBlank(evalScript)) {
    sink.add(
      "eval_script_missing",
      `instance "${instanceId}" has an absent or blank eval_script in the eval map`,
    )
  }
}

/**
 * Decode + SPLIT the official ProMax corpus. Never throws for bad content: a
 * malformed corpus is a verdict, so a caller cannot swallow it in a `catch`.
 */
export const decodeProMaxOfficialCorpus = (bytes: ProMaxCorpusBytes): ProMaxCorpusDecode => {
  // 1 — the OWNER's validation. Nothing below runs if this refuses.
  const identity = parseDatasetIdentity(bytes.datasetText)
  const evalIdentity = parseEvalIdentity(bytes.evalText)
  const ownerFailures: ProMaxFailure[] = []
  if (!identity.ok) ownerFailures.push(...identity.failures)
  if (!evalIdentity.ok) ownerFailures.push(...evalIdentity.failures)
  if (!identity.ok || !evalIdentity.ok) return reject(ownerFailures)

  const setFailures = idSetEqualityFailures(identity.identity.ids, evalIdentity.ids)
  if (setFailures.length > 0) return reject(setFailures)

  // 2 — re-read the SAME bytes to project. Structure is already proven above, so
  //     the only thing that can still fail here is the non-blank requirement.
  const datasetValue = parseJson(bytes.datasetText, "dataset", "dataset_unparseable")
  if (isFailure(datasetValue)) return reject([datasetValue])
  const evalValue = parseJson(bytes.evalText, "eval", "eval_unparseable")
  if (isFailure(evalValue)) return reject([evalValue])
  if (!Array.isArray(datasetValue) || !isRecord(evalValue)) {
    // Unreachable given step 1, but stated rather than assumed.
    return reject([
      { code: "dataset_unparseable", message: "dataset/eval shape changed between reads" },
    ])
  }

  const sink = createFailureSink()
  const agentTasks: PromaxAgentTaskView[] = []
  const graderTasks: PromaxGraderTaskView[] = []
  const instanceIds: string[] = []

  for (const raw of datasetValue) {
    if (!isRecord(raw)) continue
    const instanceId = String(raw.instance_id)
    const evalScript = evalScriptFor(evalValue, instanceId)
    checkNonBlankFields(raw, instanceId, evalScript, sink)
    instanceIds.push(instanceId)
    // The SPLIT itself: two CLOSED structs built field by field from the same
    // row, so nothing can travel from one side to the other by omission.
    agentTasks.push({
      instanceId,
      repo: String(raw.repo),
      baseCommit: String(raw.base_commit),
      problemStatement: String(raw.problem_statement),
      language: String(raw.language),
    })
    graderTasks.push({
      instanceId,
      patch: String(raw.patch),
      testPatch: String(raw.test_patch),
      evalScript: typeof evalScript === "string" ? evalScript : "",
      imageName: String(raw.image_name),
      workingDir: String(raw.working_dir),
      environmentSetupCommit: String(raw.environment_setup_commit),
    })
  }

  const failures = sink.drain()
  if (failures.length > 0) return reject(failures)
  return {
    ok: true,
    agentTasks,
    graderTasks,
    instanceIds,
    languageCounts: identity.identity.languageCounts,
  }
}

/** Spread helper so a prebuilt failure can go through the capping sink. */
const failureArgs = (f: ProMaxFailure): [ProMaxFailure["code"], string] => [f.code, f.message]
