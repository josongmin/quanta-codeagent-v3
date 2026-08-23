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
import { errMessage } from "@/shared"
import { logger } from "@/shared/logger"
import { buildProjectEnvUvRunArgv } from "../corpus/project-env"
import type { Instance } from "../types"
import { execArgv } from "./exec"
import {
  DEFAULT_MAX_TESTS,
  discoverImpactedTestCandidates,
  type ImpactedTestCandidate,
  isPythonTestFile,
  normalizeRepoPath,
  type RepoTextFile,
  type WitnessEvidence,
} from "./impacted-test-discovery"
import { toRegressionGreen } from "./regression-oracle"
import { buildProjectPytestArgv, makeBenchRegressionOracle } from "./regression-oracle-adapter"
import { resetToBase, withCandidatePatch } from "./rematerialize"
import type { Candidate } from "./selection-executor"

// jun-22: deduped to one SSOT (was a second `= 12`). The configurable override
// flows in via `args.maxTests` (the regression-max-tests knob).
const DEFAULT_DISCOVERY_MAX_TESTS = DEFAULT_MAX_TESTS

/**
 * Batch base-green pytest argv: same project-env wrapper as
 * {@link buildProjectPytestArgv} but WITHOUT `-x`. The per-witness preflight uses
 * `-x` harmlessly (single test), but the batched base-green run must let EVERY
 * witness reach a verdict — `-x` would stop at the first failure and leave the
 * rest unattributable (mis-classifying them green). All other flags are identical.
 */
const buildBaseGreenBatchArgv =
  (repo: string | undefined, version: string | undefined) =>
  (tests: readonly string[]): readonly string[] => [
    ...buildProjectEnvUvRunArgv(repo ?? "", version, ["pytest"]),
    "pytest",
    "-p",
    "no:cacheprovider",
    "-q",
    "--no-header",
    ...tests,
  ]

const keyOf = (xs: readonly string[]): string => [...xs].map(normalizeRepoPath).sort().join("\n")

export const listTrackedPythonFiles = async (
  sandbox: string,
  timeoutMs: number,
): Promise<readonly string[]> => {
  const r = await execArgv(["git", "ls-files", "-z", "--", "*.py"], sandbox, timeoutMs).catch(
    () => null,
  )
  if (r === null || r.code !== 0) return []
  return r.stdout.split("\0").map(normalizeRepoPath).filter(Boolean)
}

export const readRepoTestFiles = async (
  sandbox: string,
  paths: readonly string[],
): Promise<readonly RepoTextFile[]> => {
  const out: RepoTextFile[] = []
  for (const path of paths) {
    if (!isPythonTestFile(path)) continue
    const text = await readFile(join(sandbox, path), "utf8").catch((e) => {
      logger.warn(`regression-discovery.readRepoTestFile[${path}]: ${errMessage(e)}`)
      return null
    })
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

/**
 * F3R — three-valued PATCHED-tree witness verdict. The base-green preflight is
 * binary (`boolean | null`, {@link SingleTestVerdictPort}), but the patched-tree
 * run MUST distinguish a real regression from an infra failure:
 *
 *   - `"green"` — the witness ran and stayed green on the patched tree.
 *   - `"red"`   — the witness RAN and broke (a real regression — bars).
 *   - `"infra"` — the witness could NOT run (exec port threw / ENOENT /
 *                 timeout-kill / pytest never reached a verdict). An
 *                 infrastructure failure is NOT a correctness verdict, so it
 *                 FAILS-OPEN: it is never counted as a regression failure.
 *
 * Collapsing `"infra"` into `"red"` (the prior `!== true` test) turned a broken
 * exec env into an unjust hard veto on a CORRECT patch → winner=null → empty
 * patch laundered as a model miss. The split closes that hole.
 */
export type WitnessRunVerdict = "green" | "red" | "infra"

type SingleTestWitnessRunPort = (test: string) => Promise<WitnessRunVerdict>

/** Project a binary base-green verdict (`boolean | null`) into the three-valued
 *  patched-tree witness verdict. `true` ⇒ green; `false` ⇒ red (a real
 *  fail/non-verdict reached by an actual run that exited with a verdict code);
 *  `null` ⇒ infra (the run could not be performed at all — exec threw). */
export const toWitnessRunVerdict = (verdict: boolean | null): WitnessRunVerdict =>
  verdict === true ? "green" : verdict === false ? "red" : "infra"

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
 * A single batched base-green run over the WHOLE witness set (one reset, one
 * pytest invocation). The base tree is identical across every witness in a
 * batch, so the per-witness reset+cold-pytest loop was pure O(N) waste on large
 * repos. The batch is run WITHOUT `-x` so every witness reaches a verdict.
 *
 * `ran` mirrors {@link RegressionResult.ran}: pytest reached a real pass/fail
 * verdict (exit 0/1). `failed` is the {@link parseFailedTests} node-id list.
 */
export interface BatchBaseResult {
  readonly ran: boolean
  readonly failed: readonly string[]
}

/** A witness FILE is base-green iff the batch reached a verdict AND no failure
 *  node-id is attributable to that file. Witnesses are FILE paths (e.g.
 *  `tests/test_a.py`); a failing function inside the file is reported as
 *  `tests/test_a.py::test_fn` — so a witness file owns a failure when a failed
 *  node-id equals it OR starts with `<file>::`. */
const isFailureForWitness = (witness: string, failedId: string): boolean => {
  const w = normalizeRepoPath(witness)
  const f = normalizeRepoPath(failedId)
  return f === w || f.startsWith(`${w}::`)
}

/**
 * Partition a witness set into the base-green subset using a SINGLE batched run.
 *
 * Returns `null` when the batch did NOT reach a verdict (`!batch.ran` — pytest
 * collection error / interrupt / empty). The caller MUST then fall back to the
 * per-test path so the green/red partition stays byte-identical to the
 * (slow) per-witness path even in the pathological non-verdict case. This is the
 * ONLY behavior-preserving way to attribute a whole-batch non-verdict per test.
 *
 * On a real verdict the partition is exact: a witness is green iff no parsed
 * failure id is attributable to it — which equals the per-test path's "the
 * single-test run exited 0" (a function that fails inside the file makes the
 * file non-green in BOTH paths).
 */
export const partitionBaseGreenFromBatch = (
  tests: readonly string[],
  batch: BatchBaseResult,
): readonly string[] | null => {
  if (!batch.ran) return null
  return tests.filter((t) => !batch.failed.some((f) => isFailureForWitness(t, f)))
}

/** Injected ports for {@link collectBaseGreenBatched} — keeps the reset/run
 *  count assertable without a real git sandbox. */
export interface BaseGreenBatchPorts {
  /** Reset the shared sandbox to base. Returns false if the seam is unavailable. */
  readonly reset: () => Promise<boolean>
  /** Run the WHOLE witness set in one (no-`-x`) pytest after the single reset.
   *  `null` ⇒ the run could not be performed (exec threw). */
  readonly runBatch: (tests: readonly string[]) => Promise<BatchBaseResult | null>
  /** Per-test fallback (the legacy reset-per-witness path), used ONLY when the
   *  batch did not reach a verdict so the partition stays byte-identical. */
  readonly perTest: SingleTestVerdictPort
}

/**
 * Collect the base-green witness subset with ONE reset + ONE batched pytest.
 *
 * Reset-count contract (the perf fix): on the verdict path `reset` is called
 * EXACTLY ONCE regardless of |tests| (was once-per-witness). On the non-verdict
 * fallback path the per-test port owns its own resets — the partition there is
 * byte-identical to the legacy loop. The injected ports make both claims
 * deterministically testable.
 */
export const collectBaseGreenBatched = async (
  tests: readonly string[],
  ports: BaseGreenBatchPorts,
): Promise<readonly string[]> => {
  if (tests.length === 0) return []
  if (!(await ports.reset())) {
    // Reset seam unavailable for the batch — fall back to the per-test path,
    // which re-attempts its own reset per witness (and fails open the same way).
    return [...(await keepBaseGreenDiscoveredTests(tests, ports.perTest))]
  }
  const batch = await ports.runBatch(tests)
  const partitioned = batch === null ? null : partitionBaseGreenFromBatch(tests, batch)
  if (partitioned !== null) return [...partitioned]
  // Whole-batch non-verdict ⇒ per-test fallback (identical partition).
  return [...(await keepBaseGreenDiscoveredTests(tests, ports.perTest))]
}

export interface CollectBaseGreenRepoTestsArgs {
  readonly instance: Pick<Instance, "swebench" | "localEnv">
  readonly sandbox: string
  readonly timeoutMs: number
  readonly tests: readonly string[]
}

export interface ProbeRepoTestOnCurrentTreeArgs {
  readonly instance: Pick<Instance, "swebench" | "localEnv">
  readonly sandbox: string
  readonly timeoutMs: number
  readonly test: string
}

/** Run one repo-owned test on the CURRENT sandbox tree (no reset) and return a
 *  three-valued verdict: `true` green, `false` real red, `null` infra/non-verdict.
 *  Used to admit a public owner-test primary rail into repair only after it was
 *  actually observed red on the base tree. */
export const probeRepoTestOnCurrentTree = async (
  args: ProbeRepoTestOnCurrentTreeArgs,
): Promise<boolean | null> => {
  const oracle = makeBenchRegressionOracle(
    buildProjectPytestArgv(args.instance.swebench?.repo, args.instance.swebench?.version),
    args.instance.localEnv !== undefined ? { localEnv: args.instance.localEnv } : {},
  )
  const result = await oracle
    .run({ tests: [args.test], sandbox: args.sandbox, timeoutMs: args.timeoutMs })
    .catch((e) => {
      logger.warn(`regression-discovery.probeOnCurrentTree[${args.test}]: ${errMessage(e)}`)
      return null
    })
  return toRegressionGreen([args.test], result)
}

/**
 * Shared base-green filter for a PUBLIC repo-owned regression set discovered
 * outside verify-select. This keeps repair acceptance on the SAME "base-green
 * before patched-tree authority" contract as verify-select instead of letting a
 * statically discovered test file become a regression veto on its own.
 */
export const collectBaseGreenRepoTests = async (
  args: CollectBaseGreenRepoTestsArgs,
): Promise<readonly string[]> => {
  const baseCommit = args.instance.swebench?.baseCommit
  if (baseCommit === undefined || args.tests.length === 0) return []

  const oracle = makeBenchRegressionOracle(
    buildProjectPytestArgv(args.instance.swebench?.repo, args.instance.swebench?.version),
    args.instance.localEnv !== undefined ? { localEnv: args.instance.localEnv } : {},
  )
  const batchOracle = makeBenchRegressionOracle(
    buildBaseGreenBatchArgv(args.instance.swebench?.repo, args.instance.swebench?.version),
    args.instance.localEnv !== undefined ? { localEnv: args.instance.localEnv } : {},
  )
  const runOneBaseTest = async (test: string): Promise<boolean | null> => {
    if (!(await resetToBase(args.sandbox, baseCommit, args.timeoutMs))) return null
    const r = await oracle
      .run({ tests: [test], sandbox: args.sandbox, timeoutMs: args.timeoutMs })
      .catch((e) => {
        logger.warn(`regression-discovery.collectBaseGreen.perTest[${test}]: ${errMessage(e)}`)
        return null
      })
    return toRegressionGreen([test], r)
  }

  return [
    ...(await collectBaseGreenBatched(args.tests, {
      reset: () => resetToBase(args.sandbox, baseCommit, args.timeoutMs),
      runBatch: async (tests) => {
        const r = await batchOracle
          .run({ tests, sandbox: args.sandbox, timeoutMs: args.timeoutMs })
          .catch((e) => {
            logger.warn(`regression-discovery.collectBaseGreen.runBatch: ${errMessage(e)}`)
            return null
          })
        return r === null ? null : { ran: r.ran, failed: r.failed }
      },
      perTest: runOneBaseTest,
    })),
  ]
}

/**
 * Execute every base-green witness test on the (already-materialized) patched
 * tree and report whether the executed witnesses stayed green, plus WHICH tests
 * were actually executed, WHICH broke, and WHICH could not run (infra).
 *
 * F3R fail-open: `regressionGreen` is THREE-valued. A witness whose verdict is
 * `"infra"` (the run could not be performed — exec threw / ENOENT / timeout-kill
 * / pytest never reached a verdict) is NEVER counted as a failure. Only an
 * executed `"red"` bars (`regressionGreen=false`). When no witness produced a
 * real verdict at all (every executed witness was infra-blocked) the result is
 * `null` — fail-OPEN, never `false`.
 */
export interface ExecutedWitnessOutcome {
  /** `false` only after an executed witness BROKE (a real `"red"`); `true` if at
   *  least one witness ran green and NONE broke; `null` when every executed
   *  witness was infra-blocked (no real verdict reached — fail-OPEN). */
  readonly regressionGreen: boolean | null
  /** Tests that were attempted on the patched tree. */
  readonly executedTests: readonly string[]
  /** Executed tests that produced a real RED verdict (the rejection cause). */
  readonly failures: readonly string[]
  /** Witnesses whose run was infra-blocked (could not run) — NO veto authority. */
  readonly infraSkipped: readonly string[]
}

export const executeWitnessTestsOnPatched = async (
  tests: readonly string[],
  run: SingleTestWitnessRunPort,
): Promise<ExecutedWitnessOutcome> => {
  const executedTests: string[] = []
  const failures: string[] = []
  const infraSkipped: string[] = []
  let anyGreen = false
  for (const test of tests) {
    executedTests.push(test)
    const verdict = await run(test)
    if (verdict === "red") failures.push(test)
    else if (verdict === "infra") infraSkipped.push(test)
    else anyGreen = true
  }
  // A real RED bars unconditionally. Otherwise: green only if SOME witness
  // actually ran green; if every executed witness was infra-blocked there is no
  // verdict to report → null (fail-OPEN, never `false`).
  const regressionGreen: boolean | null = failures.length > 0 ? false : anyGreen ? true : null
  return { regressionGreen, executedTests, failures, infraSkipped }
}

/** Back-compat boolean wrapper: did the candidate keep every witness green?
 *  Takes the binary base-green port and projects through {@link toWitnessRunVerdict}.
 *  Note the F3R contract change: an infra (`null`) verdict no longer counts as a
 *  break, so an all-infra run yields `true` here (no observed regression) — the
 *  rich {@link executeWitnessTestsOnPatched} preserves the `null` distinction. */
export const candidateKeepsBaseGreenTests = async (
  tests: readonly string[],
  run: SingleTestVerdictPort,
): Promise<boolean> =>
  (await executeWitnessTestsOnPatched(tests, async (t) => toWitnessRunVerdict(await run(t))))
    .regressionGreen !== false

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
  /** F3R: witnesses whose patched-tree run was INFRA-blocked (could not run). No
   *  veto authority — surfaced for telemetry so an all-infra `null` is auditable
   *  rather than indistinguishable from "no base-green witness". */
  readonly infraSkipped?: readonly string[]
  /** #6: set when the `maxTests` cap dropped lower-ranked admissible witnesses
   *  from the executed set (`discovered > executed`). A capped gate can miss a
   *  regression in a dropped witness, so this surfaces the coverage gap rather
   *  than letting it pass silently. Absent ⇒ no witnesses were dropped. */
  readonly cappedWitnesses?: { readonly discovered: number; readonly executed: number }
}

export type PublicRegressionProofState =
  | "not_available"
  | "base_not_green"
  /** Executed subset stayed green, but the witness cap dropped admissible tests.
   *  Negative evidence would still be authoritative; positive proof is partial. */
  | "coverage_capped"
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
/** Instance config, the oracles, and the per-key caches that keep discovery
 *  from re-running for the same instance. */
const witnessConfig = (args: DiscoveredRepoRegressionPortArgs) => {
  /** The factory's MUTABLE state. `let` bindings cannot cross a function
   *  boundary by value, so they live here and every link mutates in place —
   *  observationally identical to the closure they replace. */
  const mut = {
    repoTestSnapshot: undefined as Promise<readonly RepoTextFile[] | null> | undefined,
  }
  const { instance, sandbox, timeoutMs } = args
  const baseCommit = instance.swebench?.baseCommit
  const maxTests = args.maxTests ?? DEFAULT_DISCOVERY_MAX_TESTS
  const oracle = makeBenchRegressionOracle(
    buildProjectPytestArgv(instance.swebench?.repo, instance.swebench?.version),
    instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {},
  )
  // Batch oracle (no `-x`): runs the whole base-green witness set in ONE pytest
  // invocation after a SINGLE reset, replacing the O(N) reset+cold-pytest loop.
  const batchOracle = makeBenchRegressionOracle(
    buildBaseGreenBatchArgv(instance.swebench?.repo, instance.swebench?.version),
    instance.localEnv !== undefined ? { localEnv: instance.localEnv } : {},
  )

  const discoveryCache = new Map<string, Promise<readonly ImpactedTestCandidate[]>>()
  const baseGreenCache = new Map<string, Promise<readonly string[] | null>>()
  // #6: cap-truncation telemetry per changed-file key (witnesses dropped by maxTests).
  const cappedByKey = new Map<string, { readonly discovered: number; readonly executed: number }>()
  return {
    args,
    instance,
    sandbox,
    timeoutMs,
    baseCommit,
    maxTests,
    oracle,
    batchOracle,
    discoveryCache,
    baseGreenCache,
    cappedByKey,
    mut,
  }
}

/** Discovery: the repo's tests at the base commit, and the per-instance
 *  discovery that caps and caches them. */
const witnessDiscovery = (ctx: ReturnType<typeof witnessConfig>) => {
  const { sandbox, timeoutMs, baseCommit, maxTests, discoveryCache, cappedByKey, mut } = ctx

  const repoTestsOnBase = (): Promise<readonly RepoTextFile[] | null> => {
    if (mut.repoTestSnapshot !== undefined) return mut.repoTestSnapshot
    mut.repoTestSnapshot = (async () => {
      if (baseCommit === undefined) return null
      if (!(await resetToBase(sandbox, baseCommit, timeoutMs))) return null
      const paths = await listTrackedPythonFiles(sandbox, timeoutMs)
      return readRepoTestFiles(sandbox, paths)
    })()
    return mut.repoTestSnapshot
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
        onCap: (info) => {
          cappedByKey.set(key, info)
          // #6: silent under-coverage is a regression-gate hazard — a witness
          // dropped by `maxTests` never runs, so a candidate that breaks it reads
          // green. Emit the drop so capped coverage is attributable, not invisible.
          logger.warn("regression-discovery: maxTests capped witnesses", {
            files: key,
            discovered: info.discovered,
            executed: info.executed,
            dropped: info.discovered - info.executed,
          })
        },
      })
    })()
    discoveryCache.set(key, p)
    return p
  }
  return { repoTestsOnBase, discoverFor }
}

/** Base-green verification: run one test at base, in batch, and the cached
 *  verdict the witness answers with. */
const witnessBaseGreen = (
  ctx: ReturnType<typeof witnessConfig> & ReturnType<typeof witnessDiscovery>,
) => {
  const { sandbox, timeoutMs, baseCommit, oracle, batchOracle, baseGreenCache } = ctx

  const runOneBaseTest = async (test: string): Promise<boolean | null> => {
    if (baseCommit === undefined) return null
    if (!(await resetToBase(sandbox, baseCommit, timeoutMs))) return null
    const r = await oracle.run({ tests: [test], sandbox, timeoutMs }).catch((e) => {
      logger.warn(`regression-discovery.runOneBaseTest[${test}]: ${errMessage(e)}`)
      return null
    })
    return toRegressionGreen([test], r)
  }

  // Reset ONCE, then run the WHOLE witness set in a single (no-`-x`) pytest. The
  // base tree is identical across every witness in a batch, so this is the same
  // partition the per-test loop produces at 1/N the resets + cold starts. A
  // whole-batch non-verdict (collection error / interrupt) falls back to the
  // per-test path inside collectBaseGreenBatched — keeping the partition exact.
  const batchPorts: BaseGreenBatchPorts = {
    reset: () =>
      baseCommit === undefined
        ? Promise.resolve(false)
        : resetToBase(sandbox, baseCommit, timeoutMs),
    runBatch: async (tests) => {
      const r = await batchOracle.run({ tests, sandbox, timeoutMs }).catch((e) => {
        logger.warn(`regression-discovery.batchPorts.runBatch: ${errMessage(e)}`)
        return null
      })
      return r === null ? null : { ran: r.ran, failed: r.failed }
    },
    perTest: runOneBaseTest,
  }

  const baseGreenFor = (tests: readonly string[]): Promise<readonly string[] | null> => {
    const key = keyOf(tests)
    const cached = baseGreenCache.get(key)
    if (cached !== undefined) return cached
    const p = (async (): Promise<readonly string[] | null> => {
      if (baseCommit === undefined || tests.length === 0) return null
      const green = await collectBaseGreenBatched(tests, batchPorts)
      return green.length > 0 ? green : null
    })()
    baseGreenCache.set(key, p)
    return p
  }

  return { runOneBaseTest, batchPorts, baseGreenFor }
}

/** Assemble the chained builders. */
export const makeDiscoveredRepoRegressionWitness = (args: DiscoveredRepoRegressionPortArgs) => {
  const p0 = witnessConfig(args)
  const p1 = witnessDiscovery({ ...p0 })
  const p2 = witnessBaseGreen({ ...p0, ...p1 })
  const { sandbox, timeoutMs, baseCommit, oracle, cappedByKey, discoverFor, baseGreenFor } = {
    ...p0,
    ...p1,
    ...p2,
  }
  return async (candidate: Candidate): Promise<ExecutedWitnessResult> => {
    const candidates = await discoverFor(candidate)
    const capped = cappedByKey.get(keyOf(candidate.files))
    const withCap = (r: ExecutedWitnessResult): ExecutedWitnessResult =>
      capped === undefined ? r : { ...r, cappedWitnesses: capped }
    // Empty witness candidate set → fail-open null (NEVER a reject).
    if (candidates.length === 0) return emptyWitnessResult(null, candidates)

    const tests = candidates.map((c) => c.path)
    const baseGreenTests = await baseGreenFor(tests)
    // No witness is green on base → nothing executable can speak → fail-open.
    if (baseGreenTests === null || baseGreenTests.length === 0) {
      return withCap(emptyWitnessResult(null, candidates))
    }

    const outcome = await withCandidatePatch<ExecutedWitnessOutcome>({
      sandbox,
      patch: candidate.patch,
      baseCommit,
      timeoutMs,
      probe: async (sb) =>
        executeWitnessTestsOnPatched(baseGreenTests, async (test) => {
          // F3R: a witness that could not RUN on the patched tree (exec port
          // threw / ENOENT / timeout-kill ⇒ `null`, or pytest never reached a
          // verdict ⇒ `null`) is `"infra"`, NOT a `"red"` regression. Only a real
          // executed fail/non-verdict (`false`) bars. `toRegressionGreen` already
          // maps a non-verdict run to `null`, so the infra/red split is exact.
          const r = await oracle.run({ tests: [test], sandbox: sb, timeoutMs }).catch((e) => {
            logger.warn(`regression-discovery.executeWitnessOnPatched[${test}]: ${errMessage(e)}`)
            return null
          })
          return toWitnessRunVerdict(toRegressionGreen([test], r))
        }),
    })

    // Re-materialization failure (null) → fail-open. The verdict ONLY exists when
    // the witnesses actually ran on the patched tree.
    if (outcome === null) {
      return withCap({
        regressionGreen: null,
        candidateTests: tests,
        sourceEvidence: new Map(candidates.map((c) => [c.path, c.evidence])),
        baseGreenTests,
        executedTests: [],
        failures: [],
      })
    }

    return withCap({
      regressionGreen: outcome.regressionGreen,
      candidateTests: tests,
      sourceEvidence: new Map(candidates.map((c) => [c.path, c.evidence])),
      baseGreenTests,
      executedTests: outcome.executedTests,
      failures: outcome.failures,
      ...(outcome.infraSkipped.length > 0 ? { infraSkipped: outcome.infraSkipped } : {}),
    })
  }
}

export const publicRegressionProofReceiptOf = (
  result: ExecutedWitnessResult,
): PublicRegressionProofReceipt => {
  const state: PublicRegressionProofState =
    result.candidateTests.length === 0
      ? "not_available"
      : result.baseGreenTests.length === 0
        ? "base_not_green"
        : result.regressionGreen === false
          ? "candidate_red"
          : result.cappedWitnesses !== undefined && result.regressionGreen === true
            ? "coverage_capped"
            : result.regressionGreen === true
              ? "safety_green"
              : "execution_failed"
  return { state, ...result }
}

export const regressionAuthorityOf = (receipt: PublicRegressionProofReceipt): boolean | null =>
  receipt.state === "candidate_red" ? false : receipt.state === "safety_green" ? true : null

export const makeDiscoveredRepoRegressionProofPort = (
  args: DiscoveredRepoRegressionPortArgs,
): ((c: Candidate) => Promise<PublicRegressionProofReceipt>) => {
  const witness = makeDiscoveredRepoRegressionWitness(args)
  return async (candidate: Candidate): Promise<PublicRegressionProofReceipt> =>
    publicRegressionProofReceiptOf(await witness(candidate))
}

/**
 * Back-compat port: same `(candidate) => Promise<boolean | null>` signature the
 * selector wires today. It is a pure projection of {@link ExecutedWitnessResult}
 * — `regressionGreen` — so the `false` it returns is ALWAYS execution-backed
 * (non-empty `executedTests` + a real `failures` entry). Positive authority is
 * narrower: a capped witness set (`coverage_capped`) must FAIL-OPEN to `null`
 * because the unexecuted dropped witnesses could still hide a regression.
 */
export const makeDiscoveredRepoRegressionPort = (
  args: DiscoveredRepoRegressionPortArgs,
): ((c: Candidate) => Promise<boolean | null>) => {
  const proof = makeDiscoveredRepoRegressionProofPort(args)
  return async (candidate: Candidate): Promise<boolean | null> =>
    regressionAuthorityOf(await proof(candidate))
}
