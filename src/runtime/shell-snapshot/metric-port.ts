/**
 * ADR-0217 — narrow metric port for shell-snapshot.
 *
 * Single-method port: `recordCapture(durationMs, bytes)` — one event per
 * persisted snapshot. Both arguments map 1:1 to histogram observations on
 * `quanta.shell.snapshot_duration_ms` / `quanta.shell.snapshot_bytes`.
 *
 * Plane-clean: zero imports. The slice never imports `@/observability`;
 * the adapter at `@/observability/metrics/wire-new-slices` returns an
 * object satisfying this interface.
 */

export interface ShellSnapshotMetric {
  /** Record one capture event. Both arguments are histogram observations.
   *  Non-finite / negative values are silently coerced to 0 at the adapter
   *  boundary so a poisoned caller cannot poison the registry. No-throw. */
  recordCapture(durationMs: number, bytes: number): void
}
