/**
 * L4b cross-run cost ledger — loop e2e (DETERMINISTIC, anti-theater).
 *
 * Drives the REAL `runAgent` loop with a `BudgetLedger` carrying a hard session
 * cost limit. The model emits a `usage` event that the loop records into the
 * ledger; the cumulative cost crosses the hard ceiling, and the loop stops with
 * `budget_exhausted`. The CONTROL run (ledger present but NO policy = pure
 * accountant) completes normally, proving the enforcement is policy-gated and
 * default-OFF.
 */
import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import type { StreamEvent } from "@/llm"
import { baseConfig, FakeLLM, RecordingStream, text } from "./_harness"

class PricedFakeLLM extends FakeLLM {
  readonly model = "gpt-5.4"
}

const usage = (inTok: number, outTok: number): StreamEvent => ({
  type: "usage",
  model: "gpt-5.4",
  inputTokens: inTok,
  outputTokens: outTok,
})

describe("L4b cross-run ledger — loop e2e", () => {
  test("ANTI-THEATER: a hard session cost breach stops the run (budget_exhausted)", async () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    // One turn: a big usage event ($10 input >> $1 hard cap) then "done".
    const llm = new PricedFakeLLM([[usage(4_000_000, 0), ...text("done")]])
    const outcome = await runAgent(
      baseConfig({
        llm,
        stream: new RecordingStream(),
        budgetLedger: ledger,
        sessionId: "camp-1",
      }),
    )
    expect(outcome.reason).toBe("budget_exhausted")
    // Proof the loop actually recorded into the ledger and read the breach.
    expect(ledger.hardBreach()?.kind).toBe("session-hard")
    expect(ledger.snapshot().perSession.get("camp-1")?.totalCost).toBeGreaterThan(1)
  })

  test("CONTROL: ledger present but NO policy ⇒ pure accountant, run completes", async () => {
    const ledger = defaultBudgetLedger() // no policy
    const llm = new PricedFakeLLM([[usage(4_000_000, 0), ...text("done")]])
    const outcome = await runAgent(
      baseConfig({
        llm,
        stream: new RecordingStream(),
        budgetLedger: ledger,
        sessionId: "camp-2",
      }),
    )
    expect(outcome.reason).toBe("completed")
    // Cost was still accounted (accountant mode) — just never enforced.
    expect(ledger.snapshot().perSession.get("camp-2")?.totalCost).toBeGreaterThan(0)
    expect(ledger.hardBreach()).toBeUndefined()
  })

  test("CONTROL: no ledger at all ⇒ unaffected (byte-identical)", async () => {
    const llm = new PricedFakeLLM([[usage(4_000_000, 0), ...text("done")]])
    const outcome = await runAgent(baseConfig({ llm, stream: new RecordingStream() }))
    expect(outcome.reason).toBe("completed")
  })
})
