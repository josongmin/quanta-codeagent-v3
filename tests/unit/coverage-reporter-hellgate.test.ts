/**
 * Hellgate — coverage reporter (ADR-0165).
 *
 * Seals:
 *   A. evaluate     (HELL-16..22) — 7 cases
 *   B. emitMetrics  (HELL-23..27) — 5 cases
 */

import { describe, expect, test } from "bun:test"
import { type CoverageReport, defaultCoverageReporter } from "@/observability/coverage"
import type { MetricSample, MetricSink } from "@/observability/metrics/index"

const mkReport = (totals: {
  linesPercent: number
  branchesPercent: number
  statementsPercent: number
}): CoverageReport => ({
  files: [],
  totals: { ...totals, fileCount: 0 },
  generatedAt: 0,
})

const mkReportWithFiles = (
  files: Array<{
    file: string
    linesPercent: number
    branchesPercent: number
    statementsPercent: number
  }>,
): CoverageReport => ({
  files: files.map((f) => ({
    file: f.file,
    lineCount: 100,
    linesCovered: f.linesPercent,
    linesPercent: f.linesPercent,
    branchCount: 100,
    branchesCovered: f.branchesPercent,
    branchesPercent: f.branchesPercent,
    statementCount: 100,
    statementsCovered: f.statementsPercent,
    statementsPercent: f.statementsPercent,
    uncoveredLines: [],
  })),
  totals: {
    linesPercent: 50,
    branchesPercent: 50,
    statementsPercent: 50,
    fileCount: files.length,
  },
  generatedAt: 0,
})

const sinkOf = (): { sink: MetricSink; samples: MetricSample[] } => {
  const samples: MetricSample[] = []
  return {
    sink: {
      send(s) {
        samples.push(s)
      },
    },
    samples,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// A. EVALUATE (7)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / A. evaluate", () => {
  test("HELL-16: no threshold → always pass", () => {
    const r = mkReport({ linesPercent: 5, branchesPercent: 5, statementsPercent: 5 })
    expect(defaultCoverageReporter().evaluate(r).kind).toBe("pass")
    expect(defaultCoverageReporter().evaluate(r, {}).kind).toBe("pass")
    expect(defaultCoverageReporter().evaluate(r, { threshold: {} }).kind).toBe("pass")
  })

  test("HELL-17: thresholds met → pass", () => {
    const r = mkReport({ linesPercent: 80, branchesPercent: 75, statementsPercent: 85 })
    const v = defaultCoverageReporter().evaluate(r, {
      threshold: { linesPercent: 80, branchesPercent: 70, statementsPercent: 80 },
    })
    expect(v.kind).toBe("pass")
  })

  test("HELL-18: linesPercent crossed → fail with reason 'lines: X < Y'", () => {
    const r = mkReport({ linesPercent: 73.2, branchesPercent: 90, statementsPercent: 90 })
    const v = defaultCoverageReporter().evaluate(r, {
      threshold: { linesPercent: 80 },
    })
    expect(v.kind).toBe("fail")
    if (v.kind === "fail") {
      expect(v.reasons[0]).toMatch(/^lines: 73\.2 < 80$/)
    }
  })

  test("HELL-19: multiple thresholds crossed → multiple reasons", () => {
    const r = mkReport({ linesPercent: 10, branchesPercent: 20, statementsPercent: 30 })
    const v = defaultCoverageReporter().evaluate(r, {
      threshold: { linesPercent: 80, branchesPercent: 70, statementsPercent: 90 },
    })
    expect(v.kind).toBe("fail")
    if (v.kind === "fail") {
      expect(v.reasons).toHaveLength(3)
      expect(v.reasons[0]).toMatch(/^lines:/)
      expect(v.reasons[1]).toMatch(/^branches:/)
      expect(v.reasons[2]).toMatch(/^statements:/)
    }
  })

  test("HELL-20: statements/branches independent (only one crosses)", () => {
    const r = mkReport({ linesPercent: 90, branchesPercent: 10, statementsPercent: 95 })
    const v = defaultCoverageReporter().evaluate(r, {
      threshold: { linesPercent: 80, branchesPercent: 80, statementsPercent: 80 },
    })
    expect(v.kind).toBe("fail")
    if (v.kind === "fail") {
      expect(v.reasons).toHaveLength(1)
      expect(v.reasons[0]).toMatch(/^branches:/)
    }
  })

  test("HELL-21: threshold 100 + actual 99.99 → fail", () => {
    const r = mkReport({ linesPercent: 99.99, branchesPercent: 100, statementsPercent: 100 })
    const v = defaultCoverageReporter().evaluate(r, { threshold: { linesPercent: 100 } })
    expect(v.kind).toBe("fail")
  })

  test("HELL-22: threshold 0 + actual 0 → pass (edge case)", () => {
    const r = mkReport({ linesPercent: 0, branchesPercent: 0, statementsPercent: 0 })
    const v = defaultCoverageReporter().evaluate(r, {
      threshold: { linesPercent: 0, branchesPercent: 0, statementsPercent: 0 },
    })
    expect(v.kind).toBe("pass")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. EMIT METRICS (5)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / B. emitMetrics", () => {
  test("HELL-23: single file → 3 gauge calls per file (lines/branches/statements)", () => {
    const r = mkReportWithFiles([
      { file: "/abs/a.ts", linesPercent: 80, branchesPercent: 70, statementsPercent: 90 },
    ])
    const { sink, samples } = sinkOf()
    defaultCoverageReporter().emitMetrics(r, sink)
    // 3 per file + 3 totals = 6
    expect(samples).toHaveLength(6)
    const fileSamples = samples.filter((s) => s.labels?.file === "/abs/a.ts")
    expect(fileSamples).toHaveLength(3)
    expect(fileSamples.map((s) => s.name).sort()).toEqual([
      "coverage.branches_percent",
      "coverage.lines_percent",
      "coverage.statements_percent",
    ])
    for (const s of fileSamples) expect(s.kind).toBe("gauge")
  })

  test("HELL-24: multi-file → N*3 gauges + 3 totals", () => {
    const r = mkReportWithFiles([
      { file: "/abs/a.ts", linesPercent: 80, branchesPercent: 70, statementsPercent: 90 },
      { file: "/abs/b.ts", linesPercent: 50, branchesPercent: 40, statementsPercent: 60 },
      { file: "/abs/c.ts", linesPercent: 90, branchesPercent: 95, statementsPercent: 95 },
    ])
    const { sink, samples } = sinkOf()
    defaultCoverageReporter().emitMetrics(r, sink)
    expect(samples).toHaveLength(3 * 3 + 3)
  })

  test("HELL-25: totals emitted as separate (label-less) metrics", () => {
    const r = mkReportWithFiles([
      { file: "/abs/a.ts", linesPercent: 80, branchesPercent: 70, statementsPercent: 90 },
    ])
    const { sink, samples } = sinkOf()
    defaultCoverageReporter().emitMetrics(r, sink)
    const totalNames = samples
      .filter((s) => s.labels === undefined)
      .map((s) => s.name)
      .sort()
    expect(totalNames).toEqual([
      "coverage.total_branches_percent",
      "coverage.total_lines_percent",
      "coverage.total_statements_percent",
    ])
  })

  test("HELL-26: throwing sink → no throw escapes (no-throw contract)", () => {
    const throwingSink: MetricSink = {
      send() {
        throw new Error("sink boom")
      },
    }
    const r = mkReportWithFiles([
      { file: "/abs/a.ts", linesPercent: 80, branchesPercent: 70, statementsPercent: 90 },
    ])
    expect(() => defaultCoverageReporter().emitMetrics(r, throwingSink)).not.toThrow()
  })

  test("HELL-27: per-file labels include the file path", () => {
    const r = mkReportWithFiles([
      { file: "/abs/foo/bar.ts", linesPercent: 50, branchesPercent: 50, statementsPercent: 50 },
    ])
    const { sink, samples } = sinkOf()
    defaultCoverageReporter().emitMetrics(r, sink)
    const fileSamples = samples.filter((s) => s.labels?.file !== undefined)
    expect(fileSamples).toHaveLength(3)
    for (const s of fileSamples) expect(s.labels?.file).toBe("/abs/foo/bar.ts")
  })
})
