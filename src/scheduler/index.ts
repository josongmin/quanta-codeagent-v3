/**
 * ADR-0161 — Scheduled agent slice barrel.
 *
 * Re-exports the closed-port types, parsers, evaluator, store, model reroute,
 * and runtime. Importers MUST go through this barrel; reaching into
 * `@/scheduler/*` deep paths is allowed for adapter wiring but not for the
 * public API contract.
 *
 * Default-OFF: importing this barrel does NOT instantiate a scheduler. The
 * runtime only fires when the composition root calls `start()`.
 */

export type { CreateAutomationInput } from "./automation"
// Automation lifecycle
export {
  createAutomation,
  isFireEligible,
  markError,
  recordFire,
  transitionStatus,
} from "./automation"
export type { ChooseModelOpts, ChooseModelResult, ModelRerouteReason } from "./model-reroute"
// Model reroute
export { chooseModel } from "./model-reroute"
// Evaluator
export { computeNextFire, iterateFires } from "./next-fire"
export type { RRuleParseResult } from "./rrule-parser"
// Parser
export { parseRRule, serializeRRule } from "./rrule-parser"
export type { SchedulerRuntime, SchedulerRuntimeOpts } from "./runtime"
// Runtime
export {
  createSchedulerRuntime,
  DEFAULT_TICK_INTERVAL_MS,
  SCHEDULER_ENV_FLAG,
} from "./runtime"
export type { JsonlAutomationStoreOpts } from "./store-jsonl"
// JSONL store
export { defaultJsonlAutomationStore } from "./store-jsonl"
// Types
export type {
  AgentLoopPort,
  Automation,
  AutomationStatus,
  AutomationStorePort,
  ClockPort,
  EnvPort,
  Frequency,
  ModelAvailabilityPort,
  RRule,
  RRuleParseError,
  RRuleParseErrorCode,
  SchedulerEvent,
  SchedulerSinkPort,
  Weekday,
  WeekdayDay,
} from "./types"
export {
  ALL_AUTOMATION_STATUSES,
  ALL_FREQUENCIES,
  ALL_WEEKDAYS,
  AutomationStoreError,
} from "./types"
// Weekday
export {
  allOccurrencesInMonth,
  daysInUtcMonth,
  nthWeekdayOfMonth,
  parseWeekday,
  serializeWeekday,
} from "./weekday"
