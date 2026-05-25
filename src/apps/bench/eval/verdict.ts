/**
 * Verdict-time grading: decide pass/fail for the captured patch.
 *
 * When the Python harness is wired AND the instance has swebench metadata,
 * grade officially; otherwise (the default) run the local `testCmd`. Never
 * throws — a harness error degrades to passed=false with the cause in
 * `error`. Returns rich evidence so the caller can emit a `verify` trajectory
 * event; pass/fail semantics are unchanged.
 */
import { evaluateWithPythonSwebench, type PySwebenchOpts } from "../python-swebench"
import type { Instance } from "../types"
import { exec } from "./exec"

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
  pythonSwebench?: {
    evaluate?: typeof evaluateWithPythonSwebench
    opts?: PySwebenchOpts
  }
}

export const verify = async (
  instance: Instance,
  patch: string,
  sandbox: string,
  deps: VerifyDeps,
): Promise<VerifyOutcome> => {
  if (deps.pythonSwebench && instance.swebench) {
    const evaluate = deps.pythonSwebench.evaluate ?? evaluateWithPythonSwebench
    const r = await evaluate(instance, patch, deps.pythonSwebench.opts ?? {})
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
  const test = await exec(instance.testCmd, sandbox, deps.timeoutMs)
  return {
    passed: test.code === 0,
    command: instance.testCmd,
    exitCode: test.code,
    failedTests: [],
    logTail: `${test.stdout}\n${test.stderr}`.slice(-2000),
    reportPath: "",
  }
}
