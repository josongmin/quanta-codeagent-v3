import { describe, expect, it } from "bun:test"
import { sliceTailWholeChars, sliceWholeChars } from "@/shared/slice-whole-chars"

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

describe("sliceTailWholeChars — surrogate safety (FRONT of result)", () => {
  it("never leads with a lone LOW surrogate straddling the cut at EVERY offset", () => {
    for (let suffix = 0; suffix <= 8; suffix++) {
      const s = `${"a".repeat(8)}${EMOJI}${"b".repeat(suffix)}`
      for (let keep = 0; keep <= s.length + 2; keep++) {
        const out = sliceTailWholeChars(s, keep)
        expect(out.length).toBeLessThanOrEqual(keep)
        expect(hasLoneSurrogate(out)).toBe(false)
        expect(out.isWellFormed()).toBe(true)
        // the tail is always a suffix of the input (we only drop from the FRONT).
        expect(s.endsWith(out)).toBe(true)
      }
    }
  })

  it("advances exactly one unit when the cut lands inside a pair", () => {
    // "😀cd": units = HIGH,LOW,c,d. keep=3 would start at LOW (lone) → advance to "cd".
    const s = `${EMOJI}cd`
    expect(sliceTailWholeChars(s, 3)).toBe("cd")
    // keep=4 keeps the whole pair.
    expect(sliceTailWholeChars(s, 4)).toBe(s)
  })

  it("leaves under-cap inputs byte-identical and handles empty / non-positive keep", () => {
    const s = `hello ${EMOJI} world`
    expect(sliceTailWholeChars(s, s.length)).toBe(s)
    expect(sliceTailWholeChars(s, s.length + 100)).toBe(s)
    expect(sliceTailWholeChars("", 5)).toBe("")
    expect(sliceTailWholeChars("abc", 0)).toBe("")
    expect(sliceTailWholeChars("abc", -1)).toBe("")
  })

  it("is byte-identical to slice when no pair straddles the cut", () => {
    const s = "plain ascii text here"
    for (let keep = 0; keep <= s.length; keep++) {
      expect(sliceTailWholeChars(s, keep)).toBe(keep === 0 ? "" : s.slice(s.length - keep))
    }
  })

  it("all-astral tail is always even-length (no half emoji at the front)", () => {
    const s = EMOJI.repeat(10) // 20 UTF-16 units
    for (let keep = 0; keep <= 20; keep++) {
      const out = sliceTailWholeChars(s, keep)
      expect(out.isWellFormed()).toBe(true)
      expect(out.length % 2).toBe(0)
    }
  })
})

// ── DRIFT-LOCK ───────────────────────────────────────────────────────────────
// The PTY read-cap (`src/tool/pty/tools.ts capOutput`) and the side-agent finding
// clamp (`src/agent/side-agent-runner.ts capDetail`) were each open-coded copies
// of the surrogate boundary-snap. They now route through these shared helpers.
// This block re-derives the OLD inline implementations verbatim and asserts the
// shared helpers stay byte-identical to them across a brutal offset/astral matrix
// — so a future "optimization" of either helper can never silently regress a
// truncation site back into emitting a lone surrogate.
describe("DRIFT-LOCK — shared helpers match the retired inline truncators", () => {
  // Verbatim copy of the OLD pty `sliceHeadWhole` (assumed keep <= s.length).
  const oldHead = (s: string, keep: number): string => {
    const c = s.charCodeAt(keep - 1)
    const end = c >= 0xd800 && c <= 0xdbff ? keep - 1 : keep
    return s.slice(0, end)
  }
  // Verbatim copy of the OLD pty `sliceTailWhole` (assumed keep <= s.length).
  const oldTail = (s: string, keep: number): string => {
    const start = s.length - keep
    const c = s.charCodeAt(start)
    return s.slice(c >= 0xdc00 && c <= 0xdfff ? start + 1 : start)
  }

  it("sliceWholeChars ≡ old pty sliceHeadWhole on the over-cap band", () => {
    for (let prefix = 0; prefix <= 8; prefix++) {
      const s = `${"a".repeat(prefix)}${EMOJI}${"b".repeat(8)}`
      // The old helper was only ever called with 1 <= keep < s.length.
      for (let keep = 1; keep < s.length; keep++) {
        expect(sliceWholeChars(s, keep)).toBe(oldHead(s, keep))
      }
    }
  })

  it("sliceTailWholeChars ≡ old pty sliceTailWhole on the over-cap band", () => {
    for (let suffix = 0; suffix <= 8; suffix++) {
      const s = `${"a".repeat(8)}${EMOJI}${"b".repeat(suffix)}`
      for (let keep = 1; keep < s.length; keep++) {
        expect(sliceTailWholeChars(s, keep)).toBe(oldTail(s, keep))
      }
    }
  })

  it("side-agent capDetail idiom: sliceWholeChars(detail, cut) ≡ old back-off", () => {
    const oldCapCut = (detail: string, cut: number): string => {
      const prev = detail.charCodeAt(cut - 1)
      const end = prev >= 0xd800 && prev <= 0xdbff ? cut - 1 : cut
      return detail.slice(0, end)
    }
    for (let prefix = 0; prefix <= 8; prefix++) {
      const detail = `${"a".repeat(prefix)}${EMOJI}${"b".repeat(20)}`
      for (let cut = 1; cut < detail.length; cut++) {
        expect(sliceWholeChars(detail, cut)).toBe(oldCapCut(detail, cut))
      }
    }
  })
})
