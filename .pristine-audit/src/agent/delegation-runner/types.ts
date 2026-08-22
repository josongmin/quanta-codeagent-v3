/**
 * Default delegation-runner types (ADR-0283).
 *
 * `DelegateSpec` is the input the host hands to {@link TypedDelegationRunner}.
 * `RunnerError` is the CLOSED 5-arm union returned for every operational
 * failure — the runner NEVER throws past the port surface.
 *
 * Plane-clean: this file imports only from sibling slices (`@/agent/subagent-typed`)
 * for the `AgentMode` type alias. No `@/agent/loop`, no `@/agent/dispatch`,
 * no `@/llm`, no `@/tool`.
 *
 * exactOptionalPropertyTypes — every optional field is OMITTED when absent
 * rather than spread as `undefined`.
 */

import type { AgentMode } from "@/agent/subagent-typed"

/** Closed 5-arm error union for the default runner. The host branches on
 *  `kind`; there is no prose parsing path. Adding a new arm forces a
 *  compile-time exhaustiveness update at every consumer (the dispatch
 *  table in `default-runner.ts` + every catch site).
 *
 *  5 arms:
 *   - `spec-invalid`       — caller-supplied {@link DelegateSpec} failed shape
 *                            validation (empty prompt, unknown mode, malformed
 *                            budget). NO spawn happens.
 *   - `spawn-failed`       — the runner could not construct a child agent
 *                            instance (resource exhaustion, missing wire).
 *   - `child-threw`        — the child agent uncaught-threw. The error is
 *                            wrapped and surfaced via this arm so the parent
 *                            sees a typed result, not a thrown exception.
 *   - `depth-exceeded`     — the requested delegation depth ≥ {@link MAX_DEPTH}.
 *                            Prevents runaway recursion when a child also
 *                            delegates.
 *   - `aborted`            — the parent's `signal` fired before / during the
 *                            child run. The boomerang carries this kind. */
export type RunnerErrorKind =
  | "spec-invalid"
  | "spawn-failed"
  | "child-threw"
  | "depth-exceeded"
  | "aborted"

/** Closed shape of every operational failure. `message` is FREE-FORM prose
 *  the host MAY surface; branching uses `kind` ONLY. */
export interface RunnerError {
  readonly kind: RunnerErrorKind
  readonly message: string
  /** Optional carry-through of the underlying error (for child-threw). */
  readonly cause?: unknown
}

/** Canonical literal tuple for runtime guards + tests. */
export const ALL_RUNNER_ERROR_KINDS = [
  "spec-invalid",
  "spawn-failed",
  "child-threw",
  "depth-exceeded",
  "aborted",
] as const satisfies readonly RunnerErrorKind[]
// Two-way drift guard (satisfies = array⊆union; Assert = union⊆array). A new
// RunnerErrorKind missing from this tuple is a build error.
type _AssertRunner<T extends true> = T
export type _RunnerErrorKindsDriftGuard = _AssertRunner<
  RunnerErrorKind extends (typeof ALL_RUNNER_ERROR_KINDS)[number] ? true : false
>

/** Hard cap on delegation depth. A child that delegates again sees `depth=1`
 *  on its spec; the third level (`depth=2`) is the LAST allowed — `depth=3`
 *  returns `Err("depth-exceeded")`. The cap is hard-coded by design: the
 *  default runner is a stub used in tests + as a safe production fallback;
 *  hosts that need deeper recursion ship their own runner. */
export const MAX_DEPTH = 3

/** The 5 modes the spec accepts — mirrors the closed `AgentMode` union from
 *  `@/agent/subagent-typed/port.ts` so the runner does not need its own
 *  enum. Re-exported here so consumers can import a single name from this
 *  slice's barrel. */
export type DelegateMode = AgentMode

/** Caller input handed to {@link TypedDelegationRunner}. The mode + prompt
 *  are REQUIRED. `budget` / `signal` / `depth` / `correlation` are OPT-IN. */
export interface DelegateSpec {
  /** Closed `AgentMode` from `@/agent/subagent-typed`. */
  readonly mode: DelegateMode
  /** Non-empty prompt — empty string ⇒ `Err("spec-invalid")`. */
  readonly prompt: string
  /** Optional per-call budget cap. Both fields must be finite + positive
   *  when present; invalid ⇒ `Err("spec-invalid")`. */
  readonly budget?: {
    readonly maxTurns?: number
    readonly maxTokens?: number
  }
  /** Optional parent `AbortSignal`. Already-aborted at call ⇒ `Err("aborted")`
   *  with no spawn. Aborted DURING run ⇒ `Err("aborted")` after graceful
   *  unwind. */
  readonly signal?: AbortSignal
  /** Current recursion depth. The PARENT sets `depth=0`; the child sets
   *  `depth=1`. {@link MAX_DEPTH} bounds the chain. */
  readonly depth?: number
  /** Optional opaque correlation map for tracing. Pure passthrough. */
  readonly correlation?: Readonly<Record<string, string>>
}
