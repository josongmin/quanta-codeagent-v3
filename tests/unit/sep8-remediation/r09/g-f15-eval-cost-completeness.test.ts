/**
 * G-F15 — unpriced eval usage must not render as measured $0.
 *
 * Fixtures: all-unknown, mixed, known-zero, known-positive, no-usage.
 * Asserts markdown AND structured report, and that headline/detail share one
 * projection. Mutation that drops completeness must not be able to hide behind $0.
 */
import { describe, expect, test } from "bun:test"
import {
  buildCoverageMatrix,
  type EvalCostPricing,
  projectEvalCost,
  type TokenCostRollup,
} from "@/../src/apps/eval/report/coverage-matrix"
import { renderHeadline, renderMatrixMarkdown } from "@/../src/apps/eval/report/markdown"
import type { EvalRecord } from "@/../src/apps/eval/storage"
import { allLeaves } from "@/../src/apps/eval/taxonomy"

const usecase = allLeaves()[0]?.id ?? "software-quality.debugging.error-message-paste"

const syn = (over: {
  tokens?: { prompt: number; completion: number; cacheRead?: number }
  costUsd?: number
}): EvalRecord => ({
  ts: 1,
  schema: 1,
  runId: "r09",
  tier: "synthetic",
  usecase,
  payload: {
    kind: "synthetic",
    scenarioId: "s",
    verdict: "pass",
    rubric: [],
    toolsUsed: [],
    durationMs: 1,
    ...(over.tokens !== undefined ? { tokens: over.tokens } : {}),
    ...(over.costUsd !== undefined ? { costUsd: over.costUsd } : {}),
  },
})

const tokens = (prompt: number, completion: number) => ({ prompt, completion })

describe("G-F15 — eval cost completeness", () => {
  test("no-usage: tokenCost absent, no cost line, byte-identical to pre-feature", () => {
    const m = buildCoverageMatrix([syn({})])
    expect(m.tokenCost).toBeUndefined()
    expect(m.costPricing).toBeUndefined()
    const md = renderMatrixMarkdown(m)
    expect(md).not.toContain("Token & Cost Summary")
    expect(md).not.toContain("Estimated cost")
    const head = renderHeadline(m)
    expect(head).not.toContain("Tokens=")
    expect(head).not.toContain("Cost=")
  })

  test("all-unknown: structured unavailable, markdown/headline are not $0", () => {
    const m = buildCoverageMatrix([
      syn({ tokens: tokens(800, 100) }),
      syn({ tokens: tokens(10, 5) }),
    ])
    expect(m.tokenCost).toBeDefined()
    expect(m.tokenCost?.records).toBe(2)
    expect(m.tokenCost?.prompt).toBe(810)
    expect(m.costPricing?.completeness).toBe("unavailable")
    expect(m.costPricing?.unpricedRecords).toBe(2)
    expect(m.costPricing?.pricedRecords).toBe(0)
    expect(m.costPricing?.knownSubtotalUsd).toBe(0)

    const md = renderMatrixMarkdown(m)
    const head = renderHeadline(m)
    expect(md).toContain("Token & Cost Summary")
    expect(md).toMatch(/Estimated cost: unavailable/i)
    expect(md).not.toMatch(/Estimated cost: \$0/)
    expect(head).toContain("Cost=unavailable")
    expect(head).not.toMatch(/Cost=\$0/)
    const projected = projectEvalCost(
      m.tokenCost as TokenCostRollup,
      m.costPricing as EvalCostPricing,
    )
    expect(projected.headlineCost).toBe("unavailable")
    expect(projected.detailCost).toBe("unavailable")
    expect(head).toContain(`Cost=${projected.headlineCost}`)
    expect(md).toContain(`Estimated cost: ${projected.detailCost}`)
  })

  test("mixed: partial + known subtotal on markdown AND headline", () => {
    const m = buildCoverageMatrix([
      syn({ tokens: tokens(100, 50), costUsd: 0.5 }),
      syn({ tokens: tokens(200, 60) }),
    ])
    expect(m.costPricing?.completeness).toBe("partial")
    expect(m.costPricing?.knownSubtotalUsd).toBe(0.5)
    expect(m.costPricing?.pricedRecords).toBe(1)
    expect(m.costPricing?.unpricedRecords).toBe(1)
    expect(m.tokenCost?.costUsd).toBe(0.5)

    const md = renderMatrixMarkdown(m)
    const head = renderHeadline(m)
    const projected = projectEvalCost(
      m.tokenCost as TokenCostRollup,
      m.costPricing as EvalCostPricing,
    )
    expect(projected.headlineCost).toContain("$0.5000")
    expect(projected.headlineCost).toContain("partial")
    expect(projected.detailCost).toContain("$0.5000")
    expect(projected.detailCost).toContain("partial")
    expect(head).toContain(`Cost=${projected.headlineCost}`)
    expect(md).toContain(`Estimated cost: ${projected.detailCost}`)
    expect(md).not.toMatch(/Estimated cost: \$0\.5000$/)
  })

  test("known-zero: actual measured $0 is allowed", () => {
    const m = buildCoverageMatrix([syn({ tokens: tokens(1, 1), costUsd: 0 })])
    expect(m.costPricing?.completeness).toBe("complete")
    expect(m.costPricing?.knownSubtotalUsd).toBe(0)
    expect(m.costPricing?.unpricedRecords).toBe(0)
    const md = renderMatrixMarkdown(m)
    const head = renderHeadline(m)
    expect(md).toContain("Estimated cost: $0.0000")
    expect(head).toContain("Cost=$0.0000")
    expect(head).not.toContain("unavailable")
    expect(head).not.toContain("partial")
  })

  test("known-positive: dollar figure, complete, shared projection", () => {
    const m = buildCoverageMatrix([
      syn({ tokens: tokens(100, 50), costUsd: 0.5 }),
      syn({ tokens: tokens(200, 60), costUsd: 1.25 }),
    ])
    expect(m.tokenCost).toEqual({
      prompt: 300,
      completion: 110,
      cacheRead: 0,
      costUsd: 1.75,
      records: 2,
    })
    expect(m.costPricing?.completeness).toBe("complete")
    expect(m.costPricing?.knownSubtotalUsd).toBe(1.75)
    const md = renderMatrixMarkdown(m)
    const head = renderHeadline(m)
    const projected = projectEvalCost(
      m.tokenCost as TokenCostRollup,
      m.costPricing as EvalCostPricing,
    )
    expect(projected.headlineCost).toBe("$1.7500")
    expect(projected.detailCost).toBe("$1.7500")
    expect(md).toContain("Estimated cost: $1.7500")
    expect(head).toContain("Cost=$1.7500")
    expect(head).toContain(`Cost=${projected.headlineCost}`)
  })

  test("MUTATION: stripping completeness on all-unknown would render $0; production does not", () => {
    const m = buildCoverageMatrix([syn({ tokens: tokens(800, 100) })])
    const tc = m.tokenCost
    const pricing = m.costPricing
    if (tc === undefined || pricing === undefined) throw new Error("expected rollup")
    expect(pricing.completeness).toBe("unavailable")

    const legacyHide = `Estimated cost: $${tc.costUsd.toFixed(4)}`
    expect(legacyHide).toBe("Estimated cost: $0.0000")

    const stripped: EvalCostPricing = { ...pricing, completeness: "complete" }
    const mutated = projectEvalCost(tc, stripped)
    expect(mutated.detailCost).toBe("$0.0000")
    expect(projectEvalCost(tc, pricing).detailCost).toBe("unavailable")
    expect(renderMatrixMarkdown(m)).not.toContain("$0.0000")
  })
})
