import { describe, expect, test } from "bun:test"
import {
  countBiomeErrors,
  countTscErrors,
  parseBunTestOutput,
} from "../../tools/feature-catalog/refresh-baseline"

describe("parseBunTestOutput", () => {
  test("happy path: full footer with all five counters", () => {
    const text = [
      "bun test v1.3.14 (0d9b296a)",
      "[error] some stderr noise",
      "",
      " 1952 pass",
      " 2 skip",
      " 0 fail",
      " 5624 expect() calls",
      "Ran 1954 tests across 154 files. [26.27s]",
    ].join("\n")
    expect(parseBunTestOutput(text)).toEqual({
      pass: 1952,
      fail: 0,
      skip: 2,
      expect_count: 5624,
      files: 154,
    })
  })

  test("zero pass / nonzero fail still parses (no implicit success bias)", () => {
    const text = [
      " 0 pass",
      " 12 fail",
      " 0 skip",
      " 0 expect() calls",
      "Ran 12 tests across 3 files. [0.42s]",
    ].join("\n")
    expect(parseBunTestOutput(text)).toEqual({
      pass: 0,
      fail: 12,
      skip: 0,
      expect_count: 0,
      files: 3,
    })
  })

  test("counters embedded mid-line still match (no anchor lock-in)", () => {
    const text = "prefix 7 pass and 1 fail and 0 skip 42 expect() calls done across 5 files."
    expect(parseBunTestOutput(text)).toEqual({
      pass: 7,
      fail: 1,
      skip: 0,
      expect_count: 42,
      files: 5,
    })
  })

  test("CRLF + extra blank lines tolerated", () => {
    const text = " 100 pass\r\n 0 fail\r\n 0 skip\r\n\r\n 250 expect() calls\r\nacross 10 files\r\n"
    expect(parseBunTestOutput(text)).toEqual({
      pass: 100,
      fail: 0,
      skip: 0,
      expect_count: 250,
      files: 10,
    })
  })

  test("missing one counter returns null (no silent zero-fill)", () => {
    const text = " 1 pass\n 0 fail\n 0 skip\n 1 expect() calls" // no `across N files`
    expect(parseBunTestOutput(text)).toBeNull()
  })

  test("totally malformed → null", () => {
    expect(parseBunTestOutput("garbage in, garbage out")).toBeNull()
  })

  test("empty string → null", () => {
    expect(parseBunTestOutput("")).toBeNull()
  })
})

describe("countTscErrors", () => {
  test("counts each `(LINE,COL): error TSxxxx:` row exactly once", () => {
    const text = [
      "tests/unit/foo.test.ts(143,15): error TS2339: Property 'x' does not exist on type 'Y'.",
      "tests/unit/bar.test.ts(37,34): error TS2554: Expected 0 arguments, but got 1.",
      "tests/unit/bar.test.ts(57,16): error TS2339: Property 'z' does not exist.",
      "",
      "Found 3 errors in 2 files.",
    ].join("\n")
    expect(countTscErrors(text)).toBe(3)
  })

  test("clean output → 0", () => {
    expect(countTscErrors("")).toBe(0)
  })

  test("non-matching diagnostic text → 0", () => {
    expect(countTscErrors("tsc completed successfully\nFound 0 errors.")).toBe(0)
  })
})

describe("countBiomeErrors", () => {
  test("counts each `× ...` diagnostic header", () => {
    const text = [
      "  × Unused variable foo",
      "  × Unused import bar",
      "  × noExplicitAny",
      "Checked 315 files. 3 errors.",
    ].join("\n")
    expect(countBiomeErrors(text)).toBe(3)
  })

  test("clean output → 0", () => {
    expect(countBiomeErrors("Checked 315 files in 372ms. No fixes applied.")).toBe(0)
  })
})
