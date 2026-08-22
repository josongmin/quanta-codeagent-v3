/**
 * OpenTelemetry `MeterProvider`-backed metric sink (ADR-0150).
 *
 * Closed-port adapter: `MetricSample → OTel Counter / Histogram / UpDownCounter`.
 * Caller constructs the `MeterProvider` (with their chosen exporters / resource
 * attrs / shutdown lifecycle) and hands it in. We never auto-instantiate one —
 * Default-OFF posture per ADR-0144.
 *
 * Why a STRUCTURAL OTel surface instead of `import type { MeterProvider } from
 * "@opentelemetry/api"`?
 *
 *   The `@opentelemetry/api` package is not pinned as a hard dependency in this
 *   tree (Default-OFF means surfaces that don't use OTel pay zero install /
 *   bundle cost). We declare a minimal *structural* interface that matches the
 *   real OTel `MeterProvider` / `Meter` / `Counter` / `Histogram` /
 *   `UpDownCounter` shapes so:
 *     - A real `MeterProvider` from `@opentelemetry/api` / `@opentelemetry/sdk-metrics`
 *       is structurally assignable when callers wire it in.
 *     - This sink compiles without the OTel package physically present in
 *       node_modules — the typed contract is local.
 *     - Tests can mock the OTel surface trivially (the hellgate does this).
 *
 *   The shapes mirror `@opentelemetry/api` exactly for the methods we use:
 *     `MeterProvider.getMeter(name, version?)`
 *     `Meter.createCounter(name).add(value, labels?)`
 *     `Meter.createHistogram(name).record(value, labels?)`
 *     `Meter.createUpDownCounter(name).add(value, labels?)`
 *     `MeterProvider.forceFlush()` (optional)
 *
 * Gauge emulation: OTel's API has NO synchronous gauge primitive for
 * point-in-time values. We use `UpDownCounter` + a per-(name, labelsKey)
 * previous-value cache, sending the delta `value - prev` on each `gauge`
 * sample. Net effect at the collector: `UpDownCounter`'s monotonic-sum acts
 * as the gauge's current value. (The alternative — `ObservableGauge` — needs
 * a callback that pulls from our in-memory registry, which couples the sink
 * to the registry; the delta approach keeps the sink stateless w.r.t. the
 * registry and is what the OTel docs recommend when a sync gauge is needed.)
 *
 * Instrument kind lock: once a `name` is bound to a kind on first send, a
 * later sample of a different kind is dropped with a `console.warn` rather
 * than throwing. The registry enforces the same one-name-one-kind invariant
 * (ADR-0144 #2) so this is defense-in-depth; throwing here would violate the
 * sink no-throw policy (ADR-0144 #3).
 *
 * No-throw policy: EVERY OTel API call is wrapped in try/catch and swallowed.
 * An observability sink must never break the recorder. Misbehaving exporters
 * (network down, collector unreachable, serialization bug) are isolated.
 *
 * Plane-clean: imports only `./port`. No `@/agent`, `@/tool`, `@/llm`.
 */

import type { MetricSample, MetricSink } from "./port"

// ────────────────────────────────────────────────────────────────────────────
// Structural OTel surface (matches `@opentelemetry/api` shapes exactly for
// the methods we call). Real `MeterProvider` from `@opentelemetry/api` is
// structurally assignable to `OtelMeterProvider`.
// ────────────────────────────────────────────────────────────────────────────

/** Label set handed to OTel instrument methods. Mirrors `MetricAttributes`. */
export type OtelAttributes = Readonly<Record<string, string | number | boolean>>

/** Synchronous `Counter` — only `.add` is used. */
export interface OtelCounter {
  add(value: number, attributes?: OtelAttributes): void
}

/** Synchronous `Histogram` — only `.record` is used. */
export interface OtelHistogram {
  record(value: number, attributes?: OtelAttributes): void
}

/** Synchronous `UpDownCounter` — used to emulate a gauge via delta-add. */
export interface OtelUpDownCounter {
  add(value: number, attributes?: OtelAttributes): void
}

/** Subset of `Meter` we use. */
export interface OtelMeter {
  createCounter(name: string): OtelCounter
  createHistogram(name: string): OtelHistogram
  createUpDownCounter(name: string): OtelUpDownCounter
}

/** Subset of `MeterProvider` we use. `forceFlush` is optional — the real
 *  `@opentelemetry/sdk-metrics` `MeterProvider` exposes it; the
 *  `@opentelemetry/api` no-op default provider does not. */
export interface OtelMeterProvider {
  getMeter(name: string, version?: string): OtelMeter
  forceFlush?(): Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────────

export interface OtelSinkOpts {
  /** Caller-built MeterProvider. Quanta does NOT auto-instantiate one —
   *  caller controls the OTel SDK lifecycle (exporters, resource attrs,
   *  shutdown). The sink just adapts our samples to OTel meter instruments. */
  readonly meterProvider: OtelMeterProvider
  /** Logical meter name (groups metrics in OTel UI). Default `"quanta"`. */
  readonly meterName?: string
  /** Optional version (passed to `getMeter(name, version)`). */
  readonly meterVersion?: string
  /** Optional warn sink for kind-mismatch sample drops. Slice purity
   *  (ADR-0144): no `console.*` default — caller injects or it's silent. */
  readonly warn?: (msg: string) => void
}

// ────────────────────────────────────────────────────────────────────────────
// Internal cache entry
// ────────────────────────────────────────────────────────────────────────────

interface CachedCounter {
  readonly kind: "counter"
  readonly instrument: OtelCounter
}
interface CachedHistogram {
  readonly kind: "histogram"
  readonly instrument: OtelHistogram
}
interface CachedGauge {
  readonly kind: "gauge"
  readonly instrument: OtelUpDownCounter
  /** Per-series previous gauge value so we can send the delta. Keyed by the
   *  same stable-sorted JSON of labels the registry uses. */
  readonly prevByLabelKey: Map<string, number>
}
type CachedInstrument = CachedCounter | CachedHistogram | CachedGauge

// ────────────────────────────────────────────────────────────────────────────
// Label normalization → OTel attributes
// ────────────────────────────────────────────────────────────────────────────

/** Stable-sorted JSON of the labels — matches `in-memory-registry`'s
 *  `labelKey` so the gauge prev-value cache aligns with the registry's
 *  series identity. */
const labelKey = (labels: Readonly<Record<string, string>> | undefined): string => {
  if (labels === undefined) return "{}"
  const keys = Object.keys(labels).sort()
  const ordered: Record<string, string> = {}
  for (const k of keys) {
    const v = labels[k]
    if (typeof v === "string") ordered[k] = v
  }
  return JSON.stringify(ordered)
}

/** Convert our `Record<string,string>` labels to OTel `MetricAttributes`.
 *  Empty / missing labels → `undefined` so OTel sees "no attributes" rather
 *  than an empty record (matches OTel exporter expectations). */
const toAttributes = (
  labels: Readonly<Record<string, string>> | undefined,
): OtelAttributes | undefined => {
  if (labels === undefined) return undefined
  const keys = Object.keys(labels)
  if (keys.length === 0) return undefined
  // OTel accepts string|number|boolean; we only emit strings, so a shallow
  // freeze of a copy is safe to hand to the instrument.
  const out: Record<string, string> = {}
  for (const k of keys) {
    const v = labels[k]
    if (typeof v === "string") out[k] = v
  }
  return Object.freeze(out)
}

// ────────────────────────────────────────────────────────────────────────────
// Sink factory
// ────────────────────────────────────────────────────────────────────────────

/** Construct an OTel-backed `MetricSink`. Caller owns the `MeterProvider`
 *  lifecycle. */
export const otelMetricsSink = (opts: OtelSinkOpts): MetricSink => {
  const meterName = opts.meterName ?? "quanta"
  const meterVersion = opts.meterVersion

  /** Lazy: `getMeter` is only called on the first `send`. Subsequent sends
   *  reuse the cached meter (matches OTel best practice — `getMeter` is
   *  idempotent but the cache avoids the lookup on the hot path). */
  let meter: OtelMeter | undefined

  /** name → cached instrument. Instrument kind is locked on first send. */
  const instruments = new Map<string, CachedInstrument>()

  const getMeter = (): OtelMeter | undefined => {
    if (meter !== undefined) return meter
    try {
      meter =
        meterVersion === undefined
          ? opts.meterProvider.getMeter(meterName)
          : opts.meterProvider.getMeter(meterName, meterVersion)
      return meter
    } catch {
      // MeterProvider misconfigured — swallow per no-throw policy.
      return undefined
    }
  }

  /** Log a kind-mismatch drop. Defense-in-depth — registry already enforces
   *  one-name-one-kind (ADR-0144 #2); we only reach here if a caller bypasses
   *  the registry. No-throw per ADR-0144 #3. */
  const warnKindLock = (sample: MetricSample, lockedTo: CachedInstrument["kind"]): void => {
    const warn = opts.warn
    if (warn === undefined) return
    try {
      warn(
        `[otel-metrics-sink] dropping sample: name "${sample.name}" locked to kind "${lockedTo}", got "${sample.kind}"`,
      )
    } catch {
      // warn sink can throw in exotic runtimes — swallow.
    }
  }

  /** Build a fresh cached instrument for `sample.kind`. Throws ⇒ caller
   *  swallows (transient meter error; retry on next send). */
  const buildInstrument = (m: OtelMeter, sample: MetricSample): CachedInstrument => {
    if (sample.kind === "counter") {
      return { kind: "counter", instrument: m.createCounter(sample.name) }
    }
    if (sample.kind === "histogram") {
      return { kind: "histogram", instrument: m.createHistogram(sample.name) }
    }
    // gauge → UpDownCounter + delta cache
    return {
      kind: "gauge",
      instrument: m.createUpDownCounter(sample.name),
      prevByLabelKey: new Map<string, number>(),
    }
  }

  const getOrCreate = (sample: MetricSample): CachedInstrument | undefined => {
    const existing = instruments.get(sample.name)
    if (existing !== undefined) {
      if (existing.kind !== sample.kind) {
        warnKindLock(sample, existing.kind)
        return undefined
      }
      return existing
    }
    const m = getMeter()
    if (m === undefined) return undefined
    try {
      const entry = buildInstrument(m, sample)
      instruments.set(sample.name, entry)
      return entry
    } catch {
      // Instrument creation failed — swallow; future samples for the same
      // name will retry. (Not caching the failure keeps the sink resilient
      // to transient meter errors — the caller may have re-wired their
      // provider mid-flight.)
      return undefined
    }
  }

  /** Dispatch a sample to its cached instrument. Extracted to keep `send`
   *  below the cognitive-complexity budget. Pre-condition: `entry.kind`
   *  matches `sample.kind` (the caller checked via `getOrCreate`). */
  const dispatch = (entry: CachedInstrument, sample: MetricSample): void => {
    const attrs = toAttributes(sample.labels)
    if (entry.kind === "counter") {
      if (attrs === undefined) entry.instrument.add(sample.value)
      else entry.instrument.add(sample.value, attrs)
      return
    }
    if (entry.kind === "histogram") {
      if (attrs === undefined) entry.instrument.record(sample.value)
      else entry.instrument.record(sample.value, attrs)
      return
    }
    // gauge → delta-add against UpDownCounter
    const k = labelKey(sample.labels)
    const prev = entry.prevByLabelKey.get(k) ?? 0
    const delta = sample.value - prev
    entry.prevByLabelKey.set(k, sample.value)
    if (delta === 0) return // no-op (collectors treat add(0) as a write; skip for cleanliness)
    if (attrs === undefined) entry.instrument.add(delta)
    else entry.instrument.add(delta, attrs)
  }

  return {
    send(sample) {
      const entry = getOrCreate(sample)
      if (entry === undefined) return
      try {
        dispatch(entry, sample)
      } catch {
        // Instrument call threw — swallow per ADR-0144 #3.
      }
    },
    async flush() {
      const flush = opts.meterProvider.forceFlush
      if (flush === undefined) return
      try {
        await flush.call(opts.meterProvider)
      } catch {
        // Swallow — observability flush must not crash callers.
      }
    },
  }
}
