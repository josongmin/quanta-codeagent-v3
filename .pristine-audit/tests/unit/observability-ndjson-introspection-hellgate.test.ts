/**
 * HELLGATE — NDJSON live-event introspection sink (ADR-0468).
 *
 * Threat model & invariants this battery locks:
 *
 *   A. Encoder determinism — the SAME event encodes to byte-identical bytes
 *      regardless of key insertion order, at every nesting level. A monitor
 *      diffing the stream must never see spurious churn. (Cursor's
 *      cursor-ndjson-ingest streams NDJSON; non-determinism would defeat
 *      diff-based introspection + caching.)
 *
 *   B. NDJSON framing safety — the line separator (`\n`/`\r`) must NEVER appear
 *      raw inside an encoded line, even when a string value contains embedded
 *      newlines / control chars / quotes. Otherwise one logical event splits
 *      into two records and corrupts the stream. This is THE correctness
 *      property of NDJSON.
 *
 *   C. emit() never throws — BigInt, function, symbol, circular reference, and
 *      non-finite numbers are all encoded as `Err({kind:"encode-failed"})`,
 *      never thrown past the boundary.
 *
 *   D. Ring-buffer overflow — drop-oldest evicts the OLDEST line and reports the
 *      drop; reject-newest refuses the newcomer, keeps the tail, and surfaces
 *      `buffer-full`. Capacity is a validated required field (0 / -1 / 3.5 /
 *      NaN → construction Err, never a silent clamp).
 *
 *   E. Default-OFF byte-identity — NullNdjsonSink.emit() is a no-op returning
 *      ok() for ANY event (including ones that would fail to encode). Wiring it
 *      is observationally identical to "no NDJSON introspection".
 *
 *   F. Buffered sink — flush hands drained lines to the injected callback;
 *      a throwing flush is contained (never propagates to the producer);
 *      flush is full-buffer-triggered + manually invocable.
 *
 * Plane-clean: imports ONLY the slice barrel + bun:test.
 */
import { describe, expect, test } from "bun:test"
import {
  type BackpressurePolicy,
  createBufferedNdjsonSink,
  createCapturingNdjsonSink,
  createNdjsonEncoder,
  createNdjsonRingBuffer,
  defaultNdjsonEncoder,
  type NdjsonEvent,
  NullNdjsonSink,
} from "@/observability/ndjson"

// ────────────────────────────────────────────────────────────────────────────
// A. Encoder determinism + stable key ordering
// ────────────────────────────────────────────────────────────────────────────

describe("A. encoder determinism", () => {
  test("A1 byte-identical regardless of key insertion order", () => {
    const a: NdjsonEvent = { type: "tool", zeta: 1, alpha: 2, mid: 3 }
    const b: NdjsonEvent = { mid: 3, alpha: 2, type: "tool", zeta: 1 }
    const ra = defaultNdjsonEncoder.encode(a)
    const rb = defaultNdjsonEncoder.encode(b)
    expect(ra.ok && rb.ok).toBe(true)
    if (ra.ok && rb.ok) {
      expect(ra.value).toBe(rb.value)
      // keys sorted lexicographically at the top level
      expect(ra.value).toBe('{"alpha":2,"mid":3,"type":"tool","zeta":1}')
    }
  })

  test("A2 stable ordering recurses into nested objects", () => {
    const ev: NdjsonEvent = { type: "x", data: { c: 1, a: 2, b: { z: 9, y: 8 } } }
    const r = defaultNdjsonEncoder.encode(ev)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('{"data":{"a":2,"b":{"y":8,"z":9},"c":1},"type":"x"}')
    }
  })

  test("A3 array element order is PRESERVED (semantic), keys inside still sorted", () => {
    const ev: NdjsonEvent = { type: "x", items: [{ b: 1, a: 2 }, "z", "a"] }
    const r = defaultNdjsonEncoder.encode(ev)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('{"items":[{"a":2,"b":1},"z","a"],"type":"x"}')
  })

  test("A4 createNdjsonEncoder returns an equivalent encoder", () => {
    const enc = createNdjsonEncoder()
    const r = enc.encode({ type: "t", b: 1, a: 2 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('{"a":2,"b":1,"type":"t"}')
  })

  test("A5 undefined fields are dropped (JSON semantics), no trailing newline", () => {
    const ev: NdjsonEvent = { type: "t", keep: 1, gone: undefined }
    const r = defaultNdjsonEncoder.encode(ev)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value).toBe('{"keep":1,"type":"t"}')
      expect(r.value.endsWith("\n")).toBe(false)
    }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. NDJSON framing safety — newlines / control chars escaped
// ────────────────────────────────────────────────────────────────────────────

describe("B. framing safety", () => {
  test("B1 embedded newline in a value is escaped, not raw", () => {
    const ev: NdjsonEvent = { type: "log", msg: "line1\nline2\rline3\ttab" }
    const r = defaultNdjsonEncoder.encode(ev)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.includes("\n")).toBe(false)
      expect(r.value.includes("\r")).toBe(false)
      // escaped sequences present
      expect(r.value.includes("\\n")).toBe(true)
      expect(r.value.includes("\\r")).toBe(true)
      expect(r.value.includes("\\t")).toBe(true)
      // round-trips back to the original value
      const parsed = JSON.parse(r.value) as { msg: string }
      expect(parsed.msg).toBe("line1\nline2\rline3\ttab")
    }
  })

  test("B2 quotes / backslashes / unicode controls escaped", () => {
    const ev: NdjsonEvent = { type: "x", v: 'he said "hi"\\ \x00' }
    const r = defaultNdjsonEncoder.encode(ev)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.split("\n").length).toBe(1) // exactly one line
      const parsed = JSON.parse(r.value) as { v: string }
      expect(parsed.v).toBe('he said "hi"\\ \x00')
    }
  })

  test("B3 a multi-line key name is also escaped", () => {
    const ev: NdjsonEvent = { type: "x" }
    ;(ev as Record<string, unknown>)["a\nb"] = 1 // newline INSIDE a key name
    const r = defaultNdjsonEncoder.encode(ev)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.includes("\n")).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. emit/encode never throws on bad events
// ────────────────────────────────────────────────────────────────────────────

describe("C. no-throw on bad events", () => {
  const bad: Array<[string, NdjsonEvent]> = [
    ["bigint", { type: "x", n: 10n } as unknown as NdjsonEvent],
    ["function", { type: "x", f: () => 1 } as unknown as NdjsonEvent],
    ["symbol", { type: "x", s: Symbol("z") } as unknown as NdjsonEvent],
    ["NaN", { type: "x", n: Number.NaN }],
    ["Infinity", { type: "x", n: Number.POSITIVE_INFINITY }],
  ]
  for (const [label, ev] of bad) {
    test(`C-${label} → Err(encode-failed), no throw`, () => {
      let r: ReturnType<typeof defaultNdjsonEncoder.encode> | undefined
      expect(() => {
        r = defaultNdjsonEncoder.encode(ev)
      }).not.toThrow()
      expect(r?.ok).toBe(false)
      if (r && !r.ok) expect(r.error.kind).toBe("encode-failed")
    })
  }

  test("C-circular → Err(encode-failed), no throw", () => {
    const ev: Record<string, unknown> = { type: "x" }
    ev.self = ev // cycle
    let r: ReturnType<typeof defaultNdjsonEncoder.encode> | undefined
    expect(() => {
      r = defaultNdjsonEncoder.encode(ev as NdjsonEvent)
    }).not.toThrow()
    expect(r?.ok).toBe(false)
    if (r && !r.ok) {
      expect(r.error.kind).toBe("encode-failed")
      if (r.error.kind === "encode-failed") expect(r.error.reason).toContain("circular")
    }
  })

  test("C-nested-bad: bad leaf deep in the tree still rejected", () => {
    const ev = { type: "x", a: { b: { c: 5n } } } as unknown as NdjsonEvent
    const r = defaultNdjsonEncoder.encode(ev)
    expect(r.ok).toBe(false)
  })

  test("C-toplevel-primitive: a bare string event is rejected (must be an object)", () => {
    const r = defaultNdjsonEncoder.encode("not-an-event" as unknown as NdjsonEvent)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("encode-failed")
  })

  test("C-toplevel-array: a bare array event is rejected (typeof [] === 'object' trap)", () => {
    // A consumer routes on `type`; `[1,2]` has none. `typeof [] === "object"`
    // would slip past a naive object-check — the encoder must reject it.
    const r = defaultNdjsonEncoder.encode([1, 2, 3] as unknown as NdjsonEvent)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("encode-failed")
  })

  test("C-toplevel-undefined: a top-level undefined is rejected", () => {
    const r = defaultNdjsonEncoder.encode(undefined as unknown as NdjsonEvent)
    expect(r.ok).toBe(false)
  })

  test("C-toJSON-not-honored: an instance's toJSON is NOT invoked (own-keys only)", () => {
    // Documented determinism choice: toJSON could be non-deterministic, so the
    // encoder canonicalizes own enumerable keys only. A Date has no own
    // enumerable keys → encodes to an empty object, NOT its ISO string.
    const r = defaultNdjsonEncoder.encode({ type: "x", at: new Date(0) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe('{"at":{},"type":"x"}')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. ring buffer overflow + config validation
// ────────────────────────────────────────────────────────────────────────────

describe("D. ring buffer", () => {
  const invalidCaps: Array<[string, number]> = [
    ["zero", 0],
    ["negative", -1],
    ["fractional", 3.5],
    ["NaN", Number.NaN],
  ]
  for (const [label, capacity] of invalidCaps) {
    test(`D-cfg-${label}: capacity ${label} → invalid-config Err`, () => {
      const r = createNdjsonRingBuffer({ capacity, policy: "drop-oldest" })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe("invalid-config")
    })
  }

  test("D-cfg-bad-policy: unknown policy → invalid-config Err", () => {
    const r = createNdjsonRingBuffer({
      capacity: 4,
      policy: "spin" as unknown as BackpressurePolicy,
    })
    expect(r.ok).toBe(false)
  })

  test("D1 drop-oldest evicts the OLDEST and reports the drop", () => {
    const r = createNdjsonRingBuffer({ capacity: 3, policy: "drop-oldest" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const buf = r.value
    expect(buf.offer("a")).toEqual({ accepted: true, dropped: 0 })
    buf.offer("b")
    buf.offer("c")
    // full now; next offer evicts "a"
    expect(buf.offer("d")).toEqual({ accepted: true, dropped: 1 })
    expect(buf.drain()).toEqual(["b", "c", "d"])
    expect(buf.totalDropped()).toBe(1)
    expect(buf.size()).toBe(0) // drained
  })

  test("D2 reject-newest keeps the tail and refuses the newcomer", () => {
    const r = createNdjsonRingBuffer({ capacity: 2, policy: "reject-newest" })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const buf = r.value
    buf.offer("a")
    buf.offer("b")
    expect(buf.offer("c")).toEqual({ accepted: false, dropped: 0 })
    expect(buf.drain()).toEqual(["a", "b"]) // tail intact, "c" gone
    expect(buf.totalDropped()).toBe(0) // reject-newest never "drops", it rejects
  })

  test("D3 capacity=1 boundary (drop-oldest)", () => {
    const r = createNdjsonRingBuffer({ capacity: 1, policy: "drop-oldest" })
    if (!r.ok) throw new Error("setup")
    const buf = r.value
    buf.offer("a")
    buf.offer("b")
    expect(buf.drain()).toEqual(["b"])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// E. DEFAULT-OFF byte-identity (NullNdjsonSink)
// ────────────────────────────────────────────────────────────────────────────

describe("E. NullNdjsonSink default-OFF", () => {
  test("E1 emit() of a valid event is a no-op returning ok()", () => {
    const r = NullNdjsonSink.emit({ type: "tool", a: 1 })
    expect(r.ok).toBe(true)
  })

  test("E2 emit() of an UN-encodable event is STILL ok() (encodes nothing)", () => {
    // The null sink must be byte-identical to "no introspection" — it never
    // even encodes, so a BigInt that would fail the real encoder is harmless.
    const r = NullNdjsonSink.emit({ type: "x", n: 10n } as unknown as NdjsonEvent)
    expect(r.ok).toBe(true)
  })

  test("E3 emit() never throws for any input", () => {
    const circular: Record<string, unknown> = { type: "x" }
    circular.self = circular
    expect(() => NullNdjsonSink.emit(circular as NdjsonEvent)).not.toThrow()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// F. Capturing + Buffered sinks
// ────────────────────────────────────────────────────────────────────────────

describe("F. capturing + buffered sinks", () => {
  test("F1 capturing sink pins exact encoded line bytes", () => {
    const r = createCapturingNdjsonSink({ capacity: 8, policy: "drop-oldest" })
    if (!r.ok) throw new Error("setup")
    const sink = r.value
    expect(sink.emit({ type: "t", b: 1, a: 2 }).ok).toBe(true)
    expect(sink.lines()).toEqual(['{"a":2,"b":1,"type":"t"}'])
    // lines() is non-destructive — calling twice yields the same view
    expect(sink.lines()).toEqual(['{"a":2,"b":1,"type":"t"}'])
  })

  test("F2 capturing sink propagates encode-failed Err without buffering", () => {
    const r = createCapturingNdjsonSink({ capacity: 8, policy: "drop-oldest" })
    if (!r.ok) throw new Error("setup")
    const sink = r.value
    const bad = sink.emit({ type: "x", n: 5n } as unknown as NdjsonEvent)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.kind).toBe("encode-failed")
    expect(sink.lines()).toEqual([]) // nothing buffered on encode failure
  })

  test("F3 capturing sink drop-oldest overflow counts drops", () => {
    const r = createCapturingNdjsonSink({ capacity: 2, policy: "drop-oldest" })
    if (!r.ok) throw new Error("setup")
    const sink = r.value
    sink.emit({ type: "a" })
    sink.emit({ type: "b" })
    sink.emit({ type: "c" })
    expect(sink.dropped()).toBe(1)
    expect(sink.lines()).toEqual(['{"type":"b"}', '{"type":"c"}'])
  })

  test("F4 capturing sink reject-newest surfaces buffer-full + counts rejects", () => {
    const r = createCapturingNdjsonSink({ capacity: 1, policy: "reject-newest" })
    if (!r.ok) throw new Error("setup")
    const sink = r.value
    expect(sink.emit({ type: "a" }).ok).toBe(true)
    const second = sink.emit({ type: "b" })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe("buffer-full")
    expect(sink.rejected()).toBe(1)
    expect(sink.lines()).toEqual(['{"type":"a"}'])
  })

  test("F5 capturing sink construction rejects invalid capacity", () => {
    const r = createCapturingNdjsonSink({ capacity: 0, policy: "drop-oldest" })
    expect(r.ok).toBe(false)
  })

  test("F6 buffered sink flushes drained lines to the injected callback", () => {
    const flushed: string[][] = []
    const r = createBufferedNdjsonSink({ capacity: 2, policy: "drop-oldest" }, (lines) => {
      flushed.push(lines)
    })
    if (!r.ok) throw new Error("setup")
    const sink = r.value
    sink.emit({ type: "a" })
    sink.emit({ type: "b" }) // buffer now full → auto flush
    expect(flushed).toEqual([['{"type":"a"}', '{"type":"b"}']])
    expect(sink.pending()).toBe(0)
    // explicit flush of an empty buffer is a no-op
    sink.flush()
    expect(flushed.length).toBe(1)
  })

  test("F7 buffered sink: a THROWING flush is contained, never propagates", () => {
    const r = createBufferedNdjsonSink({ capacity: 1, policy: "drop-oldest" }, () => {
      throw new Error("socket closed")
    })
    if (!r.ok) throw new Error("setup")
    const sink = r.value
    expect(() => sink.emit({ type: "a" })).not.toThrow()
    // explicit flush also contained
    sink.emit({ type: "b" })
    expect(() => sink.flush()).not.toThrow()
  })

  test("F8 buffered sink manual flush drains a partial buffer", () => {
    const flushed: string[][] = []
    const r = createBufferedNdjsonSink({ capacity: 10, policy: "drop-oldest" }, (lines) => {
      flushed.push(lines)
    })
    if (!r.ok) throw new Error("setup")
    const sink = r.value
    sink.emit({ type: "a" })
    sink.emit({ type: "b" })
    expect(sink.pending()).toBe(2)
    sink.flush()
    expect(flushed).toEqual([['{"type":"a"}', '{"type":"b"}']])
    expect(sink.pending()).toBe(0)
  })

  test("F9 buffered sink construction rejects invalid config", () => {
    const r = createBufferedNdjsonSink({ capacity: -3, policy: "drop-oldest" }, () => {})
    expect(r.ok).toBe(false)
  })

  test("F10 buffered sink: drop-oldest never SILENTLY loses a line — every emitted line is flushed", () => {
    // Property: the auto-flush trigger (size >= capacity) drains the ring to
    // empty BEFORE it could ever be full at the start of the next offer, so the
    // ring's drop-oldest eviction path is never reached inside the buffered sink
    // → zero lines are lost, and dropped() stays 0. This pins the invariant that
    // production batching does not quietly eat events.
    const flushed: string[] = []
    const r = createBufferedNdjsonSink({ capacity: 2, policy: "drop-oldest" }, (lines) => {
      for (const l of lines) flushed.push(l)
    })
    if (!r.ok) throw new Error("setup")
    const sink = r.value
    const n = 7
    for (let i = 0; i < n; i++) expect(sink.emit({ type: "e", i }).ok).toBe(true)
    sink.flush() // drain the partial tail
    expect(flushed.length).toBe(n) // every line accounted for
    expect(sink.dropped()).toBe(0) // nothing silently lost
    // order + content preserved across the batches
    expect(flushed).toEqual([
      '{"i":0,"type":"e"}',
      '{"i":1,"type":"e"}',
      '{"i":2,"type":"e"}',
      '{"i":3,"type":"e"}',
      '{"i":4,"type":"e"}',
      '{"i":5,"type":"e"}',
      '{"i":6,"type":"e"}',
    ])
  })

  test("F11 buffered sink exposes dropped() so production loss is observable", () => {
    // dropped() mirrors the capturing sink so an operator wiring the real
    // adapter can see overflow loss, not only test code.
    const r = createBufferedNdjsonSink({ capacity: 4, policy: "drop-oldest" }, () => {})
    if (!r.ok) throw new Error("setup")
    expect(r.value.dropped()).toBe(0)
  })
})
