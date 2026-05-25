/**
 * ADR-0217 — pass-through default for the git-directives metric port.
 *
 * Frozen no-op (HELL-OT-03).
 */

import type { GitDirectiveMetric } from "./metric-port"

export const noopGitDirectiveMetric: GitDirectiveMetric = Object.freeze({
  recordDirective(): void {
    // intentional: no-op preserves default-OFF byte-identical behaviour
  },
})
