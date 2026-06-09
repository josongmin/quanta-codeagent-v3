/**
 * ticket — background-turn-portal bounded buffer (cli-interactive finding [20]).
 * The buffer is specified in BYTES (`BG_BUFFER_MAX_BYTES`, `bytes()`, the
 * "+N KB elided" marker), but a regression measured/sliced UTF-16 CODE UNITS,
 * so multibyte (CJK/emoji) content over-ran the byte cap and a code-unit slice
 * at the ring boundary could split a surrogate pair into lone surrogates.
 * These pin the byte-accurate, surrogate-safe contract.
 */
import { describe, expect, test } from "bun:test"
import { makeBoundedBuffer } from "@/apps/cli/repl/background-turn-portal"

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8")
// A code point is "lone surrogate" if a UTF-16 unit in [0xD800,0xDFFF] is not
// paired — i.e. the string is not well-formed. String.prototype.isWellFormed
// (ES2024 / Bun) is the canonical check.
const isWellFormed = (s: string): boolean =>
  typeof (s as { isWellFormed?: () => boolean }).isWellFormed === "function"
    ? (s as unknown as { isWellFormed(): boolean }).isWellFormed()
    : !/[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""))

describe("makeBoundedBuffer — byte-accurate, surrogate-safe", () => {
  test("bytes() reports UTF-8 byte length, not UTF-16 code-unit length", () => {
    const buf = makeBoundedBuffer()
    buf.append("가나다") // 3 CJK chars = 3 code units but 9 UTF-8 bytes
    expect(buf.bytes()).toBe(utf8("가나다"))
    expect(buf.bytes()).toBe(9)
  })

  test("the byte cap bounds RETAINED bytes for multibyte content", () => {
    const cap = 600
    const buf = makeBoundedBuffer(cap)
    // 1000 CJK chars = 3000 UTF-8 bytes (over the 600-byte cap). A code-unit
    // measure would keep ~600 chars ≈ 1800 real bytes — caught by the output
    // byte size (the marker adds a little slack).
    buf.append("한".repeat(1000))
    expect(buf.bytes()).toBeLessThanOrEqual(cap)
    expect(utf8(buf.read())).toBeLessThanOrEqual(cap + 64)
  })

  test("ring eviction never splits a surrogate pair (output stays well-formed)", () => {
    // HALF is ODD (201) so a code-unit cut lands MID surrogate-pair when the
    // 2-unit emoji are streamed, producing lone surrogates under the old code.
    const cap = 402
    const buf = makeBoundedBuffer(cap)
    for (let i = 0; i < 300; i++) buf.append("😀") // 2 UTF-16 units, 4 UTF-8 bytes
    const out = buf.read()
    expect(isWellFormed(out)).toBe(true)
    expect(utf8(out)).toBeLessThanOrEqual(cap + 64)
  })
})
