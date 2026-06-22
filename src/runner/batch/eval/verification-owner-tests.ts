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
  type RepoTextFile,
} from "./impacted-test-discovery"
import { listTrackedPythonFiles, readRepoTestFiles } from "./repo-regression-discovery-adapter"
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
  readonly instance: Pick<Instance, "swebench">
  readonly ownerCandidates: readonly string[]
  readonly sandbox: string
  readonly timeoutMs: number
  readonly maxTests?: number
}

export interface DiscoverVerificationOwnerTestsDeps {
  readonly listPythonFiles?: typeof listTrackedPythonFiles
  readonly readTestFiles?: typeof readRepoTestFiles
}

export const discoverVerificationOwnerTests = async (
  args: DiscoverVerificationOwnerTestsArgs,
  deps: DiscoverVerificationOwnerTestsDeps = {},
): Promise<readonly string[]> => {
  const changedFiles = [...new Set(args.ownerCandidates.map(normalizeRepoPath))].filter(
    isPythonSourceFile,
  )
  if (changedFiles.length === 0) return []

  const pythonFiles = await (deps.listPythonFiles ?? listTrackedPythonFiles)(
    args.sandbox,
    args.timeoutMs,
  )
  if (pythonFiles.length === 0) return []

  const repoFiles = await (deps.readTestFiles ?? readRepoTestFiles)(args.sandbox, pythonFiles)
  if (repoFiles.length === 0) return []

  const discovered = discoverImpactedTestCandidates({
    changedFiles,
    repoFiles: repoFiles as readonly RepoTextFile[],
    maxTests: args.maxTests ?? DEFAULT_VERIFICATION_OWNER_TESTS,
  })
  if (discovered.length === 0) return []

  const buildArgv =
    args.instance.swebench?.repo !== undefined
      ? buildProjectPytestArgv(args.instance.swebench.repo, args.instance.swebench.version)
      : buildPytestArgv
  return discovered.map((candidate) => shellJoin(buildArgv([candidate.path])))
}
