/**
 * Public seam for `@/reactor` — ADR-0132 autonomous proactive reactor.
 *
 * Only ports + factory functions are exported. Internal helpers (snippet
 * clamps, in-memory stores) stay module-local; the composition root binds
 * the production adapters and passes them in.
 */

export { lastTurnOutcomeFromAgentOutcome } from "./agent-outcome-adapter"
export type {
  SelfWakeOpts,
  SelfWakeResult,
} from "./self-wake"
export { injectSimulatedTurn, QUIET_WINDOW_MS, REACTOR_ENV_FLAG } from "./self-wake"

export type {
  CiTriggerOpts,
  GhCliPort,
  GhCliResult,
  SeenRunsStore,
  SnapshotSeenRunsStore,
} from "./trigger-source-ci"
export { createCiTriggerSource, createInMemorySeenRuns } from "./trigger-source-ci"

export type {
  PrCommentTriggerOpts,
  WatermarkStore,
} from "./trigger-source-pr-comment"
export {
  createInMemoryWatermarkStore,
  createPrCommentTriggerSource,
} from "./trigger-source-pr-comment"
export type {
  AgentLoopPort,
  AutorunVerdict,
  ClockPort,
  EnvPort,
  LastTurnOutcome,
  ProactiveTrigger,
  ReactorSelfWakeEvent,
  TriggerEvidence,
  TriggerReason,
  TriggerSourcePort,
} from "./types"
export { ALL_TRIGGER_REASONS } from "./types"
