/**
 * Speculative branch search — N-best verifier-prover (ADR-0084).
 *
 * Hard edits run as N parallel candidates in ISOLATED workspaces; a closed
 * `Verifier` port produces typed `VerifierSignal`s; a pure `Scorer` folds them
 * into a 0..1 score; a pure `Selector` picks the winner. The main loop sees
 * ONLY the winner — losers go to the OTel span tree + the smoke trace sidecar.
 *
 * Slice: `@/agent`-level. Imports `@/llm` (ModelCandidate), `@/runtime` (shell
 * + worktree-fork for isolation), and the existing `runAgent` via a port — no
 * upward import. Default-OFF (RFC §1.2): `AgentConfig.branchSearch === undefined`
 * ⇒ tool unregistered, byte-identical legacy single-trajectory path.
 */
export {};
