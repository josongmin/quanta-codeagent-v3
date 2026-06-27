/**
 * b2 — Repair-round orchestrator (RFC §16, ADR-0014).
 *
 * Pure policy over an injected `runOnce` (one agent run) and `validate` (one
 * validator run). The orchestrator never imports `@/agent` directly — the
 * bench runner stays the sole composer of the agent slice. This file imports
 * only local repair helpers (`./types`) so the no-leak
 * invariant stays structural.
 *
 * Loop shape (continue-from-patched-tree — the bench runner side is
 * responsible for NOT resetting the sandbox between rounds):
 *
 *   round 0:        runOnce(undefined) → validate → record
 *   round i ≥ 1:    seed = buildContext(prev diff + validator failure evidence)
 *                   runOnce(seed) → validate → record
 *   stop early when validator returns ok, OR after maxRounds repair rounds.
 *
 * Aggregate result: `patch` is the LAST round's cumulative diff (this is what
 * the bench runner hands to the OFFICIAL grader EXACTLY ONCE). `validated`
 * reflects whether any round ended ok. `history` is the per-round bookkeeping
 * for observability/golden tests. Throws only if `runOnce` itself throws —
 * validator failures are normal and never throw.
 */

import { isStrongOracleFalseGreen } from "./strong-oracle"
import type {
  BuildRepairContextArgs,
  RepairCandidateOutcome,
  RepairReproOutcome,
  RepairValidationSource,
  RoundResult,
  RunOnceResult,
  RunRepairRoundsArgs,
  RunRepairRoundsResult,
  ValidateArgs,
  ValidatorResult,
} from "./types"
import { reproOutcomeRank } from "./types"

export const runRepairRounds = async (
  args: RunRepairRoundsArgs,
): Promise<RunRepairRoundsResult> => {
  const maxRounds = args.config.maxRounds ?? 2
  const history: RoundResult[] = []

  // Round 0: initial attempt — seed is undefined so the runner uses its
  // existing problem message construction unchanged.
  const round0 = await runRound(args, undefined, 0)
  const r0 = round0.run
  const v0 = round0.validator
  let turnsTotal = round0.turnsConsumed
  history.push({ round: 0, patch: r0.patch, validated: v0.ok })
  // T-302 finish gate (default-OFF; armed only when a primary rail is set — the
  // SAME `primaryRailStep !== undefined` knob that already swaps the validator
  // gate). When armed, an exit-code-green round whose typed rail predicate did
  // NOT match (false green) does NOT clear as validated — the rail is not proven.
  // Knob ABSENT ⇒ `clearedAsValidated` is identically `v.ok` ⇒ byte-identical.
  const v0Cleared = clearedAsValidated(args, v0)
  if (shouldFinishAfterRound0(v0Cleared, maxRounds)) {
    return finalize(history, turnsTotal, v0Cleared, r0.patch, isFalseGreen(v0), isFalseRed(v0))
  }

  let prevRun: RunOnceResult = r0
  let prevValidator: ValidatorResult = v0
  let validated = false
  // ANY round (incl. round 0) whose exit-code-green was a false green (rail
  // predicate evaluable AND matched===false). SEEDED from round 0 and STICKY —
  // symmetric to `falseRed`. The round-0 case is reachable when a primary rail is
  // set and the finish gate WITHHELD clearing on a spurious exit-code green, so
  // the loop ran on without ever recording the false green it already saw.
  let falseGreen = isFalseGreen(v0)
  // ANY round whose rail exit-code rejected a repro-says-resolved patch (RCA instrument).
  let falseRed = isFalseRed(v0)
  for (let i = 1; i <= maxRounds; i++) {
    const predicateSummary = predicateSummaryOf(prevValidator)
    const validationGate = validationGateContextOf(args, prevRun, prevValidator)
    const seed = args.buildContext({
      problem: args.problem,
      cumulativeDiff: prevRun.patch,
      failTail: prevValidator.failTail ?? "",
      ...(prevValidator.failureEvidence !== undefined
        ? { failureEvidence: prevValidator.failureEvidence }
        : {}),
      ...validationGate,
      ...(predicateSummary !== undefined ? { predicateSummary } : {}),
      round: i,
    })
    const roundI = await runRound(args, seed, i)
    const ri = roundI.run
    const vi = roundI.validator
    turnsTotal += roundI.turnsConsumed
    history.push({ round: i, patch: ri.patch, validated: vi.ok })
    prevRun = ri
    prevValidator = vi
    if (isFalseRed(vi)) falseRed = true
    // Record the (observe-only) false-green signal for EVERY exit-code-green
    // round, even when the finish gate withholds clearing — the diagnostic must
    // reflect what happened, not whether the gate let it pass. STICKY (matches
    // `falseRed`): a later honest green must not erase an earlier false green.
    if (hasFalseGreenSignal(vi)) falseGreen = true
    if (clearedAsValidated(args, vi)) {
      validated = true
      break
    }
  }
  return finalize(history, turnsTotal, validated, prevRun.patch, falseGreen, falseRed)
}

/** One round's executed outcome: the agent run + its validator verdict. For the
 *  single-candidate path the orchestrator ran the validator itself; for the
 *  BREADTH path the SELECTED candidate's validator (run by the driver in-fork)
 *  is carried verbatim and its tree has already been adopted into the sandbox. */
interface RoundExecution {
  readonly run: RunOnceResult
  readonly validator: ValidatorResult
  /** Turns consumed by the WHOLE round. Single path ⇒ the one run's turns. BREADTH
   *  path ⇒ the SUM across ALL `breadth` candidates (the honest ~B× cost), not
   *  just the selected one — `run.turns` alone would under-report the budget. */
  readonly turnsConsumed: number
}

/**
 * Execute ONE repair round, dispatching on breadth.
 *
 * - Breadth ≤ 1 OR no `runCandidates` port ⇒ the LEGACY single-candidate path:
 *   `runOnce(seed)` then the orchestrator's own `validate`. BYTE-IDENTICAL — the
 *   fan-out port is never touched, no fork, no extra validate.
 * - Breadth > 1 WITH the port ⇒ generate `breadth` candidates (driver forks +
 *   lanes + validates EACH), SELECT the best (see {@link selectCandidate}), ADOPT
 *   it (driver makes the main sandbox reflect the winner's tree), and continue
 *   from its run+validator. The official grader still runs EXACTLY ONCE later on
 *   the adopted cumulative diff (no extra grading — no-leak holds: selection read
 *   ONLY the injected validator).
 */
const runRound = async (
  args: RunRepairRoundsArgs,
  seedMsg: string | undefined,
  round: number,
): Promise<RoundExecution> => {
  const breadth = args.config.breadth ?? 1
  if (breadth > 1 && args.runCandidates !== undefined) {
    const candidates = await args.runCandidates({ seedMsg, breadth, round })
    // A zero-length fan-out (every candidate failed to even generate) must not
    // wedge the loop or NPE on selection — fall back to the single path so the
    // round still produces a run+verdict (degenerate but not silently lost).
    if (candidates.length > 0) {
      const winner = selectCandidate(args, candidates)
      await winner.adopt()
      // Honest cost: ALL candidates' turns were spent this round, not just the
      // selected one's — attribute the full sum so the budget/report is truthful.
      const turnsConsumed = candidates.reduce((sum, c) => sum + c.run.turns, 0)
      return { run: winner.run, validator: winner.validator, turnsConsumed }
    }
  }
  const run = await args.runOnce(seedMsg)
  const validator = await runValidate(args, run)
  return { run, validator, turnsConsumed: run.turns }
}

/**
 * SELECT the best of a breadth fan-out — the validated-red repro/primary-rail
 * oracle acting as SELECTOR.
 *
 * 1. GREEN-FIRST: the FIRST candidate the validator turns green (under the SAME
 *    finish-gate semantics as {@link clearedAsValidated}, so a primary-rail
 *    false-green does NOT win) — index order is the stable tie-break, so a
 *    deterministic run picks the same winner every time.
 * 2. NONE-GREEN: keep the BEST by validator signal — highest
 *    {@link reproOutcomeRank} (resolved > reproduced > other > exec_failed >
 *    none), index order breaking ties — to seed the next round from the
 *    strongest red rather than an arbitrary one.
 *
 * Selection consumes ONLY each candidate's injected `validator` — never a
 * gold/hidden field (the no-leak fence is structural: the candidate type has no
 * such field). `candidates` is non-empty (the caller guards length).
 */
const selectCandidate = (
  args: RunRepairRoundsArgs,
  candidates: readonly RepairCandidateOutcome[],
): RepairCandidateOutcome => {
  const green = candidates.find((c) => clearedAsValidated(args, c.validator))
  if (green !== undefined) return green
  // None green ⇒ argmax over the validator rank, first index wins ties. Seeded
  // with index 0 so an all-equal field deterministically yields the first.
  let best = candidates[0] as RepairCandidateOutcome
  let bestRank = reproOutcomeRank(reproOutcomeOf(best.validator))
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i] as RepairCandidateOutcome
    const rank = reproOutcomeRank(reproOutcomeOf(c.validator))
    if (rank > bestRank) {
      best = c
      bestRank = rank
    }
  }
  return best
}

/** OBSERVE-ONLY measurement: the round CLEARED (ok by exit code) yet the typed
 *  rail predicate was evaluable AND did not match — the false green a
 *  predicate-aware gate would have caught. Fail-open: an unevaluable/absent
 *  predicate is NOT a false green (never penalizes). */
const isFalseGreen = (v: ValidatorResult): boolean =>
  v.ok && v.predicate?.evaluable === true && v.predicate.matched === false

const hasFalseGreenSignal = (v: ValidatorResult): boolean => v.ok && isFalseGreen(v)

const shouldFinishAfterRound0 = (cleared: boolean, maxRounds: number): boolean =>
  cleared || maxRounds <= 0

/** T-302 finish-gate ENFORCEMENT (default-OFF). Whether an exit-code-green
 *  round may be treated as VALIDATED. With no primary rail set the answer is
 *  identically `v.ok` (byte-identical to the legacy exit-code-only behavior).
 *  When a primary rail IS set, the typed-rail-aware {@link decidePrimaryRailFinishGate}
 *  is the authority: a false-green round (rail predicate evaluable AND matched
 *  ===false) maps to a still-RED rail, so the gate BLOCKS and the round does NOT
 *  clear — the spurious exit-code green is the lone non-primary green that must
 *  not substitute for the rail's own proof. Reuses the keystone decider rather
 *  than re-deriving the policy. */
const clearedAsValidated = (args: RunRepairRoundsArgs, v: ValidatorResult): boolean => {
  if (!v.ok) return false
  // jun-28 STRONG-ORACLE (default-OFF): a CONJUNCTIVE strengthening that can ONLY
  // WITHHOLD a clear the gates below would grant (monotone, precision-raising). An
  // exit-0 round whose self-repro is green but ANY available strong signal is RED
  // (declared-expected mismatch OR a non-resolved repro-vote consensus) is a FALSE
  // GREEN ⇒ does not clear ⇒ the loop iterates toward a general fix. Each conjunct
  // fails OPEN on absence, so a correct patch with no contradicting strong signal
  // is never blocked. Knob ABSENT/false ⇒ this branch is skipped ⇒ byte-identical.
  if (args.config.strongOracle === true && isStrongOracleFalseGreen(v)) return false
  if (args.primaryRailStep === undefined) return true
  // A false-green round (rail predicate evaluable AND matched===false) leaves the
  // typed rail unproven, so the lone exit-code green must NOT substitute for the
  // rail's own proof and the round does not clear. This is exactly
  // `decidePrimaryRailFinishGate`'s decision (block ⇔ rail present AND state !==
  // "green") specialised to this site; it is INLINED rather than imported from
  // `@/agent/primary-rail` so the repair slice keeps its structural no-leak fence
  // (imports only local repair helpers). Keep in sync with the keystone decider.
  return !isFalseGreen(v)
}

const reproOutcomeOf = (v: ValidatorResult): RepairReproOutcome | undefined => {
  if (v.reproOutcome !== undefined) return v.reproOutcome
  return undefined
}

/** OBSERVE-ONLY measurement: the round did NOT clear (`ok:false`) yet the
 * validator-classified repro outcome says the patch resolved the issue. The
 * outcome must be explicit on `ValidatorResult`; stdout markers are not a
 * telemetry fallback. */
const isFalseRed = (v: ValidatorResult): boolean => !v.ok && reproOutcomeOf(v) === "resolved"

const predicateSummaryOf = (v: ValidatorResult): string | undefined => {
  const predicate = v.predicate
  if (predicate?.evaluable !== true || predicate.matched !== false) return undefined
  return predicate.mismatchReason !== undefined
    ? `Typed rail mismatch: ${predicate.mismatchReason}. Advisory only in v1; keep iterating until the same rail passes.`
    : "Typed rail mismatch: the typed rail contract did not match. Advisory only in v1; keep iterating until the same rail passes."
}

const validationGateContextOf = (
  args: RunRepairRoundsArgs,
  run: RunOnceResult,
  validator: ValidatorResult,
): Pick<
  BuildRepairContextArgs,
  | "validationSource"
  | "validationCmd"
  | "validationCmdWithheld"
  | "validationStepKind"
  | "validationExitCode"
  | "validationOutcome"
> => {
  const exitCode = validator.observed?.exitCode
  // A3 (producer): forward the validator's OWN classified repro/exec outcome so
  // the downstream packet builder (`proofStateOf`) can represent an infra/exec
  // crash as `execution_failed` instead of coercing it to `candidate_red`. The
  // outcome is taken verbatim from the validator's classification. NOTHING is
  // inferred from stdout markers here. Absent ⇒ the consumer falls back to the
  // exit-code path, byte-identical to before.
  const outcome = reproOutcomeOf(validator)
  const withExit = <
    T extends {
      validationSource: RepairValidationSource
      validationCmd?: string
      validationCmdWithheld?: boolean
      validationStepKind?: BuildRepairContextArgs["validationStepKind"]
    },
  >(
    base: T,
  ): T & { validationExitCode?: number; validationOutcome?: RepairReproOutcome } => {
    const withCode = exitCode !== undefined ? { ...base, validationExitCode: exitCode } : base
    return outcome !== undefined ? { ...withCode, validationOutcome: outcome } : withCode
  }

  if (args.primaryRailStep !== undefined) {
    return withExit({
      validationSource: "primary_rail",
      validationStepKind: args.primaryRailStep.kind,
      ...(args.primaryRailStep.kind === "repro"
        ? { validationCmd: args.primaryRailStep.cmd }
        : { validationCmdWithheld: true }),
    })
  }
  const lastVerifyCmd = run.lastVerifyCmd
  if (typeof lastVerifyCmd === "string" && lastVerifyCmd !== "") {
    return withExit({
      validationSource: "verify_cmd",
      validationCmd: lastVerifyCmd,
    })
  }
  const reproPath = run.reproPath
  const reproCmd = run.reproCmd
  if (
    typeof reproPath === "string" &&
    reproPath !== "" &&
    typeof reproCmd === "string" &&
    reproCmd !== ""
  ) {
    return withExit({
      validationSource: "repro",
      validationCmd: reproCmd,
    })
  }
  // No runnable gate ⇒ no proof receipt is produced downstream; do not attach an
  // outcome to a `none` source (the consumer returns `not_run` regardless).
  return { validationSource: "none" }
}

type PrimaryRailStep = NonNullable<RunRepairRoundsArgs["primaryRailStep"]>

/** The validate-arg policy inputs the orchestrator owns. Exposed as a NARROW
 *  subset (not full {@link RunRepairRoundsArgs}) so the BREADTH fan-out in the
 *  driver can build per-fork ValidateArgs through the SAME policy — pointing
 *  `sandbox` at a candidate's fork — instead of re-deriving primary-rail-vs-agent
 *  selection (one source of truth, no drift). */
export interface RepairValidateArgsInputs {
  readonly sandbox: string
  readonly exec: RunRepairRoundsArgs["exec"]
  readonly timeoutMs: number
  readonly readFile?: RunRepairRoundsArgs["readFile"]
  readonly evaluatePredicate?: RunRepairRoundsArgs["evaluatePredicate"]
  readonly primaryRailStep?: PrimaryRailStep
}

const commonValidateArgs = (
  args: RepairValidateArgsInputs,
): Pick<ValidateArgs, "sandbox" | "exec" | "timeoutMs" | "readFile" | "evaluatePredicate"> => ({
  sandbox: args.sandbox,
  exec: args.exec,
  timeoutMs: args.timeoutMs,
  ...(args.readFile !== undefined ? { readFile: args.readFile } : {}),
  ...(args.evaluatePredicate !== undefined ? { evaluatePredicate: args.evaluatePredicate } : {}),
})

const primaryRailValidateArgs = (
  args: RepairValidateArgsInputs,
  primaryRailStep: PrimaryRailStep,
): ValidateArgs => ({
  ...commonValidateArgs(args),
  cmd: primaryRailStep.cmd,
  ...(primaryRailStep.kind === "repro" ? { reproAuthority: true } : {}),
  ...(primaryRailStep.pytestReportPath !== undefined
    ? { pytestReportPath: primaryRailStep.pytestReportPath }
    : {}),
  // T-1 wired: evaluate the rail's typed predicate over the observed output
  // (observe-only in v1 — validator records, does NOT flip ok).
  successPredicate: primaryRailStep.successPredicate,
})

const agentRunValidateArgs = (args: RepairValidateArgsInputs, r: RunOnceResult): ValidateArgs => ({
  ...commonValidateArgs(args),
  ...(r.lastVerifyCmd !== undefined ? { cmd: r.lastVerifyCmd } : {}),
  ...(r.reproPath !== undefined ? { reproPath: r.reproPath } : {}),
  ...(r.reproCmd !== undefined ? { reproCmd: r.reproCmd } : {}),
})

/** Build the ValidateArgs for one agent run under the repair gate's policy
 *  (primary-rail when set, else the agent's own verify cmd / repro). Pure +
 *  EXPORTED so the BREADTH fan-out validates each fork through the SAME policy as
 *  the orchestrator's single-candidate path (point `inputs.sandbox` at the fork). */
export const buildRepairValidateArgs = (
  inputs: RepairValidateArgsInputs,
  r: RunOnceResult,
): ValidateArgs =>
  inputs.primaryRailStep !== undefined
    ? primaryRailValidateArgs(inputs, inputs.primaryRailStep)
    : agentRunValidateArgs(inputs, r)

const runValidate = (args: RunRepairRoundsArgs, r: RunOnceResult): Promise<ValidatorResult> =>
  args.validate(buildRepairValidateArgs(args, r))

const finalize = (
  history: readonly RoundResult[],
  turns: number,
  validated: boolean,
  patch: string,
  primaryFalseGreen: boolean,
  primaryFalseRed: boolean,
): RunRepairRoundsResult => ({
  patch,
  turns,
  rounds: history.length,
  validated,
  primaryFalseGreen,
  primaryFalseRed,
  history,
})
