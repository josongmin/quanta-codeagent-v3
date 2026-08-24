/**
 * In-memory MetricsRegistry adapter (ADR-0144).
 *
 * Pure in-memory book of `Map<seriesKey, Accumulator>` where `seriesKey`
 * combines the metric name with a JSON-stable serialization of the label set.
 * Counters monotonically sum; gauges latest-write-wins; histograms retain
 * exact observations up to a bounded limit, then compact into fixed-size
 * percentile sketches so long-lived processes keep exact counts / sums without
 * unbounded memory growth WITHIN a series. The NUMBER of series per metric name
 * is separately bounded by `maxSeriesPerName` (default generous) so a future
 * high-cardinality label cannot leak the `series` map for the process lifetime
 * — drops are counted in `diagnostics().seriesDropped`.
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
 *      never crashes the agent (the registry is part of the observability
 *      plane — a misbehaving exporter must not take down the loop). The
 *      registry itself still records the sample. The drop is COUNTED in
 *      `diagnostics().exportDropped` so a broken collector is distinguishable
 *      from a healthy one (an operator reads the count off the snapshot plane
 *      without the registry coupling to a logger). `flush` failures mirror this
 *      via `diagnostics().flushDropped`.
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
/** Default per-metric-name series cap. Generous enough that every wired
 *  bounded-label emitter (`tool`,`ok`; `scope` breaches) stays well under it,
 *  so the guard is inert on the default path; it only fires for a future
 *  unbounded-cardinality label and caps the leak instead of growing forever. */
const DEFAULT_MAX_SERIES_PER_NAME = 1024

type MarkerTuple = [number, number, number, number, number]

/**
 * The five P² marker slots, as LITERAL indices.
 *
 * `noUncheckedIndexedAccess` makes `tuple[i]` for a `let i: number` counter
 * `number | undefined`, which is why the adjust step used to carry a non-null
 * assertion on all ~30 of its reads — assertions that said nothing about the
 * algorithm and would have silently survived an off-by-one. A literal-union
 * index resolves to `number` on a tuple, so iterating these makes every read
 * total by construction, with no runtime branch added to the hot path.
 */
type MarkerIndex = 0 | 1 | 2 | 3 | 4
const MARKER_INDICES = [0, 1, 2, 3, 4] as const satisfies readonly MarkerIndex[]

/**
 * The three ADJUSTABLE markers, each paired with the two neighbours its
 * parabolic update reads. Markers 0 and 4 are the running min/max and are moved
 * only by a new extremum, never by the adjust step — so naming the participants
 * (`prev`,`i`,`next`) also states that invariant, where `i - 1` / `i + 1` left
 * the reader to rederive the loop bounds.
 */
const INTERIOR_MARKERS = [
  [0, 1, 2],
  [1, 2, 3],
  [2, 3, 4],
] as const satisfies readonly (readonly [MarkerIndex, MarkerIndex, MarkerIndex])[]

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

const sanitizeMaxSeriesPerName = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_SERIES_PER_NAME
  return Math.max(1, Math.trunc(value))
}

/** Per-registry health counters. Export egress and the cardinality guard both
 *  fail silently per the no-crash / bounded-memory contracts; these counters
 *  make those otherwise-invisible events observable to an operator without
 *  changing the snapshot plane. Read via the registry's `diagnostics()`. */
export interface RegistryDiagnostics {
  /** `sink.send` threw and the sample was dropped from EXPORT (the in-memory
   *  accumulator was still updated). One per failed send. */
  readonly exportDropped: number
  /** `sink.flush` threw and the drain was dropped. One per failed flush. */
  readonly flushDropped: number
  /** A new label-series was rejected because its metric name was already at
   *  `maxSeriesPerName`. One per rejected series (the existing series for that
   *  name continue to update normally). */
  readonly seriesDropped: number
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

  for (const i of MARKER_INDICES) if (i > bucket) positions[i] += 1
  for (const i of MARKER_INDICES) desired[i] += increments[i]

  for (const [prev, i, next] of INTERIOR_MARKERS) {
    const delta = desired[i] - positions[i]
    const prevGap = positions[prev] - positions[i]
    const nextGap = positions[next] - positions[i]
    if (!((delta >= 1 && nextGap > 1) || (delta <= -1 && prevGap < -1))) continue

    const direction = delta > 0 ? 1 : -1
    // The marker the linear fallback leans on: `i + direction`, named.
    const toward = direction > 0 ? next : prev
    const parabolic =
      heights[i] +
      (direction / (positions[next] - positions[prev])) *
        (((positions[i] - positions[prev] + direction) * (heights[next] - heights[i])) /
          (positions[next] - positions[i]) +
          ((positions[next] - positions[i] - direction) * (heights[i] - heights[prev])) /
            (positions[i] - positions[prev]))

    if (parabolic > heights[prev] && parabolic < heights[next]) {
      heights[i] = parabolic
    } else {
      heights[i] =
        heights[i] +
        (direction * (heights[toward] - heights[i])) / (positions[toward] - positions[i])
    }
    positions[i] += direction
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

/** Fold ONE observation into an ALREADY-EXISTING histogram series.
 *
 *  Split out of `observe` so that method states only the series lifecycle
 *  (absent ⇒ admit-and-seed, present ⇒ fold) and the retention rule lives in
 *  one place: exact samples are kept until `maxExact`, then collapsed into
 *  sketches once and fed as sketches from there on. The two arms are mutually
 *  exclusive by construction — `exactObservations` and `sketches` are never
 *  both non-null — which is far easier to see here than inline. */
const foldHistogramObservation = (
  existing: HistogramAcc,
  value: number,
  maxExact: number,
): void => {
  existing.sum += value
  existing.count += 1
  if (existing.exactObservations !== null) {
    existing.exactObservations.push(value)
    if (existing.exactObservations.length > maxExact) {
      existing.sketches = buildHistogramSketchSet(existing.exactObservations)
      existing.exactObservations = null
    }
    return
  }
  if (existing.sketches !== null) observeHistogramSketchSet(existing.sketches, value)
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
 *  a misbehaving exporter must not crash the agent. Returns `true` when the
 *  sample was handed to the sink without throwing, `false` when the send was
 *  swallowed (so the caller can count the drop for {@link RegistryDiagnostics}).
 *  A no-sink registry returns `true` — there is nothing to fail. */
const safeSend = (sink: MetricSink | undefined, sample: MetricSample): boolean => {
  if (sink === undefined) return true
  try {
    sink.send(sample)
    return true
  } catch {
    // Swallow — contract #3. A future "strict mode" could rethrow here, but
    // today silent swallow matches every other observability surface in the
    // tree (jsonl recorder, structured logger). The drop is still COUNTED so a
    // broken collector is distinguishable from a healthy one via diagnostics().
    return false
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

/**
 * The registry's shared state: the series maps, the guards every write passes,
 * and the drop counters. Split out of `defaultMetricsRegistry` (god-function
 * burndown); the counters live in a mutable holder because a `let` binding
 * cannot cross a function boundary by value.
 */
const registryState = (opts: InMemoryRegistryOpts = {}) => {
  /** The factory's MUTABLE state. `let` bindings cannot cross a function
   *  boundary by value, so they live here and the groups mutate in place —
   *  observationally identical to the closure they replace. */
  const mut = {
    exportDropped: 0,
    flushDropped: 0,
    seriesDropped: 0,
  }
  // Explicit sink wins; otherwise fall back to the process-default (null ⇒ none).
  const sink = opts.sink ?? processDefaultSink ?? undefined
  const now = opts.now ?? Date.now
  const histogramMaxObservations = sanitizeHistogramMaxObservations(opts.histogramMaxObservations)
  const maxSeriesPerName = sanitizeMaxSeriesPerName(opts.maxSeriesPerName)
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
  /** name → distinct-series count, for the per-name cardinality cap. */
  const seriesCountByName = new Map<string, number>()

  // Health counters — exported, flush, and cardinality drops are all silent by
  // contract; these make them observable via diagnostics() without touching the
  // snapshot plane.

  /** Admit a brand-new series under the per-name cap. Returns `true` when there
   *  is headroom (caller proceeds to `series.set`), `false` when the name is at
   *  its cap (caller drops the sample and we count it). Existing series for a
   *  name always update — the guard only blocks NEW label combinations. */
  const admitNewSeries = (name: string): boolean => {
    const count = seriesCountByName.get(name) ?? 0
    if (count >= maxSeriesPerName) {
      mut.seriesDropped += 1
      return false
    }
    seriesCountByName.set(name, count + 1)
    return true
  }

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

  const emit = (sample: MetricSample): void => {
    if (!safeSend(sink, sample)) mut.exportDropped += 1
  }
  return {
    sink,
    now,
    admitNewSeries,
    histogramMaxObservations,
    maxSeriesPerName,
    buckets,
    kindByName,
    series,
    seriesCountByName,
    commitKind,
    emit,
    mut,
  }
}

/** The state every operation group shares, inferred from {@link registryState} so it
 *  can never drift from what that function actually builds. */
type RegistryCtx = ReturnType<typeof registryState>

/** The three write paths — counter, histogram, gauge. Each passes the same
 *  name/cardinality guards before it touches a series. */
const recordOps = (
  ctx: RegistryCtx,
): Pick<
  MetricsRegistry & { diagnostics(): RegistryDiagnostics },
  "increment" | "observe" | "gauge"
> => {
  const { now, histogramMaxObservations, series, admitNewSeries, commitKind, emit } = ctx
  return {
    increment(name, delta, labels) {
      commitKind(name, "counter")
      const d = sanitizePositive(delta ?? 1)
      const lbl = normLabels(labels)
      const key = seriesKey(name, lbl)
      const existing = series.get(key)
      if (existing === undefined) {
        if (!admitNewSeries(name)) return
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
        if (!admitNewSeries(name)) return
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
        foldHistogramObservation(existing, v, histogramMaxObservations)
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
        if (!admitNewSeries(name)) return
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
  }
}

/** Read/drain surface: project the series, clear them, flush to the sink, and
 *  report the registry's own drop counters. */
const readOps = (
  ctx: RegistryCtx,
): Pick<
  MetricsRegistry & { diagnostics(): RegistryDiagnostics },
  "snapshot" | "reset" | "flush" | "diagnostics"
> => {
  const { sink, kindByName, series, seriesCountByName, mut } = ctx
  return {
    snapshot() {
      // O(series) allocation is irreducible — the public contract returns one
      // MetricSnapshot row per series, so a fresh array is the cheapest faithful
      // materialization. `series.size` itself is now bounded by the per-name
      // cardinality cap (`admitNewSeries`), so this stays bounded even under a
      // high-cardinality emitter.
      const rows: MetricSnapshot[] = []
      for (const acc of series.values()) rows.push(snapshotRow(acc))
      return rows
    },

    reset() {
      series.clear()
      kindByName.clear()
      seriesCountByName.clear()
    },

    async flush() {
      if (sink?.flush === undefined) return
      try {
        await sink.flush()
      } catch {
        // Swallow — same posture as `safeSend`. A strict-mode flag could
        // rethrow here in the future. Still counted so a permanently-failing
        // drain on shutdown is visible via diagnostics().flushDropped.
        mut.flushDropped += 1
      }
    },

    /** Snapshot of the silent-failure health counters (export / flush / series
     *  cardinality drops). Frozen so callers can't mutate registry state. */
    diagnostics(): RegistryDiagnostics {
      return Object.freeze({
        exportDropped: mut.exportDropped,
        flushDropped: mut.flushDropped,
        seriesDropped: mut.seriesDropped,
      })
    },
  }
}

export const defaultMetricsRegistry = (
  opts: InMemoryRegistryOpts = {},
): MetricsRegistry & { diagnostics(): RegistryDiagnostics } => {
  const ctx = registryState(opts)
  return {
    ...recordOps(ctx),
    ...readOps(ctx),
  }
}
