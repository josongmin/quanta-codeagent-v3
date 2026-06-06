import { describe, expect, it } from "bun:test"
import { sliceWholeChars } from "@/shared/slice-whole-chars"

// A 4-byte astral char: 😀 (U+1F600) = high D83D + low DE00 (2 UTF-16 units).
const EMOJI = "😀"
const HIGH = "\ud83d"
const LOW = "\ude00"

const hasLoneSurrogate = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      // high — must be followed by a low
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++ // consume the pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // low with no preceding high (any pair consumed above)
      return true
    }
  }
  return false
}

describe("sliceWholeChars — surrogate safety", () => {
  it("never splits an astral char straddling the cut at EVERY offset", () => {
    // Build "aaa…😀…aaa": place the emoji so its high half can land at the cut.
    for (let prefix = 0; prefix <= 8; prefix++) {
      const s = `${"a".repeat(prefix)}${EMOJI}${"b".repeat(8)}`
      for (let max = 0; max <= s.length + 2; max++) {
        const out = sliceWholeChars(s, max)
        expect(out.length).toBeLessThanOrEqual(max)
        expect(hasLoneSurrogate(out)).toBe(false)
        // isWellFormed: no lone surrogates per the spec.
        expect(out.isWellFormed()).toBe(true)
      }
    }
  })

  it("backs off exactly one unit when the cut lands inside a pair", () => {
    // "ab😀": units = a,b,HIGH,LOW. max=3 would keep a,b,HIGH (lone) → back to 2.
    const s = `ab${EMOJI}`
    expect(sliceWholeChars(s, 3)).toBe("ab")
    // max=4 keeps the whole pair.
    expect(sliceWholeChars(s, 4)).toBe(s)
  })

  it("leaves under-cap inputs byte-identical (untouched)", () => {
    const s = `hello ${EMOJI} world`
    expect(sliceWholeChars(s, s.length)).toBe(s)
    expect(sliceWholeChars(s, s.length + 100)).toBe(s)
  })

  it("is byte-identical to slice when no pair straddles the cut", () => {
    const s = "plain ascii text here"
    for (let max = 0; max <= s.length; max++) {
      expect(sliceWholeChars(s, max)).toBe(s.slice(0, max))
    }
  })

  it("handles an all-astral string", () => {
    const s = EMOJI.repeat(10) // 20 UTF-16 units
    for (let max = 0; max <= 20; max++) {
      const out = sliceWholeChars(s, max)
      expect(out.isWellFormed()).toBe(true)
      expect(hasLoneSurrogate(out)).toBe(false)
      // Each emoji is 2 units → result length is always even (no half emoji).
      expect(out.length % 2).toBe(0)
    }
  })

  it("handles empty string and non-positive max", () => {
    expect(sliceWholeChars("", 5)).toBe("")
    expect(sliceWholeChars("abc", 0)).toBe("")
    expect(sliceWholeChars("abc", -1)).toBe("")
  })

  it("does NOT touch a pre-existing lone surrogate that is not at the cut", () => {
    // A lone HIGH surrogate mid-string, cut well after it: we only guard the
    // boundary, we do not sanitise the whole string.
    const s = `x${HIGH}y${LOW}zzzz`
    const out = sliceWholeChars(s, 4) // keeps x,HIGH,y,LOW → still has lone halves
    expect(out.length).toBeLessThanOrEqual(4)
    // (it may contain lone surrogates that pre-existed; that's by design)
  })
})
