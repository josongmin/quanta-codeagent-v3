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
import type { PythonSwebenchResult } from "@/runner/batch/eval/verdict"
import { type DatasetFamily, normalizeDatasetFamilyToken } from "./dataset-family-token"
import type { ProSwebenchOpts } from "./pro-swebench"
import { resolveDatasetFamilyProfile } from "./profiles/registry"
import { datasetFamilyOrDefault } from "./run-config"
import type { Instance } from "./types"

export type { DatasetFamily }

/** Resolve the family from `--dataset-family` (argvValue) then
 *  `QUANTA_SWEBENCH_DATASET_FAMILY`, defaulting to "verified". Unknown ⇒ verified
 *  (fail-safe to the byte-identical default, never an undefined branch).
 *
 *  HIGH-3 (aug-22): the token→family decision is NOT made here. It delegates to
 *  the ONE owner, `normalizeDatasetFamilyToken`, which `parseDatasetFamilyOrThrow`
 *  (the fail-closed composition-root resolver) also delegates to. Previously this
 *  function only case-folded while run-config.ts also TRIMMED, so `" pro"`
 *  validated as Pro at the composition root and resolved Verified here — the
 *  corpus parse, verifier selection, dry-run label and report stamp all silently
 *  disagreed with the run that had been admitted as Pro. The two resolvers now
 *  differ ONLY in what they do with a token the owner rejects (default vs throw). */
export const resolveDatasetFamily = (
  argvValue: string | undefined,
  env: NodeJS.ProcessEnv,
): DatasetFamily =>
  // R4 (aug-22 re-audit): the ABSENT-selector default is not spelled here either.
  // Both the "nothing was selected" branch and the "the owner rejected the token"
  // branch delegate to `datasetFamilyOrDefault`, the ONE owner of that decision.
  datasetFamilyOrDefault(
    normalizeDatasetFamilyToken(argvValue ?? env.QUANTA_SWEBENCH_DATASET_FAMILY ?? ""),
  )

// NOTE (jun-30 T2): the former `bridgeDatasetFamilyToEnv` in-process authority
// bridge is GONE. The bench composition root now resolves ONE typed
// `BenchRunConfig` (`./run-config`), which owns the fail-closed parse and threads
// the typed `datasetFamily` field into every consumer. env is written ONLY by
// `serializeFamilyForSubprocess` (the subprocess/SSH boundary WIRE encoder),
// never as the in-process source of truth.

// PMX-02: `parseTasksForFamily` is GONE. It took dataset TEXT and returned
// `SwebenchTask[]`, i.e. it hard-coded "the file is JSONL" and "a task carries the
// whole upstream row on `.raw`" into the corpus seam — the two assumptions a
// family whose corpus is an official JSON ARRAY of gold-bearing rows breaks. The
// ONE corpus reader is now `DatasetFamilyProfile.readCorpus`, reached through
// `profiles/corpus-read.ts`. Nothing here re-parses a dataset.

/** Grade evaluator for the family. Pro ⇒ the Scale harness verifier (its opts carry
 *  the harness dir + raw CSV); verified/live ⇒ the official swebench harness. Both
 *  share the `PythonSwebenchResult` return shape AND the same process-global grading
 *  lock (R2), so the caller injects either into the one `VerifyDeps.pythonSwebench`
 *  seam with no verdict.ts change.
 *
 *  THIN SHIM (jun-30 T4): the harness selection lives in the ONE
 *  `DatasetFamilyProfile` registry. This keeps the historical call surface
 *  (`run-main.ts buildProGradeVerifier`) byte-compatible. */
export const gradeEvaluatorForFamily = (
  family: DatasetFamily,
  proOpts: ProSwebenchOpts = {},
): ((instance: Instance, patch: string, opts?: unknown) => Promise<PythonSwebenchResult>) =>
  resolveDatasetFamilyProfile(family).gradeEvaluator(proOpts)
