/**
 * Parallel lane-manager port (ADR-0285).
 *
 * Closed-port DI seam. `LaneManager` exposes 2 surfaces:
 *
 *   - `spawnLane(spec)` — start ONE child lane and return a handle.
 *     Idempotent: same spec twice ⇒ two independent lanes.
 *   - `awaitAll(handles, timeoutMs?)` — block until every handle settles
 *     (success / failure / timeout). Returns results in HANDLE ORDER
 *     (input position, not completion order) so the caller can correlate
 *     by index without reading `.id`.
 *
 * Plane-clean: imports only sibling type aliases. NO `@/agent/loop`,
 * NO `@/agent/dispatch`, NO `@/llm`, NO `@/tool`.
 *
 * Default-OFF: the loop never constructs a manager; surfaces (apps /
 * future `/lanes` slash) opt in by wiring one through `AgentConfig`.
 *
 * Contracts (5):
 *   1. NO-THROW on the public surface — every lane-level failure surfaces
 *      as `LaneResult { ok:false, error:... }`.
 *   2. ORDER PRESERVATION — `awaitAll(handles)` returns one result per
 *      handle, IN THE SAME ORDER as `handles` (NOT completion order).
 *   3. CASCADE — when the parent's lane-manager signal aborts, every
 *      in-flight lane is force-cancelled and surfaces `error.kind="aborted"`.
 *   4. CONCURRENCY CAP — `spawnLane` respects `maxConcurrency`; over-cap
 *      requests either QUEUE (the default) or surface
 *      `error.kind="concurrency-exceeded"` if the manager was constructed
 *      with `queueMode:"reject"`.
 *   5. ISOLATION — failure in one lane has NO effect on sibling lanes
 *      (Promise.allSettled-style aggregation).
 */

import type { LaneHandle, LaneResult, LaneSpec } from "./types"

export interface LaneManager {
  /** Spawn a lane. Returns a handle that the caller passes to `awaitAll`. */
  spawnLane(spec: LaneSpec): LaneHandle
  /** Await every handle. Returns results in the order of `handles`.
   *  `timeoutMs` (when present) caps the TOTAL wait — a lane still running
   *  past the cap surfaces `error.kind="timeout"`. Already-settled lanes
   *  return their stored outcome regardless. */
  awaitAll(
    handles: ReadonlyArray<LaneHandle>,
    timeoutMs?: number,
  ): Promise<ReadonlyArray<LaneResult>>
}
