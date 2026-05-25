/**
 * OTLP/HTTP exporter — hellgate (ADR-0268).
 *
 * Seals the realtime export wiring across 16 cases:
 *
 *   HELL-01: 1 span → 1 POST to `/v1/traces` w/ application/json content type
 *   HELL-02: batch-size reach triggers immediate flush
 *   HELL-03: flush-interval timer triggers a flush (manual tick via fake)
 *   HELL-04: teardown flushes + clears the interval timer
 *   HELL-05: fetch failure leaves the buffer populated (retry on next flush)
 *   HELL-06: 1000 spans across multiple batches → N POST calls
 *   HELL-07: 1 metric → 1 POST to `/v1/metrics`
 *   HELL-08: service.name present in every export envelope
 *   HELL-09: empty buffer flush → 0 fetch calls
 *   HELL-10: injected clock drives start/end nanos
 *   HELL-11: traceId is 32-hex lowercase, spanId is 16-hex lowercase
 *   HELL-12: parentSpanId omitted on root, present on child
 *   HELL-13: attributes carry string/number/boolean across the wire
 *   HELL-14: large attribute value (1KB) passes through unchanged (no truncate)
 *   HELL-15: attachOtelExporterFromEnv returns undefined when env unset
 *   HELL-16: attachOtelExporterFromEnv wires endpoint + serviceName from env
 *
 * Test seam: fake `fetch` + fake `setInterval`/`clearInterval` so timers are
 * deterministic. The fake fetch records URL + body for assertions.
 */

import { describe, expect, test } from "bun:test"
import {
  attachOtelExporterFromEnv,
  buildExportingTracer,
  type ExportMetric,
  type ExportSpan,
  exporterMetricSink,
  type IntervalHandle,
  otelHttpExporter,
} from "@/observability/otel-exporter"

// ────────────────────────────────────────────────────────────────────────────
// Fake fetch — records every call so tests can assert URL / headers / body.
// ────────────────────────────────────────────────────────────────────────────

interface CapturedCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

const urlOf = (input: unknown): string => {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return String(input)
}

// `HeadersInit` is the structural union the DOM lib uses (string[][] | Record |
// Headers). We accept `unknown` to dodge a `lib.dom` dep + assert the variants
// via `instanceof` / `Array.isArray` below.
const headersOf = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (raw === undefined) return out
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(raw)) {
    for (const pair of raw) {
      const k = pair[0]
      const v = pair[1]
      if (k !== undefined && v !== undefined) out[k] = v
    }
    return out
  }
  Object.assign(out, raw as Record<string, string>)
  return out
}

const makeFakeFetch = (
  responses: Array<{ ok: boolean; status: number }> = [{ ok: true, status: 200 }],
): {
  fetch: typeof fetch
  calls: CapturedCall[]
} => {
  const calls: CapturedCall[] = []
  let cursor = 0
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const initSafe = init ?? {}
    calls.push({
      url: urlOf(input),
      method: initSafe.method ?? "GET",
      headers: headersOf(initSafe.headers),
      body: typeof initSafe.body === "string" ? initSafe.body : "",
    })
    const r = responses[cursor] ?? responses[responses.length - 1] ?? { ok: true, status: 200 }
    cursor++
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake Response shape
    return { ok: r.ok, status: r.status } as any
  }
  // Bun's typeof fetch has a `preconnect` method we don't fake — cast through
  // unknown so the fake works wherever `typeof fetch` is required.
  return { fetch: f as unknown as typeof fetch, calls }
}

/** Fake setInterval/clearInterval that captures the callback so the test can
 *  manually invoke it (deterministic time-based flush testing). */
const makeFakeTimer = (): {
  setIntervalImpl: (cb: () => void, ms: number) => IntervalHandle
  clearIntervalImpl: (h: IntervalHandle) => void
  ticks: number
  fireTick: () => void
  clearedCount: number
} => {
  const state = {
    cb: undefined as undefined | (() => void),
    ms: 0,
    ticks: 0,
    clearedCount: 0,
  }
  return {
    setIntervalImpl(cb, ms): IntervalHandle {
      state.cb = cb
      state.ms = ms
      return Symbol("fake-interval")
    },
    clearIntervalImpl(_h): void {
      state.clearedCount++
      state.cb = undefined
    },
    get ticks() {
      return state.ticks
    },
    fireTick() {
      state.ticks++
      const fn = state.cb
      if (fn !== undefined) fn()
    },
    get clearedCount() {
      return state.clearedCount
    },
  }
}

const ENDPOINT = "http://localhost:4318"

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("otel-exporter / OTLP HTTP", () => {
  test("HELL-01: 1 span → POST /v1/traces + Content-Type JSON", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
    })
    exp.recordSpan({
      traceId: "0".repeat(31) + "1",
      spanId: "0".repeat(15) + "1",
      name: "tool.bash",
      startTimeEpochMs: 1_000,
      endTimeEpochMs: 2_000,
    })
    await exp.flush()
    expect(calls.length).toBe(1)
    const c = calls[0]
    expect(c).toBeDefined()
    expect(c?.url).toBe(`${ENDPOINT}/v1/traces`)
    expect(c?.method).toBe("POST")
    expect(c?.headers["Content-Type"]).toBe("application/json")
    const body = JSON.parse(c?.body ?? "{}")
    expect(body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name).toBe("tool.bash")
    await exp.teardown()
  })

  test("HELL-02: batch-size reach triggers immediate flush + body carries all 3 batched spans", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 3,
    })
    const mk = (i: number): ExportSpan => ({
      traceId: `${i}`.padStart(32, "0"),
      spanId: `${i}`.padStart(16, "0"),
      name: `span-${i}`,
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
    })
    exp.recordSpan(mk(1))
    expect(calls.length).toBe(0)
    exp.recordSpan(mk(2))
    expect(calls.length).toBe(0)
    exp.recordSpan(mk(3))
    // Sync recordSpan triggers a fire-and-forget flush. Yield a microtask.
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(calls.length).toBe(1)
    // Audit-strengthen: previous version only checked `calls.length===1`.
    // A regression that flushed a SINGLE span instead of all 3 in the batch
    // would slip past that check. Verify the POST body actually carries the
    // 3 batched spans (the spec for "batch flush" is multi-span-per-POST).
    const body = JSON.parse(calls[0]?.body ?? "{}")
    const spans: Array<{ name: string }> = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? []
    expect(spans.length).toBe(3)
    expect(spans.map((s) => s.name).sort()).toEqual(["span-1", "span-2", "span-3"])
    await exp.teardown()
  })

  test("HELL-03: flush interval tick triggers a flush", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 100, // high so we don't trigger batch flush
      flushIntervalMs: 5000,
    })
    exp.recordSpan({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "x",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
    })
    expect(calls.length).toBe(0)
    timer.fireTick()
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(calls.length).toBe(1)
    await exp.teardown()
  })

  test("HELL-04: teardown clears the interval + flushes pending", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 100,
      flushIntervalMs: 5000,
    })
    exp.recordSpan({
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      name: "td",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
    })
    await exp.teardown()
    expect(calls.length).toBe(1) // teardown flushed
    expect(timer.clearedCount).toBe(1) // and cleared the interval
  })

  test("HELL-05: fetch failure leaves buffer populated + second flush re-POSTs the SAME span body", async () => {
    const { fetch, calls } = makeFakeFetch([
      { ok: false, status: 500 },
      { ok: true, status: 200 },
    ])
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 100,
    })
    exp.recordSpan({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      name: "retry-me",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
    })
    await exp.flush()
    expect(calls.length).toBe(1)
    // First failed; second flush should still POST (buffer was preserved).
    await exp.flush()
    expect(calls.length).toBe(2)
    // Audit-strengthen: previous test only checked the POST count. A
    // regression that retried with an EMPTY buffer (e.g., clearing on
    // failure instead of on success) would still produce `calls.length===2`
    // — the second body would just be empty. Pin that the SAME span
    // payload is re-POSTed.
    const firstBody = JSON.parse(calls[0]?.body ?? "{}")
    const secondBody = JSON.parse(calls[1]?.body ?? "{}")
    const firstSpan = firstBody.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
    const secondSpan = secondBody.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
    expect(firstSpan?.name).toBe("retry-me")
    expect(secondSpan?.name).toBe("retry-me")
    expect(secondSpan?.traceId).toBe(firstSpan?.traceId)
    expect(secondSpan?.spanId).toBe(firstSpan?.spanId)
    await exp.teardown()
  })

  test("HELL-05b: post-success the buffer is DRAINED — a third flush is a no-op", async () => {
    // Audit-add: the dual invariant to HELL-05 — on success, the buffer
    // EMPTIES. A regression that retained the span post-success (double-
    // write hazard) is what we measure here.
    const { fetch, calls } = makeFakeFetch([{ ok: true, status: 200 }])
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 100,
    })
    exp.recordSpan({
      traceId: "9".repeat(32),
      spanId: "8".repeat(16),
      name: "single",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
    })
    await exp.flush()
    expect(calls.length).toBe(1)
    // No new span recorded — next flush MUST be a no-op (buffer drained).
    await exp.flush()
    expect(calls.length).toBe(1)
    await exp.flush()
    expect(calls.length).toBe(1)
    await exp.teardown()
  })

  test("HELL-06: 200 spans → all exported across one or more POST calls", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 50,
    })
    for (let i = 0; i < 200; i++) {
      exp.recordSpan({
        traceId: `${i}`.padStart(32, "0"),
        spanId: `${i}`.padStart(16, "0"),
        name: `s-${i}`,
        startTimeEpochMs: 0,
        endTimeEpochMs: 1,
      })
    }
    // Drain via repeated explicit flush — the in-flight serialization
    // coalesces concurrent flush triggers, so a single final flush may not
    // drain the buffer if items arrived during a prior flush. Loop until
    // empty.
    for (let i = 0; i < 10; i++) {
      await exp.flush()
      await new Promise<void>((r) => setTimeout(r, 5))
    }
    // Every span made it across the wire — sum span counts in each body.
    let exportedTotal = 0
    for (const c of calls) {
      const body = JSON.parse(c.body)
      const spans: unknown[] = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? []
      exportedTotal += spans.length
    }
    expect(exportedTotal).toBe(200)
    expect(calls.length).toBeGreaterThanOrEqual(1)
    await exp.teardown()
  })

  test("HELL-07: 1 metric → POST /v1/metrics", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
    })
    const m: ExportMetric = {
      name: "tool_calls_total",
      kind: "counter",
      value: 1,
      timeEpochMs: 1_000,
    }
    exp.recordMetric(m)
    await exp.flush()
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe(`${ENDPOINT}/v1/metrics`)
    const body = JSON.parse(calls[0]?.body ?? "{}")
    const metricEnt = body.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.[0]
    expect(metricEnt?.name).toBe("tool_calls_total")
    expect(metricEnt?.sum?.isMonotonic).toBe(true)
    await exp.teardown()
  })

  test("HELL-08: service.name present in every envelope (spans + metrics)", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
      serviceName: "my-quanta",
    })
    exp.recordSpan({
      traceId: "e".repeat(32),
      spanId: "f".repeat(16),
      name: "x",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
    })
    await exp.flush()
    exp.recordMetric({ name: "m", kind: "counter", value: 1, timeEpochMs: 0 })
    await exp.flush()
    expect(calls.length).toBe(2)
    for (const c of calls) {
      const body = JSON.parse(c.body)
      const resourceAttrs = (body.resourceSpans ?? body.resourceMetrics)?.[0]?.resource?.attributes
      const svc = resourceAttrs?.find((a: { key: string }) => a.key === "service.name")
      expect(svc?.value?.stringValue).toBe("my-quanta")
    }
    await exp.teardown()
  })

  test("HELL-09: empty buffer flush → 0 fetch calls", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
    })
    await exp.flush()
    expect(calls.length).toBe(0)
    await exp.teardown()
    expect(calls.length).toBe(0)
  })

  test("HELL-10: injected clock drives start/end nanos", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    let t = 1000
    const now = (): number => t
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
      now,
    })
    const tracer = buildExportingTracer(exp, { now })
    const s = tracer.startSpan("t")
    t = 5000 // advance
    s.end()
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(calls.length).toBe(1)
    const body = JSON.parse(calls[0]?.body ?? "{}")
    const exported = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
    expect(exported?.startTimeUnixNano).toBe(`${1000 * 1_000_000}`)
    expect(exported?.endTimeUnixNano).toBe(`${5000 * 1_000_000}`)
    await exp.teardown()
  })

  test("HELL-11: trace/span IDs are W3C-shaped hex when produced by exporting tracer", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
    })
    const tracer = buildExportingTracer(exp)
    const s = tracer.startSpan("x")
    s.end()
    await new Promise<void>((r) => setTimeout(r, 5))
    const body = JSON.parse(calls[0]?.body ?? "{}")
    const exported = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
    expect(exported?.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(exported?.spanId).toMatch(/^[0-9a-f]{16}$/)
    await exp.teardown()
  })

  test("HELL-12: parentSpanId omitted on root, present on child", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
    })
    const tracer = buildExportingTracer(exp)
    const root = tracer.startSpan("root")
    const child = tracer.startSpan("child", { parent: root })
    child.end()
    await new Promise<void>((r) => setTimeout(r, 5))
    root.end()
    await new Promise<void>((r) => setTimeout(r, 5))

    expect(calls.length).toBe(2)
    const childBody = JSON.parse(calls[0]?.body ?? "{}")
    const childSpan = childBody.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
    expect(childSpan?.parentSpanId).toBe(root.context.spanId)
    expect(childSpan?.traceId).toBe(root.context.traceId)

    const rootBody = JSON.parse(calls[1]?.body ?? "{}")
    const rootSpan = rootBody.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]
    expect(rootSpan?.parentSpanId).toBeUndefined()
    await exp.teardown()
  })

  test("HELL-13: attributes carry string + number + boolean across wire", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
    })
    exp.recordSpan({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "x",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
      attributes: { str: "hello", num: 42, bool: true },
    })
    await exp.flush()
    const body = JSON.parse(calls[0]?.body ?? "{}")
    const attrs: Array<{ key: string; value: Record<string, unknown> }> =
      body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.attributes ?? []
    const byKey: Record<string, Record<string, unknown>> = {}
    for (const a of attrs) byKey[a.key] = a.value
    expect(byKey.str?.stringValue).toBe("hello")
    expect(byKey.num?.doubleValue).toBe(42)
    expect(byKey.bool?.boolValue).toBe(true)
    await exp.teardown()
  })

  test("HELL-14: 1KB attribute value passes through unchanged", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
    })
    const big = "x".repeat(1024)
    exp.recordSpan({
      traceId: "c".repeat(32),
      spanId: "d".repeat(16),
      name: "big",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
      attributes: { payload: big },
    })
    await exp.flush()
    const body = JSON.parse(calls[0]?.body ?? "{}")
    const attrs: Array<{ key: string; value: { stringValue?: string } }> =
      body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.attributes ?? []
    const payload = attrs.find((a) => a.key === "payload")
    expect(payload?.value?.stringValue?.length).toBe(1024)
    expect(payload?.value?.stringValue).toBe(big)
    await exp.teardown()
  })
})

describe("otel-exporter / endpoint normalisation + teardown idempotence", () => {
  test("HELL-18: endpoint with trailing slash normalises to {root}/v1/traces (no //v1/)", async () => {
    // Audit-add: source (otel-exporter.ts L380) strips a single trailing
    // slash so `${endpoint}/v1/traces` doesn't collapse to `${root}//v1/`.
    // The behaviour was untested — a regression that swapped slice(0, -1)
    // for slice(1) (off-by-one) would slip past every existing case.
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: `${ENDPOINT}/`, // ← trailing slash
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
    })
    exp.recordSpan({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      name: "norm",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
    })
    await exp.flush()
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe(`${ENDPOINT}/v1/traces`)
    // Defence: no `//` in the URL — that is the regression we want to catch.
    expect(calls[0]?.url).not.toContain("//v1")
    // path scheme `http://` does contain `//` legitimately — narrow check.
    expect(calls[0]?.url.replace("http://", "")).not.toContain("//")
    await exp.teardown()
  })

  test("HELL-19: teardown is idempotent — calling twice does NOT double-clear or re-POST", async () => {
    // Audit-add: teardown clears the interval + flushes. If the second
    // teardown also flushed (instead of being a no-op on the now-empty
    // buffer), we could accidentally POST stale data after process shutdown.
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 100,
      flushIntervalMs: 5000,
    })
    exp.recordSpan({
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      name: "td",
      startTimeEpochMs: 0,
      endTimeEpochMs: 1,
    })
    await exp.teardown()
    const callsAfterFirst = calls.length
    expect(callsAfterFirst).toBe(1)
    // Second teardown: must be a no-op on the POST channel.
    await exp.teardown()
    expect(calls.length).toBe(callsAfterFirst)
  })
})

describe("otel-exporter / env composition", () => {
  test("HELL-15: attachOtelExporterFromEnv returns undefined when env unset", () => {
    const result = attachOtelExporterFromEnv({})
    expect(result).toBeUndefined()
  })

  test("HELL-15b: also undefined for whitespace-only endpoint", () => {
    const result = attachOtelExporterFromEnv({ QUANTA_OTEL_ENDPOINT: "  \t " })
    expect(result).toBeUndefined()
  })

  test("HELL-16: env sets endpoint + serviceName, returns wired triple", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const result = attachOtelExporterFromEnv(
      {
        QUANTA_OTEL_ENDPOINT: "http://collector:4318",
        QUANTA_OTEL_SERVICE_NAME: "env-svc",
      },
      {
        fetch,
        setIntervalImpl: timer.setIntervalImpl,
        clearIntervalImpl: timer.clearIntervalImpl,
        batchSize: 1,
      },
    )
    expect(result).toBeDefined()
    if (result === undefined) throw new Error("unreachable") // narrowing
    result.metricSink.send({
      name: "x",
      kind: "counter",
      value: 1,
      at: 0,
    })
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe("http://collector:4318/v1/metrics")
    const body = JSON.parse(calls[0]?.body ?? "{}")
    const svc = body.resourceMetrics?.[0]?.resource?.attributes?.find(
      (a: { key: string }) => a.key === "service.name",
    )
    expect(svc?.value?.stringValue).toBe("env-svc")
    await result.exporter.teardown()
  })
})

describe("otel-exporter / sink adapter", () => {
  test("HELL-17: exporterMetricSink forwards MetricSample → recordMetric", async () => {
    const { fetch, calls } = makeFakeFetch()
    const timer = makeFakeTimer()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      setIntervalImpl: timer.setIntervalImpl,
      clearIntervalImpl: timer.clearIntervalImpl,
      batchSize: 1,
    })
    const sink = exporterMetricSink(exp)
    sink.send({ name: "h", kind: "histogram", value: 12.5, at: 1000, labels: { tag: "v" } })
    await new Promise<void>((r) => setTimeout(r, 5))
    expect(calls.length).toBe(1)
    const body = JSON.parse(calls[0]?.body ?? "{}")
    const m = body.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.[0]
    expect(m?.name).toBe("h")
    expect(m?.histogram?.dataPoints?.[0]?.sum).toBe(12.5)
    await exp.teardown()
  })
})
