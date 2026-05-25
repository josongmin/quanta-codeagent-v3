/**
 * ADR-0222 — narrow-port adapter factories for the 4 new slices.
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

/** Aggregate of the 4 new-slice metric ports (ADR-0222) wired against the
 *  same {@link MetricsRegistry}. Composition roots use this single-call
 *  helper so a 5-wire pass against the metric pipeline stays a 1-liner per
 *  slice (the slice's port factory takes one of the returned fields).
 *
 *  Each field is the same shape the slice expects via its narrow
 *  `metric-port.ts`; passing the SAME `metrics` for all four routes the
 *  emissions through the canonical `new-slice-instruments.ts` table so the
 *  vocabulary axis (ADR-0144 `QUANTA_ATTRS`) stays unified.
 *
 *  Default-OFF posture is owned by the SLICE: a slice that does not wire
 *  any of these fields (passes its `noop*Metric` instead) is byte-identical
 *  to legacy. The helper itself allocates 4 small objects (no I/O), so a
 *  caller that uses NONE of the fields can ignore the return value at
 *  zero cost. */
export interface NewSliceMetricsBundle {
  readonly errorRouting: ErrorRoutingMetric
  readonly streamTimeout: StreamTimeoutMetric
  readonly shellSnapshot: ShellSnapshotMetric
  readonly gitDirective: GitDirectiveMetric
}

export const wireNewSlices = (metrics: MetricsRegistry): NewSliceMetricsBundle => ({
  errorRouting: wireErrorRoutingMetric(metrics),
  streamTimeout: wireStreamTimeoutMetric(metrics),
  shellSnapshot: wireShellSnapshotMetric(metrics),
  gitDirective: wireGitDirectiveMetric(metrics),
})
