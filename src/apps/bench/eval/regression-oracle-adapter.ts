/**
 * TB — bench adapter for the regression oracle.
 *
 * Instantiates the engine {@link RunImpactedTestsPort} with the bench's real
 * argv-exec (`execArgv`, scrubbed env) and a project-env pytest command. The
 * caller (the selection executor, TD) supplies the concrete test ids — the
 * eval-only PASS_TO_PASS set, threaded the SAME way `closure-diagnostics`
 * threads gold files. This adapter therefore names NO official hidden field;
 * the no-leak boundary is the call site, not this module.
 *
 * pytest node-ids cover the majority of SWE-bench Python repos; `buildArgv` is
 * injectable so a per-repo command (django `runtests.py`, sympy `bin/test`) can
 * be supplied without touching the engine port.
 */

import { execArgv } from "@/runner/batch/eval/exec"
import {
  makeRegressionOracle,
  type RegressionExecPort,
  type RegressionResult,
  type RunImpactedTestsPort,
} from "@/runner/batch/eval/regression-oracle"

/** Default project-env pytest command over explicit node-ids. The patched
 *  repo is already installed by env-prep, so `python -m pytest <ids>` resolves
 *  the project's own source. `no:cacheprovider` keeps the sandbox read-clean. */
export const buildPytestArgv = (tests: readonly string[]): readonly string[] => [
  "python",
  "-m",
  "pytest",
  "-p",
  "no:cacheprovider",
  "-q",
  "--no-header",
  ...tests,
]

/** The bench exec port is `execArgv` — argv form (no shell word-splitting of
 *  test ids) with the scrubbed env (no token inheritance). */
const benchExec: RegressionExecPort = (argv, cwd, timeoutMs) => execArgv(argv, cwd, timeoutMs)

/** Regression check wall-clock cap (PASS_TO_PASS suites can be large). */
const DEFAULT_TIMEOUT_MS = 300_000

export interface BenchRegressionOracle {
  /** Run the supplied (eval-only) impacted tests in the patched sandbox. */
  run(args: {
    tests: readonly string[]
    sandbox: string
    timeoutMs?: number
  }): Promise<RegressionResult>
}

/** Build the bench-wired oracle. `buildArgv` overridable for per-repo runners. */
export const makeBenchRegressionOracle = (
  buildArgv: (tests: readonly string[]) => readonly string[] = buildPytestArgv,
): BenchRegressionOracle => {
  const port: RunImpactedTestsPort = makeRegressionOracle()
  return {
    run: ({ tests, sandbox, timeoutMs }) =>
      port.run({
        tests,
        sandbox,
        exec: benchExec,
        timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        buildArgv,
      }),
  }
}
