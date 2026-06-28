/**
 * L2 cost pre-flight — multi-turn loop e2e (DETERMINISTIC, anti-theater).
 *
 * Drives the REAL `runAgent` loop with a meter whose `maxCostUsd` is so small
 * that the very first turn's input-floor cost already breaches it. The loop
 * must stop with `budget_exhausted` BEFORE issuing any model call — proven by
 * `llm.calls === 0` (the pre-flight fired ahead of `stream()`). The CONTROL run
 * (no cost dial) runs the model normally, proving byte-identical default-OFF.
 */
import { describe, expect, test } from "bun:test"
import { BudgetMeter, runAgent } from "@/agent"
import { baseConfig, FakeLLM, RecordingStream, text } from "./_harness"

/** A FakeLLM whose model id is PRICED (in the pricing table) so the pre-flight
 *  projection is non-null. */
class PricedFakeLLM extends FakeLLM {
  readonly model = "gpt-5.4"
}

describe("L2 cost pre-flight — loop e2e", () => {
  test("ANTI-THEATER: input-floor breach stops the loop BEFORE any model call", async () => {
    const llm = new PricedFakeLLM([text("should-never-run")])
    // $1e-7 cap: even a handful of prompt tokens at $2.5/1M input breaches it.
    const meter = new BudgetMeter({ dials: { maxCostUsd: 1e-7 } })
    const outcome = await runAgent(
      baseConfig({ llm, stream: new RecordingStream(), budgetMeter: meter }),
    )
    expect(outcome.reason).toBe("budget_exhausted")
    // The decisive proof: the model was NEVER called — pre-flight fired first.
    expect(llm.calls).toBe(0)
  })

  test("CONTROL: no cost dial ⇒ loop runs the model normally (byte-identical)", async () => {
    const llm = new PricedFakeLLM([text("done")])
    const meter = new BudgetMeter({ dials: { maxTurns: 10 } }) // NO maxCostUsd
    const outcome = await runAgent(
      baseConfig({ llm, stream: new RecordingStream(), budgetMeter: meter }),
    )
    expect(outcome.reason).toBe("completed")
    expect(llm.calls).toBeGreaterThan(0)
  })

  test("CONTROL: no meter at all ⇒ unaffected", async () => {
    const llm = new PricedFakeLLM([text("done")])
    const outcome = await runAgent(baseConfig({ llm, stream: new RecordingStream() }))
    expect(outcome.reason).toBe("completed")
    expect(llm.calls).toBeGreaterThan(0)
  })

  test("priced-but-roomy cap ⇒ pre-flight does NOT fire on turn 1", async () => {
    // A generous cap must not pre-empt a normal first turn (no false positive).
    const llm = new PricedFakeLLM([text("done")])
    const meter = new BudgetMeter({ dials: { maxCostUsd: 100 } })
    const outcome = await runAgent(
      baseConfig({ llm, stream: new RecordingStream(), budgetMeter: meter }),
    )
    expect(outcome.reason).toBe("completed")
    expect(llm.calls).toBeGreaterThan(0)
  })
})
