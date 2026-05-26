/**
 * Hellgate — `aggregate` + `formatMatrixTable` adversarial battery.
 *
 * (The brief named these "summary" — in the current codebase they live in
 * `tools/swebench-matrix.ts` directly; there is no `summary.ts` slice. This
 * file pins the design as it stands: pure, deterministic, canonical-ordered.)
 *
 * Invariants:
 *   - `aggregate(rows)` is PURE: no fs, no env.
 *   - Output is canonical-ordered (the `CONDITIONS` enum order), not input
 *     order. Conditions with no rows are absent (skipped).
 *   - `passed/total` excludes verdict=='degraded' (counted=excluded). Errors
 *     count in the denominator (fail-to-deliver).
 *   - Averages compute over the same counted set (degraded excluded).
 *   - `formatMatrixTable` emits a stable markdown shape; one row per stat.
 *   - Adversarial input rows (NaN/Infinity/empty model) do not crash the
 *     aggregator; numeric rounding is lossy-but-stable.
 */
import { describe, expect, test } from "bun:test"
import {
  aggregate,
  CONDITIONS,
  type Condition,
  formatMatrixTable,
  type MatrixRow,
} from "@/../tools/swebench-matrix"

const mkRow = (over: Partial<MatrixRow>): MatrixRow => ({
  condition: "baseline",
  pickId: "x__y-1",
  verdict: "pass",
  turns: 1,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  wallMs: 0,
  costUsd: 0,
  ...over,
})

describe("hellgate aggregate — adversarial", () => {
  test("empty rows ⇒ empty stats array", () => {
    expect(aggregate([])).toEqual([])
  })

  test("single row ⇒ exactly 1 stat entry", () => {
    const stats = aggregate([mkRow({})])
    expect(stats.length).toBe(1)
    expect(stats[0]?.passed).toBe(1)
    expect(stats[0]?.total).toBe(1)
    expect(stats[0]?.passAt1Pct).toBe(100)
  })

  test("all-degraded rows ⇒ entry emitted with total=0 (degraded excluded from denominator)", () => {
    // Design pin: the aggregator iterates `list.length === 0 ⇒ skip` (BEFORE
    // filtering degraded). All-degraded rows still produce ONE entry, but
    // with `total === 0` and `passAt1Pct === 0`. Downstream printers may
    // choose to suppress the line; the aggregator does NOT.
    const stats = aggregate([
      mkRow({ verdict: "degraded" }),
      mkRow({ verdict: "degraded", pickId: "b" }),
    ])
    expect(stats.length).toBe(1)
    expect(stats[0]?.passed).toBe(0)
    expect(stats[0]?.total).toBe(0)
    expect(stats[0]?.passAt1Pct).toBe(0)
  })

  test("error counts toward denominator (NOT a pass, NOT excluded)", () => {
    const stats = aggregate([
      mkRow({ verdict: "pass", pickId: "a" }),
      mkRow({ verdict: "error", pickId: "b" }),
    ])
    const s = stats[0]
    expect(s?.passed).toBe(1)
    expect(s?.total).toBe(2)
    expect(s?.passAt1Pct).toBe(50)
  })

  test("100 rows in one condition ⇒ stable pct rounding to 1 decimal", () => {
    const rows: MatrixRow[] = []
    for (let i = 0; i < 100; i++) {
      rows.push(mkRow({ pickId: `p-${i}`, verdict: i < 37 ? "pass" : "fail" }))
    }
    const s = aggregate(rows)[0]
    expect(s?.passed).toBe(37)
    expect(s?.total).toBe(100)
    expect(s?.passAt1Pct).toBe(37) // 37.0 exact
  })

  test("output ordered by CONDITIONS canonical even when input is jumbled", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "subagent+skills", pickId: "a" }),
      mkRow({ condition: "lsp", pickId: "b" }),
      mkRow({ condition: "baseline", pickId: "c" }),
      mkRow({ condition: "all", pickId: "d" }),
      mkRow({ condition: "lsp+subagent", pickId: "e" }),
    ]
    const stats = aggregate(rows)
    const order: Condition[] = stats.map((s) => s.condition)
    // Should match CONDITIONS' index order for the conditions present.
    const expected: Condition[] = ["baseline", "lsp", "lsp+subagent", "subagent+skills", "all"]
    expect(order).toEqual(expected)
  })

  test("unknown-condition rows are SILENTLY DROPPED (aggregate iterates CONDITIONS only)", () => {
    // The aggregator iterates the closed `CONDITIONS` list; rows with a
    // non-canonical `condition` value never appear in output. This is the
    // design — guarded by the type. We force-cast to expose the runtime path.
    const rows: MatrixRow[] = [
      mkRow({ pickId: "a" }),
      mkRow({ pickId: "b", condition: "not-a-condition" as Condition }),
    ]
    const stats = aggregate(rows)
    expect(stats.length).toBe(1)
    expect(stats[0]?.total).toBe(1)
  })

  test("averages compute over non-degraded ONLY (extreme degraded row does NOT skew)", () => {
    const rows: MatrixRow[] = [
      mkRow({ pickId: "a", verdict: "pass", tokensIn: 100, turns: 2 }),
      mkRow({ pickId: "b", verdict: "fail", tokensIn: 200, turns: 4 }),
      // Adversarial: degraded row carrying massive numbers — must NOT pollute averages.
      mkRow({
        pickId: "c",
        verdict: "degraded",
        tokensIn: 1e9,
        turns: 9_999,
        wallMs: 1e12,
      }),
    ]
    const s = aggregate(rows)[0]
    expect(s?.avgTokensIn).toBe(150) // (100 + 200) / 2 — degraded excluded
    expect(s?.avgTurns).toBe(3)
  })

  test("NaN turns ⇒ averages become NaN (no silent zero) — design pin", () => {
    // The aggregator does NOT scrub NaN. Document the behaviour so the
    // upstream parser is the one responsible for sanitisation. This test
    // FAILS if someone silently introduces a sanitiser without updating the
    // contract.
    const rows: MatrixRow[] = [
      mkRow({ pickId: "a", turns: Number.NaN }),
      mkRow({ pickId: "b", turns: 2 }),
    ]
    const s = aggregate(rows)[0]
    expect(Number.isNaN(s?.avgTurns)).toBe(true)
  })

  test("Infinity wallMs ⇒ Math.round(Infinity) is Infinity (NOT crash)", () => {
    const rows: MatrixRow[] = [mkRow({ pickId: "a", wallMs: Number.POSITIVE_INFINITY })]
    const s = aggregate(rows)[0]
    expect(s?.avgWallMs).toBe(Number.POSITIVE_INFINITY)
  })

  test("very large N (1000 rows) one condition ⇒ aggregates without timeout", () => {
    const rows: MatrixRow[] = []
    for (let i = 0; i < 1000; i++) {
      rows.push(mkRow({ pickId: `p-${i}`, verdict: i % 3 === 0 ? "pass" : "fail" }))
    }
    const start = performance.now()
    const stats = aggregate(rows)
    const elapsed = performance.now() - start
    expect(stats[0]?.total).toBe(1000)
    expect(elapsed).toBeLessThan(50)
  })

  test("multi-condition pass@1 isolation (one condition's stats unaffected by another)", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "baseline", pickId: "a", verdict: "pass" }),
      mkRow({ condition: "baseline", pickId: "b", verdict: "fail" }),
      mkRow({ condition: "all", pickId: "c", verdict: "pass" }),
      mkRow({ condition: "all", pickId: "d", verdict: "pass" }),
    ]
    const stats = aggregate(rows)
    const bs = stats.find((s) => s.condition === "baseline")
    const all = stats.find((s) => s.condition === "all")
    expect(bs?.passAt1Pct).toBe(50)
    expect(all?.passAt1Pct).toBe(100)
  })

  test("zero token rows ⇒ avg = 0 (no NaN from divide-by-zero downstream)", () => {
    const rows: MatrixRow[] = [
      mkRow({ pickId: "a", tokensIn: 0, tokensOut: 0 }),
      mkRow({ pickId: "b", tokensIn: 0, tokensOut: 0 }),
    ]
    const s = aggregate(rows)[0]
    expect(s?.avgTokensIn).toBe(0)
    expect(s?.avgTokensOut).toBe(0)
  })

  test("rounding contract: passAt1Pct rounded to 1 decimal", () => {
    // 1/3 = 33.333...% → 33.3 (matrix.ts: Math.round(x*1000)/10)
    const rows: MatrixRow[] = [
      mkRow({ pickId: "a", verdict: "pass" }),
      mkRow({ pickId: "b", verdict: "fail" }),
      mkRow({ pickId: "c", verdict: "fail" }),
    ]
    const s = aggregate(rows)[0]
    expect(s?.passAt1Pct).toBeCloseTo(33.3, 1)
  })

  test("rounding contract: avgCostUsd rounded to 4 decimals", () => {
    const rows: MatrixRow[] = [
      mkRow({ pickId: "a", costUsd: 0.123456789 }),
      mkRow({ pickId: "b", costUsd: 0.987654321 }),
    ]
    const s = aggregate(rows)[0]
    // Average = 0.555555555 → round4 → 0.5556
    expect(s?.avgCostUsd).toBe(0.5556)
  })
})

describe("hellgate formatMatrixTable — adversarial", () => {
  test("empty stats ⇒ header + separator only (2 lines)", () => {
    const table = formatMatrixTable([])
    expect(table.split("\n")).toHaveLength(2)
    expect(table).toContain("| condition |")
    expect(table).toContain("| --- |")
  })

  test("single condition ⇒ 3 lines (header + separator + 1 row)", () => {
    const stats = aggregate([
      { ...mkRow({ verdict: "pass" }) },
      { ...mkRow({ pickId: "b", verdict: "fail" }) },
    ])
    const lines = formatMatrixTable(stats).split("\n")
    expect(lines.length).toBe(3)
    expect(lines[2]).toContain("baseline")
    expect(lines[2]).toContain("50.0%")
    expect(lines[2]).toContain("(1/2)")
  })

  test("multi-condition emits in canonical order regardless of stats order", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "all", pickId: "a", verdict: "pass" }),
      mkRow({ condition: "baseline", pickId: "b", verdict: "pass" }),
      mkRow({ condition: "lsp", pickId: "c", verdict: "fail" }),
    ]
    const table = formatMatrixTable(aggregate(rows))
    const lines = table.split("\n")
    // header, sep, baseline, lsp, all
    expect(lines[2]).toContain("baseline")
    expect(lines[3]).toContain("lsp")
    expect(lines[4]).toContain("all")
  })

  test("wall (s) is rendered to 1 decimal", () => {
    const rows: MatrixRow[] = [mkRow({ wallMs: 5500 }), mkRow({ pickId: "b", wallMs: 5500 })]
    const table = formatMatrixTable(aggregate(rows))
    expect(table).toContain("5.5")
  })

  test("$ value rendered to 4 decimals (toFixed(4))", () => {
    const rows: MatrixRow[] = [mkRow({ costUsd: 0.0001 })]
    const table = formatMatrixTable(aggregate(rows))
    expect(table).toContain("$0.0001")
  })

  test("0% pass shows 0.0% (NOT '0%' or blank)", () => {
    const rows: MatrixRow[] = [mkRow({ verdict: "fail" }), mkRow({ pickId: "b", verdict: "fail" })]
    const table = formatMatrixTable(aggregate(rows))
    expect(table).toContain("0.0%")
    expect(table).toContain("(0/2)")
  })

  test("100% pass shows 100.0% (precision pinned)", () => {
    const rows: MatrixRow[] = [mkRow({ verdict: "pass" })]
    const table = formatMatrixTable(aggregate(rows))
    expect(table).toContain("100.0%")
    expect(table).toContain("(1/1)")
  })

  test("output is byte-stable across two identical calls", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "lsp", pickId: "a", verdict: "pass", costUsd: 0.123 }),
    ]
    const t1 = formatMatrixTable(aggregate(rows))
    const t2 = formatMatrixTable(aggregate(rows))
    expect(t1).toBe(t2)
  })

  test("all CONDITIONS present in stats ⇒ table has 8+2 = 10 lines", () => {
    const rows: MatrixRow[] = []
    for (const c of CONDITIONS) {
      rows.push(mkRow({ condition: c, pickId: `p-${c}` }))
    }
    const lines = formatMatrixTable(aggregate(rows)).split("\n")
    expect(lines.length).toBe(2 + CONDITIONS.length)
  })
})
