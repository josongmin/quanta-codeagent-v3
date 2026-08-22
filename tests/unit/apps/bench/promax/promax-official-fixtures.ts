/**
 * PMX-03 hermetic fixtures for the pinned official evaluator's output.
 *
 * These build `pass_rate.json` documents IN MEMORY with the EXACT shape the
 * pinned `test_run.py` emits (see `_to_result_info` / `_process_one_instance` at
 * upstream commit `77041028bc4e2135644b63b504aa961a68aafbb6`):
 *
 * ```json
 * { "instance_id": "...", "language": "...", "passed": false,
 *   "model":  { "final_result": "...", "raw_reason": "...", "eval_reason": "...",
 *               "returncode": 1, "script_exit_code": 1, "stdout": "", "stderr": "" },
 *   "golden": { ... } }
 * ```
 *
 * NO GOLD-BEARING BYTES. Every `stdout`/`stderr`/patch string here is synthetic
 * placeholder text — never a real golden patch, test patch, or eval script.
 *
 * INDEPENDENT ORACLE: hashes are computed with `node:crypto` directly, never
 * through the module under test.
 */
import { createHash } from "node:crypto"
import type { OfficialFinalResult } from "@/apps/bench/harness/promax"
import type {
  OfficialEvaluatorIdentity,
  OfficialGradeEvaluatorMeta,
  RawArtifactRef,
} from "@/runner/batch/eval/official-grade"

export type JsonRecord = Record<string, unknown>

/** sha256 of UTF-8 bytes, computed WITHOUT the module under test. */
export const oracleSha256 = (input: string): string =>
  createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex")

/**
 * Every `final_result` the pinned evaluator can write, transcribed from
 * `_REASON_TO_FINAL_RESULT`. `"non zero exit"` really does contain spaces
 * upstream — that literal is load-bearing, not a typo.
 */
export const UPSTREAM_FINAL_RESULTS: readonly OfficialFinalResult[] = [
  "success",
  "apply_failed",
  "test_patch_apply_failed",
  "timeout_apply",
  "timeout_eval",
  "non zero exit",
  "need_human_review",
]

/** Reverse of upstream's `reason.lower().replace(" ", "_")` normalization. */
const rawReasonFor = (finalResult: string): string => finalResult.replace(/ /g, "_")

export interface SideOverrides {
  readonly returncode?: number | null
  readonly scriptExitCode?: number | null
  readonly stdout?: string
  readonly stderr?: string
}

/** One `model`/`golden` sub-object exactly as `_to_result_info` writes it. */
export const officialSide = (finalResult: string, overrides: SideOverrides = {}): JsonRecord => ({
  final_result: finalResult,
  raw_reason: rawReasonFor(finalResult),
  eval_reason: rawReasonFor(finalResult),
  returncode: overrides.returncode === undefined ? 0 : overrides.returncode,
  script_exit_code: overrides.scriptExitCode === undefined ? 0 : overrides.scriptExitCode,
  stdout: overrides.stdout ?? "SYNTHETIC-STDOUT",
  stderr: overrides.stderr ?? "SYNTHETIC-STDERR",
})

export interface RowSpec {
  readonly instanceId: string
  readonly golden: string
  readonly model: string
  /**
   * Upstream computes `passed = model.final_result == "success" and
   * golden.final_result == "success"`. Override it to model a FORGED or
   * drifted document — the classifier must never consult it.
   */
  readonly passed?: boolean
  readonly language?: string
  readonly modelSide?: SideOverrides
  readonly goldenSide?: SideOverrides
}

/** One full `pass_rate.json` row. */
export const officialRow = (spec: RowSpec): JsonRecord => ({
  instance_id: spec.instanceId,
  language: spec.language ?? "python",
  passed: spec.passed ?? (spec.model === "success" && spec.golden === "success"),
  model: officialSide(spec.model, spec.modelSide ?? {}),
  golden: officialSide(spec.golden, spec.goldenSide ?? {}),
})

export const officialDocument = (rows: readonly JsonRecord[]): string =>
  JSON.stringify(rows, null, 2)

export const PINNED_ROOT = "/opt/quanta/promax-upstream/77041028bc4e2135644b63b504aa961a68aafbb6"
export const OUTPUT_PATH = "/var/quanta/promax/run-1/pass-rate.json"

export const evaluatorIdentity = (): OfficialEvaluatorIdentity => ({
  evaluatorId: "swe-bench-promax",
  upstreamCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
  evaluatorPath: `${PINNED_ROOT}/src/evaluation/test_run.py`,
  evaluatorSha256: "af2ee720de8a51a921f4af2617937c45f4e3b983549b640756b0fa8b2c1bf42d",
  argv: ["python", `${PINNED_ROOT}/src/evaluation/test_run.py`],
  cwd: PINNED_ROOT,
})

export const rawArtifact = (text: string, path = OUTPUT_PATH): RawArtifactRef => ({
  path,
  sha256: oracleSha256(text),
  byteLength: Buffer.byteLength(text, "utf8"),
})

export const evaluatorMeta = (
  overrides: Partial<OfficialGradeEvaluatorMeta> = {},
): OfficialGradeEvaluatorMeta => ({
  ...evaluatorIdentity(),
  exitCode: 0,
  stdout: "",
  stderr: "",
  outputArtifact: null,
  ...overrides,
})
