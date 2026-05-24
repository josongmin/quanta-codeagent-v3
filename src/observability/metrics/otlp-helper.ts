/**
 * OTLP / Prometheus exporter wiring helpers (ADR-0155 follow-up to ADR-0154).
 *
 * ADR-0154 shipped `otelMetricsSink({meterProvider})` as a structural-type
 * adapter — caller owns the `MeterProvider` lifecycle, and the OTel runtime
 * packages stay OUT of `package.json` so surfaces that never touch OTel pay
 * zero install / bundle cost (Default-OFF).
 *
 * This module closes the wiring loop with two factory helpers:
 *
 *   - `otlpHttpMetricSink(opts?)` → sink + shutdown handle backed by
 *     `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-metrics-otlp-http`
 *     (PUSH to an OTLP HTTP endpoint — Collector, Honeycomb, Grafana Cloud).
 *
 *   - `prometheusMetricSink(opts?)` → sink + shutdown handle backed by
 *     `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-prometheus`
 *     (passive — exporter listens on an HTTP port for Prometheus to scrape).
 *
 * Why dynamic import + typed error?
 *
 *   The 3 (HTTP) / 2 (Prometheus) `@opentelemetry/*` packages are NOT pinned
 *   as `dependencies`. A caller who wants to use a helper installs them
 *   themselves (`bun add @opentelemetry/sdk-metrics
 *   @opentelemetry/exporter-metrics-otlp-http`) and then invokes the helper.
 *   If the packages are missing at call time, we throw a typed
 *   `OtelDepsMissingError(packages)` whose `message` includes the bun install
 *   hint. Auto-installing deps at runtime (some agents do this) is a
 *   security / license posture we explicitly reject.
 *
 *   The dynamic `import()` is wrapped in try/catch per package so we can
 *   surface the FULL list of missing modules in the typed error (a caller
 *   missing both packages gets one error, not two consecutive throws).
 *
 * Test seam: `__loader` (internal opt) lets the hellgate inject a fake
 * loader returning fake SDK modules without touching `node_modules`. The
 * public `Opts` shapes intentionally do NOT expose `__loader` — surfaces use
 * the default loader (real dynamic import); only the test file flips the
 * internal flag.
 *
 * Plane-clean: imports only `./port` (sink type) + `./otel-sink` (sink
 * factory + structural OTel meter-provider shape). NO `@/agent`, `@/llm`,
 * `@/tool`. Dynamic imports stay async + try/catch — they do not poison
 * top-level module evaluation.
 */

import { type OtelMeterProvider, otelMetricsSink } from "./otel-sink"
import type { MetricSink } from "./port"

// ────────────────────────────────────────────────────────────────────────────
// Typed error
// ────────────────────────────────────────────────────────────────────────────

const installHint = (packages: ReadonlyArray<string>): string =>
  `Install with: bun add ${packages.join(" ")}`

/** Thrown when one or more `@opentelemetry/*` packages required by a helper
 *  are not installed. `packages` lists the missing module specifiers and the
 *  `message` includes a copy-paste bun install command. */
export class OtelDepsMissingError extends Error {
  readonly packages: ReadonlyArray<string>
  constructor(packages: ReadonlyArray<string>) {
    super(`OTel SDK packages not installed: ${packages.join(", ")}. ${installHint(packages)}`)
    this.name = "OtelDepsMissingError"
    this.packages = packages
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public options
// ────────────────────────────────────────────────────────────────────────────

export interface OtlpHelperOpts {
  /** OTLP HTTP endpoint. Default `http://localhost:4318/v1/metrics`. */
  readonly endpoint?: string
  /** Headers for auth (e.g. `{ "x-honeycomb-team": "..." }`). */
  readonly headers?: Readonly<Record<string, string>>
  /** Export interval ms. Default 5000. */
  readonly intervalMs?: number
  /** Resource attrs (service.name, env, etc.).
   *  Default `{ "service.name": "quanta" }`. */
  readonly resourceAttrs?: Readonly<Record<string, string>>
  /** TEST-ONLY loader injection. Surfaces never set this; the hellgate uses
   *  it to stub the dynamic import without touching node_modules. */
  readonly __loader?: OtlpLoader
}

export interface PrometheusHelperOpts {
  /** HTTP port the exporter listens on. Default `9464` (OTel convention). */
  readonly port?: number
  /** HTTP path served. Default `/metrics`. */
  readonly endpoint?: string
  /** Resource attrs. Default `{ "service.name": "quanta" }`. */
  readonly resourceAttrs?: Readonly<Record<string, string>>
  /** TEST-ONLY loader injection. */
  readonly __loader?: PrometheusLoader
}

/** Sink + shutdown bundle returned by the helpers. `shutdown` calls the
 *  underlying `MeterProvider.shutdown()` for graceful cleanup. */
export interface HelperResult {
  readonly sink: MetricSink
  readonly shutdown: () => Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// Loader shapes — structural typing of the OTel SDK surface we use. We
// declare locally so the helper does not need `@opentelemetry/sdk-metrics`
// types installed (matches the structural posture of ADR-0154).
// ────────────────────────────────────────────────────────────────────────────

interface OtlpExporterCtorOpts {
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
}
interface PeriodicReaderCtorOpts {
  readonly exporter: unknown
  readonly exportIntervalMillis?: number
}
interface MeterProviderCtorOpts {
  readonly readers: ReadonlyArray<unknown>
  readonly resource?: unknown
}

interface SdkMetricsModule {
  readonly PeriodicExportingMetricReader: new (opts: PeriodicReaderCtorOpts) => unknown
  readonly MeterProvider: new (
    opts: MeterProviderCtorOpts,
  ) => OtelMeterProvider & {
    shutdown(): Promise<void>
  }
  /** Optional — only present in some SDK versions. The MeterProvider also
   *  accepts a plain `{ "service.name": "..." }` record in newer SDKs, so
   *  we pass the resource attrs object directly when this class is absent. */
  readonly Resource?: new (
    attrs: Readonly<Record<string, string>>,
  ) => unknown
}

interface OtlpExporterModule {
  readonly OTLPMetricExporter: new (opts: OtlpExporterCtorOpts) => unknown
}

interface PrometheusExporterCtorOpts {
  readonly port?: number
  readonly endpoint?: string
}

interface PrometheusExporterModule {
  readonly PrometheusExporter: new (
    opts: PrometheusExporterCtorOpts,
  ) => OtelMeterProvider & {
    shutdown(): Promise<void>
  }
}

/** OTLP loader returns the 2 SDK modules. Default loader uses dynamic
 *  `import()`; hellgate passes a fake. */
export type OtlpLoader = () => Promise<{
  sdk: SdkMetricsModule
  otlp: OtlpExporterModule
}>

/** Prometheus loader returns the 2 SDK modules. */
export type PrometheusLoader = () => Promise<{
  sdk: SdkMetricsModule
  prom: PrometheusExporterModule
}>

// ────────────────────────────────────────────────────────────────────────────
// Default loaders — try each package independently, collect misses, throw
// the typed error with the FULL list so the caller installs in one command.
// ────────────────────────────────────────────────────────────────────────────

const tryImport = async <T>(specifier: string): Promise<T | undefined> => {
  try {
    return (await import(specifier)) as T
  } catch {
    return undefined
  }
}

const defaultOtlpLoader: OtlpLoader = async () => {
  const sdk = await tryImport<SdkMetricsModule>("@opentelemetry/sdk-metrics")
  const otlp = await tryImport<OtlpExporterModule>("@opentelemetry/exporter-metrics-otlp-http")
  const missing: string[] = []
  if (sdk === undefined) missing.push("@opentelemetry/sdk-metrics")
  if (otlp === undefined) missing.push("@opentelemetry/exporter-metrics-otlp-http")
  if (missing.length > 0) throw new OtelDepsMissingError(missing)
  // Narrowing — both are defined here.
  return { sdk: sdk as SdkMetricsModule, otlp: otlp as OtlpExporterModule }
}

const defaultPrometheusLoader: PrometheusLoader = async () => {
  const sdk = await tryImport<SdkMetricsModule>("@opentelemetry/sdk-metrics")
  const prom = await tryImport<PrometheusExporterModule>("@opentelemetry/exporter-prometheus")
  const missing: string[] = []
  if (sdk === undefined) missing.push("@opentelemetry/sdk-metrics")
  if (prom === undefined) missing.push("@opentelemetry/exporter-prometheus")
  if (missing.length > 0) throw new OtelDepsMissingError(missing)
  return { sdk: sdk as SdkMetricsModule, prom: prom as PrometheusExporterModule }
}

// ────────────────────────────────────────────────────────────────────────────
// Resource helper — newer SDK accepts a plain attrs object, older needs
// `new Resource(attrs)`. We branch on presence of the `Resource` ctor.
// ────────────────────────────────────────────────────────────────────────────

const buildResource = (sdk: SdkMetricsModule, attrs: Readonly<Record<string, string>>): unknown => {
  const ResourceCtor = sdk.Resource
  if (ResourceCtor !== undefined) return new ResourceCtor(attrs)
  return attrs
}

const DEFAULT_RESOURCE_ATTRS: Readonly<Record<string, string>> = Object.freeze({
  "service.name": "quanta",
})

const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318/v1/metrics"
const DEFAULT_OTLP_INTERVAL_MS = 5000

// ────────────────────────────────────────────────────────────────────────────
// Public factories
// ────────────────────────────────────────────────────────────────────────────

/** Build a `MetricSink` backed by an OTLP HTTP exporter. Lazily imports the
 *  OTel SDK packages — if missing, rejects with `OtelDepsMissingError`. The
 *  returned `shutdown` calls `MeterProvider.shutdown()` for graceful cleanup
 *  on agent exit. */
export const otlpHttpMetricSink = async (opts?: OtlpHelperOpts): Promise<HelperResult> => {
  const endpoint = opts?.endpoint ?? DEFAULT_OTLP_ENDPOINT
  const intervalMs = opts?.intervalMs ?? DEFAULT_OTLP_INTERVAL_MS
  const resourceAttrs = opts?.resourceAttrs ?? DEFAULT_RESOURCE_ATTRS
  const loader = opts?.__loader ?? defaultOtlpLoader

  const { sdk, otlp } = await loader()

  const exporterOpts: OtlpExporterCtorOpts =
    opts?.headers === undefined ? { url: endpoint } : { url: endpoint, headers: opts.headers }
  const exporter = new otlp.OTLPMetricExporter(exporterOpts)
  const reader = new sdk.PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: intervalMs,
  })
  const meterProvider = new sdk.MeterProvider({
    readers: [reader],
    resource: buildResource(sdk, resourceAttrs),
  })

  const sink = otelMetricsSink({ meterProvider })
  return {
    sink,
    shutdown: () => meterProvider.shutdown(),
  }
}

/** Build a `MetricSink` backed by a Prometheus HTTP scrape exporter. Lazily
 *  imports the OTel SDK packages — if missing, rejects with
 *  `OtelDepsMissingError`. The exporter spins up an HTTP server on `port`
 *  serving `endpoint`; `shutdown` tears it down. */
export const prometheusMetricSink = async (opts?: PrometheusHelperOpts): Promise<HelperResult> => {
  const resourceAttrs = opts?.resourceAttrs ?? DEFAULT_RESOURCE_ATTRS
  const loader = opts?.__loader ?? defaultPrometheusLoader

  const { sdk, prom } = await loader()

  const exporterOpts: PrometheusExporterCtorOpts = {}
  const writableExporterOpts = exporterOpts as {
    port?: number
    endpoint?: string
  }
  if (opts?.port !== undefined) writableExporterOpts.port = opts.port
  if (opts?.endpoint !== undefined) writableExporterOpts.endpoint = opts.endpoint

  // PrometheusExporter is itself a MetricReader AND a partial MeterProvider
  // wrapper in upstream OTel, but the recommended pattern is to attach it as
  // a reader on a MeterProvider. We do that here so the resource attrs +
  // shutdown semantics match the OTLP path.
  const exporter = new prom.PrometheusExporter(exporterOpts)
  const meterProvider = new sdk.MeterProvider({
    readers: [exporter],
    resource: buildResource(sdk, resourceAttrs),
  })

  const sink = otelMetricsSink({ meterProvider })
  return {
    sink,
    shutdown: () => meterProvider.shutdown(),
  }
}
