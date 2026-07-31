/** RFC-09 (A) — completion-notify leaf barrel. Surface-only: NO `@/agent`,
 *  `@/llm`, `@/stream` imports (mirrors the turn-indicator slice fence). */

export { resolveNotifyChannel } from "./notify-enabled"
export {
  createOscNotificationPort,
  type NotifyChannel,
  type OscNotifyDeps,
  sanitizeTitle,
} from "./osc-adapter"
export type { IdleInfo, NotificationPort, PushStats, TurnCompleteInfo } from "./port"
export { computePresence, type PresenceSignals } from "./presence-decision"
export {
  type PushDecision,
  type PushDecisionInput,
  type PushDisabledReason,
  shouldPush,
} from "./push-decision"
