/**
 * RED-first hellgate for the cost module (ADR-0536 P1). Written BEFORE cost.ts
 * exists — these scenarios define the contract. Core scenarios:
 *   1. report carries usage  → correct per-instance + aggregate tokens/$ arithmetic
 *   2. no report usage + observe jsonl → backfill tokens (inputTokens/outputTokens)
 *      + wall-clock from ts range
 *   3. no usage anywhere → zeros + EXPLICIT caveat (never silent $0-as-real)
 *   4. pricing override applied
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { costSummaryFromReport, type ModelPricing, renderCost } from "./cost"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cost-test-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const writeReport = (obj: unknown): string => {
  const p = join(dir, "report.json")
  writeFileSync(p, JSON.stringify(obj))
  return p
}

const PRICING: Record<string, ModelPricing> = {
  "gpt-5.4": { inputPerMTok: 10, outputPerMTok: 30 },
}

describe("cost — report usage present", () => {
  test("per-instance + aggregate token/$ arithmetic", () => {
    const reportPath = writeReport({
      model: "gpt-5.4",
      perInstance: [
        {
          id: "a",
          passed: true,
          usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
          durationMs: 60_000,
        },
        {
          id: "b",
          passed: false,
          usage: { inputTokens: 2_000_000, outputTokens: 0 },
          durationMs: 30_000,
        },
      ],
    })
    const s = costSummaryFromReport({ reportPath, pricing: PRICING })
    // a: 1M in @10 = $10 + 0.5M out @30 = $15 ⇒ $25 ; b: 2M in @10 = $20
    expect(s.totalInputTokens).toBe(3_000_000)
    expect(s.totalOutputTokens).toBe(500_000)
    expect(s.totalCostUsd).toBeCloseTo(45, 5)
    expect(s.instancesWithUsage).toBe(2)
    expect(s.totalWallClockMs).toBe(90_000)
  })

  test("pricing override changes the cost", () => {
    const reportPath = writeReport({
      model: "gpt-5.4",
      perInstance: [{ id: "a", usage: { inputTokens: 1_000_000, outputTokens: 0 } }],
    })
    const s = costSummaryFromReport({
      reportPath,
      pricing: { "gpt-5.4": { inputPerMTok: 99, outputPerMTok: 0 } },
    })
    expect(s.totalCostUsd).toBeCloseTo(99, 5)
  })
})

describe("cost — observe backfill", () => {
  test("no report usage → tokens + wall-clock from observe jsonl", () => {
    const reportPath = writeReport({
      model: "gpt-5.4",
      perInstance: [{ id: "psf__requests-5414", passed: true }],
    })
    const observeDir = join(dir, "observe")
    mkdirSync(observeDir, { recursive: true })
    // quanta.trajectory.v1 shape: events with ts + inputTokens/outputTokens.
    const lines = [
      { ts: 1000, kind: "llm", data: { inputTokens: 100, outputTokens: 40 } },
      { ts: 5000, kind: "llm", data: { inputTokens: 200, outputTokens: 60 } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    writeFileSync(join(observeDir, "psf__requests-5414.0.jsonl"), lines)
    const s = costSummaryFromReport({ reportPath, observeDir, pricing: PRICING })
    expect(s.totalInputTokens).toBe(300)
    expect(s.totalOutputTokens).toBe(100)
    expect(s.totalWallClockMs).toBe(4000) // 5000 - 1000
    expect(s.instancesWithUsage).toBe(1)
  })
})

describe("cost — no usage anywhere (the honest-caveat scenario)", () => {
  test("zeros + instancesWithUsage 0 + renderCost says NO token data (not silent $0)", () => {
    const reportPath = writeReport({
      model: "gpt-5.4",
      perInstance: [
        { id: "a", passed: true },
        { id: "b", passed: false },
      ],
    })
    const s = costSummaryFromReport({ reportPath, pricing: PRICING })
    expect(s.totalCostUsd).toBe(0)
    expect(s.instancesWithUsage).toBe(0)
    const rendered = renderCost(s).toLowerCase()
    // Red-on-injection: if cost silently reports $0 as if real, this fails.
    expect(rendered).toMatch(/no token usage|observability|not recorded/)
  })
})

describe("cost — pricing unknown for the model (the OTHER silent-$0 trap)", () => {
  test("tokens present but model not in pricing → caveat, NOT a fake $0.00 total", () => {
    const reportPath = writeReport({
      model: "gpt-7-unpriced",
      perInstance: [{ id: "a", passed: true, usage: { inputTokens: 1_000_000, outputTokens: 0 } }],
    })
    const s = costSummaryFromReport({ reportPath, pricing: PRICING }) // PRICING lacks gpt-7-unpriced
    // tokens ARE recorded — so this is NOT the "no usage" branch...
    expect(s.instancesWithUsage).toBe(1)
    expect(s.pricingKnown).toBe(false)
    const rendered = renderCost(s).toLowerCase()
    // TEETH: must flag the missing price, NOT present "$0.0000" as a real cost.
    expect(rendered).toMatch(/no pricing|pricing.*unknown|unknown.*pricing|gpt-7-unpriced/)
  })

  test("pricingKnown is true when the model IS priced", () => {
    const reportPath = writeReport({
      model: "gpt-5.4",
      perInstance: [{ id: "a", usage: { inputTokens: 1_000_000, outputTokens: 0 } }],
    })
    const s = costSummaryFromReport({ reportPath, pricing: PRICING })
    expect(s.pricingKnown).toBe(true)
  })
})
