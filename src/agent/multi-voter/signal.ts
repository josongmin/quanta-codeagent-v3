/**
 * Branch-search composition seam (ADR-0433). Turns a `VoteOutcome` into ONE
 * additive `VerifierSignal` of kind `llm_voter_quorum`, so an adversarial
 * multi-voter run can be folded into the existing ADR-0084 scorer ALONGSIDE
 * `tsc`/`test`/`lint`/`llm_judge` etc.
 *
 * ORTHOGONAL / DEFAULT-OFF: the branch-search scorer only ever sees this
 * signal when a caller explicitly produces it and concatenates it onto the
 * candidate's signal list (e.g. via a custom verifier). Absent that wiring NO
 * `llm_voter_quorum` signal exists, so `scoreWith` never reads the
 * `llm_voter_quorum` weight and the score is byte-identical to pre-ADR-0433.
 */

import type { VerifierSignal } from "@/agent/branch-search"
import type { VoteOutcome } from "./types"

/** Build the additive `llm_voter_quorum` signal from a `VoteOutcome`. `pass`
 *  mirrors the quorum verdict; `magnitude` is the graded pass-fraction so the
 *  scorer can reward "9 of 10 passed" above "6 of 10 passed". */
export const voterQuorumSignal = (outcome: VoteOutcome, durationMs = 0): VerifierSignal => {
  const fraction = outcome.totalVotes > 0 ? outcome.passVotes / outcome.totalVotes : 0
  return {
    kind: "llm_voter_quorum",
    pass: outcome.verdict,
    magnitude: fraction,
    detail: `${outcome.passVotes}/${outcome.totalVotes} voters passed (quorum ${outcome.quorumMet ? "met" : "unmet"})`,
    durationMs,
  }
}
