/**
 * context vs off tracing modes (ADR-0186 — C1 delta).
 *
 *   CVO-01: `context` mode yields a VALID non-zero getActiveTraceRef() inside a
 *           withSpan scope (32-hex trace, 16-hex span, both non-all-zero).
 *   CVO-02: `off` mode installs NOTHING — getActiveTraceRef() stays undefined
 *           even inside its withSpan scope.
 *   CVO-03: neither mode touches an exporter. Both tracers are constructed with
 *           ZERO exporter wiring; we drive a full withSpan lifecycle and assert
 *           the process `fetch` is never invoked (the only OTLP egress path).
 */

import { describe, expect, test } from "bun:test"
import { contextTracer, getActiveTraceRef, noopTracer } from "@/observability/tracing"

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/
const ALL_ZERO_32 = "0".repeat(32)
const ALL_ZERO_16 = "0".repeat(16)

describe("tracing modes / context vs off", () => {
  test("CVO-01: context mode yields a valid non-zero active ref", async () => {
    const captured = await contextTracer.withSpan("op", async () => {
      const ref = getActiveTraceRef()
      expect(ref).toBeDefined()
      return ref
    })
    expect(captured).toBeDefined()
    if (captured === undefined) throw new Error("unreachable")
    expect(captured.traceId).toMatch(HEX32)
    expect(captured.spanId).toMatch(HEX16)
    expect(captured.traceId).not.toBe(ALL_ZERO_32)
    expect(captured.spanId).not.toBe(ALL_ZERO_16)
  })

  test("CVO-02: off mode installs no context — active ref stays undefined", async () => {
    let insideRef: unknown = "sentinel"
    await noopTracer.withSpan("op", async () => {
      insideRef = getActiveTraceRef()
    })
    expect(insideRef).toBeUndefined()
    expect(getActiveTraceRef()).toBeUndefined()
  })

  test("CVO-03: neither mode calls the exporter (no fetch egress)", async () => {
    const realFetch = globalThis.fetch
    let fetchCalls = 0
    // @ts-expect-error — test seam: count any egress attempt.
    globalThis.fetch = (...args: unknown[]) => {
      fetchCalls++
      return realFetch(...(args as Parameters<typeof fetch>))
    }
    try {
      await contextTracer.withSpan("ctx", async (span) => {
        span.setAttribute("k", "v")
        span.setStatus("ok")
      })
      await noopTracer.withSpan("off", async (span) => {
        span.setAttribute("k", "v")
        span.setStatus("ok")
      })
      // Give any fire-and-forget flush a microtask to (not) run.
      await new Promise((r) => setTimeout(r, 0))
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
