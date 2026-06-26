/**
 * jun-26 bench OTLP live-trace attach seam (ADR-0268).
 *
 * The bench entry binaries (apps/bench/cli.ts — the box + primary local entry —
 * and apps/bench/index.ts — legacy direct-invoke) must register the OTLP span
 * exporter as the process-global span sink so the agent loop's existing span emit
 * sites STREAM to the operator's collector. `attachBenchOtelExport(env)` is the
 * single tested seam both entries call.
 *
 * Asserts:
 *   - ON  : env has QUANTA_OTEL_ENDPOINT ⇒ a sink is registered AND a loop span
 *           flushed through it POSTs to <endpoint>/v1/traces (the emit sites go
 *           live). Service name from QUANTA_OTEL_SERVICE_NAME rides the resource.
 *   - OFF : env unset ⇒ NO sink registered (byte-identical Default-OFF) and NO
 *           POST ever happens — the loop is unchanged.
 *
 * Injected env + fake fetch/clock/no-timer make the seam deterministic (no real
 * network, no real timers).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { attachBenchOtelExport } from "@/apps/bench/otel"
import {
  __resetSpanSink,
  endSpan,
  getSpanSink,
  SPAN_NAMES,
  startSpan,
} from "@/observability/spans"
import { __resetDefaultMetricSink } from "@/observability/metrics/in-memory-registry"

const ENDPOINT = "http://127.0.0.1:4318"

interface Captured {
  readonly url: string
  readonly body: string
}
const makeFakeFetch = (): { fetch: typeof fetch; calls: Captured[] } => {
  const calls: Captured[] = []
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      body: typeof init?.body === "string" ? init.body : "",
    })
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake Response
    return { ok: true, status: 200 } as any
  }
  return { fetch: f as unknown as typeof fetch, calls }
}

// Disable the real flush timer — teardown drives the only flush.
const noTimer = {
  setIntervalImpl: () => Symbol("noop") as unknown,
  clearIntervalImpl: () => {},
}

const spansOf = (body: string): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = []
  const env = JSON.parse(body) as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key?: string; value?: { stringValue?: string } }> }
      scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }>
    }>
  }
  for (const rs of env.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) out.push(s)
  return out
}

const serviceNameOf = (body: string): string | undefined => {
  const env = JSON.parse(body) as {
    resourceSpans?: Array<{
      resource?: { attributes?: Array<{ key?: string; value?: { stringValue?: string } }> }
    }>
  }
  const attrs = env.resourceSpans?.[0]?.resource?.attributes ?? []
  return attrs.find((a) => a.key === "service.name")?.value?.stringValue
}

afterEach(() => {
  __resetSpanSink()
  __resetDefaultMetricSink()
})

describe("bench OTEL attach seam (attachBenchOtelExport)", () => {
  test("ON: endpoint set ⇒ sink registered + loop span POSTs to /v1/traces with service name", async () => {
    const { fetch, calls } = makeFakeFetch()
    const installed = attachBenchOtelExport(
      {
        QUANTA_OTEL_ENDPOINT: ENDPOINT,
        QUANTA_OTEL_SERVICE_NAME: "quanta-bench-box",
      },
      { fetch, flushIntervalMs: 0, ...noTimer },
    )
    // The emit sites are now live — previously the sink was null (no-op).
    expect(getSpanSink()).not.toBeNull()
    expect(installed.exporter).not.toBeNull()

    // Drive a real loop emit site (same call the agent loop makes).
    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    endSpan(span, "ok", {})
    await installed.teardown()

    const traceCalls = calls.filter((c) => c.url === `${ENDPOINT}/v1/traces`)
    expect(traceCalls.length).toBeGreaterThanOrEqual(1)
    const allSpans = traceCalls.flatMap((c) => spansOf(c.body))
    expect(allSpans.length).toBe(1)
    expect(allSpans[0]?.name).toBe(SPAN_NAMES.sessionLoop)
    expect(serviceNameOf(traceCalls[0]?.body ?? "{}")).toBe("quanta-bench-box")
    // teardown restores the prior (null) sink — no leak across the process.
    expect(getSpanSink()).toBeNull()
  })

  test("OFF: endpoint unset ⇒ no sink, no POST (byte-identical Default-OFF)", async () => {
    const { fetch, calls } = makeFakeFetch()
    const before = getSpanSink()
    const installed = attachBenchOtelExport({}, { fetch })
    expect(installed.exporter).toBeNull()
    // Sink unchanged — still whatever it was (null in a fresh process).
    expect(getSpanSink()).toBe(before)

    // Loop emit sites stay no-op — nothing ships.
    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    endSpan(span, "ok", {})
    await installed.teardown()
    expect(calls.length).toBe(0)
  })

  test("OFF: blank/whitespace endpoint is treated as unset (no silent localhost)", () => {
    const { fetch } = makeFakeFetch()
    const installed = attachBenchOtelExport({ QUANTA_OTEL_ENDPOINT: "  \t " }, { fetch })
    expect(installed.exporter).toBeNull()
    expect(getSpanSink()).toBeNull()
  })
})
