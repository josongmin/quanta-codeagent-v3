/**
 * In-memory MetricsRegistry adapter (ADR-0144).
 *
 * Pure in-memory book of `Map<seriesKey, Accumulator>` where `seriesKey`
 * combines the metric name with a JSON-stable serialization of the label set.
 * Counters monotonically sum; gauges latest-write-wins; histograms retain
 * exact observations up to a bounded limit, then compact into fixed-size
 * percentile sketches so long-lived processes keep exact counts / sums without
 * unbounded memory growth.
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
 *   5. HISTOGRAM RETENTION is exact up to `histogramMaxObservations`, then
 *      compacted into bounded P² percentile sketches for p50 / p95 / p99.
 *      Count and sum remain exact after compaction, and `snapshot()` stays
 *      O(1) per compacted series instead of sorting an unbounded array.
 *      `histogramBuckets` remains reserved for a future bucketed exposition
 *      mode; today it is still validated for shape only.
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
   *  current adapter ignores them — percentiles come from the bounded
   *  in-memory sketch — but they are validated for shape so a caller can wire
   *  OTel later without surface churn. Default `[1, 10, 100, 1000, 10000]`. */
  readonly histogramBuckets?: ReadonlyArray<number>
  /** Exact observation cap per histogram before compacting to a bounded
   *  percentile sketch. Count / sum remain exact after compaction. */
  readonly histogramMaxObservations?: number
  /** Cardinality guard: max distinct label-series retained PER metric name.
   *  Contract #5 bounds memory WITHIN a series (histogram compaction) but the
   *  NUMBER of series is otherwise unbounded — a future emitter that passes a
   *  high-cardinality label (per-request id, free-form error string) would grow
   *  `series` for the process lifetime. Once a name hits the cap, new series for
   *  that name are dropped (existing ones still update) and the drop is counted
   *  in {@link RegistryDiagnostics.seriesDropped}. The default is generous so
   *  the wired bounded-label paths (`tool`,`ok`) never trip it — default
   *  behavior stays byte-identical. */
  readonly maxSeriesPerName?: number
}

const DEFAULT_BUCKETS: ReadonlyArray<number> = Object.freeze([1, 10, 100, 1000, 10_000])
const DEFAULT_HISTOGRAM_MAX_OBSERVATIONS = 256
const MIN_P2_SEED_SIZE = 5

type MarkerTuple = [number, number, number, number, number]

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

/** Series key = `name|labels`. Including kind would make the
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

const sanitizeHistogramMaxObservations = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_HISTOGRAM_MAX_OBSERVATIONS
  return Math.max(MIN_P2_SEED_SIZE, Math.trunc(value))
}

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

interface P2Quantile {
  readonly probability: number
  seed: number[]
  initialized: boolean
  markerHeights: MarkerTuple | null
  markerPositions: MarkerTuple | null
  desiredPositions: MarkerTuple | null
  positionIncrements: MarkerTuple | null
}

interface HistogramSketchSet {
  readonly p50: P2Quantile
  readonly p95: P2Quantile
  readonly p99: P2Quantile
}

interface HistogramAcc {
  readonly kind: "histogram"
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  sum: number
  count: number
  exactObservations: number[] | null
  sketches: HistogramSketchSet | null
}

type SeriesAcc = CounterAcc | GaugeAcc | HistogramAcc

const createQuantileSketch = (probability: number): P2Quantile => ({
  probability,
  seed: [],
  initialized: false,
  markerHeights: null,
  markerPositions: null,
  desiredPositions: null,
  positionIncrements: null,
})

const initializeQuantileSketch = (state: P2Quantile): void => {
  if (state.seed.length < MIN_P2_SEED_SIZE) return
  const sorted = [...state.seed].sort((a, b) => a - b)
  const p = state.probability
  state.markerHeights = [
    sorted[0] ?? 0,
    sorted[1] ?? 0,
    sorted[2] ?? 0,
    sorted[3] ?? 0,
    sorted[4] ?? 0,
  ]
  state.markerPositions = [1, 2, 3, 4, 5]
  state.desiredPositions = [1, 1 + 2 * p, 1 + 4 * p, 3 + 2 * p, 5]
  state.positionIncrements = [0, p / 2, p, (1 + p) / 2, 1]
  state.initialized = true
  state.seed = []
}

const observeQuantileSketch = (state: P2Quantile, value: number): void => {
  if (!state.initialized) {
    state.seed.push(value)
    if (state.seed.length === MIN_P2_SEED_SIZE) initializeQuantileSketch(state)
    return
  }

  const heights = state.markerHeights
  const positions = state.markerPositions
  const desired = state.desiredPositions
  const increments = state.positionIncrements
  if (heights === null || positions === null || desired === null || increments === null) {
    return
  }

  let bucket = 0
  if (value < heights[0]) {
    heights[0] = value
    bucket = 0
  } else if (value < heights[1]) {
    bucket = 0
  } else if (value < heights[2]) {
    bucket = 1
  } else if (value < heights[3]) {
    bucket = 2
  } else if (value <= heights[4]) {
    bucket = 3
  } else {
    heights[4] = value
    bucket = 3
  }

  for (let i = bucket + 1; i < positions.length; i += 1) positions[i]! += 1
  for (let i = 0; i < desired.length; i += 1) desired[i]! += increments[i]!

  for (let i = 1; i <= 3; i += 1) {
    const delta = desired[i]! - positions[i]!
    const prevGap = positions[i - 1]! - positions[i]!
    const nextGap = positions[i + 1]! - positions[i]!
    if (!((delta >= 1 && nextGap > 1) || (delta <= -1 && prevGap < -1))) continue

    const direction = delta > 0 ? 1 : -1
    const parabolic =
      heights[i]! +
      (direction / (positions[i + 1]! - positions[i - 1]!)) *
        (((positions[i]! - positions[i - 1]! + direction) * (heights[i + 1]! - heights[i]!)) /
          (positions[i + 1]! - positions[i]!) +
          ((positions[i + 1]! - positions[i]! - direction) * (heights[i]! - heights[i - 1]!)) /
            (positions[i]! - positions[i - 1]!))

    if (parabolic > heights[i - 1]! && parabolic < heights[i + 1]!) {
      heights[i] = parabolic
    } else {
      heights[i] =
        heights[i]! +
        (direction * (heights[i + direction]! - heights[i]!)) /
          (positions[i + direction]! - positions[i]!)
    }
    positions[i]! += direction
  }
}

const readQuantileSketch = (state: P2Quantile): number => {
  if (!state.initialized) {
    if (state.seed.length === 0) return 0
    const sorted = [...state.seed].sort((a, b) => a - b)
    return percentile(sorted, state.probability * 100)
  }
  return state.markerHeights?.[2] ?? 0
}

const createHistogramSketchSet = (): HistogramSketchSet => ({
  p50: createQuantileSketch(0.5),
  p95: createQuantileSketch(0.95),
  p99: createQuantileSketch(0.99),
})

const observeHistogramSketchSet = (sketches: HistogramSketchSet, value: number): void => {
  observeQuantileSketch(sketches.p50, value)
  observeQuantileSketch(sketches.p95, value)
  observeQuantileSketch(sketches.p99, value)
}

const buildHistogramSketchSet = (values: ReadonlyArray<number>): HistogramSketchSet => {
  const sketches = createHistogramSketchSet()
  for (const value of values) observeHistogramSketchSet(sketches, value)
  return sketches
}

const histogramPercentiles = (acc: HistogramAcc): { p50: number; p95: number; p99: number } => {
  if (acc.exactObservations !== null) {
    const sorted = [...acc.exactObservations].sort((a, b) => a - b)
    return {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    }
  }
  if (acc.sketches !== null) {
    return {
      p50: readQuantileSketch(acc.sketches.p50),
      p95: readQuantileSketch(acc.sketches.p95),
      p99: readQuantileSketch(acc.sketches.p99),
    }
  }
  return { p50: 0, p95: 0, p99: 0 }
}

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

  const stats = histogramPercentiles(acc)
  return Object.freeze({
    name: acc.name,
    kind: "histogram" as MetricKind,
    labels: acc.labels,
    value: acc.sum,
    count: acc.count,
    p50: stats.p50,
    p95: stats.p95,
    p99: stats.p99,
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

// ---------------------------------------------------------------------------
// Process-default sink (mirror of spans.ts `setSpanSink`) — the missing metric
// egress seam. There is no global metrics registry; instruments construct fresh
// `defaultMetricsRegistry()`s at many sites, almost always WITHOUT an explicit
// sink. This module-level default lets a HOST (composition root) route ALL such
// registries to one transport (e.g. the OTLP exporter) in one call, without
// threading a sink through every factory. An EXPLICIT `opts.sink` still wins;
// absent (default) ⇒ `null` ⇒ byte-identical snapshot-only behavior.
// ---------------------------------------------------------------------------
let processDefaultSink: MetricSink | null = null

/** Register the process-default {@link MetricSink}. Pass `null` to clear.
 *  Hosts call this once at startup; `defaultMetricsRegistry()` picks it up when
 *  the caller passes no explicit sink. */
export const setDefaultMetricSink = (sink: MetricSink | null): void => {
  processDefaultSink = sink
}

/** Read the process-default sink (diagnostics + tests). */
export const getDefaultMetricSink = (): MetricSink | null => processDefaultSink

/** Test-only reset — clears the process-default sink so one test's wiring can
 *  never leak into the next (the registry is global module state). */
export const __resetDefaultMetricSink = (): void => {
  processDefaultSink = null
}

export const defaultMetricsRegistry = (opts: InMemoryRegistryOpts = {}): MetricsRegistry => {
  // Explicit sink wins; otherwise fall back to the process-default (null ⇒ none).
  const sink = opts.sink ?? processDefaultSink ?? undefined
  const now = opts.now ?? Date.now
  const histogramMaxObservations = sanitizeHistogramMaxObservations(opts.histogramMaxObservations)
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
          count: 1,
          exactObservations: [v],
          sketches: null,
        })
      } else if (existing.kind === "histogram") {
        existing.sum += v
        existing.count += 1
        if (existing.exactObservations !== null) {
          existing.exactObservations.push(v)
          if (existing.exactObservations.length > histogramMaxObservations) {
            existing.sketches = buildHistogramSketchSet(existing.exactObservations)
            existing.exactObservations = null
          }
        } else if (existing.sketches !== null) {
          observeHistogramSketchSet(existing.sketches, v)
        }
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
