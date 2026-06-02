/**
 * ADR-0453 — composition-root builder for the autorun-eligibility resolver,
 * shared by BOTH consuming paths (the reactor self-wake and the scheduler /
 * automation-engine tick). Extracted from the REPL session-loop so neither
 * path duplicates the closed-enum env parse.
 *
 * Reads the operator's autorun approval policy from the closed-enum knob
 * `QUANTA_AUTORUN_POLICY` (`never | on-request | on-failure | always`).
 *
 * Default-OFF / byte-identical: an UNSET or UNRECOGNIZED value ⇒ `undefined`
 * (no resolver ⇒ the consuming path runs its pre-ADR-0453 behavior verbatim).
 * The resolver, when built, is an ADDITIVE gate: it can only BLOCK an autorun
 * the existing guards already permitted, never force one.
 *
 * NO HEURISTIC: the verdict is the pure {@link evaluateAutorunEligibility}
 * projection of the closed enums (policy + prior outcome). `priorOutcome` is
 * read from `getPriorOutcome()` at CALL time (fresh per evaluation) so a
 * stateful caller (e.g. the reactor reading the latest turn outcome) reflects
 * the most recent state without re-building the resolver.
 *
 * SLICE: lives in `@/permission` next to the evaluator; imports NOTHING from
 * `@/reactor` / `@/scheduler`. `getPriorOutcome` is typed against this slice's
 * own {@link AutorunPriorOutcome} — the reactor's `LastTurnOutcome` is the
 * identical 4-state union, so it passes through structurally.
 */
import {
  type AutorunApprovalPolicy,
  type AutorunEligibility,
  type AutorunPriorOutcome,
  evaluateAutorunEligibility,
} from "./autorun-eligibility"

const POLICIES: readonly AutorunApprovalPolicy[] = ["never", "on-request", "on-failure", "always"]

export const buildAutorunEligibility = (
  env: Record<string, string | undefined>,
  getPriorOutcome: () => AutorunPriorOutcome | undefined,
): (() => AutorunEligibility) | undefined => {
  const raw = env.QUANTA_AUTORUN_POLICY
  if (raw === undefined || !POLICIES.includes(raw as AutorunApprovalPolicy)) return undefined
  const approvalPolicy = raw as AutorunApprovalPolicy
  return () => {
    const priorOutcome = getPriorOutcome()
    return evaluateAutorunEligibility({
      approvalPolicy,
      ...(priorOutcome !== undefined ? { priorOutcome } : {}),
    })
  }
}
