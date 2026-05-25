/**
 * Bench domain types — SWE-bench-style harness + Best-of-N sampler.
 *
 * This is an app-composition concern (RFC §4 apps/bench, §13 Q4): the bench
 * app assembles existing slices, it does not introduce a new slice. Types here
 * are local to the app and intentionally minimal.
 */

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
   * harness env pre-prep (setupCmd) failed BEFORE the agent ran. Both are
   * EXCLUDED from `resolved/total` (the agent never got a fair shot). Absent
   * ⇒ `"ok"` (default-off runs never set this, preserving byte-identical
   * behavior).
   */
  verdict?: "ok" | "degraded" | "env_prep_failed"
  /** Absolute path of the captured `.patch` file (only when observing). */
  patchPath?: string
  /** Wall-clock instance duration in ms (only when observing). */
  durationMs?: number
  /** Rolled-up token usage (only when observing and the LLM reported it). */
  usage?: InstanceUsage
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
