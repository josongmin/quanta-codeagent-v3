/**
 * ADR-0222 — narrow metric port for git-directives.
 *
 * Single-method port: `recordDirective(kind)` — fired by an instrumented
 * emitter once per successful directive emit. Maps to a counter on
 * `quanta.git.directive` keyed by the 5-arm `GitDirectiveKind`.
 *
 * Plane-clean: imports only the local kind tuple. The slice never imports
 * `@/observability`.
 */

import type { GitDirectiveKind } from "./types"

export interface GitDirectiveMetric {
  /** Record that a directive of `kind` was emitted. No-throw. */
  recordDirective(kind: GitDirectiveKind): void
}
