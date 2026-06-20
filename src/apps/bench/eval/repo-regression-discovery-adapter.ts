/**
 * No-oracle repo-regression gate for verify-and-select.
 *
 * Discovers existing repo tests related to a candidate's changed source files,
 * preflights them on the base tree, then runs the same tests on
 * base+candidate.patch. Only base-green tests can reject a candidate. Missing
 * tests, collection failures, base-red tests, and materialization failures all
 * return null (fail-open).
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { execArgv } from "@/runner/batch/eval/exec"
import {
  discoverImpactedTests,
  isPythonTestFile,
  normalizeRepoPath,
  type RepoTextFile,
} from "@/runner/batch/eval/impacted-test-discovery"
import { toRegressionGreen } from "@/runner/batch/eval/regression-oracle"
import { resetToBase, withCandidatePatch } from "@/runner/batch/eval/rematerialize"
import type { Candidate } from "@/runner/batch/eval/selection-executor"
import type { Instance } from "@/runner/batch/types"
import { buildProjectPytestArgv, makeBenchRegressionOracle } from "./regression-oracle-adapter"

const DEFAULT_DISCOVERY_MAX_TESTS = 12

const keyOf = (xs: readonly string[]): string => [...xs].map(normalizeRepoPath).sort().join("\n")

const listTrackedPythonFiles = async (
  sandbox: string,
  timeoutMs: number,
): Promise<readonly string[]> => {
  const r = await execArgv(["git", "ls-files", "-z", "--", "*.py"], sandbox, timeoutMs).catch(
    () => null,
  )
  if (r === null || r.code !== 0) return []
  return r.stdout.split("\0").map(normalizeRepoPath).filter(Boolean)
}

const readRepoTestFiles = async (
  sandbox: string,
  paths: readonly string[],
): Promise<readonly RepoTextFile[]> => {
  const out: RepoTextFile[] = []
  for (const path of paths) {
    if (!isPythonTestFile(path)) continue
    const text = await readFile(join(sandbox, path), "utf8").catch(() => null)
    if (text !== null) out.push({ path, text })
  }
  return out
}

export interface DiscoveredRepoRegressionPortArgs {
  readonly instance: Instance
  readonly sandbox: string
  readonly timeoutMs: number
  readonly maxTests?: number
}

type SingleTestVerdictPort = (test: string) => Promise<boolean | null>

/** Base preflight for heuristic discovery must be resilient to noisy matches:
 *  keep the subset that is individually green on the base tree, rather than
 *  letting one unrelated base-red file null out the entire discovered set. */
export const keepBaseGreenDiscoveredTests = async (
  tests: readonly string[],
  run: SingleTestVerdictPort,
): Promise<readonly string[]> => {
  const kept: string[] = []
  for (const test of tests) {
    if ((await run(test)) === true) kept.push(test)
  }
  return kept
}

/** Once a discovered test is proven green on base, the candidate must keep it
 *  green. A later non-verdict (collection error / no-tests / exec failure) is
 *  no longer "unknown"; it is a new failure relative to base and rejects. */
export const candidateKeepsBaseGreenTests = async (
  tests: readonly string[],
  run: SingleTestVerdictPort,
): Promise<boolean> => {
  for (const test of tests) {
    if ((await run(test)) !== true) return false
  }
  return true
}

export const makeDiscoveredRepoRegressionPort = (
  args: DiscoveredRepoRegressionPortArgs,
): ((c: Candidate) => Promise<boolean | null>) => {
  const { instance, sandbox, timeoutMs } = args
  const baseCommit = instance.swebench?.baseCommit
  const maxTests = args.maxTests ?? DEFAULT_DISCOVERY_MAX_TESTS
  const oracle = makeBenchRegressionOracle(
    buildProjectPytestArgv(instance.swebench?.repo, instance.swebench?.version),
    instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {},
  )

  const discoveryCache = new Map<string, Promise<readonly string[]>>()
  const baseGreenCache = new Map<string, Promise<readonly string[] | null>>()

  const discoverFor = (candidate: Candidate): Promise<readonly string[]> => {
    const key = keyOf(candidate.files)
    const cached = discoveryCache.get(key)
    if (cached !== undefined) return cached
    const p = (async (): Promise<readonly string[]> => {
      if (baseCommit === undefined) return []
      if (!(await resetToBase(sandbox, baseCommit, timeoutMs))) return []
      const paths = await listTrackedPythonFiles(sandbox, timeoutMs)
      const repoFiles = await readRepoTestFiles(sandbox, paths)
      return discoverImpactedTests({
        changedFiles: candidate.files,
        repoFiles,
        maxTests,
      })
    })()
    discoveryCache.set(key, p)
    return p
  }

  const runOneBaseTest = async (test: string): Promise<boolean | null> => {
    if (baseCommit === undefined) return null
    if (!(await resetToBase(sandbox, baseCommit, timeoutMs))) return null
    const r = await oracle.run({ tests: [test], sandbox, timeoutMs }).catch(() => null)
    return toRegressionGreen([test], r)
  }

  const baseGreenFor = (tests: readonly string[]): Promise<readonly string[] | null> => {
    const key = keyOf(tests)
    const cached = baseGreenCache.get(key)
    if (cached !== undefined) return cached
    const p = (async (): Promise<readonly string[] | null> => {
      if (baseCommit === undefined || tests.length === 0) return null
      const green = await keepBaseGreenDiscoveredTests(tests, runOneBaseTest)
      return green.length > 0 ? green : null
    })()
    baseGreenCache.set(key, p)
    return p
  }

  return async (candidate: Candidate): Promise<boolean | null> => {
    const tests = await discoverFor(candidate)
    if (tests.length === 0) return null
    const baseGreenTests = await baseGreenFor(tests)
    if (baseGreenTests === null || baseGreenTests.length === 0) return null
    return withCandidatePatch<boolean | null>({
      sandbox,
      patch: candidate.patch,
      baseCommit,
      timeoutMs,
      probe: async (sb) => {
        return candidateKeepsBaseGreenTests(baseGreenTests, async (test) => {
          const r = await oracle.run({ tests: [test], sandbox: sb, timeoutMs }).catch(() => null)
          return toRegressionGreen([test], r)
        })
      },
    })
  }
}
