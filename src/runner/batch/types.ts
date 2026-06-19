/**
 * Bench domain types — SWE-bench-style harness + Best-of-N sampler.
 *
 * This is an app-composition concern (RFC §4 apps/bench, §13 Q4): the bench
 * app assembles existing slices, it does not introduce a new slice. Types here
 * are local to the app and intentionally minimal.
 */

import type { LocalEnvSelection } from "@/runtime"

/** Official SWE-bench instance metadata, present only for instances loaded
 *  from the real `swebench.verified` corpus. Consumed by the optional Python
 *  harness verifier (python-swebench.ts) — the local testCmd path ignores it. */
export interface SwebenchMeta {
  /** Upstream SWE-bench instance id, e.g. `astropy__astropy-12907`. */
  instanceId: string
  /** `org/name` GitHub slug, e.g. `astropy/astropy`. */
  repo: string
  /** Commit the buggy repo is checked out at. */
  baseCommit: string
  /** Commit whose env defines the test toolchain (optional upstream). */
  environmentSetupCommit?: string
  /** EVAL-ONLY — the official PASS_TO_PASS regression set (tests that already
   *  pass on the buggy tree and must keep passing). Threaded for the
   *  verify-and-select regression oracle (TB): the bench adapter supplies these
   *  ids to {@link makeBenchRegressionOracle} so a candidate that breaks one is
   *  inadmissible. NEVER handed to the agent loop — same eval-only boundary as
   *  the closure oracle's gold files. Absent ⇒ regression signal FAIL-OPEN. */
  passToPass?: readonly string[]
}

/** A single SWE-bench-style task. `repoPath` is treated as read-only: the
 *  runner copies it into a sandbox before the agent touches anything. */
export interface Instance {
  id: string
  /** Path to a checked-out repo with the bug present. Never mutated. */
  repoPath: string
  /** Natural-language task handed to the agent verbatim. */
  problemStatement: string
  /** Optional one-time setup (deps, build) run inside the sandbox copy. */
  setupCmd?: string
  /** Declared command environment applied to agent shell tools and bench execs. */
  localEnv?: LocalEnvSelection
  /** Command whose exit code 0 == resolved. Run inside the sandbox copy. */
  testCmd: string
  /** Reference patch (informational; not applied by the TS harness). */
  goldPatch?: string
  /** Present only for real `swebench.verified` instances — enables the
   *  optional official Python harness verifier. */
  swebench?: SwebenchMeta
}

/** Token usage rolled up for one instance (RFC-0002 §5.3, cost derivation). */
export interface InstanceUsage {
  model: string
  inputTokens: number
  outputTokens: number
}

export type BenchReproTestReason =
  | "disabled"
  | "empty_problem"
  | "generation_failed"
  | "generation_empty"
  | "execution_failed"
  | "no_reproduced_candidate"
  | "write_failed"
  | "not_installed"

export type BenchReproTestTelemetry =
  | {
      installed: true
      path: string
      samples: number
      reproducedCount: number
    }
  | {
      installed: false
      reason: BenchReproTestReason
      samples?: number
      reproducedCount?: number
      /** jun-18 DIAGNOSTIC (observe-only): per-sample outcome classification +
       *  a tail of the first sample's stdout. Surfaces WHY base-red reproduction
       *  is 0% (all `resolved` ⇒ LLM repro doesn't detect on base; `exec_failed`/
       *  `other` ⇒ script crashed e.g. import error; `unknown` ⇒ no marker). */
      sampleOutcomes?: readonly string[]
      sampleStdoutTail?: string
      /** jun-18 DIAGNOSTIC: tail of the first sample's stderr. Attributes an
       *  `exec_failed` outcome — ModuleNotFoundError ⇒ project not importable in
       *  the box's python (env-shape bug, not a script bug); SyntaxError ⇒ bad
       *  LLM script; empty ⇒ timeout. */
      sampleStderrTail?: string
    }

/**
 * Per-instance grading breakdown — the "WHY did it fail" diagnostic the summary
 * `resolved` boolean discards. EVAL-ONLY (from the official harness output).
 * Separates the two failure modes a single `resolved:false` conflates:
 *   - `passToPassFailed > 0` ⇒ the patch BROKE an existing test (a REGRESSION) —
 *     the failure a regression gate / verify-and-select can address.
 *   - `passToPassFailed === 0 ∧ failToPassFailed > 0` ⇒ the patch did NOT fix the
 *     target (no regression) — only better localization/generation can help.
 */
export interface GradeBreakdown {
  resolved: boolean
  failToPassFailed: number
  passToPassFailed: number
  passToPassTotal: number
}

/**
 * Repro-oracle gold calibration (EVAL-ONLY). Did the patched-resolved oracle
 * recognize the GOLD reference fix as resolved? A `falseNegative` oracle says
 * "not resolved" on a known-correct fix — so it would reject correct candidates,
 * and a resolved gate built on it must FAIL-OPEN. `falseNegative` rate is the
 * direct readout of the oracle's correctness (the verify-and-select bottleneck).
 * See `repro-oracle-calibration.ts`.
 */
export interface ReproOracleCalibration {
  goldCalibrated: boolean
  falseNegative: boolean
  available: boolean
  goldVotes: number | null
  goldK: number | null
}

/** Outcome of running one instance once. */
export interface InstanceResult {
  id: string
  passed: boolean
  /** Unified diff of the sandbox after the agent ran ("" if no change). */
  patch: string
  /** Agent turns consumed. */
  turns: number
  /** Present only on a harness-level failure (setup crash, timeout, etc.). */
  error?: string
  /**
   * Observation verdict (RFC-0002 §3/§8/§12). `"degraded"` ⇒ the trajectory
   * recorder failed under strict (eval) mode; `"env_prep_failed"` ⇒ T4
   * harness env pre-prep (setupCmd) failed BEFORE the agent ran;
   * `"grader_invalid"` ⇒ the selected verifier rejected the reference patch,
   * so the instance is not a fair measurement item. All non-`"ok"` verdicts are
   * EXCLUDED from `resolved/total` (the agent never got a fair shot). Absent
   * ⇒ `"ok"` (default-off runs never set this, preserving byte-identical
   * behavior).
   */
  verdict?: "ok" | "degraded" | "env_prep_failed" | "grader_invalid"
  /** Absolute path of the captured `.patch` file (only when observing). */
  patchPath?: string
  /** Wall-clock instance duration in ms (only when observing). */
  durationMs?: number
  /** Rolled-up token usage (only when observing and the LLM reported it). */
  usage?: InstanceUsage
  /**
   * Per-instance adaptive-timeout + retry budget (measurement-stability slice).
   * ABSENT (default) ⇒ neither adaptive nor retry ran (byte-identical path);
   * the report.json omits the field entirely. PRESENT ⇒ the driver applied
   * the knob-aware adaptive timeout and/or the transient-retry loop and is
   * recording the per-attempt history for after-the-fact analysis.
   *
   * `attempts === 1` and `attemptOutcomes.length === 1` is the standard
   * single-pass posture (no retry consumed). `baseTimeoutMs === adaptedTimeoutMs`
   * means no knob raised the budget — byte-identical to the pre-feature wall-clock.
   */
  budget?: BenchInstanceBudget
  /** Agentless repro-test generation/install telemetry. Omitted when the
   *  repro-test knob is off; present when the driver attempted the pipeline. */
  reproTest?: BenchReproTestTelemetry
  /**
   * T-202 — repo-relative path of the FIRST mutating edit observed on the
   * stream (not the final diff). Populated by the bench driver's first-edit
   * stream tap; ABSENT (default) ⇒ byte-identical report. Consumed offline by
   * the closure-diagnostics sidecar for `first_edit_owner_match`.
   */
  firstEditFile?: string
  /**
   * F6 — count of file-mutating tool_calls across the run (the #10914 churn
   * signal: many edits without resolution). Stream-tap populated, observe-only.
   */
  editCount?: number
  /**
   * F6 — 1-based turn index of the first mutating edit (localize latency: how
   * long the agent explored before committing to a file). Observe-only.
   */
  turnsToFirstEdit?: number
  /**
   * T-3 closure measurement (observe-only, knob-gated ⇒ byte-identical when off).
   * `primaryRailPresent`: a typed primary rail was selected for this run.
   * `requiredVerificationCovered`: the VerificationPlan has ≥1 required step
   * carrying a typed successPredicate. Consumed offline by closure-diagnostics for
   * `primary_rail_present_rate` / `required_verification_coverage`.
   */
  primaryRailPresent?: boolean
  requiredVerificationCovered?: boolean
  /**
   * T-3 OBSERVE-ONLY — the repair round that cleared (ok by exit code) had a typed
   * rail predicate that was evaluable AND mismatched: the `primary_false_green`
   * the predicate-aware gate (T-4) would have caught. Repair path only; absent ⇒
   * null (metric unavailable). Quantifies the value of turning the predicate into
   * a hard gate WITHOUT yet doing so (observe-first).
   */
  primaryFalseGreen?: boolean
  /**
   * jun-18 RCA OBSERVE-ONLY — a repair round's rail (exit-code) rejected a patch
   * the repro's OWN sentinel reports as resolved (false-RED). Drives
   * `primary_false_red_rate`: if high, the validator must gate on the repro
   * sentinel (its Agentless contract), not the incidental exit code — the
   * suspected cause of repair's wasteful churn (46→131 turns, 9→7). Repair only;
   * absent ⇒ null.
   */
  primaryFalseRed?: boolean
  /**
   * T-4 OBSERVE-ONLY — the gate decision was verify-first (true) vs commit-now
   * (false), computed from public signals. Drives `gate_enter_rate`. By default it
   * is telemetry-only; when the `primaryRail` closure path is enabled, the same
   * decision also chooses single-pass vs verify-first repair. Absent ⇒ null.
   */
  gateEntered?: boolean
  /**
   * T-4 OBSERVE-ONLY — the gate took the commit-now path instead of verify-first.
   * Drives `gate_bypass_rate`. Absent ⇒ null.
   */
  gateBypassed?: boolean
  /**
   * T-4/T-301 — number of repair/verify rounds actually consumed when the
   * verify-first path ran. Absent ⇒ null.
   */
  verifyRounds?: number
  /**
   * T-3/T-4 — the selected repro rail reproduced the bug on the unpatched base.
   * Offline-only measurement for `synth_repro_base_red_rate`.
   */
  synthReproBaseRed?: boolean
  /**
   * T-6 — patch touched files outside the admitted owner set. Telemetry-first:
   * exact diff fact only, never a semantic width judgment.
   */
  outOfScopeFiles?: boolean
  /**
   * T-401 — deterministic PatchHygieneReport over the final cumulative diff
   * (stray added files, owner-outside, file count). Computed only when the
   * `patch-hygiene` knob is on AND observing; ABSENT ⇒ byte-identical report.
   * Consumed offline by the closure-diagnostics sidecar (stray_file_rate /
   * out_of_scope_file_rate). Telemetry-first: emitting the report does NOT gate
   * the run — the deny path is a later measure-first step.
   */
  patchHygiene?: import("./eval/patch-hygiene").PatchHygieneReport
  /**
   * jun-19 — typed PatchBudget over the final diff (source/new-file/new-def/
   * cross-file vs owner). Emitted when the `patch-budget` knob is on AND observing;
   * ABSENT ⇒ byte-identical. Drives over_budget_rate / new_def_rate / cross_file_rate
   * (the #13417 over-engineer A/B). `withinBudget:false ⇒ escalate` is observe-only
   * here — the late-critic routing is a later measure-first step.
   */
  patchBudget?: import("@/agent/patch-budget").PatchBudgetVerdict
  /** jun-19 — official-grade regression-vs-didn't-fix breakdown (eval-only).
   *  Present only for swebench instances graded by the Python harness; absent
   *  ⇒ byte-identical report. Lets a campaign run self-measure how often our
   *  patches break PASS_TO_PASS (the regression-gate justification) with NO
   *  extra runs — see {@link GradeBreakdown}. */
  gradeBreakdown?: GradeBreakdown
  /** jun-20 — repro-oracle gold calibration (eval-only). Present only on a
   *  verify-select run with a gold patch; absent ⇒ byte-identical. Lets a
   *  campaign self-measure the resolved-oracle false-negative rate (the
   *  verify-and-select bottleneck) with NO extra runs — see {@link
   *  ReproOracleCalibration}. */
  reproOracleCalibration?: ReproOracleCalibration
  /**
   * T-301 — the typed VerificationPlan computed for this run (primaryRail +
   * required/optional steps + per-step successPredicate). Emitted only when the
   * `verification-plan` knob is on AND observing; ABSENT ⇒ byte-identical report.
   * Consumed offline by closure-diagnostics (primary_rail_present_rate /
   * success_predicate_present_rate). Telemetry-only — does not gate the run.
   */
  verificationPlan?: import("@/agent/verification-plan").VerificationPlan
  /**
   * T-201 — FaultEvidencePacket built from the agentless localizer's ranked
   * candidates (same pass, no extra LLM call). Emitted only when the
   * `fault-evidence` knob is on AND observing; ABSENT ⇒ byte-identical. Consumed
   * offline by closure-diagnostics for owner_recall@1/@3 (compared to gold owner
   * OFFLINE — no runtime leak). Telemetry-only.
   */
  faultEvidence?: import("@/agent/fault-evidence").FaultEvidencePacket
  /**
   * T-202 — OwnerAdmission decision over the FaultEvidencePacket (admit / sibling
   * coverage expectation). Emitted only when the `owner-admission` knob is on AND
   * observing. Feeds sibling_coverage_expected_rate / miss_rate. Telemetry-only.
   */
  ownerAdmission?: import("@/agent/owner-admission").OwnerAdmission
  /**
   * T-601 — RepairEscalationDecision (escalate to multi-owner / branch-search,
   * with a structured reason). Emitted only when the `repair-escalation` knob is
   * on AND observing. Telemetry-only — does NOT activate branch-search/subagent
   * (that behavioral wiring is a later measure-first step). ABSENT ⇒ byte-identical.
   */
  repairEscalation?: import("@/agent/repair-escalation").EscalationDecision
}

/** Structured per-attempt outcome shape echoed onto the report. Mirrors the
 *  `AttemptOutcome` union in `runner/batch/eval/retry-policy.ts` but lives
 *  here so consumers of `InstanceResult` don't need to import the eval
 *  sub-slice. Keeping it pure-data (no methods) preserves the JSON-serialise
 *  round-trip used by `writeReport`. */
export type BenchAttemptOutcome =
  | { kind: "pass" }
  | { kind: "empty-patch"; reason?: string }
  | { kind: "generation-fail"; reason: string }
  | { kind: "grader-invalid"; reason: string }
  | { kind: "timeout" }
  | {
      kind: "real-fail"
      subkind: "completed_unresolved" | "verify_loop_stuck" | "max_turns_exhausted"
    }
  | { kind: "infra-fail"; reason: string }

export interface BenchInstanceBudget {
  /** `deps.timeoutMs` as passed by the caller (pre-adaptation). */
  baseTimeoutMs: number
  /** `baseTimeoutMs * Σ(active knob costMultipliers)` clamped to 30 min.
   *  Equals `baseTimeoutMs` when no knob is active. */
  adaptedTimeoutMs: number
  /** Number of attempts actually consumed (1 = no retry). */
  attempts: number
  /** Per-attempt classified outcomes (length === attempts). */
  attemptOutcomes: BenchAttemptOutcome[]
}

/** One Best-of-N trajectory result. Generic so the sampler stays reusable. */
export interface Attempt {
  index: number
  /** Raw result, or undefined when the attempt threw. */
  result?: InstanceResult
  /** Set when the attempt threw; result is then undefined. */
  error?: string
}

/** Aggregate summary printed by the CLI. */
export interface BenchSummary {
  total: number
  resolved: number
  results: InstanceResult[]
}
