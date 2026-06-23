/**
 * Hellgate for the LSP-03 measurement aggregator (tools/dev/lsp-grounding-summary).
 *
 * Proves the report.json → measurement-table pipeline: extraction is tolerant of
 * shape drift, multi-report merge gives one distribution (the n>1 the protocol
 * mandates), and the rendered table reflects the folded summary.
 */
import { describe, expect, test } from "bun:test"
import { summarizeGroundingStatuses } from "@/shared"
import {
  extractGroundingStatuses,
  renderGroundingMeasurement,
} from "../../tools/dev/lsp-grounding-summary"

const reportWith = (statuses: unknown[]): unknown => ({
  total: statuses.length,
  resolved: 0,
  results: statuses.map((s, i) => ({ id: `inst-${i}`, passed: false, lspGrounding: s })),
})

describe("LSP-03 measurement aggregator", () => {
  test("extract is tolerant of shape drift and skips rows without lspGrounding", () => {
    const reports = [
      reportWith([
        { backend: "pyright", language: "py", launch: "ok", ready: "ok" },
        { backend: "pyright", language: "py", launch: "ok", ready: "ready_timeout" },
      ]),
      {
        results: [
          { id: "x", passed: true },
          { id: "y", lspGrounding: null },
        ],
      }, // no/null grounding
      { notResults: [] }, // wrong shape
      reportWith([{ backend: "pyright", language: "py", launch: "missing_binary" }]),
    ]
    const statuses = extractGroundingStatuses(reports)
    expect(statuses.length).toBe(3) // 2 + 0 + 0 + 1 — null/missing skipped, never throws
  })

  test("multi-report merge folds into one distribution (n>1 protocol)", () => {
    const runA = reportWith([
      { backend: "pyright", language: "py", launch: "ok", ready: "ok", durationMs: 30 },
      { backend: "pyright", language: "py", launch: "ok", ready: "ready_timeout", durationMs: 120 },
    ])
    const runB = reportWith([
      { backend: "pyright", language: "py", launch: "ok", ready: "ready_timeout", durationMs: 90 },
    ])
    const summary = summarizeGroundingStatuses(extractGroundingStatuses([runA, runB]))
    expect(summary.total).toBe(3)
    expect(summary.readyTimeouts).toBe(2)
    expect(summary.readyDurationsMs).toEqual([30, 90, 120])

    const table = renderGroundingMeasurement(summary)
    expect(table).toContain("grounding rows:    3")
    expect(table).toContain("ready_timeout:     2")
    // min/median/max over 3 = 30/90/120
    expect(table).toContain("30/90/120")
    expect(table).toContain("ready outcomes:    ok=1 ready_timeout=2")
  })

  test("empty / no-grounding report renders an n/a duration cell, never throws", () => {
    const summary = summarizeGroundingStatuses(extractGroundingStatuses([{ results: [] }]))
    expect(summary.total).toBe(0)
    expect(renderGroundingMeasurement(summary)).toContain("ready ms (min/med/max over 0): n/a")
  })
})
