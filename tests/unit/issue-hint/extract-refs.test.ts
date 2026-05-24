/**
 * `extractRefs` — PR / issue references.
 *
 * Two patterns:
 *   - `#N`         GitHub-style; 1..7 digits required
 *   - `PROJ-N`     JIRA-style; 1..10 uppercase letters + 1..7 digits
 */
import { describe, expect, test } from "bun:test"
import { extractRefs } from "../../../src/agent/issue-hint/extract-refs"

describe("extractRefs — PR/issue references", () => {
  test("empty input → []", () => {
    expect(extractRefs("")).toEqual([])
    expect(extractRefs(undefined as unknown as string)).toEqual([])
  })

  test("GitHub-style #N captured", () => {
    expect(extractRefs("see PR #774 for context")).toEqual(["#774"])
  })

  test("multiple #N refs deduped + sorted", () => {
    expect(extractRefs("see #774 and #4168 and #774 again")).toEqual(["#4168", "#774"])
  })

  test("#abc (non-digit) does NOT match", () => {
    expect(extractRefs("see #abc or #FF0000 for color")).toEqual([])
  })

  test("JIRA-style PROJ-N captured", () => {
    expect(extractRefs("PROJ-456 affects this")).toEqual(["PROJ-456"])
  })

  test("single-letter project prefix accepted (A-1)", () => {
    expect(extractRefs("A-1 is the entry")).toEqual(["A-1"])
  })

  test("lowercase project prefix REJECTED (uppercase required)", () => {
    expect(extractRefs("proj-1 lowercase doesn't count")).toEqual([])
  })

  test("mid-token #N (preceded by alphanum) does NOT match", () => {
    // Prevent matching `arg=value#5` (URL fragment) or `0#1` patterns
    expect(extractRefs("value#5 should not match")).toEqual([])
    expect(extractRefs("0#1 not a ref")).toEqual([])
  })

  test("mixed refs in one input — all deduped + sorted", () => {
    const text = "PR #774 fixed PROJ-456 in #4168."
    expect(extractRefs(text)).toEqual(["#4168", "#774", "PROJ-456"])
  })

  test("ref at start of input is captured", () => {
    expect(extractRefs("#1 is the issue")).toEqual(["#1"])
    expect(extractRefs("PROJ-1 first")).toEqual(["PROJ-1"])
  })

  test("digits-only ref >7 digits NOT captured (over-bound)", () => {
    expect(extractRefs("#12345678 is too long")).toEqual([])
  })

  test("PROJ-N with >10 letter prefix NOT captured", () => {
    expect(extractRefs("ABCDEFGHIJK-1 too long")).toEqual([])
  })

  test("ANSI escape codes stripped before scanning", () => {
    // Real ANSI CSI sequence uses ESC byte (0x1b) + `[…m`.
    const ESC = ""
    const text = `${ESC}[31m#774${ESC}[0m should match`
    expect(extractRefs(text)).toEqual(["#774"])
  })

  test("regex state isolation", () => {
    expect(extractRefs("#1")).toEqual(["#1"])
    expect(extractRefs("#1")).toEqual(["#1"])
  })
})
