/**
 * Verdict-time grading: decide pass/fail for the captured patch.
 *
 * When the Python harness is wired AND the instance has swebench metadata,
 * grade officially; otherwise (the default) run the local `testCmd`. Never
 * throws — a harness error degrades to passed=false with the cause in
 * `error`. Returns rich evidence so the caller can emit a `verify` trajectory
 * event; pass/fail semantics are unchanged.
 */
import type { Instance } from "../types"
import { exec } from "./exec"

export interface PythonSwebenchResult {
  resolved: boolean
  gradingCompleted: boolean
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

export const verify = async (
  instance: Instance,
  patch: string,
  sandbox: string,
  deps: VerifyDeps,
): Promise<VerifyOutcome> => {
  if (deps.pythonSwebench && instance.swebench) {
    const evaluate = deps.pythonSwebench.evaluate
    if (evaluate === undefined) {
      return {
        passed: false,
        error: "python swebench evaluator not wired",
        command: `python -m swebench.harness.run_evaluation (${instance.swebench.instanceId})`,
        exitCode: 1,
        failedTests: [],
        logTail: "python swebench evaluator not wired",
        reportPath: "",
      }
    }
    // T01 (audit L5 H-5): forward the per-instance signal into the harness opts
    // so `evaluateWithPythonSwebench` can race its retry sleep against abort.
    // The `opts` is `unknown` at this seam (the harness module owns its shape);
    // we merge the signal as a typed extra without disturbing the rest.
    const baseOpts = (deps.pythonSwebench.opts ?? {}) as Record<string, unknown>
    const harnessOpts = deps.signal !== undefined ? { ...baseOpts, signal: deps.signal } : baseOpts
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
  const test = await exec(instance.testCmd, sandbox, deps.timeoutMs)
  // Pytest summary parsing — exit code alone is unreliable when the shell
  // wrapper got SIGTERM'd (exit 143) AFTER pytest already printed its
  // summary. Trust the explicit summary line when present:
  //   "X passed, ..." with no "Y failed" / "Y error" → passed
  // This recovers real passes that exit-code-only logic would mis-fail.
  const combined = `${test.stdout}\n${test.stderr}`
  const summaryPass =
    /\b\d+ passed\b/.test(combined) &&
    !/\b\d+ failed\b/.test(combined) &&
    !/\b\d+ error\b/.test(combined)
  const passed = test.code === 0 || summaryPass
  return {
    passed,
    command: instance.testCmd,
    exitCode: test.code,
    failedTests: [],
    logTail: combined.slice(-2000),
    reportPath: "",
  }
}
