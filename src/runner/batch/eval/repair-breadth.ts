/**
 * jun-28 repair-loop BREADTH — the DRIVER-side fan-out for oracle-selected
 * best-of-N inside the repair loop.
 *
 * The repair orchestrator (`./repair/index.ts`) is PURE: it imports only local
 * repair helpers, never `@/agent` / the sandbox-fork primitives. So the
 * fork+lane+validate+adopt fan-out CANNOT live there. This module is the driver
 * seam that implements the injected `RunRepairCandidatesPort`:
 *
 *   for each candidate i in [0, breadth):
 *     fork the source sandbox (a `cp -R` sibling tree)
 *     run the agent on the fork, routed to model lane `i mod laneCount`
 *     validate the fork through the SAME repair-gate policy
 *     hand back { run, validator, adopt }
 *
 * `adopt()` (called by the orchestrator for the SELECTED candidate only) makes
 * the MAIN sandbox reflect that candidate's cumulative tree (reset-to-base +
 * `git apply` its cumulative diff) so the next repair round AND the final
 * grader-bound capture continue from the winner. The forks are then discarded.
 *
 * NO-LEAK: selection (in the orchestrator) reads ONLY each candidate's injected
 * `validator` result — this module never touches a gold/hidden field. Candidates
 * are generated and validated EXACTLY as a single repair round would be; the only
 * new I/O is the fork copies and the winner's re-apply onto main.
 *
 * COST: `breadth` agent runs + `breadth` validator runs per round (~breadth×
 * patch-gen) — which is why the knob is opt-in (default 1 ⇒ this is never called).
 */

import { type LLMPort, laneLabeledPort } from "@/llm"
import { type CandidateFamily, candidateFamilyCoverageMissing } from "./candidate-families"
import { laneProgress, laneProgressPort } from "./lane-progress"
import type { PerCandidateSeed } from "./location-set-fanout"
import type { RepairValidateArgsInputs } from "./repair/index"
import { buildRepairValidateArgs } from "./repair/index"
import type {
  RepairCandidateOutcome,
  RepairConfig,
  RunOnceResult,
  RunRepairCandidatesArgs,
  ValidateArgs,
  ValidatorResult,
} from "./repair/types"
import { filesFromPatch } from "./selection-paths"
import type {
  Candidate,
  DerivedCandidateStructuralRepair,
  FamilyCoverageRepairArgs,
} from "./selection-types"

/**
 * Build the {@link RepairConfig} for a repair phase: `maxRounds` (when set),
 * `breadth` (ONLY when > 1, so B=1 omits the key ⇒ the orchestrator's
 * `config.breadth ?? 1` byte-identical single-candidate path), and the jun-28
 * STRONG-ORACLE clear-gate flag (ONLY when on, so OFF omits the key ⇒ the
 * orchestrator's `config.strongOracle === true` check is false ⇒ byte-identical
 * legacy single-green clear). Shared by BOTH drivers so the repair config wiring
 * is identical and the `runRepairRounds({` call site stays compact.
 */
export const buildRepairRoundsConfig = (
  maxRounds: number | undefined,
  breadth: number,
  strongOracle = false,
): RepairConfig => ({
  ...(maxRounds !== undefined ? { maxRounds } : {}),
  ...(breadth > 1 ? { breadth } : {}),
  ...(strongOracle ? { strongOracle: true } : {}),
})

/** Sandbox-fork lifecycle ports (injected from `./sandbox` by the driver). */
export interface RepairBreadthSandboxPorts {
  /** `cp -R` the source sandbox into a fresh isolated sibling; returns its path. */
  readonly forkSandbox: (instanceId: string, sourceSandbox: string) => Promise<string>
  /** Best-effort `rm -rf` of a fork's private parent (never throws). */
  readonly cleanupSandbox: (sandbox: string) => Promise<void>
}

/** Git re-materialization ports (injected from `./rematerialize` by the driver),
 *  used to ADOPT the selected candidate's tree onto the main sandbox. */
export interface RepairBreadthGitPorts {
  /** Hard-reset a sandbox to `baseCommit` (discard worktree + untracked). */
  readonly resetToBase: (sandbox: string, baseCommit: string, timeoutMs: number) => Promise<boolean>
  /** `git apply` a unified diff onto a sandbox; true iff it applied clean. */
  readonly applyCandidatePatch: (
    sandbox: string,
    patch: string,
    timeoutMs: number,
  ) => Promise<boolean>
  /** Re-inject the repo's build-env block into the adopted tree AFTER reset+apply,
   *  so the NEXT round's fork (and the agent's repro/test exec on it) can build for
   *  build-time-import repos (astropy). The leading reset wipes it, exactly as
   *  {@link withCandidatePatch} re-materializes after its reset. Optional + FAIL-
   *  OPEN; a no-build-dep repo (django) no-ops. Absent ⇒ adopt skips it (a repo
   *  with no build-time import is unaffected). */
  readonly materializeBuildEnv?: (sandbox: string, repo: string) => Promise<boolean>
}

/** Everything the driver supplies ONCE to build the fan-out port. Stable across
 *  all repair rounds for one instance; the per-round inputs (seed/breadth/round)
 *  arrive on each `RunRepairCandidatesPort` call. */
export interface RepairBreadthDeps {
  readonly instanceId: string
  /** The MAIN repair sandbox. Each round forks the CURRENT state of this dir
   *  (continue-from-patched-tree: round i forks the round i-1 winner's tree). */
  readonly mainSandbox: string
  /** SWE-bench base commit — required to faithfully re-materialize the winner on
   *  the main sandbox (reset → apply). repair-breadth is swebench-gated, so this
   *  is present; absent ⇒ `adopt()` falls back to applying onto the live main. */
  readonly baseCommit: string | undefined
  /** SWE-bench `owner/name` slug. When set (and `gitPorts.materializeBuildEnv`
   *  supplied), adopt re-injects the build-env block after reset+apply so the next
   *  round's fork can build. Absent ⇒ adopt skips build-env (no build-time import). */
  readonly repo: string | undefined
  readonly timeoutMs: number
  /** Resolve the provider lane port for candidate `index`. The driver passes its
   *  `resolveLaneLlm(deps, modelLaneDiversity, index)` — already the round-robin
   *  rule, returning `deps.llm` when diversity is off / <2 lanes (so candidates
   *  are independent samples of the SAME model). */
  readonly resolveLaneLlm: (index: number) => LLMPort
  /** Run ONE agent attempt on `forkSandbox`, seeded with `seedMsg`, generated by
   *  `laneLlm`. The driver closes over its own `runAgentOnce` (SDK or in-proc) +
   *  all the fixed wiring (hints, posture, state). Returns the fork's cumulative
   *  RunOnceResult. */
  readonly runAgentOnFork: (
    forkSandbox: string,
    seedMsg: string | undefined,
    laneLlm: LLMPort,
  ) => Promise<RunOnceResult>
  /** The SAME validator the orchestrator's single path uses (repro-vote-wrapped
   *  etc.). Called here with per-fork ValidateArgs. */
  readonly validate: (args: ValidateArgs) => Promise<ValidatorResult>
  /** The validate-arg POLICY inputs (primary-rail vs agent-cmd, exec, readFile,
   *  evaluatePredicate, timeoutMs) MINUS `sandbox` — this module substitutes each
   *  fork's sandbox so every candidate is validated through the SAME gate. */
  readonly validateInputs: Omit<RepairValidateArgsInputs, "sandbox">
  readonly sandboxPorts: RepairBreadthSandboxPorts
  readonly gitPorts: RepairBreadthGitPorts
  /** jun-29 OBSERVE-ONLY: persist the WHOLE candidate pool (not just the adopted
   *  winner) so "was there a winning candidate the selector missed?" is answerable
   *  post-hoc. Called with every round's outcomes BEFORE selection. Decision impact
   *  ZERO — never read by select/adopt; fail-open. Absent ⇒ byte-identical. */
  readonly recordCandidates?: (
    round: number,
    candidates: readonly RepairCandidateOutcome[],
  ) => void | Promise<void>
  /** OPTIONAL typed structural family derivation for a repair-breadth candidate,
   *  reusing the clean selection seam on the candidate's OWN forked sandbox. */
  readonly deriveCandidateStructuralRepair?: (
    candidate: Candidate,
    sandbox: string,
  ) => Promise<DerivedCandidateStructuralRepair | undefined>
  /** OPTIONAL bounded family-coverage co-edit for a partial repair candidate.
   *  Runs on the candidate's OWN forked sandbox and may only extend the existing
   *  patch across already-derived family files. */
  readonly repairFamilyCoverage?: (
    args: FamilyCoverageRepairArgs & { readonly sandbox: string },
  ) => Promise<Candidate | undefined>
  /** Strategy #7 multi-location-set fanout (QUANTA_BENCH_LOCATION_FANOUT): map a
   *  candidate `index` + the round's base seed → a seed that LEADS the candidate at
   *  a distinct ranked file (location diversity instead of N resamples). Returning
   *  `undefined` (or this port being absent) ⇒ the base seed is used unchanged ⇒
   *  byte-identical. Pure (built from the localizer's ranked files); see
   *  {@link buildLocationSeeder}. */
  readonly perCandidateSeed?: PerCandidateSeed
}

/**
 * Build the {@link RunRepairCandidatesPort} the orchestrator calls when
 * `breadth > 1`. Generates the candidates on forks, validates each, and returns
 * outcomes (with an `adopt` that re-materializes that candidate onto the main
 * sandbox). Forks for NON-selected candidates are cleaned up here; the SELECTED
 * candidate's fork is cleaned up too (its tree is re-applied to main by `adopt`,
 * so the fork itself is disposable).
 */
export const makeRepairBreadthRunCandidates =
  (deps: RepairBreadthDeps) =>
  async (args: RunRepairCandidatesArgs): Promise<readonly RepairCandidateOutcome[]> => {
    // Fork + generate + validate each candidate. Candidates run on INDEPENDENT
    // trees, so this is a bounded parallel fan-out (the verify-select sandbox
    // race the per-fork isolation prevents does not apply here). Each result
    // settles independently; a candidate that THROWS during generation is dropped
    // (Promise.allSettled) so one bad lane never sinks the whole round.
    const settled = await Promise.allSettled(
      Array.from({ length: args.breadth }, (_unused, index) => {
        // #7 location fanout: distinct lead-file seed per candidate (OFF ⇒ undefined
        // ⇒ base seed ⇒ byte-identical).
        const seed = deps.perCandidateSeed?.(index, args.seedMsg) ?? args.seedMsg
        return runOneBreadthCandidate(deps, seed, index)
      }),
    )
    const outcomes: RepairCandidateOutcome[] = []
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value !== undefined) outcomes.push(s.value)
    }
    // OBSERVE-ONLY pool capture (jun-29): record the FULL pool before the
    // orchestrator selects+adopts the winner. Fail-open — a sink throw must never
    // affect the round (the pool ledger is post-hoc analysis, not control flow).
    if (deps.recordCandidates !== undefined) {
      try {
        await deps.recordCandidates(args.round, outcomes)
      } catch {
        /* observe-only: never let a ledger write perturb the repair round */
      }
    }
    return outcomes
  }

const breadthCandidateOf = (run: RunOnceResult, index: number): Candidate => ({
  id: `repair-${index}`,
  patch: run.patch,
  turns: run.turns,
  files: filesFromPatch(run.patch),
  baseValidatedRed: null,
})

const withCandidatePatch = (run: RunOnceResult, patch: string): RunOnceResult =>
  patch === run.patch ? run : { ...run, patch }

interface PreparedRepairBreadthCandidate {
  readonly run: RunOnceResult
  readonly familyId?: CandidateFamily["familyId"]
  readonly familyCoverageMissing?: readonly string[]
}

const reducedFamilyCoverage = (
  family: CandidateFamily,
  beforeFiles: readonly string[],
  after: Candidate,
): boolean =>
  candidateFamilyCoverageMissing(family, after.files).length <
  candidateFamilyCoverageMissing(family, beforeFiles).length

const maybeWidenCandidateFamilyCoverage = async (
  deps: RepairBreadthDeps,
  run: RunOnceResult,
  index: number,
  sandbox: string,
): Promise<PreparedRepairBreadthCandidate> => {
  if (deps.deriveCandidateStructuralRepair === undefined || run.patch.trim() === "") {
    return { run }
  }
  const candidate = breadthCandidateOf(run, index)
  if (candidate.files.length === 0) return { run }
  const derived = await deps
    .deriveCandidateStructuralRepair(candidate, sandbox)
    .catch(() => undefined)
  const family = derived?.family
  if (family === undefined) return { run }
  const missingFiles = candidateFamilyCoverageMissing(family, candidate.files)
  if (missingFiles.length === 0) {
    return { run, familyId: family.familyId, familyCoverageMissing: [] }
  }
  const widened =
    deps.repairFamilyCoverage === undefined
      ? undefined
      : await deps
          .repairFamilyCoverage({
            sandbox,
            candidate,
            family,
            missingFiles,
          })
          .catch(() => undefined)
  if (widened === undefined || widened.patch.trim() === "") {
    return { run, familyId: family.familyId, familyCoverageMissing: missingFiles }
  }
  if (!reducedFamilyCoverage(family, candidate.files, widened)) {
    return { run, familyId: family.familyId, familyCoverageMissing: missingFiles }
  }
  return {
    run: withCandidatePatch(run, widened.patch),
    familyId: family.familyId,
    familyCoverageMissing: candidateFamilyCoverageMissing(family, widened.files),
  }
}

/** Fork → agent (lane index) → validate ONE candidate. Returns the outcome, or
 *  `undefined` when the fork could not even be created (the candidate is dropped;
 *  the fork is cleaned up on every exit path). */
const runOneBreadthCandidate = async (
  deps: RepairBreadthDeps,
  seedMsg: string | undefined,
  index: number,
): Promise<RepairCandidateOutcome | undefined> => {
  const lane = `repair-breadth#${index}`
  let laneOk = false
  let lanePatchBytes = 0
  // Fork BEFORE emitting `start` so a fork-creation failure never leaves an
  // orphaned lane (start with no matching `done`) — `done` lives in the finally
  // below, which only runs once we're inside the try.
  const fork = await deps.sandboxPorts.forkSandbox(deps.instanceId, deps.mainSandbox)
  laneProgress.emit({ kind: "start", lane })
  try {
    // Label this candidate's turns so the N concurrent lanes stay distinguishable
    // on the one shared recording tape (replay-neutral; only tags metadata.lane).
    // laneProgressPort adds LIVE per-turn/-tool progress emission (display-only).
    const laneLlm = laneProgressPort(laneLabeledPort(deps.resolveLaneLlm(index), lane), lane)
    const locationFocus = deps.perCandidateSeed?.focusOf?.(index)
    const generatedRun = await deps.runAgentOnFork(fork, seedMsg, laneLlm)
    const prepared = await maybeWidenCandidateFamilyCoverage(deps, generatedRun, index, fork)
    const run = prepared.run
    lanePatchBytes = run.patch?.length ?? 0
    // Validate the fork through the SAME repair-gate policy as the single path,
    // with `sandbox` pointed at THIS fork (so primary-rail / agent-cmd / repro all
    // execute against the candidate's own tree).
    const validator = await deps.validate(
      buildRepairValidateArgs({ ...deps.validateInputs, sandbox: fork }, run),
    )
    laneOk = validator.ok === true
    // `adopt` re-materializes THIS candidate onto the MAIN sandbox so the loop
    // continues from it. Captured by value (the fork's cumulative diff); the fork
    // is disposable once captured.
    const cumulativeDiff = run.patch
    const adopt = async (): Promise<void> => {
      await adoptCandidateOntoMain(deps, cumulativeDiff)
    }
    return {
      run,
      validator,
      ...(prepared.familyId !== undefined ? { familyId: prepared.familyId } : {}),
      ...(prepared.familyCoverageMissing !== undefined
        ? { familyCoverageMissing: prepared.familyCoverageMissing }
        : {}),
      ...(locationFocus !== undefined ? { locationFocus } : {}),
      adopt,
    }
  } finally {
    laneProgress.emit({ kind: "done", lane, ok: laneOk, patchBytes: lanePatchBytes })
    // The fork is never the continuation point — the winner is re-applied to main
    // by `adopt`, losers are discarded — so every fork is cleaned up here.
    await deps.sandboxPorts.cleanupSandbox(fork)
  }
}

/**
 * Make the MAIN sandbox reflect the selected candidate's cumulative tree:
 * reset-to-base then `git apply` the candidate's cumulative diff. The empty diff
 * (the agent made no change) just resets to base — correct (an empty winner means
 * the continuation point is base). A missing baseCommit (non-swebench; breadth is
 * swebench-gated so this is defensive) skips the reset and applies onto the live
 * main best-effort. Apply failures are swallowed: the orchestrator's `finalPatch`
 * (the winner's own `run.patch`) is the authoritative capture even if the main
 * sandbox could not be re-materialized, so a failed re-apply degrades gracefully
 * rather than corrupting the round.
 *
 * After reset+apply we RE-MATERIALIZE the build-env block (when a repo + the port
 * are supplied) — the leading reset wiped the P0 block `withGitSnapshot` installed
 * before the agent ran, and the NEXT round forks THIS sandbox, so a build-time-
 * import repo (astropy) would otherwise fail to build on the next round's forks.
 * Mirrors {@link withCandidatePatch}'s reset→apply→materialize ordering. FAIL-OPEN.
 */
const adoptCandidateOntoMain = async (
  deps: RepairBreadthDeps,
  cumulativeDiff: string,
): Promise<void> => {
  if (deps.baseCommit !== undefined) {
    await deps.gitPorts.resetToBase(deps.mainSandbox, deps.baseCommit, deps.timeoutMs)
  }
  if (cumulativeDiff.trim() !== "") {
    await deps.gitPorts.applyCandidatePatch(deps.mainSandbox, cumulativeDiff, deps.timeoutMs)
  }
  if (deps.repo !== undefined && deps.gitPorts.materializeBuildEnv !== undefined) {
    await deps.gitPorts.materializeBuildEnv(deps.mainSandbox, deps.repo).catch(() => false)
  }
}
