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
import {
  type ExportMetric,
  type ExportSpan,
  nanos,
  serializeMetrics,
  serializeSpans,
} from "@/observability/otel-exporter/otlp-encode"

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

  test("T-1 a FINITE input whose PRODUCT leaves the uint64 shape degrades too", () => {
    // The first version of this guard checked only the INPUT. Measured on it:
    //   1e15               -> "1e+21"            (float switches to exponential)
    //   MAX_SAFE_INTEGER   -> "9.007…e+21"
    //   1.756e18 (ns-as-ms)-> "1.756e+24"        (the classic unit confusion)
    //   MAX_VALUE          -> "Infinity"         (finite on input, overflows in the multiply)
    // Every one of those is a non-parseable token on a `fixed64` field, i.e.
    // exactly the failure the guard exists to prevent, one input class over.
    for (const [label, value] of [
      ["1e15", 1e15],
      ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
      ["nanos-passed-as-millis", 1.756e18],
      ["MAX_VALUE", Number.MAX_VALUE],
    ] as ReadonlyArray<readonly [string, number]>) {
      const out = nanos(value)
      expect({ label, uint64: UINT64_DECIMAL.test(out) }).toEqual({ label, uint64: true })
    }
  })

  test("T-3 PAIRED CONTROL — a real epoch in nanos is past MAX_SAFE_INTEGER and must SURVIVE", () => {
    // The obvious product guard (`n <= Number.MAX_SAFE_INTEGER`) rejects every
    // real timestamp: 1.756e12 ms is 1.756e18 ns, three orders past the safe
    // ceiling. This arm is why the implementation is BigInt and not a range
    // check — it fails on any fix that clamps the legitimate range away.
    expect(nanos(1_756_000_000_000)).toBe("1756000000000000000")
    expect(Number(nanos(1_756_000_000_000))).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
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

/**
 * T-5..T-8 — the METRICS half.
 *
 * The span envelope was pinned above; the metric envelope was not, and it is a
 * strictly larger surface: `serializeMetrics` writes timestamps from THREE
 * separate object literals (the shared `dp`, and the histogram branch's own
 * hand-rolled dataPoint), so "the encoder is total" has to be proved at the
 * ENVELOPE, not at the helper. A datapoint timestamp that leaves the uint64
 * shape is the same fatal shape as a span's: the collector rejects the whole
 * `resourceMetrics` envelope, and `flushMetrics` re-queues a rejected batch at
 * the FRONT of the buffer forever.
 *
 *   T-5  No `*UnixNano` field anywhere in the metric envelope can be a
 *        non-uint64 token, for ANY metric kind.
 *   T-6  ...including a value that is not a number at all (the runtime shape a
 *        `number`-typed field does not actually prevent).
 *   T-7  PAIRED CONTROL — a legitimate timestamp is passed through UNCHANGED,
 *        so the guard cannot be satisfied by stamping "0" on everything.
 *   T-8  PAIRED CONTROL — start/time stay EQUAL within a datapoint (the DELTA
 *        window invariant the encoder documents).
 */

/** Every `*UnixNano` leaf in an arbitrary OTLP envelope, by deep walk — so a
 *  timestamp added to a NEW branch later is covered without editing this test. */
const unixNanoLeaves = (node: unknown, path = "$"): ReadonlyArray<[string, unknown]> => {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => unixNanoLeaves(v, `${path}[${i}]`))
  }
  if (node !== null && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      k.endsWith("UnixNano")
        ? [[`${path}.${k}`, v] as [string, unknown]]
        : unixNanoLeaves(v, `${path}.${k}`),
    )
  }
  return []
}

const KINDS = ["counter", "histogram", "gauge"] as const

const metricWith = (kind: (typeof KINDS)[number], timeEpochMs: unknown): ExportMetric =>
  ({ name: "probe.metric", kind, value: 1, attributes: {}, timeEpochMs }) as unknown as ExportMetric

describe("T-5..T-8 — OTLP metric datapoint timestamps are total too", () => {
  const HOSTILE: ReadonlyArray<readonly [string, unknown]> = [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["undefined", undefined],
    ["null", null],
    ["negative", -5],
    ["1e15 (product leaves uint64 shape)", 1e15],
    ["nanos-passed-as-millis", 1.756e18],
    ["MAX_VALUE", Number.MAX_VALUE],
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["a caller-supplied STRING", "1756000000000"],
    ["an exponential STRING", "1e+21"],
    ["an object", { toString: () => "Infinity" }],
  ]

  for (const kind of KINDS) {
    for (const [label, value] of HOSTILE) {
      test(`T-5/T-6 ${kind}: ${label} cannot reach the serialized envelope`, () => {
        const payload = serializeMetrics([metricWith(kind, value)], "quanta", undefined)
        const leaves = unixNanoLeaves(payload)
        // The branch must actually HAVE timestamps — a walk that found none
        // would pass vacuously.
        expect({ kind, found: leaves.length > 0 }).toEqual({ kind, found: true })
        const bad = leaves.filter(
          ([, v]) => typeof v !== "string" || !UINT64_DECIMAL.test(v as string),
        )
        expect({ kind, label, bad }).toEqual({ kind, label, bad: [] })
        const json = JSON.stringify(payload)
        expect(json).not.toContain("NaN")
        expect(json).not.toContain("Infinity")
        // The metric must still be exported — degrading a field must not
        // silently drop the record.
        expect(json).toContain("probe.metric")
      })
    }

    test(`T-7 PAIRED CONTROL ${kind}: a legitimate timestamp is UNCHANGED`, () => {
      const payload = serializeMetrics([metricWith(kind, 1_756_000_000_000)], "quanta", undefined)
      const leaves = unixNanoLeaves(payload)
      expect(leaves.length).toBeGreaterThan(0)
      for (const [path, v] of leaves) {
        expect({ path, v }).toEqual({ path, v: "1756000000000000000" })
      }
    })

    test(`T-8 PAIRED CONTROL ${kind}: start and time stay equal in a datapoint`, () => {
      const payload = serializeMetrics([metricWith(kind, 1_756_000_000_000)], "quanta", undefined)
      const json = JSON.stringify(payload)
      const starts = [...json.matchAll(/"startTimeUnixNano":"(\d+)"/g)].map((m) => m[1])
      const times = [...json.matchAll(/"timeUnixNano":"(\d+)"/g)].map((m) => m[1])
      expect({ kind, starts, times }).toEqual({ kind, starts, times: starts })
    })
  }
})
