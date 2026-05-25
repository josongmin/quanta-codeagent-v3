/**
 * Parallel lane-manager types (ADR-0285).
 *
 * `LaneSpec` describes ONE child run; `LaneHandle` is the opaque reference
 * returned by `spawnLane`; `LaneResult` is the per-lane outcome; `LaneError`
 * is the CLOSED 4-arm union.
 *
 * Plane-clean: imports only `@/agent/delegation-runner` (for the
 * `DelegateSpec` shape) + `@/agent/subagent-typed` (for the boomerang shape).
 * No `@/agent/loop`, no `@/agent/dispatch`, no `@/llm`, no `@/tool`.
 *
 * exactOptionalPropertyTypes — every optional field is OMITTED when absent.
 */

import type { DelegateSpec } from "@/agent/delegation-runner"
import type { BoomerangResult } from "@/agent/subagent-typed"

/** Closed 4-arm error union for the lane manager.
 *
 *   - `spawn-failed`        — could not start the lane (resource exhaustion
 *                             OR no runner wired). The lane has NO boomerang.
 *   - `timeout`             — the lane exceeded `awaitAll(handles, timeoutMs)`.
 *                             The lane is force-cancelled; any partial
 *                             boomerang is dropped.
 *   - `aborted`             — the parent's lane-manager signal fired OR a
 *                             parent cascade aborted the lane.
 *   - `concurrency-exceeded`— `spawnLane` called past the configured
 *                             `maxConcurrency` AND the lane could not be
 *                             queued (deferred + saturated). Default cap is
 *                             {@link DEFAULT_MAX_CONCURRENCY}. */
export type LaneErrorKind = "spawn-failed" | "timeout" | "aborted" | "concurrency-exceeded"

/** Closed shape of every lane-level failure. */
export interface LaneError {
  readonly kind: LaneErrorKind
  readonly message: string
  /** Optional carry-through of the underlying error (for spawn-failed). */
  readonly cause?: unknown
}

/** Canonical literal tuple for runtime guards + tests. */
export const ALL_LANE_ERROR_KINDS = ["spawn-failed", "timeout", "aborted", "concurrency-exceeded"] as const

/** Default `maxConcurrency` cap. Overridable via `QUANTA_LANE_MAX_CONCURRENCY`
 *  at the composition root or via the `defaultLaneManager({ maxConcurrency })`
 *  factory opt. The cap exists to bound resource pressure when a host spawns
 *  many lanes from a Promise.all loop. */
export const DEFAULT_MAX_CONCURRENCY = 5

/** One lane request handed to {@link LaneManager.spawnLane}. Wraps the
 *  closed {@link DelegateSpec} shape from the delegation-runner slice. */
export interface LaneSpec {
  /** The child agent spec (mode + prompt + budget + correlation). */
  readonly delegate: DelegateSpec
  /** Optional human label for trace / observability. Pure passthrough. */
  readonly label?: string
}

/** Opaque handle returned by `spawnLane`. Caller passes a list of handles
 *  to `awaitAll` to collect outcomes. The handle is the SOLE thing that
 *  crosses out of the manager (no other lane state leaks). */
export interface LaneHandle {
  /** Stable id minted at spawn time (lane-XXX counter). Useful for trace. */
  readonly id: string
  /** Echo of the spec for diagnostics. */
  readonly spec: LaneSpec
  /** Internal promise — consumers call `awaitAll(handles)`, not `handle.promise`,
   *  so this field stays read-only for the host. Exported for type clarity. */
  readonly promise: Promise<LaneResult>
}

/** Per-lane outcome shape. The closed `ok` discriminant flips between a
 *  success (with the underlying `boomerang` from the delegation slice) and
 *  a failure (with a typed {@link LaneError}). Both shapes include the
 *  originating `LaneHandle.id` so the caller can correlate. */
export type LaneResult =
  | {
      readonly id: string
      readonly ok: true
      readonly boomerang: BoomerangResult
      readonly label?: string
      readonly durationMs: number
    }
  | {
      readonly id: string
      readonly ok: false
      readonly error: LaneError
      readonly label?: string
      readonly durationMs: number
    }
