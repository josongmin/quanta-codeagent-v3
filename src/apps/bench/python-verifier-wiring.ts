/**
 * Bench GRADE-VERIFIER wiring — `buildProGradeVerifier` + `buildPythonSwebench`
 * extracted VERBATIM out of `run-main.ts` (aug-22), which was over the
 * god-MODULE line gate. One cohesive, downward-closed concern: given the TYPED
 * resolved `DatasetFamily`, decide which harness fills the single
 * `RunCfg.pythonSwebench` seam.
 *
 * HIGH-1 (aug-22): the family arrives as a TYPED PARAMETER. It used to be
 * re-derived here through `datasetFamily()`, a fresh argv+ambient-env read that
 * could disagree with the config the composition root had already admitted —
 * the split-brain that degraded Pro rows to the `testCmd:"true"` no-op. The
 * remaining `process.env` reads in this module are genuine operator knobs for
 * the Pro/official harness location (HARNESS_DIR / PYTHON_BIN / RAW_SAMPLE_PATH
 * / DOCKERHUB_USERNAME / MODEL_NAME / DATASET_NAME), NOT the family axis.
 *
 * `exit` is INJECTED rather than imported so this module has no runtime edge
 * back into `run-main.ts` (the type-only imports below are erased).
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { gateOn, logger } from "@/shared"
import type { DatasetFamily } from "./dataset-family-token"
import { isPythonSwebenchAvailable } from "./harness"
import { resolveDatasetFamilyProfile } from "./profiles/registry"
import type { DatasetFamilyProfile } from "./profiles/types"
import { argValue } from "./run-args"
import type { ExitFn, RunCfg } from "./run-main"

/** Build the optional Python-harness wiring for the runner. Returns undefined
 *  unless `QUANTA_SWEBENCH_PYTHON=1` AND the official harness is importable
 *  (probe is real here). Default-off ⇒ the local testCmd path is unchanged. */
// REGRESSION FIX (jun-30): the god-MODULE split (11adab597) dropped this Pro grader
// branch — `family=pro` then fell through to the VERIFIED harness, which can't find
// Pro instance_ids ⇒ gold-sanity "gold did not resolve" ⇒ 8/8 grader_invalid. The
// Pro grader injects into the SAME `pythonSwebench` seam (the family profile's
// `gradeEvaluator` port), so verify()/gold-sanity transparently grade with the
// ScaleAI harness. Opts come
// from box-set env (QUANTA_SWEBENCH_PRO_HARNESS_DIR/RAW_SAMPLE_PATH/PYTHON_BIN).
const buildProGradeVerifier = (
  profile: DatasetFamilyProfile,
  exit: ExitFn,
): RunCfg["pythonSwebench"] => {
  const defaultHarnessDir = join(homedir(), "swebench-pro")
  const defaultPythonBin = join(homedir(), "swebench-pro-venv", "bin", "python")
  const configuredHarnessDir = process.env.QUANTA_SWEBENCH_PRO_HARNESS_DIR
  const harnessDir =
    configuredHarnessDir ??
    (existsSync(join(defaultHarnessDir, "swe_bench_pro_eval.py")) ? defaultHarnessDir : undefined)
  const configuredRawSamplePath =
    process.env.QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH ?? argValue("--swebench")
  const rawSamplePath =
    configuredRawSamplePath !== undefined ? resolve(configuredRawSamplePath) : undefined
  if (!harnessDir || !rawSamplePath) {
    logger.error(
      `dataset-family=${profile.family} requires QUANTA_SWEBENCH_PRO_HARNESS_DIR + ` +
        "QUANTA_SWEBENCH_PRO_RAW_SAMPLE_PATH, or the default ~/swebench-pro clone plus " +
        "the --swebench JSONL path. " +
        "REFUSING to fake-grade. Aborting.",
    )
    exit(1)
    return undefined
  }
  const configuredPythonBin = process.env.QUANTA_SWEBENCH_PRO_PYTHON_BIN
  const pythonBin =
    configuredPythonBin ?? (existsSync(defaultPythonBin) ? defaultPythonBin : undefined)
  const dockerhubUsername = process.env.QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME
  const modelName = process.env.QUANTA_SWEBENCH_PRO_MODEL_NAME
  logger.info(
    `using ${profile.verifierLabel ?? "the pro-harness"} for grading (${harnessDir}, python=${pythonBin ?? "python3"})`,
  )
  // aug-22 re-audit R6: the evaluator comes from THIS family's profile port, not
  // from a hardcoded `gradeEvaluatorForFamily("pro", …)`. `gradesWithProHarness`
  // is a per-profile discriminant, so any family that sets it took this branch —
  // and then got the PRO profile's evaluator regardless of its own
  // `gradeEvaluator`. The T4 stop rule ("adding a family is one token + one
  // profile object, NOTHING in any consumer") was false on the real local-run
  // grade path: family #4's grade port was unreachable there.
  return {
    evaluate: profile.gradeEvaluator({
      harnessDir,
      rawSamplePath,
      ...(pythonBin !== undefined ? { pythonBin } : {}),
      ...(dockerhubUsername ? { dockerhubUsername } : {}),
      ...(modelName ? { modelName } : {}),
    }),
  }
}

export const buildPythonSwebench = async (
  family: DatasetFamily,
  exit: ExitFn,
): Promise<RunCfg["pythonSwebench"]> => {
  const profile = resolveDatasetFamilyProfile(family)
  if (profile.gradesWithProHarness) return buildProGradeVerifier(profile, exit)
  if (!gateOn(process.env, "QUANTA_SWEBENCH_PYTHON")) {
    // WARN LOUD AT LAUNCH (aug-23). Returning `undefined` here is not a soft
    // degrade: `verdict.ts` REFUSES to grade every official-dataset instance
    // (their shipped `testCmd` is the `"true"` no-op, so grading locally would
    // fake-pass everything). The refusal surfaces per-instance as a plain FAIL,
    // which reads exactly like "the agent could not solve it" — a live misread
    // cost a full picks-10 run scored 2/10 that was really 6/10 once graded.
    // The run is still useful for patch generation, so warn rather than abort.
    logger.warn(
      `QUANTA_SWEBENCH_PYTHON is not set — official ${family} grading is OFF. ` +
        "Every instance will be REFUSED (reported as FAIL, not solved-0); patches are still written. " +
        "Read `score official_harness N/M` in the summary, not the per-instance PASS/FAIL. " +
        "To grade for real: QUANTA_SWEBENCH_PYTHON=1 (plus QUANTA_SWEBENCH_PYTHON_BIN=<python that can `import swebench`>).",
    )
    return undefined
  }
  if (!(await isPythonSwebenchAvailable())) {
    // FAIL LOUD — no silent fake fallback. The operator explicitly asked for
    // real grading (QUANTA_SWEBENCH_PYTHON=1); silently degrading to the
    // testCmd="true" no-op would fake a PASS for every swebench instance.
    // Abort so a broken harness can never be mistaken for a green run.
    logger.error(
      'QUANTA_SWEBENCH_PYTHON=1 but `python -c "import swebench"` failed (60s probe). ' +
        "REFUSING to fake-grade. Fix QUANTA_SWEBENCH_PYTHON_BIN / install swebench, " +
        "or unset QUANTA_SWEBENCH_PYTHON. Aborting.",
    )
    exit(1)
    return undefined // unreachable in prod (exit = process.exit)
  }
  // REGRESSION FIX (jun-30): restore the Live default the refactor dropped — family=live
  // grades a DIFFERENT dataset; defaulting to Verified would look Live ids up in the
  // Verified dataset (KeyError / mismatched spec). Verified/Pro unchanged.
  const liveDefault = profile.defaultDatasetName
  const datasetName =
    argValue("--dataset-name") ?? process.env.QUANTA_SWEBENCH_DATASET_NAME ?? liveDefault
  logger.info(
    `using official Python swebench harness for grading (dataset=${datasetName ?? "princeton-nlp/SWE-bench_Verified (default)"})`,
  )
  // HIGH-1 (aug-22): the TYPED family rides on the harness opts so the local
  // grade refusal reads the resolved config instead of a fresh ambient
  // `process.env` read. Without this the refusal only fired when the operator
  // happened to have exported the env var, and a `--dataset-family live` local
  // grade fell through to a KeyError.
  // HIGH-4 (aug-22): use the PROFILE's own grade evaluator rather than a
  // hand-rolled copy of it — this module used to duplicate the registry's
  // stamping, so a guard the profile added (e.g. Live's local-grade refusal) was
  // silently absent on this path.
  const evaluate: NonNullable<RunCfg["pythonSwebench"]>["evaluate"] = profile.gradeEvaluator()
  return datasetName !== undefined ? { evaluate, opts: { datasetName } } : { evaluate }
}
