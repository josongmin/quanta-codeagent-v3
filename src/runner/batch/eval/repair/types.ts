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
  /** jun-28 repair-loop BREADTH (oracle-selected best-of-N). When `> 1` AND a
   *  `runCandidates` port is injected, a repair round generates `breadth`
   *  INDEPENDENT candidates (the driver forks `breadth` sandboxes + routes model
   *  lanes), validates EACH against the SAME repro/primary-rail validator, and the
   *  orchestrator CONTINUES from the candidate the validator turns GREEN (the
   *  oracle as SELECTOR). None green ⇒ keep the best by validator signal
   *  (`reproOutcome` rank) to seed the next round. ABSENT / `1` ⇒ the legacy
   *  single-candidate `runOnce`+`validate` path (no fork, no extra validate) ⇒
   *  byte-identical. Honest cost ≈ ×breadth patch-gen per round (opt-in). */
  breadth?: number
  /** jun-28 STRONG-ORACLE clear gate (knob QUANTA_BENCH_REPAIR_STRONG_ORACLE).
   *  When `true`, a round clears ONLY when its exit-code green ALSO survives a
   *  CONJUNCTION of the AVAILABLE strong, no-leak signals (declared-expected match
   *  + repro-vote consensus); a green round contradicted by any available strong
   *  signal is treated as a FALSE GREEN and the loop iterates rounds 1..N toward a
   *  general fix. Each conjunct fails OPEN on absence (a correct patch is never
   *  blocked). ABSENT / `false` ⇒ the legacy single-green clear (byte-identical).
   *  RAISES precision of the clear gate (fewer false-greens) at the cost of more
   *  repair rounds — opt-in; A/B before promotion. See `./strong-oracle`. */
  strongOracle?: boolean
}

/**
 * Canonical validator failure payload. The validator is the sole owner of how
 * failing output is bounded; downstream repair seed builders must consume these
 * tails as-is rather than re-deriving head-vs-tail policy from raw strings.
 */
export interface ValidationFailureEvidence {
  /** Tail-bounded stdout captured from the failing validation gate. */
  stdoutTail: string
  /** Tail-bounded stderr captured from the failing validation gate. */
  stderrTail: string
  /** Tail-bounded combined stdout+stderr rendered for legacy seed prose. */
  combinedTail: string
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
  /** Authoritative structured failure payload. When present, downstream repair
   *  seed builders must prefer this over the legacy `failTail` projection so
   *  tail semantics are preserved end-to-end. */
  failureEvidence?: ValidationFailureEvidence
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
  /** jun-28 STRONG-ORACLE: the K-of-N repro-vote's RESOLVED-side consensus verdict
   *  over the independently-phrased reproducing set, when the vote ran. Set ONLY by
   *  the repro-vote validator (`makeReproVoteValidate`); ABSENT for single-repro /
   *  primary-rail rounds. A no-leak signal (agent-side repros only). Consumed by the
   *  strong-oracle clear gate: an exit-0 round whose consensus is NOT `resolved`
   *  (a minority-green) is a false green. Absent ⇒ fail-open (never penalizes). */
  consensus?: ReproConsensusVerdict
}

/** jun-28 STRONG-ORACLE: the RESOLVED-side verdict of the K-of-N repro-vote over
 *  the reproducing set, re-declared here (NOT imported from `@/agent/repro-test`)
 *  so the repair slice keeps its structural no-leak fence. Mirrors the closure
 *  engine's `ReproResolvedVerdict`:
 *    - `resolved`     — strict majority of decisive repros now pass on the patch.
 *    - `reproduced`   — strict majority still reproduce the bug (patch insufficient).
 *    - `inconclusive` — tie / all-noisy (no decisive consensus). */
export type ReproConsensusVerdict = "resolved" | "reproduced" | "inconclusive"

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
   *  the agent wrote. This is telemetry/diagnostic unless paired with
   *  `reproCmd`; the validator must not fabricate a bare host `python` command
   *  from this path because SWE-bench repros require the prepared project env. */
  reproPath?: string
  /** Exact command that runs `reproPath` under the owning project environment.
   *  When present and `lastVerifyCmd` absent, this is the only runnable repro
   *  fallback the validator may execute. */
  reproCmd?: string
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

export type ReadTextFileFn = (path: string) => Promise<string>

/** Inputs to the non-leaking validator. By design this signature CANNOT
 *  reference instance/dataset fields — the validator is structurally
 *  incapable of peeking at `FAIL_TO_PASS`, `test_patch`, or the official
 *  report. The signal is only the agent's own command/repro. */
export interface ValidateArgs {
  sandbox: string
  /** The agent's last verification command (re-executed verbatim). */
  cmd?: string
  /** Or the path to a repro script the agent created. Path-only is not runnable:
   *  callers must also provide `reproCmd` so the adapter, not the validator,
   *  supplies the correct project-env interpreter. */
  reproPath?: string
  /** Exact project-env command for `reproPath`. */
  reproCmd?: string
  /** Structured pytest sidecar path for repro authority commands. */
  pytestReportPath?: string
  /** Explicit authority bit for sidecar-mode repro validation. Use when the
   *  validator is running a repro THROUGH `cmd` (for example a selected primary
   *  rail), so the pytest sidecar is authoritative and may override exit code.
   *  Absent/false ⇒ a plain `cmd` is treated as an ordinary verify command. */
  reproAuthority?: boolean
  exec: ExecFn
  /** Reads the controlled pytest report sidecar. Required for repro authority. */
  readFile?: ReadTextFileFn
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

/**
 * jun-28 repair-loop BREADTH — SELECTOR rank over a validator signal. Higher =
 * a stronger validator-side claim the patch fixed the issue. Used ONLY when NO
 * candidate cleared (no GREEN) to seed the next round from the best of a red
 * field. This is the agent-side oracle's ordering — it consumes ONLY the
 * injected validator's classification, NEVER a gold/hidden field (no-leak).
 *   resolved (4) > reproduced (3) > other/unknown (2) > exec_failed (1) > none (0)
 * `exec_failed` ranks BELOW a plain red because an infra/exec crash carries no
 * evidence the patch is even on the right track. A missing outcome (the validator
 * never classified one) is `none`. Pure + exported so the orchestrator and any
 * driver-side tie-break share ONE ordering.
 */
export const reproOutcomeRank = (outcome: RepairReproOutcome | undefined): number => {
  switch (outcome) {
    case "resolved":
      return 4
    case "reproduced":
      return 3
    case "other":
    case "unknown":
      return 2
    case "exec_failed":
      return 1
    default:
      return 0
  }
}

/** jun-28 repair-loop BREADTH — one candidate the driver generated + validated on
 *  its OWN forked sandbox. The orchestrator ranks these and continues from the
 *  selected one. The driver owns fork/lane/git; this is the pure hand-back. */
export interface RepairCandidateOutcome {
  /** What the agent run produced on this candidate's fork (cumulative diff +
   *  turns + the agent's last verify cmd / repro). */
  readonly run: RunOnceResult
  /** The SAME validator (re-)run against this candidate's patched fork. Selection
   *  reads ONLY this — never a gold/hidden field. */
  readonly validator: ValidatorResult
  /** ADOPT this candidate as the continuation point: the driver makes the MAIN
   *  sandbox reflect this candidate's cumulative tree (reset-to-base + apply its
   *  diff) so the next repair round AND the final grader-bound capture see it.
   *  Called by the orchestrator for the SELECTED candidate only; the driver
   *  cleans up the (now-discarded) forks. */
  readonly adopt: () => Promise<void>
}

/** jun-28 repair-loop BREADTH — inputs the orchestrator hands the driver's
 *  fan-out port for ONE repair round. */
export interface RunRepairCandidatesArgs {
  /** Seed message for this round (undefined for round 0 — initial attempt). */
  readonly seedMsg: string | undefined
  /** How many INDEPENDENT candidates to generate (already clamped to ≥2 by the
   *  orchestrator before this port is called). */
  readonly breadth: number
  /** 0-based round index (0 = initial, ≥1 = repair rounds). Lets the driver vary
   *  lane assignment / telemetry per round. */
  readonly round: number
}

/** jun-28 repair-loop BREADTH — the DRIVER-implemented fan-out port. Generates
 *  `breadth` candidates on `breadth` forked sandboxes (routing model lanes when
 *  configured), validates EACH against the injected validator, and returns the
 *  per-candidate outcomes IN INDEX ORDER. Keeping this a port (vs calling
 *  `forkSandbox` here) is what lets the repair slice stay PURE — it never imports
 *  `@/agent` or the sandbox/fork helpers. */
export type RunRepairCandidatesPort = (
  args: RunRepairCandidatesArgs,
) => Promise<readonly RepairCandidateOutcome[]>

const boundTail = (s: string, maxChars: number): string =>
  s.length > maxChars ? s.slice(-maxChars) : s

/**
 * Build the canonical structured validator failure payload. The caller provides
 * the raw stdout/stderr and the tail bound once; downstream consumers only read
 * the resulting tails.
 */
export const buildValidationFailureEvidence = (args: {
  stdout: string
  stderr: string
  tailBytes: number
}): ValidationFailureEvidence => ({
  stdoutTail: boundTail(args.stdout, args.tailBytes),
  stderrTail: boundTail(args.stderr, args.tailBytes),
  combinedTail: boundTail(`${args.stdout}\n${args.stderr}`, args.tailBytes),
})

/**
 * Compatibility projection for legacy repair seed builders/tests that still
 * pass only `failTail`. When structured evidence exists, its combined tail is
 * authoritative.
 */
export const combinedFailureTailOf = (args: {
  failureEvidence?: ValidationFailureEvidence
  failTail?: string
}): string => args.failureEvidence?.combinedTail ?? args.failTail ?? ""

/** Pure-function context builder: given the running diff + the latest
 *  validator failure, produce the seed user message for the next round.
 *  No instance/dataset reads — same no-leak structural guarantee. */
export interface BuildRepairContextArgs {
  /** Original problem statement (the same text the initial round received). */
  problem: string
  /** Cumulative unified diff across rounds so far (source-only). */
  cumulativeDiff: string
  /** Legacy compatibility projection of the failing output tail. When
   *  `failureEvidence` is present, that structured payload is authoritative. */
  failTail: string
  /** Canonical structured failure payload from the validator. Downstream repair
   *  context/packet builders must prefer this over `failTail`. */
  failureEvidence?: ValidationFailureEvidence
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
  readFile?: ReadTextFileFn
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
  /** jun-28 repair-loop BREADTH — the DRIVER-implemented fan-out port. When
   *  `config.breadth > 1` AND this port is present, each repair round generates
   *  `breadth` independent candidates (on forked sandboxes, routing model lanes),
   *  validates EACH against the same validator, and the orchestrator continues
   *  from the GREEN candidate (else the best validator signal). ABSENT or
   *  `breadth <= 1` ⇒ the legacy single `runOnce`+`validate` path (byte-identical:
   *  this port is NEVER called, no fork, no extra validate). */
  runCandidates?: RunRepairCandidatesPort
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
  /** RCA OBSERVE-ONLY: ANY round whose rail stayed red while the validator's
   *  classified repro outcome says `resolved`. Records, never flips
   *  `validated`. */
  primaryFalseRed: boolean
  /** Per-round bookkeeping (for observability/tests). */
  history: readonly RoundResult[]
}
