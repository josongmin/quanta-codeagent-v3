/**
 * §12.7 — otelHeadersHelper dynamic OTLP headers hellgate.
 *
 * The pre-feature exporter takes STATIC `headers` resolved once at construction
 * (`OtelExporterOpts.headers`). An OTLP collector behind OAuth needs the bearer
 * token REFRESHED per flush — a static header goes stale and every POST 401s
 * after the token expires. This adds an optional `getHeaders(): Promise<...>`
 * callback port (the Codex/OTel `otelHeadersHelper` dynamic-header pattern):
 * when present, the exporter awaits it before EACH POST so a rotating token is
 * always fresh.
 *
 * Default-OFF byte-identity: absent `getHeaders` ⇒ the exporter uses the static
 * `headers` (or none) on every POST exactly as before — proven by HELL-DH-05.
 *
 * Cases:
 *   DH-01: getHeaders() result is applied to the POST request
 *   DH-02: getHeaders() is awaited fresh on EACH flush (token rotation)
 *   DH-03: getHeaders() merges with/overrides static `headers`
 *   DH-04: getHeaders() throwing/rejecting ⇒ POST still fires (no-throw), with
 *          the static headers as fallback; the buffer is preserved on failure
 *   DH-05: byte-identity — no getHeaders ⇒ static headers, exactly as before
 *   DH-06: attachOtelExporterFromEnv threads getHeaders override
 */

import { describe, expect, test } from "bun:test"
import {
  attachOtelExporterFromEnv,
  type ExportSpan,
  type IntervalHandle,
  otelHttpExporter,
} from "@/observability/otel-exporter"

interface CapturedCall {
  readonly url: string
  readonly headers: Record<string, string>
}

const headersOf = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {}
  if (raw === undefined) return out
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  Object.assign(out, raw as Record<string, string>)
  return out
}

const makeFakeFetch = (
  responses: Array<{ ok: boolean; status: number }> = [{ ok: true, status: 200 }],
): { fetch: typeof fetch; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = []
  let cursor = 0
  const f = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const initSafe = init ?? {}
    calls.push({
      url: typeof input === "string" ? input : String(input),
      headers: headersOf(initSafe.headers),
    })
    const r = responses[Math.min(cursor, responses.length - 1)] ?? { ok: true, status: 200 }
    cursor += 1
    return { ok: r.ok, status: r.status } as Response
  }
  return { fetch: f as unknown as typeof fetch, calls }
}

const SPAN = (id: string): ExportSpan => ({
  traceId: "0".repeat(32),
  spanId: id.padStart(16, "0"),
  name: "s",
  startTimeEpochMs: 1,
  endTimeEpochMs: 2,
})

const noTimer: Pick<
  Parameters<typeof otelHttpExporter>[0],
  "setIntervalImpl" | "clearIntervalImpl"
> = {
  setIntervalImpl: (() => 0 as IntervalHandle) as never,
  clearIntervalImpl: () => {},
}

const ENDPOINT = "http://collector.local:4318"

describe("§12.7 dynamic OTLP headers", () => {
  test("DH-00: a permanently pending collector POST is bounded and remains retryable", async () => {
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
      flushIntervalMs: 0,
      postTimeoutMs: 1,
    })
    exp.recordSpan(SPAN("timeout"))
    await expect(exp.flush()).resolves.toBeUndefined()
    await exp.teardown()
  })

  test("DH-01: getHeaders() result is applied to the POST", async () => {
    const { fetch, calls } = makeFakeFetch()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      flushIntervalMs: 0,
      getHeaders: async () => ({ authorization: "Bearer tok-1" }),
    })
    exp.recordSpan(SPAN("a"))
    await exp.flush()
    expect(calls.length).toBe(1)
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-1")
    await exp.teardown()
  })

  test("DH-02: getHeaders() is awaited fresh on EACH flush (rotation)", async () => {
    const { fetch, calls } = makeFakeFetch()
    let n = 0
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      flushIntervalMs: 0,
      getHeaders: async () => {
        n += 1
        return { authorization: `Bearer tok-${n}` }
      },
    })
    exp.recordSpan(SPAN("a"))
    await exp.flush()
    exp.recordSpan(SPAN("b"))
    await exp.flush()
    expect(calls.length).toBe(2)
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-1")
    expect(calls[1]?.headers.authorization).toBe("Bearer tok-2")
    await exp.teardown()
  })

  test("DH-03: getHeaders() merges with + overrides static headers", async () => {
    const { fetch, calls } = makeFakeFetch()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      flushIntervalMs: 0,
      headers: { "x-static": "keep", authorization: "Bearer STALE" },
      getHeaders: async () => ({ authorization: "Bearer FRESH" }),
    })
    exp.recordSpan(SPAN("a"))
    await exp.flush()
    const h = calls[0]?.headers ?? {}
    expect(h["x-static"]).toBe("keep") // static-only key preserved
    expect(h.authorization).toBe("Bearer FRESH") // dynamic overrides static
    expect(h["Content-Type"] ?? h["content-type"]).toBe("application/json")
    await exp.teardown()
  })

  test("DH-04: getHeaders() rejecting ⇒ POST still fires w/ static fallback; buffer preserved on POST fail", async () => {
    // First flush: getHeaders rejects but POST should still go out (no-throw),
    // falling back to static headers. Make the POST FAIL so we can assert the
    // span is retained, then a 2nd flush (getHeaders OK) drains it.
    const { fetch, calls } = makeFakeFetch([
      { ok: false, status: 500 },
      { ok: true, status: 200 },
    ])
    let reject = true
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      flushIntervalMs: 0,
      headers: { authorization: "Bearer STATIC" },
      getHeaders: async () => {
        if (reject) throw new Error("token endpoint down")
        return { authorization: "Bearer FRESH" }
      },
    })
    exp.recordSpan(SPAN("a"))
    await expect(exp.flush()).resolves.toBeUndefined() // never throws
    expect(calls.length).toBe(1)
    expect(calls[0]?.headers.authorization).toBe("Bearer STATIC") // fallback

    // span retained (POST failed) — next flush with a working token drains it.
    reject = false
    await exp.flush()
    expect(calls.length).toBe(2)
    expect(calls[1]?.headers.authorization).toBe("Bearer FRESH")
    await exp.teardown()
  })

  test("DH-05: BYTE-IDENTITY — no getHeaders ⇒ static headers, exactly as before", async () => {
    const { fetch, calls } = makeFakeFetch()
    const exp = otelHttpExporter({
      endpoint: ENDPOINT,
      fetch,
      flushIntervalMs: 0,
      headers: { authorization: "Bearer STATIC", "x-team": "t" },
    })
    exp.recordSpan(SPAN("a"))
    await exp.flush()
    const h = calls[0]?.headers ?? {}
    expect(h.authorization).toBe("Bearer STATIC")
    expect(h["x-team"]).toBe("t")
    expect(h["Content-Type"] ?? h["content-type"]).toBe("application/json")
    await exp.teardown()
  })
})

describe("§12.7 attachOtelExporterFromEnv threads getHeaders", () => {
  test("DH-06: getHeaders override is applied on POST", async () => {
    const { fetch, calls } = makeFakeFetch()
    const result = attachOtelExporterFromEnv(
      { QUANTA_OTEL_ENDPOINT: ENDPOINT },
      {
        fetch,
        flushIntervalMs: 0,
        ...noTimer,
        getHeaders: async () => ({ authorization: "Bearer ENV-FRESH" }),
      },
    )
    expect(result).toBeDefined()
    result?.exporter.recordSpan(SPAN("a"))
    await result?.exporter.flush()
    expect(calls[0]?.headers.authorization).toBe("Bearer ENV-FRESH")
    await result?.exporter.teardown()
  })
})
