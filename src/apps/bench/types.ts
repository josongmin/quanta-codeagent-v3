/**
 * Bench domain types — SWE-bench-style harness + Best-of-N sampler.
 *
 * This is an app-composition concern (RFC §4 apps/bench, §13 Q4): the bench
 * app assembles existing slices, it does not introduce a new slice. Types here
 * are local to the app and intentionally minimal.
 */

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
