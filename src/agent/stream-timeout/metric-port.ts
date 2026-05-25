/**
 * ADR-0217 — narrow metric port for stream-timeout.
 *
 * Two-method port:
 *   - `recordIdle(ms)` — histogram observation of the idle interval that
 *     tripped the watchdog (or 0 when the wrap completed without firing).
 *   - `recordAction(action)` — counter of which `TimeoutAction` fired.
 *
 * Plane-clean: imports only the local `TimeoutAction` from `./types`.
 */

import type { TimeoutAction } from "./types"

export interface StreamTimeoutMetric {
  /** Record an idle-interval observation. No-throw. */
  recordIdle(ms: number): void
  /** Record which timeout action the watchdog took. No-throw. */
  recordAction(action: TimeoutAction): void
}
