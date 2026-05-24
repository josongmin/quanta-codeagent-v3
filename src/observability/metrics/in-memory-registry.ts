/**
 * In-memory MetricsRegistry adapter (ADR-0144).
 *
 * Pure in-memory book of `Map<seriesKey, Accumulator>` where `seriesKey`
 * combines the metric name with a JSON-stable serialization of the label set.
 * Counters monotonically sum; gauges latest-write-wins; histograms retain
 * observations in insertion order and compute nearest-rank p50 / p95 / p99 on
 * snapshot.
 *
 * Contract (6):
 *   1. PURE STORE: in-memory only, 0 I/O. The optional `MetricSink` is the
 *      ONLY transport — when absent, the registry is a snapshot-only
 *      primitive (per ADR Default-OFF posture).
 *   2. NAME COMMITS TO KIND on first use. Calling `increment("foo")` after
 *      `gauge("foo", 5)` throws `MetricsError("name-mismatch-kind")` — a
 *      programmer bug (two unrelated subsystems collided on the same metric
 *      name). Labels do NOT affect the kind commitment — `foo{a=1}` and
 *      `foo{a=2}` share the same kind.
 *   3. SINK NO-THROW: `sink.send` is wrapped in try/catch; a throwing sink
 *      logs nothing (the registry is part of the observability plane — a
 *      misbehaving exporter must not crash the agent). The registry itself
 *      still records the sample.
 *   4. NEGATIVE / NON-FINITE INPUT coerces to 0. A poisoned caller value
 *      cannot poison the registry (same posture as `BudgetMeter.tick`).
 *      Counter `increment("x", -5)` is a no-op; histogram observation of
 *      `NaN` is dropped.
 *   5. PERCENTILES via nearest-rank on a sorted ascending copy. Cheap (one
 *      sort per snapshot) and correct enough at our scales (turns,
 *      tool-calls, latencies — never millions of observations per series).
 *      `histogramBuckets` is reserved for a future bucketed-exposition
 *      implementation; today it is recorded for parity with Prometheus
 *      semantics but is not used to compute the snapshot (the comment in
 *      the test suite documents the trade-off).
 *   6. LABELS sorted lexicographically when forming the series key so
 *      `{a:1,b:2}` and `{b:2,a:1}` share one time-series. Empty / missing
 *      labels normalize to `{}` — the snapshot row always carries a
 *      (possibly empty) frozen labels object.
 */

import type { MetricKind, MetricSample, MetricSink, MetricSnapshot, MetricsRegistry } from "./port"
import { MetricsError } from "./port"

export interface InMemoryRegistryOpts {
  /** Wire a sink to export every sample. Absent ⇒ snapshot-only (no export). */
  readonly sink?: MetricSink
  /** Injected clock for `at` timestamps. Default `Date.now`. */
  readonly now?: () => number
  /** Bucket boundaries (ms) reserved for a future bucketed exposition. The
   *  current adapter ignores them — percentiles come from nearest-rank on
   *  the observation array — but they are validated for shape so a caller
   *  can wire OTel later without surface churn. Default
   *  `[1, 10, 100, 1000, 10000]`. */
  readonly histogramBuckets?: ReadonlyArray<number>
}

const DEFAULT_BUCKETS: ReadonlyArray<number> = Object.freeze([1, 10, 100, 1000, 10_000])

/** Normalize a (possibly undefined) labels object to a frozen, sort-stable
 *  shape so the registry hashes and snapshot rows agree on the key. */
const normLabels = (
  labels: Record<string, string> | undefined,
): Readonly<Record<string, string>> => {
  if (labels === undefined) return Object.freeze({})
  const keys = Object.keys(labels).sort()
  const out: Record<string, string> = {}
  for (const k of keys) {
    const v = labels[k]
    if (typeof v === "string") out[k] = v
  }
  return Object.freeze(out)
}

/** Stable string form of a normalized label object. JSON.stringify on a
 *  sorted-key object is stable (Object.keys preserves insertion order). */
const labelKey = (labels: Readonly<Record<string, string>>): string => JSON.stringify(labels)

/** Series key = `kind|name|labels`. Including kind would make the
 *  name-mismatch-kind error impossible (the two series would coexist), so we
 *  deliberately key on `name|labels` and look up kind separately. */
const seriesKey = (name: string, labels: Readonly<Record<string, string>>): string =>
  `${name}|${labelKey(labels)}`

/** Nearest-rank percentile on a sorted ascending sample. Returns 0 for empty. */
const percentile = (sortedAsc: ReadonlyArray<number>, p: number): number => {
  const n = sortedAsc.length
  if (n === 0) return 0
  const rank = Math.ceil((p / 100) * n)
  const idx = Math.min(Math.max(rank, 1), n) - 1
  return sortedAsc[idx] ?? 0
}

/** Coerce non-finite / negative numbers to 0 (counters/histograms). Gauges
 *  accept negative — they are point-in-time values that may legitimately
 *  go below zero (e.g. "free disk delta"). */
const sanitizePositive = (v: number): number => {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v
}

const sanitizeGauge = (v: number): number => (Number.isFinite(v) ? v : 0)

interface CounterAcc {
  readonly kind: "counter"
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  total: number
}

interface GaugeAcc {
  readonly kind: "gauge"
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  value: number
}

interface HistogramAcc {
  readonly kind: "histogram"
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  sum: number
  observations: number[]
}

type SeriesAcc = CounterAcc | GaugeAcc | HistogramAcc

/** Build the public snapshot row for a single accumulator. */
const snapshotRow = (acc: SeriesAcc): MetricSnapshot => {
  if (acc.kind === "counter") {
    return Object.freeze({
      name: acc.name,
      kind: "counter" as MetricKind,
      labels: acc.labels,
      value: acc.total,
    })
  }
  if (acc.kind === "gauge") {
    return Object.freeze({
      name: acc.name,
      kind: "gauge" as MetricKind,
      labels: acc.labels,
      value: acc.value,
    })
  }
  // histogram
  const sorted = [...acc.observations].sort((a, b) => a - b)
  return Object.freeze({
    name: acc.name,
    kind: "histogram" as MetricKind,
    labels: acc.labels,
    value: acc.sum,
    count: acc.observations.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  })
}

/** No-throw sink dispatch. The registry is part of the observability plane —
 *  a misbehaving exporter must not crash the agent. */
const safeSend = (sink: MetricSink | undefined, sample: MetricSample): void => {
  if (sink === undefined) return
  try {
    sink.send(sample)
  } catch {
    // Swallow — contract #3. A future "strict mode" could rethrow here, but
    // today silent swallow matches every other observability surface in the
    // tree (jsonl recorder, structured logger).
  }
}

export const defaultMetricsRegistry = (opts: InMemoryRegistryOpts = {}): MetricsRegistry => {
  const sink = opts.sink
  const now = opts.now ?? Date.now
  // Buckets are validated for shape (numeric, ascending recommended) but not
  // applied — see contract #5.
  const buckets = (opts.histogramBuckets ?? DEFAULT_BUCKETS).filter(
    (b) => typeof b === "number" && Number.isFinite(b),
  )
  // Kept on the closure so a future bucketed-exposition mode can read them
  // without an API change. Marked as a deliberate retain via void use.
  void buckets

  /** name → committed kind (per contract #2). */
  const kindByName = new Map<string, MetricKind>()
  /** seriesKey → accumulator. */
  const series = new Map<string, SeriesAcc>()

  const commitKind = (name: string, kind: MetricKind): void => {
    const existing = kindByName.get(name)
    if (existing === undefined) {
      kindByName.set(name, kind)
      return
    }
    if (existing !== kind) {
      throw new MetricsError(
        "name-mismatch-kind",
        `metric "${name}" was first registered as ${existing}; rejecting ${kind}`,
      )
    }
  }

  const emit = (sample: MetricSample): void => safeSend(sink, sample)

  return {
    increment(name, delta, labels) {
      commitKind(name, "counter")
      const d = sanitizePositive(delta ?? 1)
      const lbl = normLabels(labels)
      const key = seriesKey(name, lbl)
      const existing = series.get(key)
      if (existing === undefined) {
        series.set(key, { kind: "counter", name, labels: lbl, total: d })
      } else if (existing.kind === "counter") {
        existing.total += d
      }
      // No `else` — commitKind already threw on a kind clash, so a non-
      // counter accumulator under the same key is unreachable.
      emit({
        name,
        kind: "counter",
        value: d,
        ...(Object.keys(lbl).length > 0 ? { labels: lbl } : {}),
        at: now(),
      })
    },

    observe(name, value, labels) {
      commitKind(name, "histogram")
      const v = sanitizePositive(value)
      const lbl = normLabels(labels)
      const key = seriesKey(name, lbl)
      const existing = series.get(key)
      if (existing === undefined) {
        series.set(key, {
          kind: "histogram",
          name,
          labels: lbl,
          sum: v,
          observations: [v],
        })
      } else if (existing.kind === "histogram") {
        existing.sum += v
        existing.observations.push(v)
      }
      emit({
        name,
        kind: "histogram",
        value: v,
        ...(Object.keys(lbl).length > 0 ? { labels: lbl } : {}),
        at: now(),
      })
    },

    gauge(name, value, labels) {
      commitKind(name, "gauge")
      const v = sanitizeGauge(value)
      const lbl = normLabels(labels)
      const key = seriesKey(name, lbl)
      const existing = series.get(key)
      if (existing === undefined) {
        series.set(key, { kind: "gauge", name, labels: lbl, value: v })
      } else if (existing.kind === "gauge") {
        existing.value = v
      }
      emit({
        name,
        kind: "gauge",
        value: v,
        ...(Object.keys(lbl).length > 0 ? { labels: lbl } : {}),
        at: now(),
      })
    },

    snapshot() {
      const rows: MetricSnapshot[] = []
      for (const acc of series.values()) rows.push(snapshotRow(acc))
      return rows
    },

    reset() {
      series.clear()
      kindByName.clear()
    },

    async flush() {
      if (sink?.flush === undefined) return
      try {
        await sink.flush()
      } catch {
        // Swallow — same posture as `safeSend`. A strict-mode flag could
        // rethrow here in the future.
      }
    },
  }
}
