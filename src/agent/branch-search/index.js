/**
 * Speculative branch search (ADR-0084) — barrel. Closed-port N-best
 * verifier-prover: propose (parallel, isolated) → verify → score → select.
 */
export { tmpdirIsolator, worktreeIsolator, } from "./isolate";
export { parallelPropose, } from "./propose";
export { argmaxSelector, DEFAULT_WEIGHTS, defaultScorer, makeScorer } from "./score";
export { runBranchSearch } from "./search";
export { buildSeeds } from "./seed";
export { branchSearchTool } from "./tool";
export { combineVerifiers, lintVerifier, lspDiagVerifier, testVerifier, tscVerifier, } from "./verify";
