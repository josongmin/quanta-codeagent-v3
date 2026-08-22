/**
 * Unit tests for `tools/swebench-matrix/progress.ts` + `summary.ts`.
 *
 * Pure-function coverage: formatters, ETA estimator, cost accumulator,
 * summary builder. The runner-side side effects (writing stderr, the
 * cost.json) are exercised in `tests/integration/matrix-resume-flow`.
 */
import { describe, expect, test } from "bun:test"
import type { MatrixRow } from "@/../tools/swebench-matrix"
import {
  buildCostFile,
  emptyCostAccumulator,
  estimateEtaMs,
  formatEta,
  formatInstanceLine,
  formatProgressBar,
  recordInstance,
  recordRows,
} from "@/../tools/swebench-matrix/progress"
import { buildSummary, formatSummaryTable } from "@/../tools/swebench-matrix/summary"

const mkRow = (over: Partial<MatrixRow> = {}): MatrixRow => ({
  condition: "baseline",
  pickId: "x",
  verdict: "pass",
  turns: 5,
  tokensIn: 100,
  tokensOut: 20,
  cacheRead: 0,
  wallMs: 10_000,
  costUsd: 0.05,
  ...over,
})

describe("formatInstanceLine", () => {
  test("PASS verdict formatted with turns + wall time", () => {
    const line = formatInstanceLine(3, 10, {
      pickId: "sympy__sympy-13480",
      verdict: "pass",
      turns: 11,
      wallMs: 12_300,
    })
    expect(line).toBe("[3/10] sympy__sympy-13480 PASS (turns=11, 12.3s)")
  })

  test("FAIL / SKIP (degraded) / ERR all use distinct 4-char tags", () => {
    const fail = formatInstanceLine(1, 1, {
      pickId: "a",
      verdict: "fail",
      turns: 1,
      wallMs: 0,
    })
    expect(fail).toContain("FAIL")
    const skip = formatInstanceLine(1, 1, {
      pickId: "a",
      verdict: "degraded",
      turns: 0,
      wallMs: 0,
    })
    expect(skip).toContain("SKIP")
    const err = formatInstanceLine(1, 1, {
      pickId: "a",
      verdict: "error",
      turns: 0,
      wallMs: 0,
    })
    expect(err).toContain("ERR")
  })

  test("zero wall ms renders as 0.0s (no NaN / Infinity)", () => {
    const line = formatInstanceLine(1, 1, {
      pickId: "p",
      verdict: "pass",
      turns: 1,
      wallMs: 0,
    })
    expect(line).toContain("0.0s")
  })
})

describe("formatProgressBar", () => {
  test("full happy line includes bar + percent + cost + ETA", () => {
    const bar = formatProgressBar({
      completed: 2,
      total: 4,
      spentUsd: 1.2,
      estUsd: 3.0,
      etaMs: 4_320_000, // 72 minutes = 1h 12m
    })
    expect(bar).toContain("[2/4 conditions]")
    expect(bar).toContain("[#####-----]")
    expect(bar).toContain("50%")
    expect(bar).toContain("$1.2000")
    expect(bar).toContain("~$3.0000 est")
    expect(bar).toContain("ETA ~1h 12m")
  })

  test("ETA / spent / est undefined → 'n/a' segments (no fabricated numbers)", () => {
    const bar = formatProgressBar({ completed: 0, total: 4 })
    expect(bar).toContain("0/4 conditions")
    expect(bar).toContain("[----------]")
    expect(bar).toContain("0%")
    expect(bar).toContain("n/a / n/a")
    expect(bar).toContain("ETA n/a")
  })

  test("total=0 renders empty bar without divide-by-zero", () => {
    const bar = formatProgressBar({ completed: 0, total: 0 })
    expect(bar).toContain("0%")
    expect(bar).toContain("[----------]")
  })

  test("100% complete renders fully filled bar", () => {
    const bar = formatProgressBar({ completed: 4, total: 4, spentUsd: 2.5 })
    expect(bar).toContain("[##########]")
    expect(bar).toContain("100%")
  })
})

describe("formatEta", () => {
  test("undefined / negative / non-finite → 'n/a'", () => {
    expect(formatEta(undefined)).toBe("n/a")
    expect(formatEta(-1)).toBe("n/a")
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe("n/a")
    expect(formatEta(Number.NaN)).toBe("n/a")
  })
  test("sub-minute → ~Ns", () => {
    expect(formatEta(15_000)).toBe("~15s")
  })
  test("sub-hour → ~Mm", () => {
    expect(formatEta(20 * 60 * 1000)).toBe("~20m")
  })
  test("≥ 1h → ~Hh MMm with zero-padded minutes", () => {
    expect(formatEta(60 * 60 * 1000)).toBe("~1h 00m")
    expect(formatEta(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe("~2h 05m")
  })
})

describe("estimateEtaMs", () => {
  test("no observations → undefined (never invent)", () => {
    expect(estimateEtaMs([], 10)).toBeUndefined()
  })
  test("zero remaining → 0 ms", () => {
    expect(estimateEtaMs([5000, 10_000], 0)).toBe(0)
  })
  test("arithmetic mean × remaining: 3 instance avg → 7 picks predicted", () => {
    // mean = (5+10+15)/3 = 10s → 7 picks remaining → 70s
    const eta = estimateEtaMs([5000, 10_000, 15_000], 7)
    expect(eta).toBe(70_000)
  })
  test("single observation behaves as expected (no special-casing)", () => {
    expect(estimateEtaMs([20_000], 5)).toBe(100_000)
  })
})

describe("CostAccumulator (recordInstance + recordRows)", () => {
  test("emptyCostAccumulator starts at zeros", () => {
    const a = emptyCostAccumulator()
    expect(a.observedWallMs).toEqual([])
    expect(a.spentUsd).toBe(0)
    expect(a.instanceCount).toBe(0)
  })

  test("recordInstance accumulates cost + wall observation", () => {
    const a = recordInstance(emptyCostAccumulator(), mkRow({ wallMs: 7000, costUsd: 0.25 }))
    expect(a.spentUsd).toBeCloseTo(0.25, 4)
    expect(a.observedWallMs).toEqual([7000])
    expect(a.instanceCount).toBe(1)
  })

  test("degraded row contributes 0 cost AND no wall observation", () => {
    const a = recordInstance(
      emptyCostAccumulator(),
      mkRow({ verdict: "degraded", wallMs: 99_999, costUsd: 0 }),
    )
    expect(a.spentUsd).toBe(0)
    expect(a.observedWallMs).toEqual([])
    // instanceCount still bumps — the pick was attempted.
    expect(a.instanceCount).toBe(1)
  })

  test("error rows DO contribute cost + wall (fail-to-deliver attribution)", () => {
    const a = recordInstance(
      emptyCostAccumulator(),
      mkRow({ verdict: "error", wallMs: 1000, costUsd: 0.05 }),
    )
    expect(a.spentUsd).toBeCloseTo(0.05, 4)
    expect(a.observedWallMs).toEqual([1000])
  })

  test("recordRows bulk replay equals sequential recordInstance", () => {
    const rows = [
      mkRow({ wallMs: 1000, costUsd: 0.1 }),
      mkRow({ wallMs: 2000, costUsd: 0.2, verdict: "fail" }),
      mkRow({ wallMs: 3000, costUsd: 0.3 }),
    ]
    const bulk = recordRows(emptyCostAccumulator(), rows)
    let seq = emptyCostAccumulator()
    for (const r of rows) seq = recordInstance(seq, r)
    expect(bulk).toEqual(seq)
    expect(bulk.spentUsd).toBeCloseTo(0.6, 4)
    expect(bulk.observedWallMs).toEqual([1000, 2000, 3000])
  })
})

describe("buildCostFile", () => {
  test("emits version=1 + spent + model + updatedAt + instancesObserved", () => {
    const acc = recordRows(emptyCostAccumulator(), [mkRow({ costUsd: 1.23 })])
    const file = buildCostFile({ acc, model: "gpt-5", now: () => 1_700_000_000_000 })
    expect(file.version).toBe(1)
    expect(file.spentUsd).toBeCloseTo(1.23, 4)
    expect(file.model).toBe("gpt-5")
    expect(file.updatedAt).toBe(1_700_000_000_000)
    expect(file.instancesObserved).toBe(1)
    expect(file.estUsd).toBeUndefined()
  })

  test("estUsd carried through when provided", () => {
    const file = buildCostFile({
      acc: emptyCostAccumulator(),
      model: "gpt-5",
      estUsd: 5.0,
    })
    expect(file.estUsd).toBe(5.0)
  })
})

describe("buildSummary (pure)", () => {
  test("groups rows by condition, excludes degraded from denominator", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "baseline", pickId: "a", verdict: "pass", costUsd: 0.1 }),
      mkRow({ condition: "baseline", pickId: "b", verdict: "fail", costUsd: 0.2 }),
      mkRow({ condition: "baseline", pickId: "c", verdict: "degraded", costUsd: 0 }),
      mkRow({ condition: "lsp", pickId: "d", verdict: "pass", costUsd: 0.3 }),
      mkRow({ condition: "lsp", pickId: "e", verdict: "pass", costUsd: 0.4 }),
    ]
    const report = buildSummary(rows)
    // lsp ranks first (100% pass) then baseline (50%) — sorted by pass@1 desc.
    expect(report.rows[0]?.condition).toBe("lsp")
    expect(report.rows[0]?.passAt1Pct).toBe(100)
    expect(report.rows[0]?.n).toBe(2)
    expect(report.rows[1]?.condition).toBe("baseline")
    // baseline excludes degraded: 2 in denominator, 1 pass = 50%
    expect(report.rows[1]?.passAt1Pct).toBe(50)
    expect(report.rows[1]?.n).toBe(2)
  })

  test("computes Bernoulli σ = √(p·(1-p))", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "baseline", verdict: "pass" }),
      mkRow({ condition: "baseline", verdict: "fail" }),
    ]
    const r = buildSummary(rows).rows[0]
    if (r === undefined) throw new Error("expected row")
    expect(r.passStddev).toBeCloseTo(0.5, 4) // √(0.5*0.5) = 0.5
  })

  test("ROI = passAt1Pct / avgCostUsd; 0 when avgCostUsd is 0", () => {
    const rows: MatrixRow[] = [mkRow({ condition: "baseline", verdict: "pass", costUsd: 0 })]
    const r = buildSummary(rows).rows[0]
    if (r === undefined) throw new Error("expected row")
    expect(r.roiPerUsd).toBe(0)
  })

  test("totalCostUsd sums non-degraded row costs", () => {
    const rows: MatrixRow[] = [
      mkRow({ condition: "baseline", costUsd: 0.1 }),
      mkRow({ condition: "baseline", costUsd: 0.2, verdict: "fail" }),
      mkRow({ condition: "baseline", costUsd: 99, verdict: "degraded" }), // excluded
    ]
    const report = buildSummary(rows)
    expect(report.totalCostUsd).toBeCloseTo(0.3, 4)
    expect(report.totalRows).toBe(3)
  })

  test("scatter mirrors rows with (cond, avgCost, passAt1, n)", () => {
    const rows: MatrixRow[] = [mkRow({ condition: "baseline", verdict: "pass", costUsd: 1 })]
    const report = buildSummary(rows)
    expect(report.scatter).toEqual([
      { condition: "baseline", avgCostUsd: 1, passAt1Pct: 100, n: 1 },
    ])
  })

  test("formatSummaryTable renders markdown with all columns", () => {
    const rows: MatrixRow[] = [mkRow({ condition: "baseline", verdict: "pass", costUsd: 0.5 })]
    const table = formatSummaryTable(buildSummary(rows))
    expect(table).toContain("| condition |")
    expect(table).toContain("pass@1")
    expect(table).toContain("ROI")
    expect(table).toContain("total cost")
  })
})
