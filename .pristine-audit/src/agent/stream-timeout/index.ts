/**
 * ADR-0200 — Stream idle/total timeout watchdog barrel.
 *
 * Closed-port primitive: idle + total wall-clock guard around an async
 * iterable + decoupled snooze controller. Default-OFF — callers opt in
 * by wiring a non-no-op watchdog + a policy with at least one axis.
 */
export { createDefaultWatchdog, type DefaultWatchdogOpts } from "./default-watchdog"
export { noOpWatchdog } from "./no-op-watchdog"
export type { StreamWatchdog } from "./port"
export { createSnoozeController, type SnoozeController, type SnoozeOpts } from "./snooze"
export {
  StreamAbortError,
  StreamIdleError,
  StreamTotalError,
  type TimeoutAction,
  type TimeoutPolicy,
} from "./types"
