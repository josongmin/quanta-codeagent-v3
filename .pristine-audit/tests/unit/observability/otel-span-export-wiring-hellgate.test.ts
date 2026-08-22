/**
 * HELLGATE — span-export WIRING (the built-not-wired last mile).
 *
 * The gap this seals: the agent loop emitted spans (`startSpan`/`endSpan`) and
 * the OTLP exporter existed + was tested, but NOTHING called `setSpanSink` in
 * production — so `QUANTA_OTEL_ENDPOINT` was a dead knob and every span was
 * discarded to the null sink. `installOtelSpanExportFromEnv` is the host wire;
 * this proves it end-to-end:
 *
 *   env{QUANTA_OTEL_ENDPOINT} → install → startSpan/endSpan → teardown
 *     ⇒ a REAL OTLP/HTTP POST to <endpoint>/v1/traces carrying the span.
 *
 * RED-ON-INJECTION (teeth, verified in-session): deleting the `setSpanSink(...)`
 * call inside `installOtelSpanExportFromEnv` makes ON-CASE-1 (the POST) and the
 * parent-linkage case fail — spans go nowhere.
 */

import { afterEach, describe, expect, test } from "bun:test"
import {
  __resetSpanSink,
  endSpan,
  getSpanSink,
  SPAN_NAMES,
  setSpanSink,
  startSpan,
} from "@/observability"
import {
  __resetDefaultMetricSink,
  defaultMetricsRegistry,
  getDefaultMetricSink,
} from "@/observability/metrics/in-memory-registry"
import type { ExportSpan, OtelExporter } from "@/observability/otel-exporter"
import {
  createExporterSpanSink,
  installOtelSpanExportFromEnv,
} from "@/observability/otel-span-export"

const ENDPOINT = "http://localhost:4318"

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

// Deterministic CSPRNG seam: each call returns distinct bytes (traceId=0x00…,
// span1=0x01…, span2=0x02…) so IDs are predictable AND distinct.
const makeSeq = (): ((n: number) => Uint8Array) => {
  let seed = 0
  return (n: number) => {
    const a = new Uint8Array(n)
    a.fill(seed & 0xff)
    seed++
    return a
  }
}

// Disable the real flush timer; teardown drives the only flush.
const noTimer = {
  setIntervalImpl: () => Symbol("noop") as unknown,
  clearIntervalImpl: () => {},
}

/** Flatten every span object out of an OTLP/JSON traces envelope. */
const spansOf = (body: string): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = []
  const env = JSON.parse(body) as {
    resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }>
  }
  for (const rs of env.resourceSpans ?? [])
    for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) out.push(s)
  return out
}

afterEach(() => {
  __resetSpanSink()
  __resetDefaultMetricSink()
})

describe("HELLGATE: span-export wiring (installOtelSpanExportFromEnv)", () => {
  test("ON: a span is POSTed to <endpoint>/v1/traces after install + teardown", async () => {
    const { fetch, calls } = makeFakeFetch()
    const installed = installOtelSpanExportFromEnv(
      { QUANTA_OTEL_ENDPOINT: ENDPOINT },
      { fetch, randomBytes: makeSeq(), flushIntervalMs: 0, ...noTimer },
    )
    // A sink IS now registered (the whole point — previously null).
    expect(getSpanSink()).not.toBeNull()

    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    endSpan(span, "ok", {})
    await installed.teardown()

    const traceCalls = calls.filter((c) => c.url.endsWith("/v1/traces"))
    expect(traceCalls.length).toBeGreaterThanOrEqual(1)
    const allSpans = traceCalls.flatMap((c) => spansOf(c.body))
    expect(allSpans.length).toBe(1)
    expect(allSpans[0]?.name).toBe(SPAN_NAMES.sessionLoop)
    expect(String(allSpans[0]?.traceId)).toMatch(/^[0-9a-f]{32}$/)
    expect(String(allSpans[0]?.spanId)).toMatch(/^[0-9a-f]{16}$/)
    // teardown restores the (null) sink
    expect(getSpanSink()).toBeNull()
  })

  test("PARENT LINKAGE: a nested span exports with the parent's spanId", async () => {
    const { fetch, calls } = makeFakeFetch()
    const installed = installOtelSpanExportFromEnv(
      { QUANTA_OTEL_ENDPOINT: ENDPOINT },
      { fetch, randomBytes: makeSeq(), flushIntervalMs: 0, ...noTimer },
    )
    const parent = startSpan(SPAN_NAMES.sessionLoop, {})
    const child = startSpan(SPAN_NAMES.turn, {})
    endSpan(child, "ok", {})
    endSpan(parent, "ok", {})
    await installed.teardown()

    const all = calls.filter((c) => c.url.endsWith("/v1/traces")).flatMap((c) => spansOf(c.body))
    const parentSpan = all.find((s) => s.name === SPAN_NAMES.sessionLoop)
    const childSpan = all.find((s) => s.name === SPAN_NAMES.turn)
    expect(parentSpan).toBeDefined()
    expect(childSpan).toBeDefined()
    // child's parent pointer == parent's spanId; root has no parent
    expect(childSpan?.parentSpanId).toBe(parentSpan?.spanId)
    expect(parentSpan?.parentSpanId).toBeUndefined()
    // both share the one trace
    expect(childSpan?.traceId).toBe(parentSpan?.traceId)
  })

  test("METRIC: a sink-less defaultMetricsRegistry ships to <endpoint>/v1/metrics", async () => {
    const { fetch, calls } = makeFakeFetch()
    const installed = installOtelSpanExportFromEnv(
      { QUANTA_OTEL_ENDPOINT: ENDPOINT },
      { fetch, flushIntervalMs: 0, ...noTimer },
    )
    // the process-default metric sink is now wired (previously null)
    expect(getDefaultMetricSink()).not.toBeNull()

    // a registry constructed with NO explicit sink picks up the default
    const reg = defaultMetricsRegistry()
    reg.increment("quanta.tool.invocations.total", 1, { tool: "bash" })
    await installed.teardown()

    const metricCalls = calls.filter((c) => c.url.endsWith("/v1/metrics"))
    expect(metricCalls.length).toBeGreaterThanOrEqual(1)
    expect(metricCalls.some((c) => c.body.includes("quanta.tool.invocations.total"))).toBe(true)
    // teardown restored the (null) default sink
    expect(getDefaultMetricSink()).toBeNull()
  })

  test("OFF: QUANTA_OTEL_ENDPOINT unset ⇒ no sink, no POST (byte-identical default)", async () => {
    const { fetch, calls } = makeFakeFetch()
    const installed = installOtelSpanExportFromEnv({}, { fetch })
    expect(installed.exporter).toBeNull()
    expect(getSpanSink()).toBeNull() // unchanged — still the no-op default

    const span = startSpan(SPAN_NAMES.sessionLoop, {})
    endSpan(span, "ok", {})
    await installed.teardown()
    expect(calls.length).toBe(0) // nothing shipped
  })

  // Direct createExporterSpanSink tests — a fake exporter capturing recordSpan.
  const fakeExporter = (): { exporter: OtelExporter; spans: ExportSpan[] } => {
    const spans: ExportSpan[] = []
    const exporter: OtelExporter = {
      recordSpan: (s) => spans.push(s),
      recordMetric: () => {},
      flush: async () => {},
      teardown: async () => {},
    }
    return { exporter, spans }
  }

  test("Q1: each ROOT span gets a fresh traceId (not one trace per process)", () => {
    const { exporter, spans } = fakeExporter()
    const sink = createExporterSpanSink(exporter, { randomBytes: makeSeq(), now: () => 1000 })
    // root #1 (open empty) → its own trace
    const r1 = sink.onStart(SPAN_NAMES.sessionLoop, {})
    sink.onEnd(r1, SPAN_NAMES.sessionLoop, "ok", 1, {})
    // root #2 (open empty again) → a DIFFERENT trace
    const r2 = sink.onStart(SPAN_NAMES.sessionLoop, {})
    sink.onEnd(r2, SPAN_NAMES.sessionLoop, "ok", 1, {})
    expect(spans).toHaveLength(2)
    expect(spans[0]?.traceId).not.toBe(spans[1]?.traceId) // two roots ⇒ two traces
  })

  test("Q1: a CHILD inherits its root's traceId", () => {
    const { exporter, spans } = fakeExporter()
    const sink = createExporterSpanSink(exporter, { randomBytes: makeSeq(), now: () => 1000 })
    const root = sink.onStart(SPAN_NAMES.sessionLoop, {})
    const child = sink.onStart(SPAN_NAMES.turn, {})
    sink.onEnd(child, SPAN_NAMES.turn, "ok", 1, {})
    sink.onEnd(root, SPAN_NAMES.sessionLoop, "ok", 1, {})
    const rootSpan = spans.find((s) => s.name === SPAN_NAMES.sessionLoop)
    const childSpan = spans.find((s) => s.name === SPAN_NAMES.turn)
    expect(childSpan?.traceId).toBe(rootSpan?.traceId) // child shares root's trace
    expect(childSpan?.parentSpanId).toBe(rootSpan?.spanId)
  })

  test("Q2: an OUT-OF-LIFO close does NOT drop the still-open sibling/child", () => {
    const { exporter, spans } = fakeExporter()
    const sink = createExporterSpanSink(exporter, { randomBytes: makeSeq(), now: () => 1000 })
    // A opens, B opens as A's child, then A closes BEFORE B (overlap — concurrent tools).
    const a = sink.onStart(SPAN_NAMES.sessionLoop, {})
    const b = sink.onStart(SPAN_NAMES.turn, {}) // parent = A
    sink.onEnd(a, SPAN_NAMES.sessionLoop, "ok", 1, {}) // close A out of order
    // C now opens — B must STILL be on the stack so C nests under B (not orphaned).
    const c = sink.onStart(SPAN_NAMES.handleToolCall, {})
    sink.onEnd(c, SPAN_NAMES.handleToolCall, "ok", 1, {})
    sink.onEnd(b, SPAN_NAMES.turn, "ok", 1, {})

    const spanA = spans.find((s) => s.name === SPAN_NAMES.sessionLoop)
    const spanB = spans.find((s) => s.name === SPAN_NAMES.turn)
    const spanC = spans.find((s) => s.name === SPAN_NAMES.handleToolCall)
    expect(spans).toHaveLength(3) // none dropped
    expect(spanB?.parentSpanId).toBe(spanA?.spanId) // B still child of A
    // RED-ON-INJECTION teeth: with the old `splice(idx)` bug, closing A would have
    // dropped B from the stack, so C would be a root (parentSpanId undefined).
    expect(spanC?.parentSpanId).toBe(spanB?.spanId) // C correctly nests under still-open B
  })

  test("ATTRS MERGE: onStart attrs (tool name/input) survive alongside onEnd attrs", () => {
    const { exporter, spans } = fakeExporter()
    const sink = createExporterSpanSink(exporter, { randomBytes: makeSeq(), now: () => 1000 })
    // open-time facts (tool name + input) at onStart; close-time facts (status +
    // output) at onEnd — exactly how dispatch.ts brackets a `handle_tool_call`.
    const tok = sink.onStart(SPAN_NAMES.handleToolCall, {
      "quanta.tool.name": "bash",
      "quanta.tool.input": "pytest -q",
    })
    sink.onEnd(tok, SPAN_NAMES.handleToolCall, "ok", 5, {
      "quanta.tool.call.status": "success",
      "quanta.tool.output": "5 passed",
    })
    const span = spans.find((s) => s.name === SPAN_NAMES.handleToolCall)
    // RED-ON-INJECTION teeth: the old bridge ignored onStart attrs entirely, so
    // tool.name + tool.input were silently absent from every exported trace.
    expect(span?.attributes?.["quanta.tool.name"]).toBe("bash")
    expect(span?.attributes?.["quanta.tool.input"]).toBe("pytest -q")
    // close attrs still present (the merge keeps both halves)
    expect(span?.attributes?.["quanta.tool.call.status"]).toBe("success")
    expect(span?.attributes?.["quanta.tool.output"]).toBe("5 passed")
  })

  test("ATTRS MERGE: a close attr WINS over a same-key open attr", () => {
    const { exporter, spans } = fakeExporter()
    const sink = createExporterSpanSink(exporter, { randomBytes: makeSeq(), now: () => 1000 })
    const tok = sink.onStart(SPAN_NAMES.handleToolCall, { "quanta.tool.call.status": "pending" })
    sink.onEnd(tok, SPAN_NAMES.handleToolCall, "ok", 1, { "quanta.tool.call.status": "success" })
    expect(spans[0]?.attributes?.["quanta.tool.call.status"]).toBe("success")
  })

  test("IDEMPOTENT: a pre-registered sink is NOT clobbered", async () => {
    const sentinel = { onStart: () => 0, onEnd: () => {} }
    setSpanSink(sentinel)
    const { fetch } = makeFakeFetch()
    const installed = installOtelSpanExportFromEnv(
      { QUANTA_OTEL_ENDPOINT: ENDPOINT },
      { fetch, ...noTimer },
    )
    expect(installed.exporter).toBeNull() // declined to install
    expect(getSpanSink()).toBe(sentinel) // owner kept control
    await installed.teardown()
  })
})
