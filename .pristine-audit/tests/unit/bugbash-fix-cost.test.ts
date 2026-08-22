/**
 * Bugbash fix #3 (MED, undercount): the cost observe-backfill aggregates ALL
 * Best-of-N attempt files (`<id>.0.jsonl`, `<id>.1.jsonl`, …), not one arbitrary
 * attempt. Before the fix, `fromObserve` used `readdirSync(...).find(...)` and
 * summed a SINGLE file, so an n-attempt run reported ~1/n of the real tokens/cost
 * exactly when report.json had no usage and the observe fallback fired.
 *
 * TEETH: each attempt file carries distinct token counts and a distinct ts span;
 * the assertions sum to the all-attempts total. Reverting the fix to a single
 * `.find()` reports only one attempt's tokens (e.g. 100 not 600) and a shorter
 * wall-clock span — these expectations go red.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { costSummaryFromReport, type ModelPricing } from "@/apps/bench/analyze/cost"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bugbash-cost-"))
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
  // $1 per 1M input tokens ⇒ costUsd == inputTokens / 1e6 (easy to reason about).
  "gpt-5.4": { inputPerMTok: 1, outputPerMTok: 0 },
}

describe("cost observe-backfill — Best-of-N multi-attempt aggregation (#3)", () => {
  test("3-attempt observe dir sums ALL three files, not one", () => {
    const reportPath = writeReport({
      model: "gpt-5.4",
      // no usage on the report → observe fallback fires
      perInstance: [{ id: "psf__requests-5414", passed: true }],
    })
    const observeDir = join(dir, "observe")
    mkdirSync(observeDir, { recursive: true })
    // One trajectory file per Best-of-N attempt (index.ts resolveInstance writes
    // `.0.jsonl`, `.1.jsonl`, … for n=3). Distinct token counts + ts per attempt.
    const attempt = (ts: number, input: number, output: number): string =>
      JSON.stringify({ ts, kind: "llm", data: { inputTokens: input, outputTokens: output } })
    writeFileSync(join(observeDir, "psf__requests-5414.0.jsonl"), attempt(1000, 100, 10))
    writeFileSync(join(observeDir, "psf__requests-5414.1.jsonl"), attempt(3000, 200, 20))
    writeFileSync(join(observeDir, "psf__requests-5414.2.jsonl"), attempt(6000, 300, 30))

    const s = costSummaryFromReport({ reportPath, observeDir, pricing: PRICING })

    // ALL three attempts summed: 100+200+300 = 600 in, 10+20+30 = 60 out.
    // (a single-file `.find()` would report only one attempt — e.g. 100/10.)
    expect(s.totalInputTokens).toBe(600)
    expect(s.totalOutputTokens).toBe(60)
    // cost: 600 in @ $1/1M tok ⇒ $0.0006 (proves cost is derived from the summed tokens)
    expect(s.totalCostUsd).toBeCloseTo(600 / 1e6, 9)
    expect(s.instancesWithUsage).toBe(1)
    // wall-clock spans every attempt's ts: 6000 - 1000 = 5000.
    expect(s.totalWallClockMs).toBe(5000)
  })

  test("an unreadable attempt file is skipped, not dropping the whole instance", () => {
    const reportPath = writeReport({
      model: "gpt-5.4",
      perInstance: [{ id: "inst", passed: true }],
    })
    const observeDir = join(dir, "observe")
    mkdirSync(observeDir, { recursive: true })
    writeFileSync(
      join(observeDir, "inst.0.jsonl"),
      JSON.stringify({ ts: 1000, data: { inputTokens: 50, outputTokens: 5 } }),
    )
    // a corrupt JSONL line in another attempt must not zero out the good attempt
    writeFileSync(join(observeDir, "inst.1.jsonl"), "{ not json }\n")

    const s = costSummaryFromReport({ reportPath, observeDir, pricing: PRICING })
    expect(s.totalInputTokens).toBe(50)
    expect(s.totalOutputTokens).toBe(5)
    expect(s.instancesWithUsage).toBe(1)
  })
})
