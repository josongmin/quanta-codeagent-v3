/**
 * GOAL P1-4 (first slice) — count a SETTLED attributed goal attempt on the
 * decision stream.
 *
 * GOAL-10 asked for bounded goal counters plus a label allowlist. Both already
 * existed and were unused: `kind: "objective"` is a reserved member of the
 * closed decision taxonomy (`@/stream` `DecisionEvent`, mirrored in
 * `@/observability` `decision-counter-sink`), whose hellgate already pins the
 * cardinality invariant — labels are `{kind, outcome}` and nothing else — and
 * it had ZERO producers. Filling that arm is cheaper and safer than inventing a
 * second counter system, and it inherits the allowlist for free.
 *
 * SCOPE, deliberately: only the TURN-SCOPED half. A `decision` carries a turn
 * index and an allow/deny/ask outcome, which fits "an attributed attempt
 * settled" exactly. Wake decisions (armed / canceled / skipped(reason)) happen
 * OUTSIDE any turn and would have to fake a turn number to fit — they need
 * their own instrument (ADR-0222 slice-port shape), which is a design decision,
 * not a mechanical extension of this one.
 *
 * The event carries NO identifier: not the attempt key, the objectiveId or the
 * threadId. A jsonl recorder writes decision events verbatim, so an identifier
 * here would leak past the counter sink that ignores it.
 */

import type { DecisionEmitter, DecisionEvent } from "@/stream"
import { safeEmitDecision } from "@/stream"

/** The settled-attempt facts this counter needs. Structural on purpose: the
 *  agent slice does not import the host's settlement module. */
export interface ObjectiveSettlementFacts {
  readonly turnOutcome: string
  readonly provenance: string
}

/** An attempt that PAUSED for the operator is neither a success nor a failure:
 *  it is the product asking. Everything else that is not a completion is a
 *  denial of forward progress. */
const outcomeOf = (turnOutcome: string): DecisionEvent["outcome"] =>
  turnOutcome === "completed" ? "allow" : turnOutcome === "awaiting_approval" ? "ask" : "deny"

export const emitObjectiveSettlementDecision = (
  emitter: DecisionEmitter | undefined,
  facts: ObjectiveSettlementFacts,
  turn: number,
): void => {
  if (emitter === undefined) return
  const scope = facts.provenance === "user-requested-goal-work" ? "user-requested" : "autonomous"
  const event: DecisionEvent = {
    type: "decision",
    turn,
    kind: "objective",
    outcome: outcomeOf(facts.turnOutcome),
    reason: `goal attempt settled: ${facts.turnOutcome} (${scope})`,
  }
  safeEmitDecision(emitter, event)
}
