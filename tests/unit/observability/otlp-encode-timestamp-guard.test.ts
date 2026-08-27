/**
 * Hellgate — OTLP timestamp encoding is total.
 *
 * `start_time_unix_nano` / `end_time_unix_nano` are OTLP `fixed64` fields, and
 * OTLP/JSON carries them as a decimal STRING. `nanos()` had no finite guard, so
 * a non-finite input produced the literal strings `"NaN"` / `"Infinity"` — which
 * are not parseable uint64. A spec-strict collector rejects the ENTIRE
 * `resourceSpans` envelope on one bad field, not just the offending span, and
 * the exporter re-queues a rejected batch at the FRONT of its buffer with no
 * 4xx classification. One span built from an undefined timestamp therefore
 * blackholes every subsequent span for the life of the process.
 *
 * Reachable inputs (all measured as producing "NaN" before the fix):
 *   - `spanOpts.startTime` computed from an absent clock read ⇒ `undefined`
 *   - a duration subtraction against an unset stamp ⇒ `NaN`
 *   - a caller that passes a parsed-but-empty field
 *
 * Invariants:
 *   T-1  Every `nanos()` output parses as a non-negative uint64 decimal.
 *   T-2  A non-finite timestamp degrades to "0", never to a non-numeric token.
 *   T-3  PAIRED CONTROL — a legitimate epoch-millis value is unchanged, so the
 *        guard cannot be satisfied by clamping everything.
 *   T-4  The guard holds through the real serializer, not just the helper.
 */

import { describe, expect, test } from "bun:test"
import { type ExportSpan, nanos, serializeSpans } from "@/observability/otel-exporter/otlp-encode"

const UINT64_DECIMAL = /^\d+$/

const spanWith = (startTime: number, endTime: number): ExportSpan =>
  ({
    traceId: "0af7651916cd43dd8448eb211c80319c",
    spanId: "b7ad6b7169203331",
    name: "probe",
    startTime,
    endTime,
    attributes: {},
  }) as unknown as ExportSpan

describe("T — OTLP timestamps are always uint64-shaped", () => {
  const NON_FINITE: ReadonlyArray<readonly [string, number]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["undefined-as-number", undefined as unknown as number],
  ]

  for (const [label, value] of NON_FINITE) {
    test(`T-1/T-2 nanos(${label}) is a uint64 decimal, not a token`, () => {
      const out = nanos(value)
      expect({ label, out, ok: UINT64_DECIMAL.test(out) }).toEqual({ label, out: "0", ok: true })
    })
  }

  test("T-3 PAIRED CONTROL — a real epoch-millis value is unchanged", () => {
    // Whole-millis inputs are exactly representable, so the guard must not
    // perturb them. 1756000000000 ms = 1756000000000000000 ns.
    expect(nanos(1_756_000_000_000)).toBe("1756000000000000000")
    expect(nanos(0)).toBe("0")
    expect(nanos(1)).toBe("1000000")
  })

  test("T-3 PAIRED CONTROL — a negative epoch is still refused as a uint64", () => {
    // A negative timestamp is not a legal fixed64 either; it must not ride out
    // as "-5000000".
    expect(UINT64_DECIMAL.test(nanos(-5))).toBe(true)
  })

  test("T-4 a non-finite timestamp cannot poison the serialized envelope", () => {
    const payload = serializeSpans([spanWith(Number.NaN, 5)], "quanta", undefined)
    const json = JSON.stringify(payload)
    expect(json).not.toContain("NaN")
    expect(json).not.toContain("Infinity")
    // The span is still exported — degrading the field must not silently drop
    // the record, which would trade one lie for another.
    expect(json).toContain("probe")
  })
})
