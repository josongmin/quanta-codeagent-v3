/**
 * Distributed tracing — hellgate (ADR-0186).
 *
 * Closed-port DI primitive: typed `Tracer` with 2 adapters (no-op default
 * + OTel) + W3C `TraceContextPropagator`. Hellgate seals 4 sections — 21
 * cases total.
 *
 * Sections:
 *   A. noop tracer                       (5)
 *   B. otelTracer with fake provider     (8)
 *   C. W3C propagator                    (5)
 *   D. withSpan integration              (3)
 */

import { describe, expect, test } from "bun:test"
import type {
  Span as OtelSpan,
  SpanOptions as OtelSpanOptions,
  Tracer as OtelTracerApi,
  TracerProvider as OtelTracerProvider,
} from "@opentelemetry/api"
import { SpanKind as OtelSpanKind, SpanStatusCode as OtelSpanStatusCode } from "@opentelemetry/api"
import {
  mapKind,
  noopTracer,
  otelTracer,
  type Span,
  type SpanContext,
  type SpanKind,
  w3cTraceContextPropagator,
} from "@/observability/tracing/index"

// ────────────────────────────────────────────────────────────────────────────
// Hex shape helpers (W3C: 32-hex traceId / 16-hex spanId, lowercase)
// ────────────────────────────────────────────────────────────────────────────

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/

// ────────────────────────────────────────────────────────────────────────────
// Fake OTel provider — captures every API call for assertion
// ────────────────────────────────────────────────────────────────────────────

interface FakeSpanCalls {
  setAttribute: Array<{ key: string; value: unknown }>
  setStatus: Array<{ code: OtelSpanStatusCode; message?: string }>
  recordException: Array<Error>
  endCount: number
  endTime?: number
  addEventCount: number
}

const buildFakeOtelSpan = (ctx: {
  traceId: string
  spanId: string
  traceFlags: number
}): { span: OtelSpan; calls: FakeSpanCalls } => {
  const calls: FakeSpanCalls = {
    setAttribute: [],
    setStatus: [],
    recordException: [],
    endCount: 0,
    addEventCount: 0,
  }
  const span: OtelSpan = {
    spanContext: () => ({
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      traceFlags: ctx.traceFlags,
    }),
    setAttribute(key, value) {
      calls.setAttribute.push({ key, value })
      return this
    },
    setAttributes(attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        calls.setAttribute.push({ key, value })
      }
      return this
    },
    addEvent(_name, _attrsOrStart, _start) {
      calls.addEventCount += 1
      return this
    },
    addLink() {
      return this
    },
    addLinks() {
      return this
    },
    setStatus(status) {
      const entry: { code: OtelSpanStatusCode; message?: string } = { code: status.code }
      if (status.message !== undefined) entry.message = status.message
      calls.setStatus.push(entry)
      return this
    },
    updateName() {
      return this
    },
    end(endTime) {
      calls.endCount += 1
      if (typeof endTime === "number") calls.endTime = endTime
    },
    isRecording: () => true,
    recordException(e) {
      // The exception type is `string | Exception` in OTel; our adapter
      // always passes Error, so the test asserts Error specifically.
      if (e instanceof Error) calls.recordException.push(e)
      // OTel's recordException internally addEvents("exception", ...);
      // emulate that so the test for "addEvent exception" can assert it.
      calls.addEventCount += 1
    },
  }
  return { span, calls }
}

interface FakeOtelProvider {
  provider: OtelTracerProvider
  startCalls: Array<{ name: string; opts?: OtelSpanOptions; parentTraceId?: string }>
  spans: Array<{ span: OtelSpan; calls: FakeSpanCalls }>
  forceFail?: boolean
}

const buildFakeOtelProvider = (forceFail = false): FakeOtelProvider => {
  const state: FakeOtelProvider = {
    startCalls: [],
    spans: [],
    forceFail,
    provider: {} as OtelTracerProvider, // populated below
  }
  // Counter for unique span IDs across the fake.
  let nextId = 1
  const genHex = (chars: number, seed: number): string => seed.toString(16).padStart(chars, "0")

  const tracer: OtelTracerApi = {
    startSpan(name, opts, ctx) {
      if (state.forceFail) {
        throw new Error("fake provider configured to fail")
      }
      // If a parent context was passed, recover its traceId by inspecting
      // OTel's getSpan(context). For the fake we don't have a real
      // ContextManager so we use a side channel: the adapter calls
      // `trace.setSpan(active, wrappedSpan)` then `startSpan(..., ctx)`.
      // OTel's real `trace.getSpan(ctx)` returns the wrapped span; in our
      // fake we hand back parent via the special carrier the adapter
      // stuffs in. Easier: we just synthesize a fresh trace ID per call,
      // UNLESS the call site provides parent via the OTel context — in
      // which case we read it via `trace.getSpan(ctx)?.spanContext()`.
      let parentTraceId: string | undefined
      if (ctx !== undefined) {
        try {
          // Lazy import the live OTel API to read the parent.
          const otelLive = require("@opentelemetry/api") as {
            trace: { getSpan: (c: unknown) => OtelSpan | undefined }
          }
          const parent = otelLive.trace.getSpan(ctx)
          if (parent !== undefined) {
            parentTraceId = parent.spanContext().traceId
          }
        } catch {
          // Best-effort — the test only asserts traceId propagation when
          // it sees parentTraceId set.
        }
      }
      const traceId = parentTraceId ?? genHex(32, nextId++ * 17 + 1)
      const spanId = genHex(16, nextId++ * 31 + 7)
      const built = buildFakeOtelSpan({ traceId, spanId, traceFlags: 1 })
      state.spans.push(built)
      const callEntry: { name: string; opts?: OtelSpanOptions; parentTraceId?: string } = { name }
      if (opts !== undefined) callEntry.opts = opts
      if (parentTraceId !== undefined) callEntry.parentTraceId = parentTraceId
      state.startCalls.push(callEntry)
      return built.span
    },
    startActiveSpan() {
      throw new Error("startActiveSpan not used by our adapter")
    },
  }
  state.provider = {
    getTracer(_name: string, _version?: string): OtelTracerApi {
      return tracer
    },
  }
  return state
}

// ────────────────────────────────────────────────────────────────────────────
// Section A — noop tracer (5)
// ────────────────────────────────────────────────────────────────────────────

describe("A. noop tracer", () => {
  test("A1: startSpan returns Span with valid 32-hex traceId + 16-hex spanId", () => {
    const s = noopTracer.startSpan("root")
    expect(s.context.traceId).toMatch(HEX32)
    expect(s.context.spanId).toMatch(HEX16)
    expect(s.context.traceFlags).toBe(0)
  })

  test("A2: setAttribute / setStatus / recordException / end are all no-throw", () => {
    const s = noopTracer.startSpan("noop")
    expect(() => s.setAttribute("k", "v")).not.toThrow()
    expect(() => s.setAttribute("n", 42)).not.toThrow()
    expect(() => s.setAttribute("b", true)).not.toThrow()
    expect(() => s.setStatus("ok")).not.toThrow()
    expect(() => s.setStatus("error", "boom")).not.toThrow()
    expect(() => s.recordException(new Error("oops"))).not.toThrow()
    expect(() => s.end()).not.toThrow()
    expect(() => s.end(Date.now())).not.toThrow()
  })

  test("A3: withSpan resolves fn return", async () => {
    const out = await noopTracer.withSpan("op", async () => 42)
    expect(out).toBe(42)
  })

  test("A4: withSpan rejection propagates", async () => {
    await expect(
      noopTracer.withSpan("op", async () => {
        throw new Error("fail")
      }),
    ).rejects.toThrow("fail")
  })

  test("A5: multiple parallel spans have unique trace + span IDs", () => {
    const spans = Array.from({ length: 50 }, () => noopTracer.startSpan("x"))
    const traceIds = new Set(spans.map((s) => s.context.traceId))
    const spanIds = new Set(spans.map((s) => s.context.spanId))
    expect(traceIds.size).toBe(50)
    expect(spanIds.size).toBe(50)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Section B — otelTracer with fake provider (8)
// ────────────────────────────────────────────────────────────────────────────

describe("B. otelTracer with fake provider", () => {
  test("B6: startSpan delegates to OTel provider", () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    const s = t.startSpan("op", { kind: "internal" })
    expect(fake.startCalls.length).toBe(1)
    const call = fake.startCalls[0]
    expect(call?.name).toBe("op")
    expect(s.context.traceId).toMatch(HEX32)
    expect(s.context.spanId).toMatch(HEX16)
  })

  test("B7: parent SpanContext propagates → child has same traceId", () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    const parent = t.startSpan("parent")
    const parentTraceId = parent.context.traceId
    const child = t.startSpan("child", { parent: parent.context })
    expect(child.context.traceId).toBe(parentTraceId)
  })

  test("B8: attributes forwarded to OTel spanOpts.attributes", () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    t.startSpan("op", { attributes: { tool: "bash", retries: 3, ok: true } })
    const call = fake.startCalls[0]
    expect(call?.opts?.attributes).toEqual({ tool: "bash", retries: 3, ok: true })
  })

  test("B9: setStatus('error', msg) → OTel SpanStatusCode.ERROR with message", () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    const s = t.startSpan("op")
    s.setStatus("error", "boom")
    const recorded = fake.spans[0]?.calls.setStatus
    expect(recorded).toEqual([{ code: OtelSpanStatusCode.ERROR, message: "boom" }])
  })

  test("B10: recordException → OTel addEvent('exception') side effect", () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    const s = t.startSpan("op")
    const before = fake.spans[0]?.calls.addEventCount ?? 0
    s.recordException(new Error("kaboom"))
    const after = fake.spans[0]?.calls.addEventCount ?? 0
    expect(after).toBe(before + 1)
    expect(fake.spans[0]?.calls.recordException.length).toBe(1)
    expect(fake.spans[0]?.calls.recordException[0]?.message).toBe("kaboom")
  })

  test("B11: end(epochMs) forwards endTime to OTel span.end", () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    const s = t.startSpan("op")
    const t1 = 1_700_000_000_000
    s.end(t1)
    expect(fake.spans[0]?.calls.endCount).toBe(1)
    expect(fake.spans[0]?.calls.endTime).toBe(t1)
    // Idempotence — second end() is a no-op.
    s.end(t1 + 10)
    expect(fake.spans[0]?.calls.endCount).toBe(1)
  })

  test("B12: provider throws → no-throw collapse returns a usable no-op span", () => {
    const fake = buildFakeOtelProvider(true)
    const t = otelTracer({ tracerProvider: fake.provider })
    const s = t.startSpan("op")
    // No-op fallback path: still a valid SpanContext shape.
    expect(s.context.traceId).toMatch(HEX32)
    expect(s.context.spanId).toMatch(HEX16)
    expect(() => s.setAttribute("k", "v")).not.toThrow()
    expect(() => s.end()).not.toThrow()
  })

  test("B13: mapKind covers all 5 SpanKind → correct OTel enum", () => {
    const cases: ReadonlyArray<[SpanKind, OtelSpanKind]> = [
      ["internal", OtelSpanKind.INTERNAL],
      ["server", OtelSpanKind.SERVER],
      ["client", OtelSpanKind.CLIENT],
      ["producer", OtelSpanKind.PRODUCER],
      ["consumer", OtelSpanKind.CONSUMER],
    ]
    for (const [ours, theirs] of cases) {
      expect(mapKind(ours)).toBe(theirs)
    }
    // Undefined defaults to INTERNAL per OTel SpanOptions default.
    expect(mapKind(undefined)).toBe(OtelSpanKind.INTERNAL)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Section C — W3C propagator (5)
// ────────────────────────────────────────────────────────────────────────────

describe("C. W3C propagator", () => {
  test("C14: inject writes traceparent: 00-<32hex>-<16hex>-XX", () => {
    const ctx: SpanContext = {
      traceId: "abcdef0123456789abcdef0123456789",
      spanId: "0123456789abcdef",
      traceFlags: 1,
    }
    const carrier: Record<string, string> = {}
    w3cTraceContextPropagator.inject(ctx, carrier)
    expect(carrier.traceparent).toBe("00-abcdef0123456789abcdef0123456789-0123456789abcdef-01")
  })

  test("C15: extract parses valid traceparent → SpanContext", () => {
    const out = w3cTraceContextPropagator.extract({
      traceparent: "00-abcdef0123456789abcdef0123456789-0123456789abcdef-01",
    })
    expect(out).toEqual({
      traceId: "abcdef0123456789abcdef0123456789",
      spanId: "0123456789abcdef",
      traceFlags: 1,
    })
  })

  test("C16: extract missing header → null", () => {
    expect(w3cTraceContextPropagator.extract({})).toBeNull()
  })

  test("C17: malformed traceparent → null (wrong segment count, bad hex, all-zero)", () => {
    // Wrong segment count
    expect(
      w3cTraceContextPropagator.extract({
        traceparent: "00-abc-def",
      }),
    ).toBeNull()
    // Non-hex in trace ID
    expect(
      w3cTraceContextPropagator.extract({
        traceparent: "00-XXXXXX0123456789abcdef0123456789-0123456789abcdef-01",
      }),
    ).toBeNull()
    // All-zero trace ID (W3C "invalid" sentinel)
    expect(
      w3cTraceContextPropagator.extract({
        traceparent: `00-${"0".repeat(32)}-0123456789abcdef-01`,
      }),
    ).toBeNull()
    // All-zero span ID
    expect(
      w3cTraceContextPropagator.extract({
        traceparent: `00-abcdef0123456789abcdef0123456789-${"0".repeat(16)}-01`,
      }),
    ).toBeNull()
    // Wrong span ID width (15 chars)
    expect(
      w3cTraceContextPropagator.extract({
        traceparent: "00-abcdef0123456789abcdef0123456789-0123456789abcde-01",
      }),
    ).toBeNull()
    // Unsupported version "01"
    expect(
      w3cTraceContextPropagator.extract({
        traceparent: "01-abcdef0123456789abcdef0123456789-0123456789abcdef-01",
      }),
    ).toBeNull()
  })

  test("C18: roundtrip — inject then extract returns equal SpanContext", () => {
    const original: SpanContext = {
      traceId: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      spanId: "fedcba9876543210",
      traceFlags: 1,
    }
    const carrier: Record<string, string> = {}
    w3cTraceContextPropagator.inject(original, carrier)
    const back = w3cTraceContextPropagator.extract(carrier)
    expect(back).toEqual(original)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Section D — withSpan integration (3)
// ────────────────────────────────────────────────────────────────────────────

describe("D. withSpan integration", () => {
  test("D19: fn resolves → span.end called once + status 'ok'", async () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    const out = await t.withSpan("op", async () => "result")
    expect(out).toBe("result")
    expect(fake.spans[0]?.calls.endCount).toBe(1)
    expect(fake.spans[0]?.calls.setStatus).toEqual([{ code: OtelSpanStatusCode.OK }])
  })

  test("D20: fn throws → recordException + status 'error' + span.end", async () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    await expect(
      t.withSpan("op", async () => {
        throw new Error("woops")
      }),
    ).rejects.toThrow("woops")
    const sp = fake.spans[0]
    expect(sp?.calls.recordException.length).toBe(1)
    expect(sp?.calls.recordException[0]?.message).toBe("woops")
    expect(sp?.calls.setStatus).toEqual([{ code: OtelSpanStatusCode.ERROR, message: "woops" }])
    expect(sp?.calls.endCount).toBe(1)
  })

  test("D21: nested withSpan — child has parent's traceId", async () => {
    const fake = buildFakeOtelProvider()
    const t = otelTracer({ tracerProvider: fake.provider })
    let parentTraceId = ""
    let childTraceId = ""
    await t.withSpan("parent", async (parent: Span) => {
      parentTraceId = parent.context.traceId
      await t.withSpan(
        "child",
        async (child: Span) => {
          childTraceId = child.context.traceId
        },
        { parent },
      )
    })
    expect(parentTraceId).toMatch(HEX32)
    expect(childTraceId).toBe(parentTraceId)
  })
})
