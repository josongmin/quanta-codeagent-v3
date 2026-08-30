/**
 * cost-panel hardening — conservation and precision through the PROJECTION.
 *
 * A3 removed the panel's own accumulation; conservation (Σ per-model rows ==
 * aggregate) and full-precision folding are now properties of the authority's
 * monotonic buckets, witnessed here through the panel's rendered surfaces so a
 * projection bug cannot hide behind a correct authority.
 */
import { describe, expect, test } from "bun:test"
import { type CostPanel, createCostPanel } from "../../../src/apps/cli/cost-panel"
import { MODEL_RATE_CARD, PRICING_VERSION } from "../../../src/observability/pricing"
import {
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageAccountingPort,
} from "../../../src/observability/usage-accounting"
import { setColorPolicy } from "../../../src/ui/ui-helpers"

setColorPolicy("off")

const SONNET = "claude-sonnet-4-6"
const HAIKU = "claude-haiku-4-5"
const OPUS = "claude-opus-4-7"

let seq = 0
const makePair = (model: string): { panel: CostPanel; accounting: UsageAccountingPort } => {
  const accounting = createUsageAccounting()
  return { panel: createCostPanel({ model, accounting }), accounting }
}

type Delta = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number }

/** Drive turns through the authority with DERIVED pricing (no hand cost), the
 *  production shape: normalize → price → record, then one noteTurn. */
const driveDerived = (
  pair: { panel: CostPanel; accounting: UsageAccountingPort },
  deltas: Delta[],
): void => {
  for (const d of deltas) {
    const usage = normalizeUsage({
      model: d.model,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      ...(d.cacheReadTokens !== undefined ? { cacheReadTokens: d.cacheReadTokens } : {}),
    })
    pair.accounting.record({
      callId: `h${++seq}`,
      at: 1,
      usage,
      cost: priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION }),
      provenance: { sessionId: "s", agentId: "root", agentKind: "root", depth: 0 },
    })
    pair.panel.noteTurn()
  }
}

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0)

describe("conservation: Σ byModel == snapshot (derived, ≥3 models)", () => {
  test("5 turns / 3 known models ⇒ token buckets conserve", () => {
    const pair = makePair(SONNET)
    driveDerived(pair, [
      { model: SONNET, inputTokens: 1_000, outputTokens: 200 },
      { model: HAIKU, inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 300 },
      { model: OPUS, inputTokens: 500, outputTokens: 50 },
      { model: SONNET, inputTokens: 700, outputTokens: 70, cacheReadTokens: 30 },
      { model: HAIKU, inputTokens: 100, outputTokens: 10 },
    ])
    const snap = pair.panel.snapshot()
    const rows = pair.panel.byModel()
    expect(snap.turns).toBe(5)
    expect(rows.length).toBe(3)
    expect(sum(rows.map((r) => r.inputTokens))).toBe(snap.inputTokens)
    expect(sum(rows.map((r) => r.outputTokens))).toBe(snap.outputTokens)
    expect(sum(rows.map((r) => r.cacheReadTokens))).toBe(snap.cacheReadTokens)
  })

  test("same session ⇒ Σ per-model cost equals the aggregate", () => {
    const pair = makePair(SONNET)
    driveDerived(pair, [
      { model: SONNET, inputTokens: 1_000, outputTokens: 200 },
      { model: HAIKU, inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 300 },
      { model: OPUS, inputTokens: 500, outputTokens: 50 },
    ])
    const snap = pair.panel.snapshot()
    const rows = pair.panel.byModel()
    expect(snap.totalCostUsd).not.toBeNull()
    expect(sum(rows.map((r) => r.costUsd ?? 0))).toBeCloseTo(snap.totalCostUsd as number, 9)
  })
})

describe("byModel ordering is deterministic", () => {
  test("rows come spend-descending, name tiebreak — stable across renders", () => {
    const pair = makePair(SONNET)
    driveDerived(pair, [
      { model: HAIKU, inputTokens: 1_000_000, outputTokens: 0 }, // $1
      { model: OPUS, inputTokens: 1_000_000, outputTokens: 0 }, // $15
      { model: SONNET, inputTokens: 1_000_000, outputTokens: 0 }, // $3
    ])
    expect(pair.panel.byModel().map((r) => r.model)).toEqual([OPUS, SONNET, HAIKU])
    expect(pair.panel.byModel().map((r) => r.model)).toEqual([OPUS, SONNET, HAIKU])
  })
})

describe("full-precision accumulation: 1000 tiny turns", () => {
  test("1000 × (1 in / 1 out) on one known model ⇒ closed-form total", () => {
    const pair = makePair(HAIKU)
    for (let i = 0; i < 1000; i++) {
      driveDerived(pair, [{ model: HAIKU, inputTokens: 1, outputTokens: 1 }])
    }
    const snap = pair.panel.snapshot()
    expect(snap.turns).toBe(1000)
    expect(snap.inputTokens).toBe(1000)
    expect(snap.outputTokens).toBe(1000)
    // haiku: (1000×$1 + 1000×$5)/1M — no per-turn cents rounding anywhere.
    expect(snap.totalCostUsd).toBeCloseTo(0.006, 12)
  })
})

describe("empty and zero states", () => {
  test("(a) no turns ⇒ byModel() [] and totalCostUsd null", () => {
    const pair = makePair(SONNET)
    expect(pair.panel.byModel()).toEqual([])
    expect(pair.panel.snapshot().turns).toBe(0)
    expect(pair.panel.snapshot().totalCostUsd).toBeNull()
  })

  test("(b) known-model turn with 0 in / 0 out ⇒ bucket cost 0 (not null)", () => {
    const pair = makePair(SONNET)
    driveDerived(pair, [{ model: SONNET, inputTokens: 0, outputTokens: 0 }])
    const b = pair.panel.byModel()[0]
    const snap = pair.panel.snapshot()
    expect(b?.costUsd).toBe(0)
    expect(snap.totalCostUsd).toBe(0)
    expect(b?.inputTokens).toBe(0)
    expect(snap.turns).toBe(1)
  })

  test("(c) unknown model mixed with known ⇒ floor + unpriced count, Σtokens conserves", () => {
    const pair = makePair(SONNET)
    driveDerived(pair, [
      { model: SONNET, inputTokens: 1_000, outputTokens: 100 },
      { model: "mystery-model-99", inputTokens: 2_000, outputTokens: 200 },
    ])
    const snap = pair.panel.snapshot()
    const rows = pair.panel.byModel()
    expect(sum(rows.map((r) => r.inputTokens))).toBe(snap.inputTokens)
    // A2 — the unknown row is a ZERO floor, and the aggregate names the gap.
    expect(rows.find((r) => r.model === "mystery-model-99")?.costUsd).toBe(0)
    expect(pair.accounting.snapshot().unpricedCalls).toBe(1)
  })
})
