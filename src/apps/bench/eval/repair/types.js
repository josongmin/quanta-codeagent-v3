/**
 * b2 — External repair-round contract (RFC §16, ADR-0014).
 *
 * SHARED TYPES the bench runner and the repair core build to. Lives in
 * `src/apps/bench/repair/` (bench-app only; agent slice unchanged). The whole
 * point of putting these in a sibling module is to make the **no-leak
 * invariant** structural: nothing here imports or names any official SWE-bench
 * hidden field (`FAIL_TO_PASS`, `test_patch`, the official report json) — the
 * validator's signal is exclusively the agent's own verification command or
 * its self-authored reproduction script. A consumer (validator/context/index)
 * cannot ask for hidden-test knowledge because the types don't expose it.
 *
 * Default-OFF byte-identical (ethos): `RunInstanceDeps.repair?: RepairConfig`
 * absent ⇒ the runner takes its existing single-pass path; nothing here is
 * exercised. Set ⇒ runner wraps `runAgentPhase` in `runRepairRounds` for real
 * SWE-bench instances only (bench-gated, identical to `verifyGuard`/SWEBENCH
 * DIRECTIVE gating).
 */
export {};
