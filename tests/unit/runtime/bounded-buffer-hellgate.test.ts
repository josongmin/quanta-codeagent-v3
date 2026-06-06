import { describe, expect, test } from "bun:test"
import {
  BOUNDED_BUFFER_HEAD_CHARS,
  BOUNDED_BUFFER_TAIL_CHARS,
  createBoundedBuffer,
} from "@/runtime/bounded-buffer"

/**
 * D2 — BoundedBuffer (jun-7-naive-impl-hardening §2.2).
 *
 * red-on-injection: streaming 10MB of output through the buffer must keep
 * `value().length` bounded (head + marker + tail) and report dropped bytes.
 * Reverting to the legacy `+= chunk` accumulator (unbounded growth) makes the
 * "<= cap + marker" assertion RED.
 */

describe("createBoundedBuffer — verbatim budget then head+tail elision (D2)", () => {
  // The VERBATIM budget. Output at/under this is preserved in full (ADR-0411);
  // over it ⇒ 8k head + 4k tail elision. We use a small budget here so the
  // tests are fast; the registry wires 200_000.
  const BUDGET = BOUNDED_BUFFER_HEAD_CHARS + BOUNDED_BUFFER_TAIL_CHARS
  const HEAD_TAIL = BOUNDED_BUFFER_HEAD_CHARS + BOUNDED_BUFFER_TAIL_CHARS

  test("at/under the budget ⇒ verbatim, no elision, droppedBytes 0", () => {
    const buf = createBoundedBuffer(BUDGET)
    buf.append("hello ")
    buf.append("world")
    expect(buf.value()).toBe("hello world")
    expect(buf.droppedBytes()).toBe(0)
  })

  test("exactly at the budget is still verbatim (no premature elision)", () => {
    const buf = createBoundedBuffer(BUDGET)
    buf.append("Q".repeat(BUDGET))
    expect(buf.value().length).toBe(BUDGET)
    expect(buf.droppedBytes()).toBe(0)
  })

  test("10MB stream stays bounded with head + tail preserved + drop count", () => {
    const buf = createBoundedBuffer(BUDGET)
    // 10MB streamed in 64KB chunks. HEAD must be the very first bytes,
    // TAIL must be the very last bytes — error tails are what we keep.
    const CHUNK = "A".repeat(64 * 1024)
    const HEAD_MARK = "<<HEAD-START>>"
    const TAIL_MARK = "<<TAIL-END>>"
    buf.append(HEAD_MARK)
    let total = HEAD_MARK.length
    for (let i = 0; i < 160; i++) {
      buf.append(CHUNK)
      total += CHUNK.length
    }
    buf.append(TAIL_MARK)
    total += TAIL_MARK.length

    const out = buf.value()
    // Bounded: 8k head + 4k tail + a single elision marker. Allow marker room.
    expect(out.length).toBeLessThanOrEqual(HEAD_TAIL + 256)
    // The unbounded `+= chunk` would have produced ~10MB here.
    expect(out.length).toBeLessThan(total)
    // Head preserved (first bytes), tail preserved (last bytes).
    expect(out.startsWith(HEAD_MARK)).toBe(true)
    expect(out.endsWith(TAIL_MARK)).toBe(true)
    // Elision marker present and reports a positive elided count.
    expect(out).toContain("bytes elided")
    expect(buf.droppedBytes()).toBeGreaterThan(0)
  })

  test("surrogate-safe: a cut between a UTF-16 surrogate pair never splits the pair", () => {
    // Build a string whose HEAD boundary lands exactly inside an emoji (a
    // surrogate pair). The head slice must not end on a lone high surrogate.
    const buf = createBoundedBuffer(BUDGET)
    // Fill head boundary region with emoji (each is 2 UTF-16 code units).
    const EMOJI = "😀" // U+1F600 — surrogate pair
    buf.append(EMOJI.repeat(BUDGET)) // way over the budget ⇒ forces elision
    buf.append("Z".repeat(BOUNDED_BUFFER_TAIL_CHARS * 2)) // force tail too
    const out = buf.value()
    // No lone surrogate anywhere in the rendered value.
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i)
      const isHigh = code >= 0xd800 && code <= 0xdbff
      const isLow = code >= 0xdc00 && code <= 0xdfff
      if (isHigh) {
        const next = out.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
      }
      if (isLow) {
        const prev = out.charCodeAt(i - 1)
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true)
      }
    }
  })

  test("droppedBytes accumulates only the middle that was elided", () => {
    const buf = createBoundedBuffer(BUDGET)
    const total = BUDGET + 5000
    buf.append("X".repeat(total))
    // Over budget ⇒ keep 8k head + 4k tail; the middle is elided. With no
    // surrogates the drop is exactly total − (head + tail).
    expect(buf.droppedBytes()).toBe(total - HEAD_TAIL)
  })
})
