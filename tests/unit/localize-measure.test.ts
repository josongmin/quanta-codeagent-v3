/**
 * Unit coverage for the PURE measurement helpers in
 * `tests/smoke/localize/measure.ts`. The corpus is NOT loaded here and no
 * ripgrep is spawned; we feed synthetic output strings through `parseRanking`
 * and exercise `recallAtK` / `mrr` / `aggregate` on known inputs.
 */
import { describe, expect, test } from "bun:test"
import {
  aggregate,
  mrr,
  normalizePredictions,
  parseRanking,
  type QueryReport,
  rankOfFirstExpected,
  recallAtK,
} from "../smoke/localize/measure"

describe("parseRanking", () => {
  test("extracts ranked file order from a synthetic localize output", () => {
    // Mirrors `render` in src/tool/localize/index.ts:
    //   <file>           ← group header (no indent)
    //     <file>:<line>  <snippet>   ← indented data row
    const output = [
      "src/foo.ts",
      "  src/foo.ts:10  const foo = 1",
      "  src/foo.ts:20  const bar = 2",
      "src/bar.ts",
      "  src/bar.ts:5  baz",
      "src/baz.ts",
      "  src/baz.ts:1  qux",
    ].join("\n")
    expect(parseRanking(output)).toEqual(["src/foo.ts", "src/bar.ts", "src/baz.ts"])
  })

  test("deduplicates: a file appearing in multiple rows keeps the first position", () => {
    // foo appears first, then bar interleaves, then foo again — foo stays at index 0.
    const output = [
      "  src/foo.ts:1  a",
      "  src/foo.ts:2  b",
      "  src/bar.ts:1  c",
      "  src/foo.ts:3  d",
      "  src/baz.ts:7  e",
    ].join("\n")
    expect(parseRanking(output)).toEqual(["src/foo.ts", "src/bar.ts", "src/baz.ts"])
  })

  test("ignores group-header lines (no leading indent) and malformed rows", () => {
    const output = [
      "(no candidates)", // sentinel from localize — no indent, ignored
      "src/header-only.ts", // header-style line, ignored
      "  not-a-file-row-without-colon-line",
      "  src/real.ts:42  snippet",
    ].join("\n")
    expect(parseRanking(output)).toEqual(["src/real.ts"])
  })
})

describe("recallAtK", () => {
  test("computes recall@K against known input", () => {
    const expected = ["a", "b"]
    const predicted = ["x", "a", "y", "b", "z"]
    // top-1: {x}            → 0 / 2
    // top-3: {x, a, y}      → 1 / 2
    // top-5: {x, a, y, b, z} → 2 / 2
    expect(recallAtK(expected, predicted, 1)).toBe(0)
    expect(recallAtK(expected, predicted, 3)).toBe(0.5)
    expect(recallAtK(expected, predicted, 5)).toBe(1)
  })

  test("returns 0 when expected is empty (defensive)", () => {
    expect(recallAtK([], ["a"], 5)).toBe(0)
  })
})

describe("MRR / rankOfFirstExpected", () => {
  test("returns 0 when no expected file appears in predicted", () => {
    expect(mrr(["target.ts"], ["a.ts", "b.ts", "c.ts"])).toBe(0)
    expect(rankOfFirstExpected(["target.ts"], ["a.ts", "b.ts", "c.ts"])).toBe(0)
  })

  test("first hit at position N gives 1/N (1-based)", () => {
    // Expected file is at index 2 (1-based rank 3) → mrr = 1/3
    expect(mrr(["target.ts"], ["a.ts", "b.ts", "target.ts", "c.ts"])).toBeCloseTo(1 / 3, 10)
    expect(rankOfFirstExpected(["target.ts"], ["a.ts", "b.ts", "target.ts", "c.ts"])).toBe(3)
  })
})

describe("normalizePredictions", () => {
  test("relativizes absolute paths under cwd and filters measurement artifacts", () => {
    const cwd = "/repo"
    const input = [
      "/repo/src/foo.ts",
      "/repo/tests/smoke/localize/corpus.json", // measurement instrument — dropped
      "/repo/tests/smoke/localize/baseline.json", // prior baseline — dropped
      "/repo/tests/unit/bar.test.ts",
      "/unrelated/elsewhere.ts", // outside cwd — kept verbatim, will not match any corpus entry
    ]
    expect(normalizePredictions(input, cwd)).toEqual([
      "src/foo.ts",
      "tests/unit/bar.test.ts",
      "/unrelated/elsewhere.ts",
    ])
  })

  test("passes already-relative paths through unchanged", () => {
    expect(normalizePredictions(["src/a.ts", "src/b.ts"], "/repo")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ])
  })
})

describe("aggregate", () => {
  test("is the arithmetic mean across queries", () => {
    const reports: QueryReport[] = [
      {
        id: "q1",
        predicted_top5: [],
        rank_of_first_expected: 1,
        "recall@1": 1,
        "recall@3": 1,
        "recall@5": 1,
      },
      {
        id: "q2",
        predicted_top5: [],
        rank_of_first_expected: 0,
        "recall@1": 0,
        "recall@3": 0,
        "recall@5": 0,
      },
      {
        id: "q3",
        predicted_top5: [],
        rank_of_first_expected: 3,
        "recall@1": 0,
        "recall@3": 1,
        "recall@5": 1,
      },
    ]
    // q1 mrr = 1, q2 mrr = 0, q3 mrr = 1/3 → mean MRR = (1 + 0 + 1/3) / 3
    const agg = aggregate(reports, [1, 0, 1 / 3])
    expect(agg.n).toBe(3)
    expect(agg["recall@1"]).toBeCloseTo(1 / 3, 10)
    expect(agg["recall@3"]).toBeCloseTo(2 / 3, 10)
    expect(agg["recall@5"]).toBeCloseTo(2 / 3, 10)
    expect(agg.MRR).toBeCloseTo((1 + 0 + 1 / 3) / 3, 10)
  })

  test("handles the empty corpus (defensive)", () => {
    const agg = aggregate([], [])
    expect(agg).toEqual({ "recall@1": 0, "recall@3": 0, "recall@5": 0, MRR: 0, n: 0 })
  })
})
