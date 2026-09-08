/**
 * ADR-0215 — Automation engine barrel.
 *
 * Re-exports the closed port + in-memory + sqlite adapters + the pure
 * ticker. The barrel is the only allowed import path.
 *
 * Default-OFF: importing the barrel does NOT open a connection or schedule
 * anything. The host wires an adapter and calls `tickScheduler` on its own
 * cadence.
 */

export type { InMemoryAutomationEngine, InMemoryAutomationEngineOpts } from "./in-memory"
export { inMemoryAutomationEngine } from "./in-memory"
export type {
  AutomationEnginePort,
  AutomationRun,
  ClaimedRun,
  ClaimOpts,
  EngineAutomation,
  EngineErrorResult,
  EngineResult,
  EngineStatus,
  FinalizeInput,
  InboxItem,
  MarkRunInput,
  ScheduleInput,
} from "./port"
export { ALL_ENGINE_STATUSES } from "./port"

export type { SqliteAutomationEngineOpts } from "./sqlite"
export {
  ensureAutomationEngineSchema,
  listAutomationRuns,
  listInboxItems,
  sqliteAutomationEngine,
} from "./sqlite"

export type {
  AutomationHandler,
  InboxBuilder,
  TickEligibilityVerdict,
  TickOpts,
  TickOutcome,
} from "./ticker"
export { DEFAULT_CLAIM_RECLAIM_MS, DEFAULT_CLAIM_RENEW_MS, tickScheduler } from "./ticker"
