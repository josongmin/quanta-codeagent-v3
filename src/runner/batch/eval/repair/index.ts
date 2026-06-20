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
import { decidePrimaryRailFinishGate } from "@/agent/primary-rail"
import type {
  BuildRepairContextArgs,
  RepairReproOutcome,
  RepairValidationSource,
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
  // T-302 finish gate (default-OFF; armed only when a primary rail is set — the
  // SAME `primaryRailStep !== undefined` knob that already swaps the validator
  // gate). When armed, an exit-code-green round whose typed rail predicate did
  // NOT match (false green) does NOT clear as validated — the rail is not proven.
  // Knob ABSENT ⇒ `clearedAsValidated` is identically `v.ok` ⇒ byte-identical.
  const v0Cleared = clearedAsValidated(args, v0)
  if (v0Cleared || maxRounds <= 0) {
    return finalize(history, turnsTotal, v0Cleared, r0.patch, isFalseGreen(v0), isFalseRed(v0))
  }

  let prevRun: RunOnceResult = r0
  let prevValidator: ValidatorResult = v0
  let validated = false
  let falseGreen = false
  // ANY round whose rail exit-code rejected a repro-says-resolved patch (RCA instrument).
  let falseRed = isFalseRed(v0)
  for (let i = 1; i <= maxRounds; i++) {
    const predicateSummary = predicateSummaryOf(prevValidator)
    const validationGate = validationGateContextOf(args, prevRun, prevValidator)
    const seed = args.buildContext({
      problem: args.problem,
      cumulativeDiff: prevRun.patch,
      failTail: prevValidator.failTail ?? "",
      ...validationGate,
      ...(predicateSummary !== undefined ? { predicateSummary } : {}),
      round: i,
    })
    const ri = await args.runOnce(seed)
    const vi = await runValidate(args, ri)
    turnsTotal += ri.turns
    history.push({ round: i, patch: ri.patch, validated: vi.ok })
    prevRun = ri
    prevValidator = vi
    if (isFalseRed(vi)) falseRed = true
    // Record the (observe-only) false-green signal for EVERY exit-code-green
    // round, even when the finish gate withholds clearing — the diagnostic must
    // reflect what happened, not whether the gate let it pass.
    if (vi.ok) falseGreen = isFalseGreen(vi)
    if (clearedAsValidated(args, vi)) {
      validated = true
      break
    }
  }
  return finalize(history, turnsTotal, validated, prevRun.patch, falseGreen, falseRed)
}

/** OBSERVE-ONLY measurement: the round CLEARED (ok by exit code) yet the typed
 *  rail predicate was evaluable AND did not match — the false green a
 *  predicate-aware gate would have caught. Fail-open: an unevaluable/absent
 *  predicate is NOT a false green (never penalizes). */
const isFalseGreen = (v: ValidatorResult): boolean =>
  v.ok && v.predicate?.evaluable === true && v.predicate.matched === false

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
  if (args.primaryRailStep === undefined) return true
  const railState: "green" | "red" = isFalseGreen(v) ? "red" : "green"
  const decision = decidePrimaryRailFinishGate({
    cfg: { enabled: true },
    result: {
      primaryRailPresent: true,
      primaryRailState: railState,
      // The exit-code green that did not match the typed rail predicate is the
      // single non-primary green that the gate must refuse to honor.
      nonPrimaryGreens: railState === "red" ? 1 : 0,
    },
  })
  return !decision.block
}

const MARKER_REPRODUCED = "Issue reproduced"
const MARKER_RESOLVED = "Issue resolved"
const MARKER_OTHER = "Other issues"

const classifyReproOutcome = (stdout: string, code: number): RepairReproOutcome => {
  const s = typeof stdout === "string" ? stdout : ""
  const iReproduced = s.lastIndexOf(MARKER_REPRODUCED)
  const iResolved = s.lastIndexOf(MARKER_RESOLVED)
  const iOther = s.lastIndexOf(MARKER_OTHER)
  const max = Math.max(iReproduced, iResolved, iOther)
  if (max < 0) return code !== 0 ? "exec_failed" : "unknown"
  if (max === iResolved) return "resolved"
  if (max === iReproduced) return "reproduced"
  return "other"
}

const reproOutcomeOf = (v: ValidatorResult): RepairReproOutcome | undefined => {
  if (v.reproOutcome !== undefined) return v.reproOutcome
  return v.observed !== undefined
    ? classifyReproOutcome(v.observed.stdout, v.observed.exitCode)
    : undefined
}

/** OBSERVE-ONLY measurement (jun-18 RCA instrument): the round did NOT clear
 *  (`ok:false`, exit-code ≠ 0 on the rail) YET the repro's OWN sentinel says the
 *  bug is fixed (`classifyStdout(stdout) === "resolved"`). This is a false-RED:
 *  the exit-code gate rejected a patch the repro itself reports as resolved,
 *  forcing wasteful repair churn (measured: repair runs all rounds, 46→131 turns,
 *  re-deriving the SAME correct patch). If this rate is high, the validator must
 *  gate on the repro's sentinel (its actual Agentless contract) rather than the
 *  incidental exit code. Records, never flips `ok` — the fix is the next step,
 *  gated on THIS measurement (no blind loop change). Prefer the validator's
 *  recorded `reproOutcome`; custom / test validators that omit it still
 *  participate via `observed.stdout` fallback. */
const isFalseRed = (v: ValidatorResult): boolean =>
  !v.ok && reproOutcomeOf(v) === "resolved"

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
  "validationSource" | "validationCmd" | "validationExitCode"
> => {
  const exitCode = validator.observed?.exitCode
  const withExit = <T extends { validationSource: RepairValidationSource; validationCmd?: string }>(
    base: T,
  ): T & { validationExitCode?: number } =>
    exitCode !== undefined ? { ...base, validationExitCode: exitCode } : base

  if (args.primaryRailStep !== undefined) {
    return withExit({
      validationSource: "primary_rail",
      validationCmd: args.primaryRailStep.cmd,
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
  if (typeof reproPath === "string" && reproPath !== "") {
    return withExit({
      validationSource: "repro",
      validationCmd: `python "${reproPath}"`,
    })
  }
  return { validationSource: "none" }
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
          ...(args.primaryRailStep.kind === "repro" ? { reproAuthority: true } : {}),
          // T-1 wired: evaluate the rail's typed predicate over the observed
          // output (observe-only in v1 — validator records, does NOT flip ok).
          successPredicate: args.primaryRailStep.successPredicate,
          ...(args.evaluatePredicate !== undefined ? { evaluatePredicate: args.evaluatePredicate } : {}),
        }
      : {
          sandbox: args.sandbox,
          exec: args.exec,
          timeoutMs: args.timeoutMs,
          ...(r.lastVerifyCmd !== undefined ? { cmd: r.lastVerifyCmd } : {}),
          ...(r.reproPath !== undefined ? { reproPath: r.reproPath } : {}),
          ...(args.evaluatePredicate !== undefined ? { evaluatePredicate: args.evaluatePredicate } : {}),
        }
  return args.validate(validateArgs)
}

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
