/**
 * b2 — Repair-round orchestrator (RFC §16, ADR-0014).
 *
 * Pure policy over an injected `runOnce` (one agent run) and `validate` (one
 * validator run). The orchestrator never imports `@/agent` directly — the
 * bench runner stays the sole composer of the agent slice. This file imports
 * only from `./types` so the no-leak invariant is structural.
 *
 * Loop shape (continue-from-patched-tree — the bench runner side is
 * responsible for NOT resetting the sandbox between rounds):
 *
 *   round 0:        runOnce(undefined) → validate → record
 *   round i ≥ 1:    seed = buildContext(prev diff + failTail)
 *                   runOnce(seed) → validate → record
 *   stop early when validator returns ok, OR after maxRounds repair rounds.
 *
 * Aggregate result: `patch` is the LAST round's cumulative diff (this is what
 * the bench runner hands to the OFFICIAL grader EXACTLY ONCE). `validated`
 * reflects whether any round ended ok. `history` is the per-round bookkeeping
 * for observability/golden tests. Throws only if `runOnce` itself throws —
 * validator failures are normal and never throw.
 */
import type {
  RoundResult,
  RunOnceResult,
  RunRepairRoundsArgs,
  RunRepairRoundsResult,
  ValidatorResult,
} from "./types"

export const runRepairRounds = async (
  args: RunRepairRoundsArgs,
): Promise<RunRepairRoundsResult> => {
  const maxRounds = args.config.maxRounds ?? 2
  const history: RoundResult[] = []

  // Round 0: initial attempt — seed is undefined so the runner uses its
  // existing problem message construction unchanged.
  const r0 = await args.runOnce(undefined)
  const v0 = await runValidate(args, r0)
  let turnsTotal = r0.turns
  history.push({ round: 0, patch: r0.patch, validated: v0.ok })
  if (v0.ok || maxRounds <= 0) {
    return finalize(history, turnsTotal, v0.ok, r0.patch, isFalseGreen(v0))
  }

  let prevRun: RunOnceResult = r0
  let prevValidator: ValidatorResult = v0
  let validated = false
  let falseGreen = false
  for (let i = 1; i <= maxRounds; i++) {
    const predicateSummary = predicateSummaryOf(prevValidator)
    const seed = args.buildContext({
      problem: args.problem,
      cumulativeDiff: prevRun.patch,
      failTail: prevValidator.failTail ?? "",
      ...(predicateSummary !== undefined ? { predicateSummary } : {}),
      round: i,
    })
    const ri = await args.runOnce(seed)
    const vi = await runValidate(args, ri)
    turnsTotal += ri.turns
    history.push({ round: i, patch: ri.patch, validated: vi.ok })
    prevRun = ri
    prevValidator = vi
    if (vi.ok) {
      validated = true
      falseGreen = isFalseGreen(vi)
      break
    }
  }
  return finalize(history, turnsTotal, validated, prevRun.patch, falseGreen)
}

/** OBSERVE-ONLY measurement: the round CLEARED (ok by exit code) yet the typed
 *  rail predicate was evaluable AND did not match — the false green a
 *  predicate-aware gate would have caught. Fail-open: an unevaluable/absent
 *  predicate is NOT a false green (never penalizes). */
const isFalseGreen = (v: ValidatorResult): boolean =>
  v.ok && v.predicate?.evaluable === true && v.predicate.matched === false

const predicateSummaryOf = (v: ValidatorResult): string | undefined => {
  const predicate = v.predicate
  if (predicate?.evaluable !== true || predicate.matched !== false) return undefined
  return predicate.mismatchReason !== undefined
    ? `Typed rail mismatch: ${predicate.mismatchReason}. Advisory only in v1; keep iterating until the same rail passes.`
    : "Typed rail mismatch: the typed rail contract did not match. Advisory only in v1; keep iterating until the same rail passes."
}

const runValidate = (args: RunRepairRoundsArgs, r: RunOnceResult): Promise<ValidatorResult> => {
  // T-302: when a primary rail is set, IT is the gate — the agent's own
  // `lastVerifyCmd`/repro can no longer clear the round (a non-primary green is
  // not proof). The validator clears only when the primary rail passes; an
  // unset rail (default) falls back to the agent-command gate, byte-identical.
  // exactOptionalPropertyTypes: conditionally include optional fields only when
  // present — never set them to explicit `undefined`.
  const validateArgs =
    args.primaryRailStep !== undefined
      ? {
          sandbox: args.sandbox,
          exec: args.exec,
          timeoutMs: args.timeoutMs,
          cmd: args.primaryRailStep.cmd,
          // T-1 wired: evaluate the rail's typed predicate over the observed
          // output (observe-only in v1 — validator records, does NOT flip ok).
          successPredicate: args.primaryRailStep.successPredicate,
        }
      : {
          sandbox: args.sandbox,
          exec: args.exec,
          timeoutMs: args.timeoutMs,
          ...(r.lastVerifyCmd !== undefined ? { cmd: r.lastVerifyCmd } : {}),
          ...(r.reproPath !== undefined ? { reproPath: r.reproPath } : {}),
        }
  return args.validate(validateArgs)
}

const finalize = (
  history: readonly RoundResult[],
  turns: number,
  validated: boolean,
  patch: string,
  primaryFalseGreen: boolean,
): RunRepairRoundsResult => ({
  patch,
  turns,
  rounds: history.length,
  validated,
  primaryFalseGreen,
  history,
})
