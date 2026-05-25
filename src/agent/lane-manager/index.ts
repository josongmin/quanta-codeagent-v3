/**
 * Parallel lane-manager slice barrel (ADR-0285).
 *
 * `Promise.allSettled`-shaped aggregation of N child agent lanes with
 * `AbortSignal` cascade, `maxConcurrency` cap, and per-call `awaitAll`
 * timeout. Default-OFF: surfaces opt in by wiring through `AgentConfig`.
 */

export {
  type DefaultLaneManagerOpts,
  defaultLaneManager,
} from "./default-manager"
export type { LaneManager } from "./port"
export {
  ALL_LANE_ERROR_KINDS,
  DEFAULT_MAX_CONCURRENCY,
  type LaneError,
  type LaneErrorKind,
  type LaneHandle,
  type LaneResult,
  type LaneSpec,
} from "./types"
