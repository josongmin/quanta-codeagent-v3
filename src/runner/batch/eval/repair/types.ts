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

import type {
  ExecObservation,
  PredicateResult,
  PrimaryRailStep,
  SuccessPredicate,
} from "@/agent/closure"
import type { VerificationTargetFact } from "@/runner/batch/eval/llm-evidence-packet"

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
  /** T-1 OBSERVE-ONLY: what the validator command produced, and the typed
   *  predicate verdict over it (when a `successPredicate` was supplied). These
   *  are RECORDED for diagnostics / repair-seed pressure; in v1 they do NOT
   *  change `ok` (the exit-code decision stands). `predicate.evaluable===false`
   *  ⇒ fail-open: the predicate is advisory and never overrides `ok`. */
  observed?: ExecObservation
  predicate?: PredicateResult
  /** Repro-marker outcome recorded from stdout classification. Diagnostic only:
   *  used by observe-only repair instruments such as false-RED measurement. */
  reproOutcome?: RepairReproOutcome
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
  /** Explicit authority bit for sentinel-mode repro validation. Use when the
   *  validator is running a repro THROUGH `cmd` (for example a selected primary
   *  rail), so stdout markers are authoritative and may override exit code.
   *  Absent/false ⇒ a plain `cmd` is treated as an ordinary verify command. */
  reproAuthority?: boolean
  exec: ExecFn
  timeoutMs: number
  /** Bound on captured tail bytes from stdout+stderr (default 2000). */
  tailBytes?: number
  /** T-1 OBSERVE-ONLY: typed proof obligation for the rail's cmd. When present,
   *  the validator evaluates it over the observed output and RECORDS the verdict
   *  in `ValidatorResult.predicate` — but does NOT change `ok` in v1 (fail-open;
   *  the exit-code decision stands). Pure-core evaluation; the predicate type is
   *  the closure engine's. */
  successPredicate?: SuccessPredicate
  /** Injected typed-predicate evaluator. The repair slice stays structurally
   *  isolated from the closure engine by receiving this pure evaluator from the
   *  owning driver rather than importing it directly. */
  evaluatePredicate?: (observed: ExecObservation, predicate: SuccessPredicate) => PredicateResult
}

export type RepairReproOutcome = "reproduced" | "resolved" | "other" | "exec_failed" | "unknown"

export type RepairValidationSource = "primary_rail" | "verify_cmd" | "repro" | "none"

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
  /** The exact gate the validator used for the previous round. Exposes WHY the
   *  loop stayed red: primary rail, agent verify cmd, repro script, or no
   *  runnable signal at all. */
  validationSource?: RepairValidationSource
  /** Exact command the validator ran for the previous round (when any). */
  validationCmd?: string
  /** When true, the validator DID run a gate command but the command text is
   *  intentionally withheld from the model because it can encode a hidden
   *  verification selector path (owner-test / module-smoke primary rail). */
  validationCmdWithheld?: boolean
  /** Typed kind of the validation step when the gate was the selected primary
   *  rail. Lets downstream evidence preserve repro vs owner-test vs module-smoke
   *  provenance instead of collapsing all primary rails into one string bucket. */
  validationStepKind?: PrimaryRailStep["kind"]
  /** Exit code observed from the validation gate (when a command actually ran). */
  validationExitCode?: number
  /** A3: the validator's OWN already-classified repro/exec outcome. When
   *  `exec_failed`, the proof receipt is an INFRA failure (`execution_failed`),
   *  NOT a candidate-correctness verdict (`candidate_red`). Pre-classified
   *  upstream (no re-derivation/heuristic here). Absent ⇒ exit-code only. */
  validationOutcome?: RepairReproOutcome
  /** B3: the active proof target the repaired patch must satisfy. Forwarded into
   *  the classic-repair packet so it names the public proof (selector-repair
   *  sibling already carries this; classic repair structurally lacked it). */
  verificationTarget?: VerificationTargetFact
  /** B1: issue symbols used to resolve the EXACT owner source slice (paired with
   *  `readSource`). Blind — derived from public issue text only. */
  issueSymbols?: readonly string[]
  /** B1: sandbox source reader (rel path ⇒ source | null). When supplied with
   *  `issueSymbols`, owner evidence carries the exact symbol slice instead of a
   *  path-only reconstruction. No reader ⇒ path-only (B2 surfaces the gap). */
  readSource?: (rel: string) => string | null
  /** Advisory typed-rail mismatch summary for the next round's seed. */
  predicateSummary?: string
  /** 1-based round number we are about to start (for prose only). */
  round: number
  /** WS2 widen behavior: co-change sibling owner files (blind — from the LSP/grep
   *  `ownerResolved`, NEVER hidden test fields). When non-empty, the seed tells
   *  the agent these files override the SAME method and likely need the same fix
   *  — turning the gate's `sibling_coverage_missing` record into actual model
   *  pressure. buildContext is only called AFTER a red round, so this fires
   *  exactly when the single-site attempt proved insufficient. */
  siblingOwners?: readonly string[]
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
  /** T-302/T-2 primary-rail enforcement (default-OFF). When set (driver passes the
   *  VerificationPlan's selected primary rail as a TYPED step), the per-round
   *  validator gate runs `step.cmd` instead of the agent's own `lastVerifyCmd`/
   *  repro — so a NON-primary green can no longer clear the loop — AND evaluates
   *  `step.successPredicate` over the observed output (T-1, observe-only in v1).
   *  ABSENT ⇒ byte-identical (agent-command gate). The rail is selected from
   *  PUBLIC evidence only (repro/owner-test/smoke) upstream (no-leak preserved). */
  primaryRailStep?: PrimaryRailStep
  /** Injected typed-predicate evaluator passed through to the validator when a
   *  typed success predicate is present. */
  evaluatePredicate?: ValidateArgs["evaluatePredicate"]
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
  /** T-3 OBSERVE-ONLY measurement: ANY round (including round 0) whose exit-code
   *  green had a typed rail predicate that was EVALUABLE but did NOT match — i.e.
   *  the rail went green on exit code while the typed proof says it should not
   *  have. This is the `primary_false_green` signal that quantifies how often a
   *  predicate-aware gate (T-4) WOULD have caught a false green. SEEDED from round
   *  0 and STICKY (symmetric to `primaryFalseRed`): an earlier false green is not
   *  erased by a later honest green, and a round-0 false green the finish gate
   *  withheld is still counted. Does NOT change `validated` in v1 (fail-open /
   *  observe-first). False only when NO round was a false green. */
  primaryFalseGreen: boolean
  /** jun-18 RCA OBSERVE-ONLY: ANY round whose rail (exit-code) rejected a patch
   *  the repro's OWN sentinel reports as resolved (`classifyStdout==="resolved"`
   *  yet `ok:false`). This is the false-RED that forces wasteful repair churn
   *  (measured 46→131 turns re-deriving the same correct patch). If this rate is
   *  high, the validator must gate on the repro sentinel (its Agentless contract),
   *  not the incidental exit code. Records, never flips `validated`. */
  primaryFalseRed: boolean
  /** Per-round bookkeeping (for observability/tests). */
  history: readonly RoundResult[]
}
