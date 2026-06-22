/**
 * No-oracle repo-regression gate for verify-and-select.
 *
 * Shared runner-surface copy so `@/runner/batch/eval` can execute the SAME
 * verify-select regression policy its knob surface advertises.
 *
 * ── Authority split (T-REG-03) ──────────────────────────────────────────────
 * Two concerns are kept strictly separate here:
 *
 *   (a) STATIC candidate building — delegated to the `WitnessTestCandidateBuilder`
 *       in `impacted-test-discovery.ts`. It produces an ORDERED list of witness
 *       tests with telemetry-visible evidence + an ORDERING-ONLY rank. It has NO
 *       verdict authority.
 *
 *   (b) EXECUTED witness result — `ExecutedWitnessResult` below. `regressionGreen`
 *       is `false` ONLY after the selected witness tests were (1) confirmed
 *       base-green by an actual run AND (2) actually re-run on the patched tree
 *       and observed to break. A candidate that was merely *discovered* (static
 *       rank), but never executed, can never produce `false`.
 *
 * Fail-open by construction: an empty witness candidate set, an absent base
 * commit, a base preflight that yields no green witness, or a re-materialization
 * failure all yield `null` (no objection — never a rejection). The ONLY way to
 * reach `regressionGreen=false` is an EXECUTED test, base-green, that fails on
 * the patched tree. Therefore changing the static rank weights cannot, on its
 * own, change admissibility — it can only change which already-green witnesses
 * run first under `maxTests`; a verdict still requires a real execution failure.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { execArgv } from "./exec"
import {
  discoverImpactedTestCandidates,
  type ImpactedTestCandidate,
  isPythonTestFile,
  normalizeRepoPath,
  type RepoTextFile,
  type WitnessEvidence,
} from "./impacted-test-discovery"
import { toRegressionGreen } from "./regression-oracle"
import { resetToBase, withCandidatePatch } from "./rematerialize"
import type { Candidate } from "./selection-executor"
import type { Instance } from "../types"
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

/**
 * Execute every base-green witness test on the (already-materialized) patched
 * tree and report whether ALL of them stayed green, plus WHICH tests were
 * actually executed and WHICH failed. The returned `regressionGreen=false` is by
 * construction the product of a real execution: a non-`true` verdict from `run`
 * (a fresh failure or a non-verdict on the patched tree) flips it to `false`.
 */
export interface ExecutedWitnessOutcome {
  /** `false` only after an executed witness broke; `true` if all stayed green. */
  readonly regressionGreen: boolean
  /** Tests that were actually executed on the patched tree. */
  readonly executedTests: readonly string[]
  /** Executed tests that did NOT stay green on the patched tree. */
  readonly failures: readonly string[]
}

export const executeWitnessTestsOnPatched = async (
  tests: readonly string[],
  run: SingleTestVerdictPort,
): Promise<ExecutedWitnessOutcome> => {
  const executedTests: string[] = []
  const failures: string[] = []
  for (const test of tests) {
    executedTests.push(test)
    if ((await run(test)) !== true) failures.push(test)
  }
  return {
    regressionGreen: failures.length === 0,
    executedTests,
    failures,
  }
}

/** Back-compat boolean wrapper: did the candidate keep every witness green? */
export const candidateKeepsBaseGreenTests = async (
  tests: readonly string[],
  run: SingleTestVerdictPort,
): Promise<boolean> => (await executeWitnessTestsOnPatched(tests, run)).regressionGreen

/**
 * Full telemetry receipt for one candidate's witness regression check, with the
 * static-candidate evidence kept separate from the executed verdict.
 *
 * `regressionGreen`:
 *   - `null`  → fail-open. No witness candidates, no base-green witness, or the
 *               candidate could not be re-materialized. NEVER a rejection.
 *   - `true`  → every executed witness stayed green on the patched tree.
 *   - `false` → at least one EXECUTED, base-green witness broke on the patched
 *               tree. This is the only way to reach a rejection, and it always
 *               carries a non-empty `executedTests` with the offending test in
 *               `failures`.
 */
export interface ExecutedWitnessResult {
  readonly regressionGreen: boolean | null
  /** Static witness candidates the builder proposed (ordered, rank desc). */
  readonly candidateTests: readonly string[]
  /** Structural evidence per candidate (why each was proposed) — telemetry. */
  readonly sourceEvidence: ReadonlyMap<string, readonly WitnessEvidence[]>
  /** Witnesses confirmed green on base (the only ones eligible to reject). */
  readonly baseGreenTests: readonly string[]
  /** Witnesses actually executed on the patched tree. */
  readonly executedTests: readonly string[]
  /** Executed witnesses that broke on the patched tree (the rejection cause). */
  readonly failures: readonly string[]
}

export type PublicRegressionProofState =
  | "not_available"
  | "base_not_green"
  | "safety_green"
  | "candidate_red"
  | "execution_failed"

export interface PublicRegressionProofReceipt extends ExecutedWitnessResult {
  readonly state: PublicRegressionProofState
}

const emptyWitnessResult = (
  regressionGreen: boolean | null,
  candidates: readonly ImpactedTestCandidate[],
): ExecutedWitnessResult => ({
  regressionGreen,
  candidateTests: candidates.map((c) => c.path),
  sourceEvidence: new Map(candidates.map((c) => [c.path, c.evidence])),
  baseGreenTests: [],
  executedTests: [],
  failures: [],
})

/**
 * Build the full {@link ExecutedWitnessResult} for a candidate. This is the rich
 * surface; {@link makeDiscoveredRepoRegressionPort} projects it down to the
 * back-compat `boolean | null` port. Authority lives ONLY in `executedTests` /
 * `failures`: the static `candidateTests` + `sourceEvidence` are telemetry and
 * never produce a `false` by themselves.
 */
export const makeDiscoveredRepoRegressionWitness = (
  args: DiscoveredRepoRegressionPortArgs,
): ((c: Candidate) => Promise<ExecutedWitnessResult>) => {
  const { instance, sandbox, timeoutMs } = args
  const baseCommit = instance.swebench?.baseCommit
  const maxTests = args.maxTests ?? DEFAULT_DISCOVERY_MAX_TESTS
  const oracle = makeBenchRegressionOracle(
    buildProjectPytestArgv(instance.swebench?.repo, instance.swebench?.version),
    instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {},
  )

  const discoveryCache = new Map<string, Promise<readonly ImpactedTestCandidate[]>>()
  const baseGreenCache = new Map<string, Promise<readonly string[] | null>>()
  let repoTestSnapshot: Promise<readonly RepoTextFile[] | null> | undefined

  const repoTestsOnBase = (): Promise<readonly RepoTextFile[] | null> => {
    if (repoTestSnapshot !== undefined) return repoTestSnapshot
    repoTestSnapshot = (async () => {
      if (baseCommit === undefined) return null
      if (!(await resetToBase(sandbox, baseCommit, timeoutMs))) return null
      const paths = await listTrackedPythonFiles(sandbox, timeoutMs)
      return readRepoTestFiles(sandbox, paths)
    })()
    return repoTestSnapshot
  }

  // STATIC candidate building (no verdict authority): ordered witness list +
  // telemetry-visible evidence. Whether these run / reject is decided below.
  const discoverFor = (candidate: Candidate): Promise<readonly ImpactedTestCandidate[]> => {
    const key = keyOf(candidate.files)
    const cached = discoveryCache.get(key)
    if (cached !== undefined) return cached
    const p = (async (): Promise<readonly ImpactedTestCandidate[]> => {
      const repoFiles = await repoTestsOnBase()
      if (repoFiles === null) return []
      return discoverImpactedTestCandidates({
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

  return async (candidate: Candidate): Promise<ExecutedWitnessResult> => {
    const candidates = await discoverFor(candidate)
    // Empty witness candidate set → fail-open null (NEVER a reject).
    if (candidates.length === 0) return emptyWitnessResult(null, candidates)

    const tests = candidates.map((c) => c.path)
    const baseGreenTests = await baseGreenFor(tests)
    // No witness is green on base → nothing executable can speak → fail-open.
    if (baseGreenTests === null || baseGreenTests.length === 0) {
      return emptyWitnessResult(null, candidates)
    }

    const outcome = await withCandidatePatch<ExecutedWitnessOutcome>({
      sandbox,
      patch: candidate.patch,
      baseCommit,
      timeoutMs,
      probe: async (sb) =>
        executeWitnessTestsOnPatched(baseGreenTests, async (test) => {
          const r = await oracle.run({ tests: [test], sandbox: sb, timeoutMs }).catch(() => null)
          return toRegressionGreen([test], r)
        }),
    })

    // Re-materialization failure (null) → fail-open. The verdict ONLY exists when
    // the witnesses actually ran on the patched tree.
    if (outcome === null) {
      return {
        regressionGreen: null,
        candidateTests: tests,
        sourceEvidence: new Map(candidates.map((c) => [c.path, c.evidence])),
        baseGreenTests,
        executedTests: [],
        failures: [],
      }
    }

    return {
      regressionGreen: outcome.regressionGreen,
      candidateTests: tests,
      sourceEvidence: new Map(candidates.map((c) => [c.path, c.evidence])),
      baseGreenTests,
      executedTests: outcome.executedTests,
      failures: outcome.failures,
    }
  }
}

const toPublicRegressionProofReceipt = (
  result: ExecutedWitnessResult,
): PublicRegressionProofReceipt => {
  const state: PublicRegressionProofState =
    result.candidateTests.length === 0
      ? "not_available"
      : result.baseGreenTests.length === 0
        ? "base_not_green"
        : result.regressionGreen === true
          ? "safety_green"
          : result.regressionGreen === false
            ? "candidate_red"
            : "execution_failed"
  return { state, ...result }
}

export const makeDiscoveredRepoRegressionProofPort = (
  args: DiscoveredRepoRegressionPortArgs,
): ((c: Candidate) => Promise<PublicRegressionProofReceipt>) => {
  const witness = makeDiscoveredRepoRegressionWitness(args)
  return async (candidate: Candidate): Promise<PublicRegressionProofReceipt> =>
    toPublicRegressionProofReceipt(await witness(candidate))
}

/**
 * Back-compat port: same `(candidate) => Promise<boolean | null>` signature the
 * selector wires today. It is a pure projection of {@link ExecutedWitnessResult}
 * — `regressionGreen` — so the `false` it returns is ALWAYS execution-backed
 * (non-empty `executedTests` + a real `failures` entry), and an empty witness
 * set / non-materializable candidate is `null` (fail-open).
 */
export const makeDiscoveredRepoRegressionPort = (
  args: DiscoveredRepoRegressionPortArgs,
): ((c: Candidate) => Promise<boolean | null>) => {
  const proof = makeDiscoveredRepoRegressionProofPort(args)
  return async (candidate: Candidate): Promise<boolean | null> =>
    (await proof(candidate)).regressionGreen
}
