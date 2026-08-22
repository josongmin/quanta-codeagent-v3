/**
 * TB — bench adapter for the regression oracle.
 *
 * Shared runner-surface wiring for verify-select regression checks. Mirrors the
 * app adapter but lives in the shared eval slice so `@/runner/batch/eval`
 * doesn't silently expose verify-select knobs without an executor.
 */

import type { LocalEnvSelection } from "@/runtime"
import { buildProjectEnvUvRunArgv } from "../corpus/project-env"
import { execArgv } from "./exec"
import {
  makeRegressionOracle,
  type RegressionExecPort,
  type RegressionResult,
  type RunImpactedTestsPort,
} from "./regression-oracle"

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

export const buildProjectPytestArgv =
  (repo: string | undefined, version: string | undefined) =>
  (tests: readonly string[]): readonly string[] => [
    ...buildProjectEnvUvRunArgv(repo ?? "", version, ["pytest"]),
    "pytest",
    "-x",
    "-p",
    "no:cacheprovider",
    "-q",
    "--no-header",
    ...tests,
  ]

const benchExec =
  (localEnv: LocalEnvSelection | undefined): RegressionExecPort =>
  (argv, cwd, timeoutMs) =>
    execArgv(argv, cwd, timeoutMs, localEnv !== undefined ? { localEnv } : undefined)

const DEFAULT_TIMEOUT_MS = 300_000

export interface BenchRegressionOracle {
  run(args: {
    tests: readonly string[]
    sandbox: string
    timeoutMs?: number
  }): Promise<RegressionResult>
}

export const makeBenchRegressionOracle = (
  buildArgv: (tests: readonly string[]) => readonly string[] = buildPytestArgv,
  options: { readonly localEnv?: LocalEnvSelection } = {},
): BenchRegressionOracle => {
  const port: RunImpactedTestsPort = makeRegressionOracle()
  return {
    run: ({ tests, sandbox, timeoutMs }) =>
      port.run({
        tests,
        sandbox,
        exec: benchExec(options.localEnv),
        timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        buildArgv,
      }),
  }
}
