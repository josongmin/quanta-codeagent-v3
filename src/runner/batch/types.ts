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
