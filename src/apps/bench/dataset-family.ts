/**
 * Dataset-family selector (RFC jun-29) — the seam that makes the Pro/Live path
 * REACHABLE from a real run (de-theaters normalizeProRow + the Pro verifier).
 *
 * Pure + testable: `resolveDatasetFamily` (argv/env → family), `parseTasksForFamily`
 * (Pro ⇒ lowercase-schema normalize), `gradeEvaluatorForFamily` (Pro ⇒ Scale harness,
 * else ⇒ official). The grade evaluator returns the SAME `PythonSwebenchResult` shape
 * so it injects into the existing `VerifyDeps.pythonSwebench` seam unchanged.
 *
 * Default = "verified" ⇒ byte-identical to the pre-RFC path (R1).
 */
import {
  normalizeProRow,
  parseSwebenchJsonl,
  type SwebenchTask,
} from "@/runner/batch/corpus/dataset"
import type { PythonSwebenchResult } from "@/runner/batch/eval/verdict"
import { type ProSwebenchOpts, evaluateWithProSwebench } from "./pro-swebench"
import { evaluateWithPythonSwebench } from "./python-swebench"
import type { Instance } from "./types"

export type DatasetFamily = "verified" | "live" | "pro"

/** Resolve the family from `--dataset-family` (argvValue) then
 *  `QUANTA_SWEBENCH_DATASET_FAMILY`, defaulting to "verified". Unknown ⇒ verified
 *  (fail-safe to the byte-identical default, never an undefined branch). */
export const resolveDatasetFamily = (
  argvValue: string | undefined,
  env: NodeJS.ProcessEnv,
): DatasetFamily => {
  const raw = (argvValue ?? env.QUANTA_SWEBENCH_DATASET_FAMILY ?? "verified").toLowerCase()
  return raw === "pro" || raw === "live" ? raw : "verified"
}

/** Parse the dataset JSONL for the family: Pro rows carry lowercase `fail_to_pass`
 *  + extra fields and MUST be normalized (else they degrade to the `testCmd:"true"`
 *  no-op); verified/live are the standard upper-case schema (identity parse). */
export const parseTasksForFamily = (text: string, family: DatasetFamily): SwebenchTask[] =>
  family === "pro" ? parseSwebenchJsonl(text, normalizeProRow) : parseSwebenchJsonl(text)

/** Grade evaluator for the family. Pro ⇒ the Scale harness verifier (its opts carry
 *  the harness dir + raw CSV); verified/live ⇒ the official swebench harness. Both
 *  share the `PythonSwebenchResult` return shape AND the same process-global grading
 *  lock (R2), so the caller injects either into the one `VerifyDeps.pythonSwebench`
 *  seam with no verdict.ts change. */
export const gradeEvaluatorForFamily = (
  family: DatasetFamily,
  proOpts: ProSwebenchOpts = {},
): ((instance: Instance, patch: string, opts?: unknown) => Promise<PythonSwebenchResult>) =>
  family === "pro"
    ? (instance, patch, opts) =>
        // Forward ONLY the per-call signal from the seam's opts (the eval driver passes
        // `{signal}`); the operator-injected harnessDir/rawSamplePath (proOpts) MUST win
        // and never be overridable by a caller's opts (audit R2 #4 override footgun).
        evaluateWithProSwebench(instance, patch, {
          ...(typeof opts === "object" && opts !== null && "signal" in opts
            ? { signal: (opts as { signal?: AbortSignal }).signal }
            : {}),
          ...proOpts,
        })
    : (instance, patch, opts) =>
        evaluateWithPythonSwebench(
          instance,
          patch,
          opts as Parameters<typeof evaluateWithPythonSwebench>[2],
        )
