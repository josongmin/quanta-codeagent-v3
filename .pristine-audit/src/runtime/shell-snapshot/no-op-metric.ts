/**
 * ADR-0222 — pass-through default for the shell-snapshot metric port.
 *
 * Frozen object literal; `recordCapture` is a no-op. Wired wherever the
 * host has not opted in to telemetry (HELL-OT-03).
 */

import type { ShellSnapshotMetric } from "./metric-port"

export const noopShellSnapshotMetric: ShellSnapshotMetric = Object.freeze({
  recordCapture(): void {
    // intentional: no-op preserves default-OFF byte-identical behaviour
  },
})
