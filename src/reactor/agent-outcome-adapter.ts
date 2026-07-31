import type { AgentOutcome } from "@/agent"
import type { LastTurnOutcome } from "./types"

/**
 * Project an agent turn's terminal `AgentOutcome` into the reactor's coarse
 * `LastTurnOutcome` vocabulary (the input to autorun-eligibility / on-failure
 * policy).
 *
 * This is a domain JUDGMENT — "what counts as a failed vs partial vs successful
 * turn" — so it lives in the reactor (the domain that REACTS to the outcome),
 * not in a surface. It previously lived in `apps/cli/repl/session-loop`, where a
 * surface was deciding reactor semantics; the audit flagged that as a
 * cross-domain leak. Dependency direction is observer→observed (reactor → agent,
 * type-only), the correct way round: the reactor knows the agent's outcome
 * shape, never the reverse.
 *
 * Total over `AgentOutcome["reason"]` — adding a new reason is a compile error
 * here, forcing an explicit classification rather than a silent default.
 */
export const lastTurnOutcomeFromAgentOutcome = (outcome: { reason: AgentOutcome["reason"] }): LastTurnOutcome => {
  switch (outcome.reason) {
    case "completed":
      return "success"
    case "max_turns":
    case "aborted":
    case "budget_exhausted":
    // ALBB-18 — a turn paused for HITL approval is incomplete but resumable
    // (NOT a failure). Classifies to the same coarse bucket as the other
    // non-terminal-but-not-successful stops.
    case "awaiting_approval":
      return "partial"
    case "error":
    case "refusal":
      return "fail"
  }
}
