/**
 * Hellgate — line-shift-tolerant lint delta (ADR-0495).
 *
 * The legacy `computeLintDelta` keys identity on `(file,line,code,message)`. That
 * excludes COLUMN shift but NOT LINE shift: an edit that inserts/removes lines
 * renumbers every later diagnostic, so a pre-existing lint at L10→L11 fails the
 * exact-line match and is FALSELY reported as "introduced by this edit". Claude
 * Code guards this with a line-tolerance window = |Δ lines in file|.
 *
 * `computeLintDeltaTolerant(pre, post, lineShift)` mirrors that: a post diagnostic
 * is pre-existing iff an unconsumed pre diagnostic shares (file,code,message) AND
 * sits within |lineShift| lines. Proven invariants:
 *   1. PARITY: lineShift=0 ⇒ identical output to `computeLintDelta` (byte-compat).
 *   2. The false-positive class is FIXED: a pre-existing lint shifted by exactly
 *      the edit's line delta is NOT reported as introduced.
 *   3. A shift BEYOND the window IS reported (no over-suppression).
 *   4. A genuinely new diagnostic (new message) IS reported.
 *   5. Multiset 1-for-1 within the window (1 pre + 2 post ⇒ exactly 1 new).
 *   6. NO-THROW on garbage lineShift (NaN / negative / float).
 */
import { describe, expect, test } from "bun:test"
import type { Diagnostic } from "@/agent/edit-repair-loop"
import { computeLintDelta, computeLintDeltaTolerant } from "@/agent/edit-repair-loop"

const d = (line: number, code: string, message: string, file = "a.ts"): Diagnostic => ({
  file,
  line,
  code,
  message,
  severity: "error",
})

describe("tolerant lint delta — parity at lineShift=0", () => {
  test("lineShift=0 reproduces computeLintDelta exactly", () => {
    const pre = [d(10, "TS1", "x"), d(20, "TS2", "y"), d(20, "TS2", "y")]
    const post = [d(10, "TS1", "x"), d(20, "TS2", "y"), d(20, "TS2", "y"), d(30, "TS3", "z")]
    expect(computeLintDeltaTolerant(pre, post, 0)).toEqual([...computeLintDelta(pre, post)])
  })

  test("lineShift=0 still flags a pure line move (legacy behavior preserved)", () => {
    const pre = [d(10, "TS1", "x")]
    const post = [d(11, "TS1", "x")]
    expect(computeLintDeltaTolerant(pre, post, 0)).toEqual([d(11, "TS1", "x")])
  })
})

describe("tolerant lint delta — kills the line-shift false positive", () => {
  test("a pre-existing lint shifted by the edit's line delta is NOT introduced", () => {
    const pre = [d(10, "TS1", "x")]
    const post = [d(11, "TS1", "x")] // edit added 1 line above ⇒ shift +1
    expect(computeLintDeltaTolerant(pre, post, 1)).toEqual([])
  })

  test("shift beyond the window IS reported (no over-suppression)", () => {
    const pre = [d(10, "TS1", "x")]
    const post = [d(15, "TS1", "x")] // 5-line move, window only 1
    expect(computeLintDeltaTolerant(pre, post, 1)).toEqual([d(15, "TS1", "x")])
  })

  test("a genuinely new diagnostic is reported even within the window", () => {
    const pre = [d(10, "TS1", "x")]
    const post = [d(11, "TS1", "x"), d(12, "TS9", "BRAND NEW")]
    expect(computeLintDeltaTolerant(pre, post, 2)).toEqual([d(12, "TS9", "BRAND NEW")])
  })
})

describe("tolerant lint delta — multiset 1-for-1 within window", () => {
  test("1 pre + 2 post (same group, in window) ⇒ exactly 1 introduced", () => {
    const pre = [d(10, "TS1", "x")]
    const post = [d(11, "TS1", "x"), d(12, "TS1", "x")]
    const got = computeLintDeltaTolerant(pre, post, 3)
    expect(got).toHaveLength(1)
  })

  test("nearest-match consumes the closest pre within window", () => {
    const pre = [d(10, "TS1", "x"), d(20, "TS1", "x")]
    const post = [d(11, "TS1", "x"), d(21, "TS1", "x")]
    expect(computeLintDeltaTolerant(pre, post, 2)).toEqual([])
  })

  test("MAXIMUM matching: greedy-nearest would strand a pre, optimal matches both", () => {
    // R1 audit finding #2: pre=[10,14] post=[13,16] tol=3. A naive nearest-first
    // grabs pre14 for post13, then post16 finds pre10 out of window ⇒ false [16].
    // The optimal assignment (post13↔pre10, post16↔pre14) matches BOTH ⇒ [].
    const pre = [d(10, "TS1", "x"), d(14, "TS1", "x")]
    const post = [d(13, "TS1", "x"), d(16, "TS1", "x")]
    expect(computeLintDeltaTolerant(pre, post, 3)).toEqual([])
  })

  test("introduced set preserves ORIGINAL post order", () => {
    const pre = [d(10, "TS1", "x")]
    const post = [d(50, "TS9", "later"), d(11, "TS1", "x"), d(40, "TS8", "earlier")]
    // post[1] matches pre; the two unmatched come back in original order.
    expect(computeLintDeltaTolerant(pre, post, 2)).toEqual([
      d(50, "TS9", "later"),
      d(40, "TS8", "earlier"),
    ])
  })
})

describe("lint delta — NUL-separator key collision is fixed (R2 F1)", () => {
  test("distinct diagnostics straddling \\x00 do NOT collide (no false negative)", () => {
    // B and A differ in where the field boundary falls; a \x00-joined key would
    // collide them. With pre=[B,B], post=[A], A is genuinely introduced ⇒ len 1.
    const B = d(10, "x\x00b", "c")
    const A = d(10, "x", "b\x00c")
    expect(computeLintDelta([B, B], [A])).toHaveLength(1)
    expect(computeLintDeltaTolerant([B, B], [A], 0)).toHaveLength(1)
  })
})

describe("tolerant lint delta — no-throw on garbage shift", () => {
  test("NaN / negative / float lineShift never throws; |shift| used, trunc applied", () => {
    const pre = [d(10, "TS1", "x")]
    const post = [d(11, "TS1", "x")]
    expect(computeLintDeltaTolerant(pre, post, Number.NaN)).toEqual([d(11, "TS1", "x")]) // tol 0
    expect(computeLintDeltaTolerant(pre, post, -1)).toEqual([]) // |−1| = 1
    expect(computeLintDeltaTolerant(pre, post, 1.9)).toEqual([]) // trunc → 1
  })
})
