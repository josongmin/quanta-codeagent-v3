/**
 * PMX-03 — the PURE argv / predictions boundary for the pinned evaluator.
 *
 * Nothing here spawns anything. It builds, deterministically, the exact command
 * PMX-04 will hand to the OS, plus the exact prediction file that command reads.
 *
 * WHY AN ARRAY, NEVER A STRING: upstream's `test_run.py` builds its own docker
 * commands as shell strings and runs them with `subprocess.run(..., shell=True)`.
 * That is PINNED SEMANTICS — the campaign is only reproducible if the evaluator
 * behaves exactly as its hashed bytes say, so we neither patch it nor mimic it.
 * Our own boundary is the opposite: an argv array, no shell, no quoting layer,
 * no interpolation. A path containing `$(…)` or a space is one token, verbatim.
 */
import { posix } from "node:path"

/** Upstream layout at the pinned commit (`PROMAX_V1_UPSTREAM_PATHS`). */
export const PROMAX_EVALUATOR_RELATIVE_PATH = "src/evaluation/test_run.py"
export const PROMAX_EVAL_META_RELATIVE_PATH = "data/eval.json"

export type ProMaxInvocationFailureCode =
  | "path_blank"
  | "path_not_absolute"
  | "workers_invalid"
  | "python_blank"

export interface ProMaxInvocationFailure {
  readonly code: ProMaxInvocationFailureCode
  readonly message: string
}

export interface ProMaxEvaluatorInvocationInput {
  /** absolute root of the verified upstream bundle checkout. */
  readonly pinnedRoot: string
  readonly predictionsPath: string
  /** campaign golden file. GRADER-ONLY material; never an agent-visible path. */
  readonly goldenPath: string
  readonly outputPath: string
  readonly pythonExecutable?: string | undefined
  readonly workers?: number | undefined
  /** override only to point at a relocated eval file; defaults under the root. */
  readonly evalPath?: string | undefined
}

export interface ProMaxEvaluatorInvocation {
  readonly argv: readonly string[]
  readonly cwd: string
}

export type ProMaxInvocationResult =
  | { readonly ok: true; readonly invocation: ProMaxEvaluatorInvocation }
  | { readonly ok: false; readonly failures: readonly ProMaxInvocationFailure[] }

const checkPath = (label: string, value: string, sink: ProMaxInvocationFailure[]): void => {
  if (typeof value !== "string" || value.trim() === "") {
    sink.push({ code: "path_blank", message: `${label} is absent or blank` })
    return
  }
  if (!value.startsWith("/")) {
    sink.push({
      code: "path_not_absolute",
      message:
        `${label} "${value}" is not absolute — a cwd-relative campaign path cannot be replayed ` +
        "from a report",
    })
  }
}

/**
 * Build the exact pinned command:
 *
 * ```text
 * python <PINNED_ROOT>/src/evaluation/test_run.py
 *   --pred <preds.json> --golden <campaign-golden.json>
 *   --eval <PINNED_ROOT>/data/eval.json --output <pass-rate.json> --workers 1
 * ```
 *
 * `--cleanup` is deliberately NEVER passed: upstream's cleanup deletes the
 * docker images, and those images are the campaign's replay evidence.
 */
export const buildProMaxEvaluatorInvocation = (
  input: ProMaxEvaluatorInvocationInput,
): ProMaxInvocationResult => {
  const failures: ProMaxInvocationFailure[] = []
  checkPath("pinnedRoot", input.pinnedRoot, failures)
  checkPath("predictionsPath", input.predictionsPath, failures)
  checkPath("goldenPath", input.goldenPath, failures)
  checkPath("outputPath", input.outputPath, failures)
  if (input.evalPath !== undefined) checkPath("evalPath", input.evalPath, failures)

  const python = input.pythonExecutable ?? "python"
  if (python.trim() === "") {
    failures.push({ code: "python_blank", message: "pythonExecutable is blank" })
  }

  const workers = input.workers ?? 1
  if (!Number.isInteger(workers) || workers < 1) {
    failures.push({
      code: "workers_invalid",
      message: `workers must be a positive integer, got ${String(workers)}`,
    })
  }

  if (failures.length > 0) return { ok: false, failures }

  const root = input.pinnedRoot.replace(/\/+$/, "")
  const argv: readonly string[] = [
    python,
    posix.join(root, PROMAX_EVALUATOR_RELATIVE_PATH),
    "--pred",
    input.predictionsPath,
    "--golden",
    input.goldenPath,
    "--eval",
    input.evalPath ?? posix.join(root, PROMAX_EVAL_META_RELATIVE_PATH),
    "--output",
    input.outputPath,
    "--workers",
    String(workers),
  ]

  return {
    ok: true,
    invocation: Object.freeze({ argv: Object.freeze(argv), cwd: root }),
  }
}

export interface ProMaxPrediction {
  readonly instanceId: string
  readonly modelPatch: string
}

export type ProMaxPredictionFailureCode =
  | "instance_id_invalid"
  | "instance_id_duplicated"
  | "model_patch_invalid"

export interface ProMaxPredictionFailure {
  readonly code: ProMaxPredictionFailureCode
  readonly message: string
}

/** The on-disk row shape upstream reads: `item.get("instance_id"/"model_patch")`. */
export interface ProMaxPredictionRow {
  readonly instance_id: string
  readonly model_patch: string
}

export type ProMaxPredictionsResult =
  | { readonly ok: true; readonly json: string; readonly rows: readonly ProMaxPredictionRow[] }
  | { readonly ok: false; readonly failures: readonly ProMaxPredictionFailure[] }

/**
 * Serialize `preds.json`: a JSON ARRAY of objects with EXACTLY `instance_id`
 * and `model_patch`.
 *
 * The projection is explicit rather than a spread, which is the leak guard: a
 * caller passing a richer object (trajectory, reasoning, a `patch` field
 * carrying gold) cannot have it ride into a file the evaluator reads.
 */
export const serializeProMaxPredictions = (
  predictions: readonly ProMaxPrediction[],
): ProMaxPredictionsResult => {
  const failures: ProMaxPredictionFailure[] = []
  const seen = new Set<string>()
  const rows: ProMaxPredictionRow[] = []

  for (const p of predictions) {
    const id = p.instanceId
    if (typeof id !== "string" || id.trim() === "") {
      failures.push({
        code: "instance_id_invalid",
        message: `prediction has an absent or blank instance_id: ${JSON.stringify(id)}`,
      })
      continue
    }
    if (seen.has(id)) {
      failures.push({
        code: "instance_id_duplicated",
        message: `instance "${id}" appears more than once — the evaluator would grade it twice`,
      })
      continue
    }
    seen.add(id)
    if (typeof p.modelPatch !== "string") {
      failures.push({
        code: "model_patch_invalid",
        message: `instance "${id}" has a non-string model_patch (${typeof p.modelPatch})`,
      })
      continue
    }
    rows.push({ instance_id: id, model_patch: p.modelPatch })
  }

  if (failures.length > 0) return { ok: false, failures }
  return { ok: true, json: JSON.stringify(rows, null, 2), rows }
}
