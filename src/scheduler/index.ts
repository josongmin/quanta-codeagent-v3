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

// Types
export type {
  Frequency,
  WeekdayDay,
  Weekday,
  RRule,
  RRuleParseError,
  RRuleParseErrorCode,
  AutomationStatus,
  Automation,
  AutomationStorePort,
  ClockPort,
  EnvPort,
  ModelAvailabilityPort,
  AgentLoopPort,
  SchedulerEvent,
  SchedulerSinkPort,
} from "./types"

export {
  ALL_FREQUENCIES,
  ALL_WEEKDAYS,
  ALL_AUTOMATION_STATUSES,
  AutomationStoreError,
} from "./types"

// Parser
export { parseRRule, serializeRRule } from "./rrule-parser"
export type { RRuleParseResult } from "./rrule-parser"

// Weekday
export {
  parseWeekday,
  serializeWeekday,
  nthWeekdayOfMonth,
  allOccurrencesInMonth,
  daysInUtcMonth,
} from "./weekday"

// Evaluator
export { computeNextFire, iterateFires } from "./next-fire"
