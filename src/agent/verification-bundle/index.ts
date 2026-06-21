/**
 * VerificationBundle — verify-and-select verdict authority (barrel).
 *
 * See {@link ./types} for the contract and the `null = FAIL-OPEN` invariant,
 * and {@link ./score} for the pure `scoreCandidate` / `selectBest` core.
 */

export {
  isCleanHardVeto,
  isKnownSignal,
  type KnownSignal,
  type SelectorMode,
  SIGNAL_AUTHORITY,
  type SignalAuthority,
} from "./authority"
export {
  isValidResolvedKofN,
  resolvedKofNPositive,
  resolvedKofNVoterQuorum,
} from "./resolved-kofn"
export { scoreCandidate, selectBest, selectBestEffort } from "./score"
export {
  compareLexTiers,
  type LexCandidate,
  type LexTiers,
  selectLexicographic,
} from "./select-lexicographic"
export type {
  CandidateVerdict,
  HardGateSignals,
  ResolvedKofNSignal,
  ScoredCandidate,
  SoftScoreSignals,
} from "./types"
