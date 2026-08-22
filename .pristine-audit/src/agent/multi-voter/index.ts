/**
 * Adversarial multi-voter verification (ADR-0433) — barrel. N independent
 * refute-biased voters aggregated by quorum, an additive `llm_voter_quorum`
 * branch-search signal, and a per-surface `VerifierSkillSpec` + generator stub.
 */
export { voterQuorumSignal, voterQuorumVerifier } from "./signal"
export { generateVerifierSkill, type VerifierSkillSpec, type VerifierSurface } from "./skill-spec"
export type {
  MultiVoterRequest,
  Verdict,
  VoteOutcome,
  VoteRecord,
  Voter,
} from "./types"
export {
  buildRefutePrompt,
  DEFAULT_QUORUM,
  explicitQuorumPasses,
  parseVerdict,
  quorumPasses,
  runMultiVoter,
} from "./voter"
