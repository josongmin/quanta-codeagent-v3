/**
 * MR-00 RED RAIL — usage accounting, pricing plane (REDs #4, #5, #6).
 *
 * MEASURED PREMISE (2026-08-30, HEAD 35adaf25). The per-million RATE TABLE is
 * already a single SSOT: `budget-ledger-pricing.DEFAULT_MODEL_PRICING` is
 * DERIVED from `observability/pricing.MODEL_RATE_CARD`. What diverges is the
 * FORMULA applied to that table — there are two, and they disagree:
 *
 *   1. cache-read semantics. `costUsd` is provider-aware: for OpenAI it carves
 *      cached tokens OUT of `inputTokens` (prompt_tokens INCLUDES cached), for
 *      Anthropic it adds them (input_tokens EXCLUDES cache reads). The ledger
 *      is provider-blind and ALWAYS adds. Measured, gpt-5.4 @ 1M in / 400k
 *      cache-read:  costUsd $1.60  vs  ledger $2.60.
 *   2. cache-write. `costUsd` has NO cacheWrite parameter at all, though the
 *      rate card carries `cacheWritePerM`. The ledger prices it. Every
 *      cache-write token is therefore free on one path and billed on the other.
 *   3. unknown model. `costUsd` returns `null` (explicit "I cannot price this").
 *      The ledger silently substitutes sonnet rates via `FALLBACK_PRICING_KEY`
 *      (budget-ledger.ts:210) — an unknown model bills $18/2M tokens and looks
 *      like real data.
 *
 * MR-01 makes ONE `priceUsage(normalizedUsage)` the only formula; `costUsd`
 * survives only as a compatibility wrapper delegating to it. These tests then
 * go green WITHOUT being edited.
 *
 * REVERT/MUTATION POINTS (each must re-RED the named test after MR-01):
 *   - re-introduce a provider-blind additive branch in the unified pricer
 *     ⇒ "cache-read semantics agree across both pricing paths" REDs.
 *   - drop `cacheWriteTokens` from the unified pricer's inputs
 *     ⇒ "cache-write is billed identically on both pricing paths" REDs.
 *   - restore `FALLBACK_PRICING_KEY` substitution
 *     ⇒ "an unknown model is never silently priced" REDs.
 */
import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent/budget/meter"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { emitUsage } from "@/agent/loop/emit-helpers"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent as LlmStreamEvent } from "@/llm"
import { costUsd, MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import { normalizeUsage, priceUsage } from "@/observability/usage-accounting"

/** Price one usage shape through the LEDGER formula, isolated per call so no
 *  aggregate or breach memory leaks between cases. */
const ledgerCost = (u: {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): number =>
  defaultBudgetLedger().record({ ...u, sessionId: "parity", at: 1_700_000_000_000 }).cost

/** Price the same shape through the OBSERVABILITY formula. `null` = "unknown
 *  model, cannot price" — kept distinct from `0` on purpose. */
const observabilityCost = (u: {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}): number | null => costUsd(u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0)

const round = (n: number) => Math.round(n * 1e6) / 1e6

describe("RED #4 — one usage record must cost the same on every pricing path", () => {
  // The headline census: every priced model × a token shape that exercises
  // cache-read. A single divergence here is a real billing discrepancy, not a
  // rounding artifact — the shapes are chosen so the two formulas differ by a
  // whole rate multiple when they disagree.
  test("cache-read semantics agree across both pricing paths (all carded models)", () => {
    const divergences: string[] = []
    for (const model of Object.keys(MODEL_RATE_CARD)) {
      const shape = { model, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 400_000 }
      const a = observabilityCost(shape)
      const b = ledgerCost(shape)
      if (a === null || round(a) !== round(b)) {
        divergences.push(`${model}: observability=${a} ledger=${b}`)
      }
    }
    expect(divergences).toEqual([])
  })

  // PAIRED CONTROL — with NO cache tokens the two formulas have never had
  // anything to disagree about. This is green today and must STAY green: it
  // proves the RED above is about cache normalization specifically, not about
  // the rate table or a broken harness.
  test("PAIRED CONTROL: cache-free usage already agrees (must stay green)", () => {
    for (const model of Object.keys(MODEL_RATE_CARD)) {
      const shape = { model, inputTokens: 250_000, outputTokens: 50_000 }
      expect(round(observabilityCost(shape) as number)).toBe(round(ledgerCost(shape)))
    }
  })
})

describe("RED #5 — cache-write tokens are billed, and billed once", () => {
  /**
   * SCOPE CORRECTION (recorded deliberately). The first draft asked `costUsd`
   * and the ledger to agree on cache-write. `costUsd` has no cache-write
   * PARAMETER — it is a four-argument total-cost wrapper — so that draft
   * demanded something its signature cannot express, and "fixing" it would
   * have meant changing a compatibility shim's contract to satisfy a test.
   *
   * The real defect was one layer down and genuinely live: `emitUsage` priced
   * the budget meter through `costUsd`, so every cache-creation token was FREE
   * to the run's cost ceiling while the ledger billed it. An autonomous run
   * could walk past its cap by however much it spent warming caches. That is
   * what these tests hold now.
   */
  test("the unified formula bills cache-write, and the ledger agrees with it", () => {
    // sonnet cacheWritePerM $3.75 ⇒ 100k = $0.375.
    const shape = {
      model: "claude-sonnet-4-6",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 100_000,
    }
    const usage = normalizeUsage(shape)
    const priced = priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION })
    expect(priced.cacheWriteUsd).toBeCloseTo(0.375, 9)
    expect(ledgerCost(shape)).toBeCloseTo(priced.totalUsd, 9)
  })

  test("the run's cost ceiling sees cache-write", () => {
    // Driven through the shipped fan-out: if the meter is priced by anything
    // that cannot express cache-write, this is 0 and a cap never notices.
    const meter = new BudgetMeter({})
    const config = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "s",
      budgetMeter: meter,
    } as unknown as AgentConfig

    emitUsage(
      config,
      {
        type: "usage",
        model: "claude-sonnet-4-6",
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 100_000,
      } as Extract<LlmStreamEvent, { type: "usage" }>,
      undefined,
      undefined,
      undefined,
    )
    expect(meter.snapshot().costUsd).toBeCloseTo(0.375, 9)
  })

  // PAIRED CONTROL — a provider that does not bill cache creation stays at $0,
  // so the fix cannot be "bill everyone for cache-write".
  test("PAIRED CONTROL: a provider with no cache-write rate bills $0 (must stay green)", () => {
    const shape = { model: "gpt-5.4", inputTokens: 0, outputTokens: 0, cacheWriteTokens: 100_000 }
    expect(ledgerCost(shape)).toBe(0)
  })
})

describe("RED #6 — an unknown model is priced EXPLICITLY, not silently", () => {
  /**
   * SCOPE CORRECTION (recorded deliberately). An earlier draft of this rail
   * asserted that an unknown model must cost 0. That was wrong, and two
   * existing hellgates say so: HELL-3 and HELL-30
   * (tests/unit/budget-ledger-hellgate.test.ts:71,424) deliberately pin the
   * sonnet fallback so unknown spend stays OPERATOR-VISIBLE rather than
   * silently vanishing. Zeroing it would trade one invisible failure for
   * another.
   *
   * The actual defect is narrower: the fallback number is INDISTINGUISHABLE
   * from a measured one. `costUsd` says `null` ("I cannot price this"); the
   * ledger says `18` and nothing downstream can tell that 18 is a guess. So
   * the requirement is the plan's words — an EXPLICIT unknown-pricing policy:
   * keep the estimate, and carry the fact that it IS an estimate.
   *
   * This keeps HELL-3/HELL-30 green after MR-01/MR-05 rather than forcing
   * their revision.
   */
  test("an unknown model's cost is flagged as an estimate, not reported as measured", () => {
    const ledger = defaultBudgetLedger()
    const result = ledger.record({
      model: "totally-unknown-model-xyz",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      sessionId: "parity",
      at: 1_700_000_000_000,
    })
    // The estimate survives (HELL-3 / HELL-30 stay true) …
    expect(result.cost).toBeCloseTo(18, 9)
    // … but the record must SAY the rate was not the model's own. REDs:
    // `RecordResult` has no such field, so 18 reads as measured truth.
    expect((result as { pricingKnown?: boolean }).pricingKnown).toBe(false)
  })

  test("a known model is flagged as measured", () => {
    const ledger = defaultBudgetLedger()
    const result = ledger.record({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      sessionId: "parity",
      at: 1_700_000_000_000,
    })
    expect(result.cost).toBeCloseTo(18, 9)
    // Same $18 as the unknown model above — which is exactly why the two cases
    // must be distinguishable by something OTHER than the number.
    expect((result as { pricingKnown?: boolean }).pricingKnown).toBe(true)
  })

  // PAIRED CONTROL — the observability path already draws this distinction
  // (null vs a number). It is the behaviour the ledger is missing, and it must
  // keep working.
  test("PAIRED CONTROL: costUsd already signals unknown pricing (must stay green)", () => {
    expect(
      observabilityCost({ model: "nope-not-a-model", inputTokens: 1, outputTokens: 1 }),
    ).toBeNull()
    expect(
      observabilityCost({ model: "claude-sonnet-4-6", inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(3, 9)
  })
})
