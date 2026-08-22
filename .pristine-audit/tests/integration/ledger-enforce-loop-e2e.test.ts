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
import { baseConfig, FakeLLM, RecordingStream, text, toolUse } from "./_harness"

class PricedFakeLLM extends FakeLLM {
  readonly model = "gpt-5.4"
}

const usage = (inTok: number, outTok: number): StreamEvent => ({
  type: "usage",
  model: "gpt-5.4",
  inputTokens: inTok,
  outputTokens: outTok,
})

// Turn 1 spends big then issues a tool call (the run WOULD continue to turn 2);
// turn 2 would finish with text. A hard breach must pre-empt the continuation
// between the two.
const continuingThenDone = (): StreamEvent[][] => [
  [usage(4_000_000, 0), ...toolUse("c1", "read", { path: "/tmp/__nope_ledger_e2e__.txt" })],
  text("done"),
]

describe("L4b cross-run ledger — loop e2e", () => {
  test("ANTI-THEATER: a hard session breach PRE-EMPTS the continuation (budget_exhausted)", async () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    const llm = new PricedFakeLLM(continuingThenDone())
    const outcome = await runAgent(
      baseConfig({
        llm,
        stream: new RecordingStream(),
        budgetLedger: ledger,
        sessionId: "camp-1",
      }),
    )
    expect(outcome.reason).toBe("budget_exhausted")
    // The breach stopped the loop AFTER turn 1 — turn 2 (the "done" text) never ran.
    expect(llm.calls).toBe(1)
    expect(ledger.hardBreach()?.kind).toBe("session-hard")
    expect(ledger.snapshot().perSession.get("camp-1")?.totalCost).toBeGreaterThan(1)
  })

  test("DOES NOT override a turn that legitimately COMPLETED on the same turn it breached", async () => {
    // A single turn that both spends over the cap AND finishes the task keeps
    // its natural `completed` outcome — the hard breach only pre-empts a
    // CONTINUATION, it does not retro-label finished work as exhausted.
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    const llm = new PricedFakeLLM([[usage(4_000_000, 0), ...text("done")]])
    const outcome = await runAgent(
      baseConfig({
        llm,
        stream: new RecordingStream(),
        budgetLedger: ledger,
        sessionId: "camp-done",
      }),
    )
    expect(outcome.reason).toBe("completed")
    // The breach IS recorded (cross-run memory) — it just didn't override completion.
    expect(ledger.hardBreach()?.kind).toBe("session-hard")
  })

  test("CONTROL: ledger present but NO policy ⇒ pure accountant, run completes", async () => {
    const ledger = defaultBudgetLedger() // no policy
    const llm = new PricedFakeLLM(continuingThenDone())
    const outcome = await runAgent(
      baseConfig({
        llm,
        stream: new RecordingStream(),
        budgetLedger: ledger,
        sessionId: "camp-2",
      }),
    )
    expect(outcome.reason).toBe("completed")
    expect(llm.calls).toBe(2) // ran both turns — never pre-empted
    expect(ledger.snapshot().perSession.get("camp-2")?.totalCost).toBeGreaterThan(0)
    expect(ledger.hardBreach()).toBeUndefined()
  })

  test("CONTROL: no ledger at all ⇒ unaffected (byte-identical)", async () => {
    const llm = new PricedFakeLLM(continuingThenDone())
    const outcome = await runAgent(baseConfig({ llm, stream: new RecordingStream() }))
    expect(outcome.reason).toBe("completed")
  })
})
