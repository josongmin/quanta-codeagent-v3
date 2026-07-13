/**
 * OTLP `arrayValue` serialization (ADR-0268 — C1 delta).
 *
 * The exporter used to handle only string/number/boolean and SILENTLY DROP
 * arrays, so `gen_ai.response.finish_reasons` as a `string[]` never reached the
 * collector. These cases seal the homogeneous-array branch:
 *
 *   AV-01: a string[] attribute serializes to an OTLP `arrayValue.values` of
 *          stringValue entries — NOT dropped.
 *   AV-02: scalar attrs alongside the array still serialize as scalars (no
 *          regression on the existing tag path).
 *   AV-03: a number[] attribute serializes to `arrayValue.values` of doubleValue
 *          entries.
 *   AV-04: the registry-int gen_ai token/cap keys serialize as OTLP `intValue`
 *          (string-encoded 64-bit) — every other numeric attr stays doubleValue
 *          (paired control); a fractional value on an int key degrades to
 *          doubleValue rather than truncating (AV-04b red-on-injection).
 */

import { describe, expect, test } from "bun:test"
import { type IntervalHandle, otelHttpExporter } from "@/observability/otel-exporter"

interface CapturedCall {
  readonly url: string
  readonly body: string
}

const makeFakeFetch = (): { fetch: typeof fetch; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = []
  const f = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      body: typeof init?.body === "string" ? init.body : "",
    })
    return new Response("{}", { status: 200 })
  }
  return { fetch: f as unknown as typeof fetch, calls }
}

const noTimer = {
  setIntervalImpl: (_cb: () => void, _ms: number): IntervalHandle => Symbol("noop"),
  clearIntervalImpl: (_h: IntervalHandle): void => {},
}

const ENDPOINT = "http://localhost:4318"

const firstSpan = (calls: CapturedCall[]): Record<string, unknown> => {
  const body = JSON.parse(calls[0]?.body ?? "{}")
  return body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0] ?? {}
}

/** Find the OTLP KeyValue for `key` in a span's attribute list. */
const attrOf = (
  span: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const attrs = (span.attributes ?? []) as Array<{ key: string; value: Record<string, unknown> }>
  return attrs.find((a) => a.key === key)?.value
}

describe("otel-exporter / OTLP arrayValue", () => {
  test("AV-01: string[] attr serializes to arrayValue, not dropped", async () => {
    const { fetch, calls } = makeFakeFetch()
    const exp = otelHttpExporter({ endpoint: ENDPOINT, fetch, ...noTimer, batchSize: 1 })
    exp.recordSpan({
      traceId: "0".repeat(31) + "1",
      spanId: "0".repeat(15) + "1",
      name: "run_sampling_request",
      startTimeEpochMs: 1_000,
      endTimeEpochMs: 2_000,
      attributes: { "gen_ai.response.finish_reasons": ["stop", "tool_calls"] },
    })
    await exp.flush()

    const span = firstSpan(calls)
    const val = attrOf(span, "gen_ai.response.finish_reasons")
    expect(val).toBeDefined()
    // NOT dropped, and NOT a scalar tag.
    expect(val?.stringValue).toBeUndefined()
    const arr = val?.arrayValue as { values?: Array<Record<string, unknown>> } | undefined
    expect(arr?.values).toEqual([{ stringValue: "stop" }, { stringValue: "tool_calls" }])
    await exp.teardown()
  })

  test("AV-02: scalar attrs alongside an array still serialize as scalars", async () => {
    const { fetch, calls } = makeFakeFetch()
    const exp = otelHttpExporter({ endpoint: ENDPOINT, fetch, ...noTimer, batchSize: 1 })
    exp.recordSpan({
      traceId: "0".repeat(31) + "2",
      spanId: "0".repeat(15) + "2",
      name: "run_sampling_request",
      startTimeEpochMs: 1_000,
      endTimeEpochMs: 2_000,
      attributes: {
        "gen_ai.request.model": "gpt-5",
        "gen_ai.usage.input_tokens": 42,
        "gen_ai.response.finish_reasons": ["stop"],
      },
    })
    await exp.flush()

    const span = firstSpan(calls)
    expect(attrOf(span, "gen_ai.request.model")).toEqual({ stringValue: "gpt-5" })
    // gen_ai.usage.input_tokens is registry-int → OTLP `intValue` (string-encoded
    // 64-bit), NOT `doubleValue`. Only the known-int gen_ai token keys take this
    // arm; every other numeric attr stays doubleValue (see the AV-04 pair below).
    expect(attrOf(span, "gen_ai.usage.input_tokens")).toEqual({ intValue: "42" })
    const arr = attrOf(span, "gen_ai.response.finish_reasons")?.arrayValue as
      | { values?: unknown[] }
      | undefined
    expect(arr?.values).toEqual([{ stringValue: "stop" }])
    await exp.teardown()
  })

  test("AV-03: number[] attr serializes to arrayValue of doubleValue", async () => {
    const { fetch, calls } = makeFakeFetch()
    const exp = otelHttpExporter({ endpoint: ENDPOINT, fetch, ...noTimer, batchSize: 1 })
    exp.recordSpan({
      traceId: "0".repeat(31) + "3",
      spanId: "0".repeat(15) + "3",
      name: "op",
      startTimeEpochMs: 1_000,
      endTimeEpochMs: 2_000,
      attributes: { "quanta.sample.latencies": [1, 2, 3] },
    })
    await exp.flush()

    const span = firstSpan(calls)
    const arr = attrOf(span, "quanta.sample.latencies")?.arrayValue as
      | { values?: unknown[] }
      | undefined
    expect(arr?.values).toEqual([{ doubleValue: 1 }, { doubleValue: 2 }, { doubleValue: 3 }])
    await exp.teardown()
  })

  // AV-04 — registry-int token attrs on the WIRE (ADR-0539 int-typing fix). The
  // OTel-GenAI registry types the token counts + request cap as `int`; the wire
  // must carry them as OTLP `intValue` (string-encoded 64-bit), not `doubleValue`.
  test("AV-04: known-int gen_ai token/cap keys serialize as intValue (string)", async () => {
    const { fetch, calls } = makeFakeFetch()
    const exp = otelHttpExporter({ endpoint: ENDPOINT, fetch, ...noTimer, batchSize: 1 })
    exp.recordSpan({
      traceId: "0".repeat(31) + "4",
      spanId: "0".repeat(15) + "4",
      name: "run_sampling_request",
      startTimeEpochMs: 1_000,
      endTimeEpochMs: 2_000,
      attributes: {
        "gen_ai.usage.input_tokens": 42,
        "gen_ai.usage.output_tokens": 7,
        "gen_ai.usage.cache_read_input_tokens": 100,
        "gen_ai.usage.cache_creation_input_tokens": 0,
        "gen_ai.request.max_tokens": 4096,
        // PAIRED CONTROL — a fractional gen_ai attr (TTFT ms) that is NOT in the
        // int-key set must stay doubleValue; a whole-number non-int key too.
        "gen_ai.response.time_to_first_token_ms": 12.5,
        "gen_ai.request.temperature": 1,
      },
    })
    await exp.flush()

    const span = firstSpan(calls)
    // The five registry-int keys → intValue as a STRING (OTLP 64-bit-in-JSON).
    expect(attrOf(span, "gen_ai.usage.input_tokens")).toEqual({ intValue: "42" })
    expect(attrOf(span, "gen_ai.usage.output_tokens")).toEqual({ intValue: "7" })
    expect(attrOf(span, "gen_ai.usage.cache_read_input_tokens")).toEqual({ intValue: "100" })
    expect(attrOf(span, "gen_ai.usage.cache_creation_input_tokens")).toEqual({ intValue: "0" })
    expect(attrOf(span, "gen_ai.request.max_tokens")).toEqual({ intValue: "4096" })
    // Paired control: a fractional non-int-key stays doubleValue; and a whole
    // number on a NON-int key (temperature) also stays doubleValue — proving the
    // fix is scoped to the key SET, not to "any integer-valued number".
    expect(attrOf(span, "gen_ai.response.time_to_first_token_ms")).toEqual({ doubleValue: 12.5 })
    expect(attrOf(span, "gen_ai.request.temperature")).toEqual({ doubleValue: 1 })
    await exp.teardown()
  })

  // AV-04b — red-on-injection: if the int-typing were reverted (token key →
  // doubleValue), THIS assertion fails. It is the mutation witness for the fix.
  test("AV-04b: a non-integer value on an int key falls back to doubleValue (no truncation)", async () => {
    const { fetch, calls } = makeFakeFetch()
    const exp = otelHttpExporter({ endpoint: ENDPOINT, fetch, ...noTimer, batchSize: 1 })
    exp.recordSpan({
      traceId: "0".repeat(31) + "5",
      spanId: "0".repeat(15) + "5",
      name: "run_sampling_request",
      startTimeEpochMs: 1_000,
      endTimeEpochMs: 2_000,
      // Pathological: a fractional token count must NOT be silently truncated to
      // an int — it degrades to doubleValue so no information is lost on the wire.
      attributes: { "gen_ai.usage.input_tokens": 42.5 },
    })
    await exp.flush()
    const span = firstSpan(calls)
    expect(attrOf(span, "gen_ai.usage.input_tokens")).toEqual({ doubleValue: 42.5 })
    await exp.teardown()
  })
})
