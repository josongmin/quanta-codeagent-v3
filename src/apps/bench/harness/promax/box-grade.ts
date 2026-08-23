/**
 * PMX-04 — THE ON-BOX GRADE INVOCATION for SWE-bench ProMax.
 *
 * ProMax does not grade through the `swebench` pip harness: `harnessSpec`
 * refuses it, because looking ProMax ids up in SWE-bench Verified is exactly the
 * silent-wrong-family route packet invariant 1 forbids. It grades by running its
 * own PINNED evaluator (`src/evaluation/test_run.py` at the frozen commit).
 *
 * On a box that evaluator exists only inside the GRADER WINDOW — the checkout is
 * created by the grader phase and `rm -rf`'d by the teardown bound to the same
 * `executeFamilyRemoteBootstrap` call. So every input here is resolved against
 * the MATERIALIZED tree rather than against anything shipped separately:
 *
 *   evaluator  <checkout>/src/evaluation/test_run.py   ← hash-verified by the
 *   golden     <checkout>/data/swe-bench-promax.json      grader phase moments
 *   eval meta  <checkout>/data/eval.json                  before this runs
 *   python     <venv>/bin/python                        ← built by the grader phase
 *
 * The answer key is therefore READ from inside the window and destroyed with it.
 * Nothing about it is copied to a path the teardown does not cover, and the
 * agent phase — which ran earlier, with the checkout absent and an absence probe
 * proving it — never saw any of these paths exist.
 *
 * `--workers` is pinned at 1 and is NOT a parameter. Concurrent grading produced
 * FALSE NEGATIVES on correct patches (jun-19), so the value is a measurement
 * property; offering a knob would let a run trade correctness for wall-clock
 * without saying so. The argv construction itself is delegated to
 * {@link buildProMaxEvaluatorInvocation}, the same builder the local gate uses,
 * so the box and the operator's laptop cannot drift into invoking the pinned
 * evaluator differently.
 *
 * PURE: builds a string. Issues nothing.
 */
import { shq } from "../../remote/box-session/shell"
import type { ProMaxInvocationFailureCode } from "./invocation"
import { buildProMaxEvaluatorInvocation } from "./invocation"

/**
 * This module's own failure vocabulary, EXTENDING the shared invocation codes
 * rather than borrowing them.
 *
 * The two roots below are a concern the shared builder does not have — it is
 * given one `pinnedRoot` and knows nothing about a venv or a grader window — so
 * inventing codes inside its closed union would have made that union mean two
 * different things depending on the caller.
 */
export type ProMaxBoxGradeFailureCode =
  | "checkout_root_not_absolute"
  | "venv_root_not_absolute"
  | ProMaxInvocationFailureCode

export interface ProMaxBoxGradeFailure {
  readonly code: ProMaxBoxGradeFailureCode
  readonly message: string
}

/**
 * The upstream dataset inside the pinned checkout — the ProMax answer key.
 *
 * It is the golden the evaluator compares against, and it is one of the three
 * files the grader phase `sha256sum`s, so grading reads the same bytes the pin
 * was proved on.
 */
export const PROMAX_ONBOX_GOLDEN_RELATIVE_PATH = "data/swe-bench-promax.json"

/** The pinned evaluator's concurrency. See the module note — not a parameter. */
const PROMAX_ONBOX_GRADE_WORKERS = 1

export interface ProMaxBoxGradeInput {
  /** on-box root of the pinned checkout the grader phase created. */
  readonly checkoutRoot: string
  /** on-box root of the venv the grader phase built. */
  readonly venvRoot: string
  /** on-box predictions the AGENT phase produced. */
  readonly predictionsPath: string
  /** on-box path the evaluator writes its pass-rate document to. */
  readonly outputPath: string
}

export type ProMaxBoxGradeResult =
  | {
      readonly ok: true
      /** the shell command, fully quoted, ready for `ssh`. */
      readonly command: string
      readonly argv: readonly string[]
      readonly cwd: string
    }
  | { readonly ok: false; readonly failures: readonly ProMaxBoxGradeFailure[] }

/** Absolute-path check for the two roots this module adds on top of the shared
 *  invocation builder's own checks. A relative root would resolve against
 *  whatever cwd ssh happens to land in, which is not replayable from a receipt. */
const relativeRootFailure = (
  field: "checkoutRoot" | "venvRoot",
  code: "checkout_root_not_absolute" | "venv_root_not_absolute",
  value: string,
): ProMaxBoxGradeFailure | undefined =>
  value.startsWith("/")
    ? undefined
    : {
        code,
        message:
          `${field}="${value}" is not an absolute path. The grader window's paths are fixed ` +
          "on-box locations; a relative one would resolve against whatever cwd the ssh session " +
          "happens to have, and could not be replayed from a receipt.",
      }

/**
 * Build the command that grades this chunk's predictions on the box.
 *
 * Intended to be handed to `executeFamilyRemoteBootstrap`'s `whileMaterialized`
 * seam, so the teardown that removes the answer key covers this run too —
 * including when it throws.
 */
export const buildProMaxBoxGradeCommand = (input: ProMaxBoxGradeInput): ProMaxBoxGradeResult => {
  const rootFailures = [
    relativeRootFailure("checkoutRoot", "checkout_root_not_absolute", input.checkoutRoot),
    relativeRootFailure("venvRoot", "venv_root_not_absolute", input.venvRoot),
  ].filter((f): f is ProMaxBoxGradeFailure => f !== undefined)
  if (rootFailures.length > 0) return { ok: false, failures: rootFailures }

  const checkout = input.checkoutRoot.replace(/\/+$/, "")
  const venv = input.venvRoot.replace(/\/+$/, "")

  // Delegated, NOT re-implemented: the local gate and the box must not drift
  // into two spellings of the same pinned invocation.
  const invocation = buildProMaxEvaluatorInvocation({
    pinnedRoot: checkout,
    predictionsPath: input.predictionsPath,
    goldenPath: `${checkout}/${PROMAX_ONBOX_GOLDEN_RELATIVE_PATH}`,
    outputPath: input.outputPath,
    pythonExecutable: `${venv}/bin/python`,
    workers: PROMAX_ONBOX_GRADE_WORKERS,
  })
  if (!invocation.ok) return { ok: false, failures: invocation.failures }

  const { argv, cwd } = invocation.invocation
  return {
    ok: true,
    // Every token quoted — a campaign path is operator-supplied in principle,
    // and an unquoted one is a shell-injection seam on a box that also holds the
    // answer key.
    command: argv.map((token) => shq(token)).join(" "),
    argv,
    cwd,
  }
}
