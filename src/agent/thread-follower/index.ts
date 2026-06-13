/**
 * Thread-follower co-control protocol (T02) — public barrel.
 *
 * See {@link ./types} for the pure verb→effect planner + the HARD_DENY relay
 * guard, and {@link ./timeout} for the request/response/timeout (stale-decision)
 * discipline. DEFAULT-OFF behind the existing `QUANTA_THIN_CLIENT_DISPATCH` gate.
 */

export {
  type FollowerVerbEnvelope,
  FollowerVerbTracker,
  type ResolveOutcome,
  type StaleReason,
  type TimedOutVerb,
} from "./timeout"
export {
  ALL_FOLLOWER_VERB_KINDS,
  FOLLOWER_CO_CONTROL_FLAG,
  type FollowerApprovalDecision,
  type FollowerEffect,
  type FollowerPlanContext,
  type FollowerVerb,
  isFollowerCoControlEnabled,
  planFollowerVerb,
} from "./types"
