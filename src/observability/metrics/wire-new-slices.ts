/**
 * ADR-0217 — narrow-port adapter factories for the 4 new slices.
 *
 * Each factory takes a `MetricsRegistry` and returns an object that
 * satisfies the slice's narrow `*Metric` port. The slice never sees this
 * module (or `@/observability`); it imports only its own `metric-port.ts`
 * interface. Coupling is interface-only.
 *
 * Type imports for the slice port shapes are `import type` so the
 * compiled output has zero runtime dependency on the slices — the
 * observability plane stays the "leaf" w.r.t. these slices.
 */

import type { ErrorRoutingMetric } from "@/agent/error-routing/metric-port"
import type { GitDirectiveMetric } from "@/agent/git-directives/metric-port"
import type { StreamTimeoutMetric } from "@/agent/stream-timeout/metric-port"
import type { ShellSnapshotMetric } from "@/runtime/shell-snapshot/metric-port"
import {
  emitErrorAction,
  emitErrorKind,
  emitGitDirective,
  emitShellSnapshotCapture,
  emitStreamIdleMs,
  emitStreamTimeoutAction,
} from "./new-slice-instruments"
import type { MetricsRegistry } from "./port"

export const wireErrorRoutingMetric = (metrics: MetricsRegistry): ErrorRoutingMetric => ({
  recordClassified(kind): void {
    emitErrorKind(metrics, kind)
  },
  recordAction(action): void {
    emitErrorAction(metrics, action)
  },
})

export const wireStreamTimeoutMetric = (metrics: MetricsRegistry): StreamTimeoutMetric => ({
  recordIdle(ms): void {
    emitStreamIdleMs(metrics, ms)
  },
  recordAction(action): void {
    emitStreamTimeoutAction(metrics, action)
  },
})

export const wireShellSnapshotMetric = (metrics: MetricsRegistry): ShellSnapshotMetric => ({
  recordCapture(durationMs, bytes): void {
    emitShellSnapshotCapture(metrics, durationMs, bytes)
  },
})

export const wireGitDirectiveMetric = (metrics: MetricsRegistry): GitDirectiveMetric => ({
  recordDirective(kind): void {
    emitGitDirective(metrics, kind)
  },
})
