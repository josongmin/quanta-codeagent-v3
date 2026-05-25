/**
 * ADR-0217 — pass-through default for the stream-timeout metric port.
 *
 * Frozen no-op (HELL-OT-03).
 */

import type { StreamTimeoutMetric } from "./metric-port"

export const noopStreamTimeoutMetric: StreamTimeoutMetric = Object.freeze({
  recordIdle(): void {
    // intentional: no-op preserves default-OFF byte-identical behaviour
  },
  recordAction(): void {
    // intentional: no-op preserves default-OFF byte-identical behaviour
  },
})
