/**
 * Focus Chain slice barrel (ADR-0219).
 *
 * Closed surface for automatic N-turn todo-list re-injection + drift
 * detection. Default-OFF: the loop never constructs a tracker; callers
 * (apps / tier1 builders / future CLI command) opt in by wiring through
 * AgentConfig. Voice match: ADR-0130 (BG scheduler) — types + factory the
 * host composes.
 */

export {
  type DefaultTrackerOpts,
  defaultFocusChainTracker,
} from "./default-tracker"
export {
  type DriftState,
  formatDriftWarning,
  isDrifting,
} from "./drift-detector"
export type {
  FocusChainPort,
  FocusTodo,
} from "./port"
export {
  renderTodos,
  sanitizeTodo,
} from "./todo-injector"
