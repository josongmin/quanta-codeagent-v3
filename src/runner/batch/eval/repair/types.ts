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

/** Caller-facing config (mirror the optional-feature pattern). */
export interface RepairConfig {
  /** Max additional repair rounds after the initial attempt. Default 2 ⇒ up
   *  to 3 total agent invocations. Honest cost ≈ ×(1+maxRounds). */
  maxRounds?: number
}

/** Outcome of the non-leaking validator (the per-round gate). */
export interface ValidatorResult {
  /** True ⇒ agent's own verification command (or its repro) now passes in the
   *  patched sandbox; loop is done. False ⇒ feed `failTail` back to the agent
   *  for the next round. */
  ok: boolean
  /** Bounded tail of combined stdout+stderr from the validator command, for
   *  the next-round seed message. Empty when ok or when no command was
   *  available to validate. */
  failTail?: string
}

/** One repair round's bookkeeping (observability/golden, not the score). */
export interface RoundResult {
  /** 0-based: 0 = initial attempt, ≥1 = repair rounds. */
  round: number
  /** Captured unified diff at the END of this round (cumulative). */
  patch: string
  /** Validator verdict at end of this round (true ⇒ loop terminated here). */
  validated: boolean
}

/** What one `runAgent` invocation hands back to the orchestrator. Populated
 *  by the bench runner; the orchestrator never invokes the agent directly
 *  (slice isolation: only `apps/` composes `@/agent`). */
export interface RunOnceResult {
  /** Cumulative diff in the sandbox after this agent run (post-sourceOnly
   *  filter, source-only). */
  patch: string
  /** Turn count consumed by this agent run (for budgeting/reporting). */
  turns: number
  /** The agent's LAST bash/test_runner command, if any — the validator
   *  re-executes EXACTLY this in the patched sandbox. Optional: if the agent
   *  never ran a verification command, the validator has nothing to check and
   *  must return `{ok:false, failTail:""}` so the loop can still iterate
   *  (the round is degenerate but not silently "passed"). */
  lastVerifyCmd?: string
  /** Optional path (sandbox-relative or absolute) to a reproduction script
   *  the agent wrote; if present and `lastVerifyCmd` absent, the validator
   *  may invoke `python <reproPath>` as the validation command. */
  reproPath?: string
}

/** Minimal shell-exec port for the validator. SAME shape as `runner.ts`'s
 *  local `exec` (intentionally re-declared here — not imported — to avoid
 *  coupling repair/* to runner.ts internals and to keep the validator
 *  hermetic-by-injection in tests). */
export type ExecFn = (
  cmd: string,
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>

/** Inputs to the non-leaking validator. By design this signature CANNOT
 *  reference instance/dataset fields — the validator is structurally
 *  incapable of peeking at `FAIL_TO_PASS`, `test_patch`, or the official
 *  report. The signal is only the agent's own command/repro. */
export interface ValidateArgs {
  sandbox: string
  /** The agent's last verification command (re-executed verbatim). */
  cmd?: string
  /** Or the path to a repro script the agent created (run as
   *  `python <reproPath>`). */
  reproPath?: string
  exec: ExecFn
  timeoutMs: number
  /** Bound on captured tail bytes from stdout+stderr (default 2000). */
  tailBytes?: number
}

/** Pure-function context builder: given the running diff + the latest
 *  validator failure, produce the seed user message for the next round.
 *  No instance/dataset reads — same no-leak structural guarantee. */
export interface BuildRepairContextArgs {
  /** Original problem statement (the same text the initial round received). */
  problem: string
  /** Cumulative unified diff across rounds so far (source-only). */
  cumulativeDiff: string
  /** Bounded tail from the validator's failure (≤ ~2000 chars). */
  failTail: string
  /** 1-based round number we are about to start (for prose only). */
  round: number
  /** Optional cap on total message bytes (default ~12k); the diff/tail are
   *  truncated first to fit. */
  maxBytes?: number
}

/** Orchestrator argument bundle. The orchestrator is pure-policy over an
 *  injected `runOnce` (one agent run) and `validate` (one validator run); it
 *  never imports `@/agent` directly, so the bench runner stays the sole
 *  composer of the agent slice. */
export interface RunRepairRoundsArgs {
  config: RepairConfig
  problem: string
  /** Run ONE agent attempt. `seedMsg` is undefined for round 0 (initial),
   *  set for rounds ≥1 (the BuildRepairContext output). The runner is
   *  responsible for keeping the sandbox patched between rounds (do NOT
   *  reset / git-clean between rounds — repair is `continue-from-patched-
   *  tree`). */
  runOnce: (seedMsg: string | undefined) => Promise<RunOnceResult>
  /** Inject the validator (G1 implements; tests pass a fake). */
  validate: (args: ValidateArgs) => Promise<ValidatorResult>
  /** Inject the context builder (G1 implements; tests can swap). */
  buildContext: (args: BuildRepairContextArgs) => string
  /** Sandbox dir (forwarded to validator only). */
  sandbox: string
  exec: ExecFn
  timeoutMs: number
  /** T-302 primary-rail enforcement (default-OFF). When set (driver passes the
   *  VerificationPlan's `primaryRail.cmd`), the per-round validator gate runs
   *  THIS command instead of the agent's own `lastVerifyCmd`/repro — so a
   *  NON-primary green can no longer clear the loop (the false-green killer) and
   *  repair iterates only while the primary rail is red. ABSENT ⇒ byte-identical
   *  (agent-command gate). The rail is selected from PUBLIC evidence only
   *  (repro/owner-test/smoke) upstream, so the no-leak invariant is preserved. */
  primaryRailCmd?: string
}

/** Orchestrator result. The cumulative `patch` is what the bench runner then
 *  hands to the OFFICIAL grader (`verify()` — outside this loop, called
 *  EXACTLY ONCE per instance, never fed back). */
export interface RunRepairRoundsResult {
  patch: string
  turns: number
  /** Total rounds executed (incl. round 0). 1 ⇒ no repair (initial validated
   *  or no repair budget). */
  rounds: number
  /** True ⇒ a round's validator returned ok; false ⇒ all rounds exhausted
   *  without ok (the final patch is still handed to the official grader). */
  validated: boolean
  /** Per-round bookkeeping (for observability/tests). */
  history: readonly RoundResult[]
}
