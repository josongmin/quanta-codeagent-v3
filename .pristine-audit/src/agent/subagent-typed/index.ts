/**
 * Mode-typed delegation slice barrel (ADR-0218).
 *
 * Closed surface for parent→child mode-typed handoff with isolated context.
 * Default-OFF: the loop never constructs a router; callers (apps / tier1
 * builders / future CLI) opt in by wiring through AgentConfig. Voice match:
 * ADR-0130 (BG scheduler) — both slices ship as types + factories the host
 * composes.
 */

export {
  failureBoomerang,
  successBoomerang,
} from "./boomerang"
export {
  type DelegationRouterOpts,
  defaultDelegationRouter,
  type TypedDelegationRunner,
  type TypedRunnerInput,
  type TypedRunnerOutcome,
  wrapSubagentRunner,
} from "./delegation-router"
export {
  chainParentSignal,
  makeChildCorrelation,
} from "./isolated-context"
export {
  ALL_MODE_KEYS,
  DEFAULT_MODE_REGISTRY,
  lookupModeProfile,
} from "./mode-registry"
export {
  AGENT_MODES,
  type AgentMode,
  assertKnownMode,
  type BoomerangErrorKind,
  type BoomerangResult,
  type DelegationPort,
  type DelegationRequest,
  type ModeProfile,
  UnknownModeError,
} from "./port"
