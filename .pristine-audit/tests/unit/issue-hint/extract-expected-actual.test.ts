/**
 * `extractExpectedActual` — opt-in expected/actual extraction.
 *
 * False-positive-prone in prose; this extractor only runs when the bench
 * caller explicitly opts in (gated via `QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL=1`
 * upstream — this test exercises the function directly).
 *
 * Sentence-bounded: matches anchored on a keyword (`expected/actual/should/got/
 * but/instead`) extend up to the next `. ! ? newline` or 200 chars.
 */
import { describe, expect, test } from "bun:test"
import { extractExpectedActual } from "../../../src/agent/issue-hint/extract-expected-actual"

describe("extractExpectedActual — opt-in expected/actual phrases", () => {
  test("empty input → []", () => {
    expect(extractExpectedActual("")).toEqual([])
    expect(extractExpectedActual(undefined as unknown as string)).toEqual([])
  })

  test("expected … . pattern captured to sentence terminator", () => {
    const text = "We expected the function to return 1."
    expect(extractExpectedActual(text)).toContain("expected the function to return 1.")
  })

  test("got … . pattern captured", () => {
    const text = "But got an exception instead."
    const out = extractExpectedActual(text)
    expect(out.length).toBeGreaterThan(0)
    // The match anchors on the keyword and extends to the next terminator.
    expect(out.some((s) => s.includes("got an exception"))).toBe(true)
  })

  test("should … . pattern captured", () => {
    const text = "It should return 5."
    expect(extractExpectedActual(text)).toContain("should return 5.")
  })

  test("no keyword → []", () => {
    expect(extractExpectedActual("The function works fine.")).toEqual([])
  })

  test("multiple keywords in distinct sentences → multiple matches", () => {
    const text = "We expected 1. But got 2. Should be different."
    const out = extractExpectedActual(text)
    // Each sentence's keyword anchors a distinct match
    expect(out.length).toBeGreaterThanOrEqual(2)
  })

  test("newline terminates the phrase (next line not appended)", () => {
    const text = "expected the result\nunrelated next line"
    const out = extractExpectedActual(text)
    expect(out.length).toBeGreaterThan(0)
    // The match anchors on `expected` and terminates at newline. The trim
    // step strips the trailing whitespace, so the stored entry ends at the
    // word "result".
    expect(out.some((s) => s.includes("expected the result"))).toBe(true)
    // Unrelated next line content NOT appended
    expect(out.some((s) => s.includes("unrelated"))).toBe(false)
  })

  test("very long runaway sentence capped at 200 chars body", () => {
    // The regex is bounded by `[^.?!\n]{0,200}` — so even a 10K-char no-
    // terminator string never matches (the body length cap requires a terminator).
    const big = `expected ${"x".repeat(10_000)}.`
    const out = extractExpectedActual(big)
    // The runaway body exceeds the {0,200} bound, so the regex does NOT match
    // (greedy-with-bound — no match means no match, not a partial one).
    expect(out).toEqual([])
  })

  test("dedup of repeated phrase", () => {
    const text = "should work. should work. should work."
    const out = extractExpectedActual(text)
    // All three are textually identical → deduped to one
    expect(out).toEqual(["should work."])
  })

  test("ANSI strip (real ESC bytes)", () => {
    const ESC = ""
    const text = `${ESC}[31mexpected 1.${ESC}[0m`
    const out = extractExpectedActual(text)
    expect(out.some((s) => s.includes("expected 1."))).toBe(true)
  })
})
