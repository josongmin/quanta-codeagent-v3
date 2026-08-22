/**
 * ADR-0222 — pass-through default for the error-routing metric port.
 *
 * Frozen object literal; both methods are no-ops. Wired wherever the host
 * has not opted in to telemetry — keeps the call sites byte-identical to
 * pre-ADR-0222 behaviour (HELL-OT-03).
 */

import type { ErrorRoutingMetric } from "./metric-port"

export const noopErrorRoutingMetric: ErrorRoutingMetric = Object.freeze({
  recordClassified(): void {
    // intentional: no-op preserves default-OFF byte-identical behaviour
  },
  recordAction(): void {
    // intentional: no-op preserves default-OFF byte-identical behaviour
  },
})
