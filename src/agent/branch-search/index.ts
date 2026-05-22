/**
 * Speculative branch search (ADR-0083) — barrel. Contract types only at the
 * moment; concrete impls land in sibling files (scorer/selector/verify/
 * propose/orchestrator) per the 6-PR plan.
 */
export type {
  BranchCandidate,
  BranchSearchConfig,
  BranchSearchRequest,
  BranchSearchResult,
  BranchSeed,
  BranchTraceEvent,
  CandidateScore,
  Isolator,
  Scorer,
  Selector,
  Verifier,
  VerifierKind,
  VerifierSignal,
} from "./types"
