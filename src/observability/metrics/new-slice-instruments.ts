/**
 * ADR-0217 — emit helpers for the 4 new slices.
 *
 * Six pure functions, one per canonical metric, that look up the key from
 * `QUANTA_ATTRS` and dispatch to a `MetricsRegistry`. The helpers live in
 * the observability plane so the slice never references a `quanta.*`
 * literal — Wave-D's vocabulary orphan scan keeps passing.
 *
 * Each helper:
 *   - swallows any error from `metrics.increment`/`observe` (defense in
 *     depth — the registry already no-throws, but a misbehaving sink
 *     could surface here);
 *   - sanitises non-finite / negative histogram values to 0 (counters do
 *     not accept a delta — the registry's own coercion handles it);
 *   - never reads from any global.
 */

import { QUANTA_ATTRS } from "@/observability/vocabulary"
import type { MetricsRegistry } from "./port"

const safe = (fn: () => void): void => {
  try {
    fn()
  } catch {
    /* metrics emission must never break the wrapped call */
  }
}

const sanitizeNonNegative = (n: number): number => {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* error-routing                                                               */
/* ──────────────────────────────────────────────────────────────────────────── */

export const emitErrorKind = (metrics: MetricsRegistry, kind: string): void => {
  safe(() => metrics.increment(QUANTA_ATTRS.error.kind, 1, { kind }))
}

export const emitErrorAction = (metrics: MetricsRegistry, action: string): void => {
  safe(() => metrics.increment(QUANTA_ATTRS.error.action, 1, { action }))
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* stream-timeout                                                              */
/* ──────────────────────────────────────────────────────────────────────────── */

export const emitStreamIdleMs = (metrics: MetricsRegistry, ms: number): void => {
  safe(() => metrics.observe(QUANTA_ATTRS.stream.idleMs, sanitizeNonNegative(ms)))
}

export const emitStreamTimeoutAction = (metrics: MetricsRegistry, action: string): void => {
  safe(() => metrics.increment(QUANTA_ATTRS.stream.timeoutAction, 1, { action }))
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* shell-snapshot                                                              */
/* ──────────────────────────────────────────────────────────────────────────── */

export const emitShellSnapshotCapture = (
  metrics: MetricsRegistry,
  durationMs: number,
  bytes: number,
): void => {
  safe(() =>
    metrics.observe(QUANTA_ATTRS.shell.snapshotDurationMs, sanitizeNonNegative(durationMs)),
  )
  safe(() => metrics.observe(QUANTA_ATTRS.shell.snapshotBytes, sanitizeNonNegative(bytes)))
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* git-directives                                                              */
/* ──────────────────────────────────────────────────────────────────────────── */

export const emitGitDirective = (metrics: MetricsRegistry, kind: string): void => {
  safe(() => metrics.increment(QUANTA_ATTRS.git.directive, 1, { kind }))
}
