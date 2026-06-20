/**
 * Verdict-time grading: decide pass/fail for the captured patch.
 *
 * When the Python harness is wired AND the instance has swebench metadata,
 * grade officially; otherwise (the default) run the local `testCmd`. Never
 * throws — a harness error degrades to passed=false with the cause in
 * `error`. Returns rich evidence so the caller can emit a `verify` trajectory
 * event; pass/fail semantics are unchanged.
 */
import { isVerifyOutputFailing } from "@/agent/verify-signal"
import type { GradeBreakdown, Instance } from "../types"
import { exec } from "./exec"

export interface PythonSwebenchResult {
  resolved: boolean
  gradingCompleted: boolean
  /** Regression-vs-didn't-fix breakdown from the harness (eval-only diagnostic). */
  breakdown?: GradeBreakdown
  log: string
}

export type PythonSwebenchEvaluate = (
  instance: Instance,
  patch: string,
  opts?: unknown,
) => Promise<PythonSwebenchResult>

/** Pass/fail + the evidence a `verify` trajectory event needs (RFC §5.2). */
export interface VerifyOutcome {
  passed: boolean
  error?: string
  /** The grading command (testCmd, or the python-harness pseudo-command). */
  command: string
  exitCode: number
  failedTests: string[]
  logTail: string
  reportPath: string
  /** Official-grade regression-vs-didn't-fix breakdown (swebench path only). */
  breakdown?: GradeBreakdown
}

export interface VerifyDeps {
  timeoutMs: number
  /** T01 (audit L5 H-5): per-instance deadline / cancel signal. Threaded from
   *  `runInstanceOnce`'s `abort.signal` so a verify that is past its deadline
   *  stops the underlying harness work (and its transient-crash retry sleep)
   *  instead of running to completion and cascading into the next instance. */
  signal?: AbortSignal
  pythonSwebench?: {
    evaluate?: PythonSwebenchEvaluate
    opts?: unknown
  }
}

const PASS_SUMMARY_RE = /\b\d+\s+passed\b/i

const hasExplicitPassingSummary = (output: string): boolean => PASS_SUMMARY_RE.test(output)

const hasExplicitFailureSummary = (output: string): boolean =>
  isVerifyOutputFailing("test_runner", undefined, output)

export const verify = async (
  instance: Instance,
  patch: string,
  sandbox: string,
  deps: VerifyDeps,
): Promise<VerifyOutcome> => {
  // A swebench instance MUST be graded by the official Python harness. There is
  // NO testCmd fallback for it: the dataset sets `testCmd:"true"` (a no-op that
  // exits 0), so falling through to the local testCmd path below would FAKE a
  // PASS for every instance. Refuse loudly instead — a missing/unwired harness
  // is an infra error (harness_error), never a silent green.
  if (instance.swebench) {
    const ps = deps.pythonSwebench
    if (ps?.evaluate === undefined) {
      // When the Python harness is not wired, allow fallback to local testCmd ONLY
      // when: (a) the instance has a real, non-trivial testCmd (not the production
      // dataset's `testCmd:"true"` no-op), AND (b) the patch is non-empty.
      // The `testCmd:"true"` sentinel is what the official SWE-bench dataset ships —
      // falling through there would fake-pass every instance. An empty patch with a
      // real testCmd would also produce misleading results (swebench F2P tests can
      // pass on base). Both cases must refuse loudly.
      const isNoopTestCmd = instance.testCmd.trim() === "true" || instance.testCmd.trim() === ""
      if (isNoopTestCmd || patch.trim() === "") {
        return {
          passed: false,
          error:
            "swebench instance requires the official Python harness — REFUSING to fake-grade via testCmd. Set QUANTA_SWEBENCH_PYTHON=1 with an importable swebench (QUANTA_SWEBENCH_PYTHON_BIN).",
          command: `python -m swebench.harness.run_evaluation (${instance.swebench.instanceId})`,
          exitCode: 1,
          failedTests: [],
          logTail: "python swebench harness not wired — refused testCmd fake-grade",
          reportPath: "",
        }
      }
      // Real testCmd + non-empty patch: fall through to the local testCmd path below.
    } else {
      const evaluate = ps.evaluate
      // T01 (audit L5 H-5): forward the per-instance signal into the harness opts
      // so `evaluateWithPythonSwebench` can race its retry sleep against abort.
      // The `opts` is `unknown` at this seam (the harness module owns its shape);
      // we merge the signal as a typed extra without disturbing the rest.
      const baseOpts = (ps.opts ?? {}) as Record<string, unknown>
      const harnessOpts =
        deps.signal !== undefined ? { ...baseOpts, signal: deps.signal } : baseOpts
      const r = await evaluate(instance, patch, harnessOpts)
      const command = `python -m swebench.harness.run_evaluation (${instance.swebench.instanceId})`
      // REAL patch fail (`gradingCompleted:true + resolved:false`) → no `error`
      // (clean `passed:false`, classifier falls to `completed_unresolved`).
      // INFRA fail (`gradingCompleted:false`) → set `error` → `harness_error`.
      // Without this distinction every patch fail is misnamed harness_error.
      const isInfraFailure = !r.resolved && !r.gradingCompleted
      return {
        passed: r.resolved,
        ...(isInfraFailure ? { error: r.log.slice(0, 500) } : {}),
        command,
        exitCode: r.resolved ? 0 : 1,
        failedTests: [],
        logTail: r.log.slice(-2000),
        reportPath: "",
        ...(r.breakdown !== undefined ? { breakdown: r.breakdown } : {}),
      }
    }
  }
  // Empty-patch guard — when the agent produced no diff (LLM error, abort,
  // empty completion) running the FAIL_TO_PASS tests on the UNPATCHED
  // sandbox returns whatever the base commit produces. For swebench
  // instances that's *supposed* to fail (F2P = fail-to-pass), but pytest
  // `-k` substring matching can collect tests that pass on base too,
  // yielding a false PASS. Fail-closed: empty patch ⇒ unresolved.
  if (patch.trim() === "") {
    return {
      passed: false,
      error: "empty prediction (agent produced no patch)",
      command: instance.testCmd,
      exitCode: 1,
      failedTests: [],
      logTail: "agent produced empty patch — testCmd skipped (fail-closed)",
      reportPath: "",
    }
  }
  const test = await exec(instance.testCmd, sandbox, deps.timeoutMs, {
    ...(instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {}),
  })
  // Pytest summary parsing — exit code alone is unreliable when the shell
  // wrapper got SIGTERM'd (exit 143) AFTER pytest already printed its
  // summary. Trust the explicit pass summary only when there is NO explicit
  // non-zero failure signal in the same output:
  //   "X passed, ..." + no "N failed/failures/errors" (N>0) → passed
  // Any explicit failure signal wins over exit code 0 as well: some runners
  // can still emit a zero exit while reporting failed/error counts in their
  // summary, and grading must fail closed there.
  const combined = `${test.stdout}\n${test.stderr}`
  const explicitFailure = hasExplicitFailureSummary(combined)
  const summaryPass =
    hasExplicitPassingSummary(combined) && !explicitFailure
  const passed = !explicitFailure && (test.code === 0 || summaryPass)
  return {
    passed,
    command: instance.testCmd,
    exitCode: test.code,
    failedTests: [],
    logTail: combined.slice(-2000),
    reportPath: "",
  }
}
