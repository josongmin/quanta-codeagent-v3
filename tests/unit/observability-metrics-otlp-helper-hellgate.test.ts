/**
 * OTLP / Prometheus helper — hellgate (ADR-0155).
 *
 * Seals the lazy-import wiring factories `otlpHttpMetricSink` and
 * `prometheusMetricSink` across 2 sections — 8 cases total.
 *
 * Sections:
 *   A. OtelDepsMissingError surface (3) — default loader, typed error,
 *      install-hint message body.
 *   B. With injected loader (5)         — construction, shutdown, endpoint
 *      defaults, custom endpoint + headers, default resource attrs.
 *
 * The loader injection seam (`__loader`) avoids touching `node_modules` —
 * the test depends on zero OTel runtime.
 */

import { describe, expect, test } from "bun:test"
import {
  OtelDepsMissingError,
  otlpHttpMetricSink,
  prometheusMetricSink,
} from "@/observability/metrics/otlp-helper"

// ────────────────────────────────────────────────────────────────────────────
// Fake SDK / exporter surface
// ────────────────────────────────────────────────────────────────────────────

interface ExporterCtorCall {
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
}
interface ReaderCtorCall {
  readonly exportIntervalMillis?: number
  readonly hasExporter: boolean
}
interface MeterProviderCtorCall {
  readonly readerCount: number
  readonly resource: unknown
}

const makeFakeLoader = (): {
  loader: Parameters<typeof otlpHttpMetricSink>[0] extends infer T
    ? T extends { __loader?: infer L }
      ? NonNullable<L>
      : never
    : never
  exporterCalls: ExporterCtorCall[]
  readerCalls: ReaderCtorCall[]
  providerCalls: MeterProviderCtorCall[]
  shutdownCount: { value: number }
} => {
  const exporterCalls: ExporterCtorCall[] = []
  const readerCalls: ReaderCtorCall[] = []
  const providerCalls: MeterProviderCtorCall[] = []
  const shutdownCount = { value: 0 }

  class FakeOtlpExporter {
    constructor(opts: { url?: string; headers?: Readonly<Record<string, string>> }) {
      const call: ExporterCtorCall =
        opts.headers === undefined
          ? opts.url === undefined
            ? {}
            : { url: opts.url }
          : opts.url === undefined
            ? { headers: opts.headers }
            : { url: opts.url, headers: opts.headers }
      exporterCalls.push(call)
    }
  }
  class FakeReader {
    constructor(opts: { exporter: unknown; exportIntervalMillis?: number }) {
      const call: ReaderCtorCall =
        opts.exportIntervalMillis === undefined
          ? { hasExporter: opts.exporter !== undefined }
          : {
              hasExporter: opts.exporter !== undefined,
              exportIntervalMillis: opts.exportIntervalMillis,
            }
      readerCalls.push(call)
    }
  }
  class FakeMeterProvider {
    constructor(opts: { readers: ReadonlyArray<unknown>; resource?: unknown }) {
      providerCalls.push({ readerCount: opts.readers.length, resource: opts.resource })
    }
    getMeter(_name: string, _version?: string): unknown {
      return {
        createCounter: () => ({ add: () => {} }),
        createHistogram: () => ({ record: () => {} }),
        createUpDownCounter: () => ({ add: () => {} }),
      }
    }
    async shutdown(): Promise<void> {
      shutdownCount.value += 1
    }
  }

  const loader = async () =>
    ({
      sdk: {
        PeriodicExportingMetricReader: FakeReader,
        MeterProvider: FakeMeterProvider,
      },
      otlp: { OTLPMetricExporter: FakeOtlpExporter },
      // biome-ignore lint/suspicious/noExplicitAny: fake module shape — typing through OtlpLoader directly is verbose for a test fake
    }) as any

  return { loader, exporterCalls, readerCalls, providerCalls, shutdownCount }
}

const makeFakePromLoader = (): {
  loader: Parameters<typeof prometheusMetricSink>[0] extends infer T
    ? T extends { __loader?: infer L }
      ? NonNullable<L>
      : never
    : never
  promCtorCalls: Array<{ port?: number; endpoint?: string }>
  providerCalls: MeterProviderCtorCall[]
  shutdownCount: { value: number }
} => {
  const promCtorCalls: Array<{ port?: number; endpoint?: string }> = []
  const providerCalls: MeterProviderCtorCall[] = []
  const shutdownCount = { value: 0 }

  class FakePromExporter {
    constructor(opts: { port?: number; endpoint?: string }) {
      const call: { port?: number; endpoint?: string } =
        opts.port === undefined
          ? opts.endpoint === undefined
            ? {}
            : { endpoint: opts.endpoint }
          : opts.endpoint === undefined
            ? { port: opts.port }
            : { port: opts.port, endpoint: opts.endpoint }
      promCtorCalls.push(call)
    }
    getMeter(_name: string, _version?: string): unknown {
      return {
        createCounter: () => ({ add: () => {} }),
        createHistogram: () => ({ record: () => {} }),
        createUpDownCounter: () => ({ add: () => {} }),
      }
    }
    async shutdown(): Promise<void> {
      shutdownCount.value += 1
    }
  }
  class FakeMeterProvider {
    constructor(opts: { readers: ReadonlyArray<unknown>; resource?: unknown }) {
      providerCalls.push({ readerCount: opts.readers.length, resource: opts.resource })
    }
    getMeter(_name: string, _version?: string): unknown {
      return {
        createCounter: () => ({ add: () => {} }),
        createHistogram: () => ({ record: () => {} }),
        createUpDownCounter: () => ({ add: () => {} }),
      }
    }
    async shutdown(): Promise<void> {
      shutdownCount.value += 1
    }
  }

  const loader = async () =>
    ({
      sdk: {
        PeriodicExportingMetricReader: class {},
        MeterProvider: FakeMeterProvider,
      },
      prom: { PrometheusExporter: FakePromExporter },
      // biome-ignore lint/suspicious/noExplicitAny: fake module shape
    }) as any

  return { loader, promCtorCalls, providerCalls, shutdownCount }
}

// ────────────────────────────────────────────────────────────────────────────
// A. OtelDepsMissingError surface (3)
// ────────────────────────────────────────────────────────────────────────────
describe("otlp-helper / A. OtelDepsMissingError surface", () => {
  test("HELL-1: default loader (no installed deps) → rejects with OtelDepsMissingError", async () => {
    // The packages are not in node_modules → default loader collects misses
    // and throws the typed error.
    let caught: unknown
    try {
      await otlpHttpMetricSink()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(OtelDepsMissingError)
  })

  test("HELL-2: error.packages lists both missing modules", async () => {
    let caught: unknown
    try {
      await otlpHttpMetricSink()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(OtelDepsMissingError)
    const err = caught as OtelDepsMissingError
    expect(err.packages).toContain("@opentelemetry/sdk-metrics")
    expect(err.packages).toContain("@opentelemetry/exporter-metrics-otlp-http")
    expect(err.packages.length).toBe(2)
  })

  test("HELL-3: error.message contains bun install hint", async () => {
    let caught: unknown
    try {
      await otlpHttpMetricSink()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(OtelDepsMissingError)
    const err = caught as OtelDepsMissingError
    expect(err.message).toContain("bun add")
    expect(err.message).toContain("@opentelemetry/sdk-metrics")
    expect(err.message).toContain("@opentelemetry/exporter-metrics-otlp-http")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. With injected loader (5)
// ────────────────────────────────────────────────────────────────────────────
describe("otlp-helper / B. with injected loader", () => {
  test("HELL-4: successful construction → returns sink + shutdown", async () => {
    const fake = makeFakeLoader()
    const result = await otlpHttpMetricSink({ __loader: fake.loader })
    expect(typeof result.sink.send).toBe("function")
    expect(typeof result.shutdown).toBe("function")
    expect(fake.providerCalls.length).toBe(1)
    expect(fake.providerCalls[0]?.readerCount).toBe(1)
  })

  test("HELL-5: shutdown is callable and propagates to MeterProvider.shutdown()", async () => {
    const fake = makeFakeLoader()
    const result = await otlpHttpMetricSink({ __loader: fake.loader })
    expect(fake.shutdownCount.value).toBe(0)
    await result.shutdown()
    expect(fake.shutdownCount.value).toBe(1)
  })

  test("HELL-6: endpoint defaults to localhost:4318/v1/metrics", async () => {
    const fake = makeFakeLoader()
    await otlpHttpMetricSink({ __loader: fake.loader })
    expect(fake.exporterCalls.length).toBe(1)
    expect(fake.exporterCalls[0]?.url).toBe("http://localhost:4318/v1/metrics")
    // Default headers omitted (exactOptional — undefined, not {}).
    expect(fake.exporterCalls[0]?.headers).toBeUndefined()
    // Default interval forwarded to reader.
    expect(fake.readerCalls[0]?.exportIntervalMillis).toBe(5000)
  })

  test("HELL-7: custom endpoint + headers + interval forwarded to OTLPMetricExporter / reader", async () => {
    const fake = makeFakeLoader()
    await otlpHttpMetricSink({
      __loader: fake.loader,
      endpoint: "https://api.honeycomb.io/v1/metrics",
      headers: { "x-honeycomb-team": "secret-key" },
      intervalMs: 1000,
    })
    expect(fake.exporterCalls[0]?.url).toBe("https://api.honeycomb.io/v1/metrics")
    expect(fake.exporterCalls[0]?.headers).toEqual({ "x-honeycomb-team": "secret-key" })
    expect(fake.readerCalls[0]?.exportIntervalMillis).toBe(1000)
  })

  test("HELL-8: resource attrs default to {service.name:'quanta'}", async () => {
    const fake = makeFakeLoader()
    await otlpHttpMetricSink({ __loader: fake.loader })
    expect(fake.providerCalls.length).toBe(1)
    // SDK lacks Resource ctor in our fake → resource passed as plain attrs object.
    const resource = fake.providerCalls[0]?.resource as Record<string, string>
    expect(resource).toEqual({ "service.name": "quanta" })
  })

  test("HELL-9: prometheusMetricSink default loader → OtelDepsMissingError lists 2 prom packages", async () => {
    let caught: unknown
    try {
      await prometheusMetricSink()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(OtelDepsMissingError)
    const err = caught as OtelDepsMissingError
    expect(err.packages).toContain("@opentelemetry/sdk-metrics")
    expect(err.packages).toContain("@opentelemetry/exporter-prometheus")
  })

  test("HELL-10: prometheusMetricSink injected loader → sink + shutdown wired", async () => {
    const fake = makeFakePromLoader()
    const result = await prometheusMetricSink({
      __loader: fake.loader,
      port: 9999,
      endpoint: "/m",
    })
    expect(typeof result.sink.send).toBe("function")
    expect(fake.promCtorCalls[0]?.port).toBe(9999)
    expect(fake.promCtorCalls[0]?.endpoint).toBe("/m")
    expect(fake.providerCalls[0]?.readerCount).toBe(1)
    await result.shutdown()
    expect(fake.shutdownCount.value).toBe(1)
  })
})
