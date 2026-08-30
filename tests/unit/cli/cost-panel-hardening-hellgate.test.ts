/**
 * cost-panel-hardening-hellgate — SOTA++ hardening for `jun7-cost-panel-per-model`
 * (per-model cost breakdown, §23.5).
 *
 * This suite is intentionally adversarial. It pins the CONSERVATION INVARIANT
 * that the audit identified as the headline tooth:
 *
 *      Σ byModel()[*].{inputTokens,outputTokens,cacheReadTokens} === snapshot().{…}
 *      Σ byModel()[*].costUsd                                     === snapshot().totalCostUsd
 *
 * i.e. the aggregate (CostPanelState) and the per-model attribution (perModel
 * Map) are folded from the SAME resolved per-turn delta and may never diverge.
 *
 * The two driving forces of these tests:
 *   1. DERIVED cost (no caller-supplied `costUsd`) so we exercise the live
 *      `costUsd(state.model, …)` pricing path — the path NOT covered by the
 *      existing cost-panel.test.ts (which mostly hands explicit costUsd).
 *   2. The expected USD figures are recomputed here via the SAME `costUsd`
 *      SSOT (closed-form on the SUMMED tokens), proving there is no per-turn
 *      rounding and that the aggregate equals the row sum to full precision.
 *
 * Mutation teeth (verified RED-on-injection in cost-panel.ts):
 *   - case 1: swap/drop a token bucket in incrementTurn ⇒ Σrows ≠ snapshot.
 *   - case 2: divide the per-model cost from the aggregate cost ⇒ Σrows ≠ total.
 */

import { describe, expect, test } from "bun:test"
import {
  type CostPanel,
  type CostPanelOptions,
  createCostPanel,
} from "../../../src/apps/cli/cost-panel"
import { costUsd } from "../../../src/observability/pricing"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

// Deterministic, escape-free renders.
setColorPolicy("off")

const make = (overrides: Partial<CostPanelOptions> = {}): CostPanel =>
  createCostPanel({ model: "claude-sonnet-4-6", ...overrides })

// Real model ids the pricing SSOT (src/observability/pricing.ts) knows.
// claude-* → anthropic (additive cache), gpt-* → openai (carve-out cache).
const SONNET = "claude-sonnet-4-6" // $3 in / $15 out / $0.30 cache  (anthropic)
const HAIKU = "claude-haiku-4-5" //   $1 in / $5  out / $0.10 cache  (anthropic)
const GPT_MINI = "gpt-4o-mini" //     $0.15 in / $0.60 out / $0.075 cache (openai)
const GPT_4O = "gpt-4o" //            $2.50 in / $10 out / $1.25 cache (openai)

type Delta = { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number }

/** Drive a panel through `deltas`, carrying each turn's model ON the usage
 *  delta — the shipped seam — and supplying NO explicit costUsd so the live
 *  pricing derivation runs. (This used to switch the model via `update()`
 *  first; production never called that, so the helper was driving a path no
 *  session takes.) */
const driveDerived = (panel: CostPanel, deltas: Delta[]): void => {
  for (const d of deltas) {
    panel.incrementTurn({
      model: d.model,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens ?? 0,
    })
  }
}

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0)

// ── case 1: TOTAL == Σ ROWS (tokens), ≥3 models, DERIVED cost ───────────────

describe("conservation: Σ byModel tokens === snapshot tokens (derived, ≥3 models)", () => {
  test("5 turns / 3 known models / no explicit costUsd ⇒ token buckets conserve", () => {
    const panel = make({ model: SONNET })
    const deltas: Delta[] = [
      { model: SONNET, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 },
      { model: HAIKU, inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0 },
      { model: GPT_MINI, inputTokens: 3000, outputTokens: 600, cacheReadTokens: 700 },
      { model: SONNET, inputTokens: 1500, outputTokens: 300, cacheReadTokens: 120 },
      { model: HAIKU, inputTokens: 800, outputTokens: 90, cacheReadTokens: 10 },
    ]
    driveDerived(panel, deltas)

    const buckets = panel.byModel()
    const snap = panel.snapshot()

    // Three distinct models actually materialized (kills a "collapse to last
    // model" regression that the per-model feature was built to prevent).
    expect(buckets.length).toBe(3)
    // byte sort: 'claude-haiku…' < 'claude-sonnet…' < 'gpt-4o-mini'
    expect(buckets.map((b) => b.model)).toEqual([HAIKU, SONNET, GPT_MINI])

    // HEADLINE INVARIANT: Σ rows === aggregate, for every token bucket.
    // RED-on-injection: drop/swap any bucket fold in incrementTurn ⇒ this fails.
    expect(sum(buckets.map((b) => b.inputTokens))).toBe(snap.inputTokens)
    expect(sum(buckets.map((b) => b.outputTokens))).toBe(snap.outputTokens)
    expect(sum(buckets.map((b) => b.cacheReadTokens))).toBe(snap.cacheReadTokens)

    // Absolute pin (closed-form on the raw deltas) so a uniform-scale mutation
    // that preserves equality-by-construction still gets caught.
    expect(snap.inputTokens).toBe(1000 + 2000 + 3000 + 1500 + 800)
    expect(snap.outputTokens).toBe(200 + 400 + 600 + 300 + 90)
    expect(snap.cacheReadTokens).toBe(50 + 0 + 700 + 120 + 10)
    expect(snap.turns).toBe(5)
  })
})

// ── case 2: TOTAL == Σ ROWS (cost), derived ─────────────────────────────────

describe("conservation: Σ byModel costUsd === snapshot totalCostUsd (derived)", () => {
  test("same 5-turn/3-model session ⇒ per-model cost sum equals the aggregate", () => {
    const panel = make({ model: SONNET })
    const deltas: Delta[] = [
      { model: SONNET, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 },
      { model: HAIKU, inputTokens: 2000, outputTokens: 400, cacheReadTokens: 0 },
      { model: GPT_MINI, inputTokens: 3000, outputTokens: 600, cacheReadTokens: 700 },
      { model: SONNET, inputTokens: 1500, outputTokens: 300, cacheReadTokens: 120 },
      { model: HAIKU, inputTokens: 800, outputTokens: 90, cacheReadTokens: 10 },
    ]
    driveDerived(panel, deltas)

    const buckets = panel.byModel()
    const snap = panel.snapshot()
    expect(snap.totalCostUsd).not.toBeNull()

    const rowSum = buckets.reduce((s, b) => s + (b.costUsd ?? 0), 0)
    // HEADLINE INVARIANT (cost): aggregate must equal the row sum to ≥9 digits.
    // RED-on-injection: bill the bucket from a different number than the
    // aggregate (e.g. *2 on the per-model fold) ⇒ this drifts.
    expect(rowSum).toBeCloseTo(snap.totalCostUsd as number, 9)

    // Cross-check the aggregate against the pricing SSOT, summed PER MODEL on
    // the SUMMED tokens (full-precision closed form — proves no per-turn round).
    const expSonnet = costUsd(SONNET, 1000 + 1500, 200 + 300, 50 + 120) as number
    const expHaiku = costUsd(HAIKU, 2000 + 800, 400 + 90, 0 + 10) as number
    const expGpt = costUsd(GPT_MINI, 3000, 600, 700) as number
    expect(expSonnet).toBeGreaterThan(0)
    expect(expHaiku).toBeGreaterThan(0)
    expect(expGpt).toBeGreaterThan(0)

    // Each bucket equals its independent closed-form cost.
    const bk = (m: string) => buckets.find((b) => b.model === m)?.costUsd as number
    expect(bk(SONNET)).toBeCloseTo(expSonnet, 9)
    expect(bk(HAIKU)).toBeCloseTo(expHaiku, 9)
    expect(bk(GPT_MINI)).toBeCloseTo(expGpt, 9)
    expect(snap.totalCostUsd as number).toBeCloseTo(expSonnet + expHaiku + expGpt, 9)
  })
})

// ── case 3: full-precision accumulation (no per-turn cents rounding) ─────────

describe("full-precision accumulation: 1000 tiny turns", () => {
  test("1000 × (1 in / 1 out) on one known model ⇒ total == closed-form of summed tokens", () => {
    const panel = make({ model: HAIKU })
    for (let i = 0; i < 1000; i++) {
      panel.incrementTurn({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })
    }
    const snap = panel.snapshot()
    expect(snap.turns).toBe(1000)
    expect(snap.inputTokens).toBe(1000)
    expect(snap.outputTokens).toBe(1000)

    // Closed-form cost of the SUMMED tokens. If the impl rounded each per-turn
    // cost to cents this would diverge wildly (each turn ≈ $0.000006 → $0.00).
    const expected = costUsd(HAIKU, 1000, 1000, 0) as number
    expect(expected).toBeGreaterThan(0)
    expect(snap.totalCostUsd as number).toBeCloseTo(expected, 9)

    // Per-model row conserves with the aggregate too.
    const b = panel.byModel()[0]
    expect(b?.costUsd as number).toBeCloseTo(snap.totalCostUsd as number, 9)
  })
})

// ── case 4: formatUsd threshold boundaries (via render) ─────────────────────
//
// Thresholds read verbatim from cost-panel.ts formatUsd:
//   usd < 0.01 → toFixed(4)   (sub-cent: 4dp, never "$0.00")
//   usd < 1    → toFixed(3)
//   else       → toFixed(2)
// We inject exact costs via caller-provided costUsd to land precisely on each
// side of the boundary, then read the leading "$…" token of render().

describe("formatUsd threshold boundaries", () => {
  const costToken = (panel: CostPanel): string => {
    const line = stripAnsi(panel.render())
    return line.split(" ")[0] ?? ""
  }

  test("0.009999 just below cent ⇒ 4dp, NOT $0.00", () => {
    const p = make()
    p.incrementTurn({ inputTokens: 1, outputTokens: 1, costUsd: 0.009999 })
    expect(costToken(p)).toBe("$0.0100") // 0.009999 → toFixed(4) rounds to 0.0100
  })

  test("0.009 well below cent ⇒ 4dp visible (no silent zero)", () => {
    const p = make()
    p.incrementTurn({ inputTokens: 1, outputTokens: 1, costUsd: 0.009 })
    expect(costToken(p)).toBe("$0.0090")
  })

  test("exactly 0.01 ⇒ crosses to 3dp branch", () => {
    const p = make()
    p.incrementTurn({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 })
    expect(costToken(p)).toBe("$0.010")
  })

  test("0.999 just below a dollar ⇒ 3dp", () => {
    const p = make()
    p.incrementTurn({ inputTokens: 1, outputTokens: 1, costUsd: 0.999 })
    expect(costToken(p)).toBe("$0.999")
  })

  test("exactly 1.00 ⇒ crosses to 2dp branch", () => {
    const p = make()
    p.incrementTurn({ inputTokens: 1, outputTokens: 1, costUsd: 1.0 })
    expect(costToken(p)).toBe("$1.00")
  })

  test("1.005 above a dollar ⇒ 2dp", () => {
    const p = make()
    p.incrementTurn({ inputTokens: 1, outputTokens: 1, costUsd: 1.005 })
    // 1.005.toFixed(2) → "1.00" or "1.01" is FP-dependent; pin the branch shape
    // (2 decimal places) rather than the rounding tie-break.
    expect(costToken(p)).toMatch(/^\$1\.\d{2}$/)
  })
})

// ── case 5: ordering determinism (insertion order ≠ sorted order) ───────────

describe("byModel ordering is byte-sorted regardless of insertion order", () => {
  test("seed gpt-4o, claude-sonnet-4-6, claude-haiku-4-5 ⇒ sorted", () => {
    const panel = make({ model: GPT_4O })
    // Insertion order deliberately UNSORTED.
    driveDerived(panel, [
      { model: GPT_4O, inputTokens: 10, outputTokens: 5 },
      { model: SONNET, inputTokens: 10, outputTokens: 5 },
      { model: HAIKU, inputTokens: 10, outputTokens: 5 },
    ])
    const order = panel.byModel().map((b) => b.model)
    // byte sort: 'claude-haiku…' < 'claude-sonnet…' < 'gpt-4o'
    expect(order).toEqual([HAIKU, SONNET, GPT_4O])
    // Defensive: this MUST differ from insertion order, else the assertion is
    // vacuous (insertion was gpt, sonnet, haiku).
    expect(order).not.toEqual([GPT_4O, SONNET, HAIKU])
  })
})

// ── case 6: empty / zero ─────────────────────────────────────────────────────

describe("empty and zero states", () => {
  test("(a) no turns ⇒ byModel() [] and totalCostUsd null", () => {
    const panel = make()
    expect(panel.byModel()).toEqual([])
    expect(panel.snapshot().totalCostUsd).toBeNull()
    expect(panel.snapshot().turns).toBe(0)
  })

  test("(b) known-model turn with 0 in / 0 out ⇒ bucket cost 0 (not null), conservation holds", () => {
    const panel = make({ model: SONNET })
    panel.incrementTurn({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
    const b = panel.byModel()[0]
    const snap = panel.snapshot()
    // costUsd(known, 0,0,0) === 0 per pricing contract (NOT null).
    expect(b?.costUsd).toBe(0)
    expect(snap.totalCostUsd).toBe(0)
    // Σrows == total still holds in the zero case.
    expect(b?.costUsd as number).toBeCloseTo(snap.totalCostUsd as number, 9)
    expect(b?.inputTokens).toBe(0)
    expect(snap.turns).toBe(1)
  })
})

// ── case 7: unknown model mixed with known ──────────────────────────────────

describe("unknown model mixed with known", () => {
  test("unknown bucket cost null, known finite, aggregate excludes null, Σtokens conserves", () => {
    const panel = make({ model: SONNET })
    driveDerived(panel, [
      { model: SONNET, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 30 },
      { model: "fictional-model-9000", inputTokens: 5000, outputTokens: 999, cacheReadTokens: 7 },
      { model: SONNET, inputTokens: 500, outputTokens: 100, cacheReadTokens: 0 },
    ])
    const buckets = panel.byModel()
    const snap = panel.snapshot()
    expect(buckets.length).toBe(2)

    const known = buckets.find((b) => b.model === SONNET)
    const unknown = buckets.find((b) => b.model === "fictional-model-9000")
    expect(unknown?.costUsd).toBeNull()
    expect(known?.costUsd).not.toBeNull()
    expect(Number.isFinite(known?.costUsd as number)).toBe(true)

    // Aggregate cost == known-model cost only (null contributions excluded).
    const expKnown = costUsd(SONNET, 1000 + 500, 200 + 100, 30 + 0) as number
    expect(snap.totalCostUsd as number).toBeCloseTo(expKnown, 9)
    expect(snap.totalCostUsd as number).toBeCloseTo(known?.costUsd as number, 9)

    // Token conservation holds even though one bucket has null cost.
    expect(sum(buckets.map((b) => b.inputTokens))).toBe(snap.inputTokens)
    expect(sum(buckets.map((b) => b.outputTokens))).toBe(snap.outputTokens)
    expect(sum(buckets.map((b) => b.cacheReadTokens))).toBe(snap.cacheReadTokens)
    // Cost row-sum (treating null as 0) == aggregate.
    expect(buckets.reduce((s, b) => s + (b.costUsd ?? 0), 0)).toBeCloseTo(
      snap.totalCostUsd as number,
      9,
    )
  })
})

// ── case 8: very large numbers ──────────────────────────────────────────────

describe("very large token counts", () => {
  test("2.5M in / 1.2M out on a known model ⇒ finite, conservation holds", () => {
    const panel = make({ model: SONNET })
    panel.incrementTurn({ inputTokens: 2_500_000, outputTokens: 1_200_000, cacheReadTokens: 0 })
    const snap = panel.snapshot()
    const b = panel.byModel()[0]
    expect(Number.isFinite(snap.totalCostUsd as number)).toBe(true)
    expect(Number.isNaN(snap.totalCostUsd as number)).toBe(false)
    expect(snap.totalCostUsd as number).not.toBe(Number.POSITIVE_INFINITY)

    const expected = costUsd(SONNET, 2_500_000, 1_200_000, 0) as number
    // sonnet: 2.5M*$3/M + 1.2M*$15/M = 7.5 + 18 = $25.50
    expect(expected).toBeCloseTo(25.5, 6)
    expect(snap.totalCostUsd as number).toBeCloseTo(expected, 6)
    expect(b?.costUsd as number).toBeCloseTo(snap.totalCostUsd as number, 6)
    expect(b?.inputTokens).toBe(2_500_000)
    expect(b?.outputTokens).toBe(1_200_000)
  })
})
