/**
 * E2E — the PRODUCTION assembly path caps cost end-to-end.
 *
 * Every other cost-cap test hand-injects a `BudgetMeter`. This one proves the
 * REAL path the autonomous modes take: `assembleAgentConfig({mode:"batch"})`
 * builds the meter from `BUDGET_PRESETS.batch` (maxCostUsd $5) with NO manual
 * wiring, then `runAgent` stops the run with `budget_exhausted` once the priced
 * usage crosses that cap. The env-gated cross-run ledger is exercised the same
 * way. Only REAL provider spend (a live LLM) is out of scope here — that's the
 * box-side validation; the wiring is proven end-to-end locally.
 */
import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
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

/**
 * COST-CAP TRIP SEMANTIC (commit 4843c6020, jul-2 — SHIPPED): the post-turn meter
 * stops with `budget_exhausted` only when the turn was about to CONTINUE
 * (`TurnResult.kind === "tools"`). A cleanly-COMPLETED final turn wins on its own
 * merit even if it also crossed the cap. So a cap TRIP must be exercised on a
 * CONTINUING (tool-use) turn — a `cont(...)` followed by a benign `text("done")`
 * the loop never reaches because the meter pre-empts at the tool-turn epilogue.
 */
const cont = (u: StreamEvent): StreamEvent[] => [
  u,
  ...toolUse("cc1", "read", { path: "/tmp/__cc_prod_nope__.txt" }),
]

describe("E2E — production assembly caps cost (no hand-built meter)", () => {
  test("assembleAgentConfig(batch) builds the $5 cost cap ⇒ runAgent stops on overrun", async () => {
    // gpt-5.4 output is $15/1M ⇒ 2M out = $30 >> the batch preset's $5 cap. The
    // breaching turn CONTINUES (tool-use) so the meter pre-empts it (a completed
    // turn wins even when it crosses — see COST-CAP TRIP SEMANTIC note above).
    const llm = new PricedFakeLLM([cont(usage(0, 2_000_000)), text("done")])
    const cfg = assembleAgentConfig(
      { mode: "batch", base: baseConfig({ llm, stream: new RecordingStream() }) },
      {},
    )
    // The meter came from BUDGET_PRESETS.batch — proof the cap is real, not injected.
    expect(cfg.budgetMeter?.dials.maxCostUsd).toBe(5)
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("budget_exhausted")
  })

  test("under the $5 cap ⇒ the run completes normally (no false stop)", async () => {
    // 100k output = $1.5 < $5.
    const llm = new PricedFakeLLM([[usage(0, 100_000), ...text("done")]])
    const cfg = assembleAgentConfig(
      { mode: "batch", base: baseConfig({ llm, stream: new RecordingStream() }) },
      {},
    )
    const outcome = await runAgent(cfg)
    expect(outcome.reason).toBe("completed")
  })

  test("env-gated cross-run ledger: assembled batch config enforces a daily cap", async () => {
    const llm = new PricedFakeLLM([
      cont(usage(0, 1_000_000)), // $15 on a CONTINUING turn ⇒ ledger hard-breach pre-empts
      text("done"), // never reached — stopped at the turn-1 epilogue
    ])
    const cfg = assembleAgentConfig(
      { mode: "batch", base: baseConfig({ llm, stream: new RecordingStream() }) },
      { QUANTA_BUDGET_LEDGER: "1", QUANTA_BUDGET_LEDGER_DAILY_USD: "10" },
    )
    expect(cfg.budgetLedger).toBeDefined() // wired by the activation seam
    const outcome = await runAgent(cfg)
    // $15 turn-1 spend > $10 daily cap ⇒ the run is stopped.
    expect(outcome.reason).toBe("budget_exhausted")
  })
})
