/**
 * ★ HELLGATE (MR-05) — a turn's spend is priced by the model that RAN it.
 *
 * THE DEFECT. `emitWorkMetrics` called `collector.finalize(<one model>)`, and the
 * collector priced ALL of the turn's tokens at that single label. The label was a
 * LIVE selection read at turn CLOSE, so:
 *
 *   - a turn that switched models mid-flight was costed entirely at the model
 *     selected when it ended — including the requests that ran on the previous one;
 *   - before the campaign it was `cfg.llm.model`, the BOOT port, so a switched
 *     session's whole spend was attributed to a model that never ran.
 *
 * That is worse than a missing number: it renders as data.
 *
 * THE FIX. Each `recordUsage` carries the model the ADAPTER reported for that
 * request (the `usage` event's own `model`), the collector keeps per-model buckets,
 * and cost is the SUM of each bucket priced with its OWN model.
 *
 * RED-on-injection: drop `model` from the `recordUsage` payload in
 * `emit-helpers.ts`, or make `costFromBuckets` return null ⇒ the split cases fall
 * back to single-model pricing and red.
 */

import { describe, expect, test } from "bun:test"
import { TurnWorkMetricsCollector } from "@/agent/work-metrics-collector"
import { costUsd } from "@/observability"

/** Two models with DIFFERENT prices, taken from the real pricing table — a split
 *  that costs the same either way would prove nothing. */
const A = "gpt-4o"
const B = "gpt-4o-mini"

describe("MR-05 · per-model cost attribution", () => {
  test("the premise is real: these two models are priced differently", () => {
    const a = costUsd(A, 1000, 1000, 0)
    const b = costUsd(B, 1000, 1000, 0)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a).not.toBe(b)
  })

  test("a two-model turn costs A's tokens at A and B's at B", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ model: A, tokensInput: 100, tokensOutput: 20 })
    c.recordUsage({ model: B, tokensInput: 40, tokensOutput: 10 })
    // The label passed to finalize is the caller's best guess for the turn; it must
    // NOT decide the price of requests that ran on the other model.
    const m = c.finalize(B)
    expect(m.tokensInput).toBe(140)
    expect(m.tokensOutput).toBe(30)
    const expected = (costUsd(A, 100, 20, 0) ?? 0) + (costUsd(B, 40, 10, 0) ?? 0)
    expect(m.estimatedCostUsd).toBeCloseTo(expected, 10)
    // …and it is NOT what pricing the whole turn at either single label gives.
    expect(m.estimatedCostUsd).not.toBeCloseTo(costUsd(B, 140, 30, 0) ?? 0, 10)
    expect(m.estimatedCostUsd).not.toBeCloseTo(costUsd(A, 140, 30, 0) ?? 0, 10)
  })

  test("the finalize LABEL cannot change a bucketed turn's cost", () => {
    // The label used to be the whole story. Now it is a fallback, so passing a
    // different one must not move the number by a cent.
    const mk = () => {
      const c = new TurnWorkMetricsCollector()
      c.recordUsage({ model: A, tokensInput: 100, tokensOutput: 20 })
      c.recordUsage({ model: B, tokensInput: 40, tokensOutput: 10 })
      return c
    }
    expect(mk().finalize(A).estimatedCostUsd).toBe(mk().finalize(B).estimatedCostUsd)
    expect(mk().finalize(undefined).estimatedCostUsd).toBe(mk().finalize(A).estimatedCostUsd)
  })

  test("single-model turn: byte-identical to pricing the whole turn at that model", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ model: A, tokensInput: 100, tokensOutput: 20, cacheReadTokens: 7 })
    expect(c.finalize(A).estimatedCostUsd).toBeCloseTo(costUsd(A, 100, 20, 7) ?? 0, 12)
  })

  test("WIRING: the REAL usage sink carries each event's model into the collector", async () => {
    // The cases above build the collector directly, so they cannot see whether the
    // LOOP actually hands it a model — and it did not until MR-05. This drives the
    // real `emitUsage` sink chain (the same one `stream-consume` calls per usage
    // event) with two models, and asserts the split reaches the metrics.
    const { emitUsage } = await import("@/agent/loop/emit-helpers")
    const collector = new TurnWorkMetricsCollector()
    const config = { stream: { emit: () => undefined } } as never
    const usage = (model: string, inTok: number, outTok: number) =>
      ({ type: "usage", model, inputTokens: inTok, outputTokens: outTok }) as never
    emitUsage(config, usage(A, 100, 20), undefined, collector, undefined)
    emitUsage(config, usage(B, 40, 10), undefined, collector, undefined)
    const m = collector.finalize(B)
    expect(m.tokensInput).toBe(140)
    const expected = (costUsd(A, 100, 20, 0) ?? 0) + (costUsd(B, 40, 10, 0) ?? 0)
    expect(m.estimatedCostUsd).toBeCloseTo(expected, 10)
    // Non-vacuity: the split must differ from pricing everything at one label, or
    // this case would pass with the model silently dropped on the way in.
    expect(m.estimatedCostUsd).not.toBeCloseTo(costUsd(B, 140, 30, 0) ?? 0, 10)
  })

  test("paired control — usage with NO model still counts tokens, and costs via the label", () => {
    // The pre-MR-05 shape must keep working: a caller (or an adapter) that reports
    // no model per request still gets a turn total from the label.
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ tokensInput: 100, tokensOutput: 20 })
    const m = c.finalize(A)
    expect(m.tokensInput).toBe(100)
    expect(m.estimatedCostUsd).toBeCloseTo(costUsd(A, 100, 20, 0) ?? 0, 12)
  })

  test("an UNPRICED model contributes tokens but not a fabricated cost", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ model: "no-such-model-in-the-table", tokensInput: 999, tokensOutput: 999 })
    c.recordUsage({ model: A, tokensInput: 100, tokensOutput: 20 })
    const m = c.finalize(A)
    expect(m.tokensInput).toBe(1099)
    // Only the priced bucket contributes — never an estimate invented for the
    // unknown one, and never the unknown one's tokens at the known one's rate.
    expect(m.estimatedCostUsd).toBeCloseTo(costUsd(A, 100, 20, 0) ?? 0, 12)
  })
})
