/**
 * `hexId` — the single W3C hex-id mint (consolidates the four formerly-
 * duplicated copies: exporter span sink, OTel exporting tracer, no-op tracer,
 * and the agent session-resources CONTEXT-only bridge).
 *
 * Pins the id shape callers rely on:
 *   HX-01: length == byteCount*2 hex chars (16→32 traceId, 8→16 spanId).
 *   HX-02: lowercase only (W3C requires lowercase; a-f, never A-F).
 *   HX-03: per-byte zero-padding — a byte < 0x10 renders as TWO chars, not one
 *          (0x01 → "01"), so length is exact regardless of byte values.
 *   HX-04: a passed `gen` is used VERBATIM (deterministic test seam) — the same
 *          byte source that the exporter hellgate injects must yield the exact
 *          fixed ids other tests assert.
 */
import { describe, expect, test } from "bun:test"
import { hexId } from "@/observability/tracing"

describe("hexId", () => {
  test("HX-01: length is byteCount*2 hex chars", () => {
    expect(hexId(16).length).toBe(32) // traceId
    expect(hexId(8).length).toBe(16) // spanId
    expect(hexId(1).length).toBe(2)
    expect(hexId(0).length).toBe(0)
  })

  test("HX-02: output is lowercase hex only", () => {
    // Force high-nibble bytes (0xAB, 0xFF) that would surface A-F if not lowercased.
    const out = hexId(2, () => new Uint8Array([0xab, 0xff]))
    expect(out).toBe("abff")
    expect(out).toBe(out.toLowerCase())
    expect(out).toMatch(/^[0-9a-f]+$/)
  })

  test("HX-03: bytes < 0x10 zero-pad to two chars", () => {
    // 0x00, 0x01, 0x0f each MUST render as two chars — not "0","1","f".
    expect(hexId(3, () => new Uint8Array([0x00, 0x01, 0x0f]))).toBe("00010f")
  })

  test("HX-04: passed gen is used verbatim (deterministic)", () => {
    const gen = (len: number) => new Uint8Array(len).fill(0x01)
    // The exact fixed shape the exporter hellgate asserts (all-0x01 → "0101…").
    expect(hexId(8, gen)).toBe("0101010101010101")
    // Distinct fixed source → distinct id (rules out a hardcoded return).
    const zeros = (len: number) => new Uint8Array(len) // all 0x00
    expect(hexId(8, zeros)).toBe("0000000000000000")
  })

  test("HX-04b: gen receives the requested byteCount", () => {
    let requested = -1
    hexId(16, (len) => {
      requested = len
      return new Uint8Array(len)
    })
    expect(requested).toBe(16)
  })
})
