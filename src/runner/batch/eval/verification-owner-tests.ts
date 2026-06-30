/**
 * Public owner-near verification commands for ClosureSession / VerificationPlan.
 *
 * This module discovers EXISTING repo tests near the current owner candidates
 * and renders them as stable pytest shell commands. The output is PUBLIC
 * evidence only: these commands may seed verification planning / repair
 * guidance, but they are not a hidden oracle and they do not bypass the clean
 * selector's executed-proof authority.
 */

import type { Instance } from "../types"
import {
  discoverImpactedTestCandidates,
  isPythonTestFile,
  normalizeRepoPath,
} from "./impacted-test-discovery"
import {
  collectBaseGreenRepoTests,
  listTrackedPythonFiles,
  probeRepoTestOnCurrentTree,
  readRepoTestFiles,
} from "./repo-regression-discovery-adapter"
import { buildProjectPytestArgv, buildPytestArgv } from "./regression-oracle-adapter"

export const DEFAULT_VERIFICATION_OWNER_TESTS = 3

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
const shellWord = (s: string): string => (/^[A-Za-z0-9_./:=+-]+$/.test(s) ? s : shellQuote(s))
const shellJoin = (argv: readonly string[]): string => argv.map(shellWord).join(" ")

const isPythonSourceFile = (path: string): boolean => {
  const normalized = normalizeRepoPath(path)
  return normalized.endsWith(".py") && !isPythonTestFile(normalized)
}

export interface DiscoverVerificationOwnerTestsArgs {
  readonly instance: Pick<Instance, "swebench" | "localEnv">
  readonly ownerCandidates: readonly string[]
  readonly sandbox: string
  readonly timeoutMs: number
  readonly maxTests?: number
}

export interface DiscoverVerificationOwnerTestsDeps {
  readonly listPythonFiles?: typeof listTrackedPythonFiles
  readonly readTestFiles?: typeof readRepoTestFiles
  readonly collectBaseGreenTests?: typeof collectBaseGreenRepoTests
  readonly probeBaseTest?: typeof probeRepoTestOnCurrentTree
}

export type VerificationPrimaryBaseState = "red" | "green" | "unavailable"

export interface VerificationOwnerTestsPlan {
  readonly commands: readonly string[]
  readonly testPaths: readonly string[]
  readonly baseGreenTestPaths: readonly string[]
  /** Base-tree verdict of the PRIMARY owner-test candidate (the first command that
   *  becomes the fallback primary rail when no validated repro exists). */
  readonly primaryBaseState: VerificationPrimaryBaseState
}

const renderVerificationOwnerTestCommands = (
  instance: Pick<Instance, "swebench">,
  tests: readonly string[],
): readonly string[] => {
  const buildArgv =
    instance.swebench?.repo !== undefined
      ? buildProjectPytestArgv(instance.swebench.repo, instance.swebench.version)
      : buildPytestArgv
  return tests.map((test) => shellJoin(buildArgv([test])))
}

const toPrimaryBaseState = (verdict: boolean | null): VerificationPrimaryBaseState =>
  verdict === true ? "green" : verdict === false ? "red" : "unavailable"

export const discoverVerificationOwnerTestsPlan = async (
  args: DiscoverVerificationOwnerTestsArgs,
  deps: DiscoverVerificationOwnerTestsDeps = {},
): Promise<VerificationOwnerTestsPlan> => {
  const changedFiles = [...new Set(args.ownerCandidates.map(normalizeRepoPath))].filter(
    isPythonSourceFile,
  )
  if (changedFiles.length === 0) {
    return { commands: [], testPaths: [], baseGreenTestPaths: [], primaryBaseState: "unavailable" }
  }

  const pythonFiles = await (deps.listPythonFiles ?? listTrackedPythonFiles)(
    args.sandbox,
    args.timeoutMs,
  )
  if (pythonFiles.length === 0) {
    return { commands: [], testPaths: [], baseGreenTestPaths: [], primaryBaseState: "unavailable" }
  }

  const repoFiles = await (deps.readTestFiles ?? readRepoTestFiles)(args.sandbox, pythonFiles)
  if (repoFiles.length === 0) {
    return { commands: [], testPaths: [], baseGreenTestPaths: [], primaryBaseState: "unavailable" }
  }

  const discovered = discoverImpactedTestCandidates({
    changedFiles,
    repoFiles,
    maxTests: args.maxTests ?? DEFAULT_VERIFICATION_OWNER_TESTS,
  })
  if (discovered.length === 0) {
    return { commands: [], testPaths: [], baseGreenTestPaths: [], primaryBaseState: "unavailable" }
  }

  const testPaths = discovered.map((candidate) => candidate.path)
  const baseGreenTestPaths =
    args.instance.swebench?.baseCommit === undefined
      ? []
      : [
          ...(
            await (deps.collectBaseGreenTests ?? collectBaseGreenRepoTests)({
              instance: args.instance,
              sandbox: args.sandbox,
              timeoutMs: args.timeoutMs,
              tests: testPaths,
            })
          ),
        ]
  const primaryBaseVerdict =
    testPaths[0] === undefined
      ? null
      : await (deps.probeBaseTest ?? probeRepoTestOnCurrentTree)({
          instance: args.instance,
          sandbox: args.sandbox,
          timeoutMs: args.timeoutMs,
          test: testPaths[0],
        })
  return {
    commands: renderVerificationOwnerTestCommands(args.instance, testPaths),
    testPaths,
    baseGreenTestPaths,
    primaryBaseState: toPrimaryBaseState(primaryBaseVerdict),
  }
}

export const discoverVerificationOwnerTests = async (
  args: DiscoverVerificationOwnerTestsArgs,
  deps: DiscoverVerificationOwnerTestsDeps = {},
): Promise<readonly string[]> => (await discoverVerificationOwnerTestsPlan(args, deps)).commands
