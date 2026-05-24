/**
 * OTel Resource auto-enrichment — hellgate (ADR-0163).
 *
 * Seals `buildOtelResourceAttrs` (10 cases) across:
 *   A. Pure function defaults + overrides (6)
 *   B. Test-seam injection (2)
 *   C. otlp-helper integration via `autoResource` opt-in (2)
 *
 * Posture matched in tests:
 *   - service.namespace OMITTED when env unset (case A6 enforces exactOptional).
 *   - opts.extra overrides auto-detected attrs (case A5).
 *   - autoResource integration is opt-in — absent ⇒ byte-identical to ADR-0155
 *     (case C10).
 */

import { describe, expect, test } from "bun:test"
import { buildOtelResourceAttrs } from "@/observability/metrics/otel-resource"
import { otlpHttpMetricSink } from "@/observability/metrics/otlp-helper"

// ────────────────────────────────────────────────────────────────────────────
// Helpers — fake loader matching the otlp-helper test seam shape (kept local
// to avoid coupling to the otlp-helper hellgate's private fake fabric).
// ────────────────────────────────────────────────────────────────────────────

const makeFakeLoader = (): {
  loader: NonNullable<NonNullable<Parameters<typeof otlpHttpMetricSink>[0]>["__loader"]>
  capturedResource: { value: unknown }
} => {
  const capturedResource: { value: unknown } = { value: undefined }

  class FakeOtlpExporter {}
  class FakeReader {}
  class FakeMeterProvider {
    constructor(opts: { readers: ReadonlyArray<unknown>; resource?: unknown }) {
      capturedResource.value = opts.resource
    }
    getMeter(_name: string, _version?: string): unknown {
      return {
        createCounter: () => ({ add: () => {} }),
        createHistogram: () => ({ record: () => {} }),
        createUpDownCounter: () => ({ add: () => {} }),
      }
    }
    async shutdown(): Promise<void> {
      // no-op
    }
  }

  const loader = async () =>
    ({
      sdk: {
        PeriodicExportingMetricReader: FakeReader,
        MeterProvider: FakeMeterProvider,
      },
      otlp: { OTLPMetricExporter: FakeOtlpExporter },
      // biome-ignore lint/suspicious/noExplicitAny: fake module shape
    }) as any

  return { loader, capturedResource }
}

// ────────────────────────────────────────────────────────────────────────────
// A. Pure function (6)
// ────────────────────────────────────────────────────────────────────────────
describe("otel-resource / A. pure function", () => {
  test("HELL-A1: empty opts → service.name default + service.instance.id w/ pid + runtime name in {bun,node}", () => {
    const attrs = buildOtelResourceAttrs({ env: {} })
    expect(attrs["service.name"]).toBe("quanta")
    // service.instance.id is "<hostname>-<pid>" — ends with `-${pid}`.
    expect(attrs["service.instance.id"]).toMatch(new RegExp(`-${process.pid}$`))
    const runtimeName = attrs["process.runtime.name"] ?? ""
    expect(["bun", "node"]).toContain(runtimeName)
    expect(typeof attrs["process.runtime.version"]).toBe("string")
    expect(attrs["process.pid"]).toBe(String(process.pid))
    // deployment.environment defaults to "unknown" when env empty.
    expect(attrs["deployment.environment"]).toBe("unknown")
  })

  test("HELL-A2: opts.serviceName overrides env + default", () => {
    const attrs = buildOtelResourceAttrs({
      serviceName: "explicit-name",
      env: { QUANTA_SERVICE_NAME: "env-name" },
    })
    expect(attrs["service.name"]).toBe("explicit-name")
  })

  test("HELL-A3: env.QUANTA_VERSION populates service.version", () => {
    const attrs = buildOtelResourceAttrs({ env: { QUANTA_VERSION: "9.9.9-test" } })
    expect(attrs["service.version"]).toBe("9.9.9-test")
  })

  test("HELL-A4: opts.deploymentEnv wins over env.QUANTA_DEPLOYMENT_ENV", () => {
    const attrs = buildOtelResourceAttrs({
      deploymentEnv: "prod",
      env: { QUANTA_DEPLOYMENT_ENV: "staging" },
    })
    expect(attrs["deployment.environment"]).toBe("prod")
  })

  test("HELL-A5: opts.extra overrides auto-detected attrs (host.name pinned)", () => {
    const attrs = buildOtelResourceAttrs({
      env: {},
      hostnameFn: () => "real-host",
      extra: { "host.name": "fake-host", "custom.key": "v" },
    })
    expect(attrs["host.name"]).toBe("fake-host")
    expect(attrs["custom.key"]).toBe("v")
  })

  test("HELL-A6: service.namespace OMITTED when env absent", () => {
    const attrs = buildOtelResourceAttrs({ env: {} })
    // exactOptional posture: the KEY must not exist (not undefined value).
    expect("service.namespace" in attrs).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. Test seams (2)
// ────────────────────────────────────────────────────────────────────────────
describe("otel-resource / B. test seams", () => {
  test("HELL-B7: hostnameFn + pidFn drive service.instance.id deterministically", () => {
    const attrs = buildOtelResourceAttrs({
      env: {},
      hostnameFn: () => "host-x",
      pidFn: () => 42,
    })
    expect(attrs["service.instance.id"]).toBe("host-x-42")
    expect(attrs["host.name"]).toBe("host-x")
    expect(attrs["process.pid"]).toBe("42")
  })

  test("HELL-B8: env injection populates service.version + namespace", () => {
    const attrs = buildOtelResourceAttrs({
      env: { QUANTA_VERSION: "1.2.3", QUANTA_NAMESPACE: "team-a" },
    })
    expect(attrs["service.version"]).toBe("1.2.3")
    expect(attrs["service.namespace"]).toBe("team-a")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. Integration with otlp-helper (2)
// ────────────────────────────────────────────────────────────────────────────
describe("otel-resource / C. otlp-helper integration", () => {
  test("HELL-C9: autoResource: true → MeterProvider receives enriched attrs", async () => {
    const fake = makeFakeLoader()
    await otlpHttpMetricSink({ __loader: fake.loader, autoResource: true })
    const resource = fake.capturedResource.value as Record<string, string>
    // Default service.name preserved; enrichment adds service.instance.id +
    // host.name + process.* attributes.
    expect(resource["service.name"]).toBe("quanta")
    expect(typeof resource["service.instance.id"]).toBe("string")
    expect(typeof resource["host.name"]).toBe("string")
    expect(resource["process.pid"]).toBe(String(process.pid))
    const runtimeName = resource["process.runtime.name"] ?? ""
    expect(["bun", "node"]).toContain(runtimeName)
  })

  test("HELL-C10: no autoResource → byte-identical resource attrs (ADR-0155 default)", async () => {
    const fake = makeFakeLoader()
    await otlpHttpMetricSink({ __loader: fake.loader })
    const resource = fake.capturedResource.value as Record<string, string>
    // Byte-identical to the prior default: a single `service.name` key.
    expect(resource).toEqual({ "service.name": "quanta" })
  })
})
