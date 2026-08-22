/**
 * DOF-21 REAL-LOOP proof for `budget-ledger` (ADR-0136 / ADR-0138, config slot
 * `config.budgetLedger`).
 *
 * STALE/WEAK EXCERPT REPLACED — `tests/unit/budget-ledger-hellgate.test.ts` is
 * PURE MATH on the ledger primitive: it constructs `defaultBudgetLedger(...)`,
 * calls `record(...)` / `snapshot()` / `hardBreach()` directly, and asserts the
 * pricing arithmetic + breach debounce. It NEVER routes a usage event through a
 * real agent loop, so it does not prove the ledger is CONSUMED by the loop's
 * dispatch/cost path (the "wired-but-inert" trap ADR-0136 warns about).
 *
 * WHAT THIS DRIVES (the real consumer, end-to-end):
 *   `runAgent` with a SCRIPTED `LLMPort` that emits a provider `usage` StreamEvent
 *   each turn. The loop's per-turn usage fan-out (`src/agent/loop/emit-helpers.ts`
 *   `USAGE_SINKS`) calls `config.budgetLedger.record({...})` with the streamed
 *   token counts; the post-continue stop condition
 *   (`src/agent/loop/stop-conditions.ts` `ledgerHardBreachCondition`) then reads
 *   `config.budgetLedger.hardBreach()` and STOPS the run with
 *   `reason:"budget_exhausted"` once the session HARD cap is crossed.
 *
 * GROUND TRUTH (effect observation, not ok:true):
 *   - the loop's OUTCOME flips to `budget_exhausted` (real stop, real reason),
 *   - the ledger's own `snapshot()` shows cost actually accrued from the streamed
 *     usage (the record wire ran — read back from the SAME injected ledger),
 *   - the loop stopped EARLY (fewer turns than the scripted budget would allow).
 *
 * PAIRED CONTROL (remove the one required condition ⇒ behavior fails):
 *   Same scripted usage + same maxTurns, but the ledger is built WITHOUT a hard
 *   policy (pure-accountant mode). `hardBreach()` stays `undefined`, so the loop
 *   NEVER stops on budget — it runs to `max_turns` and the outcome is NOT
 *   `budget_exhausted`. The ledger still ACCRUES cost (the record wire is the
 *   same), so the discriminator is purely the HARD-cap stop, not the recording.
 *   This isolates the stop-condition consumer from the record consumer.
 */

import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, RecordingStream, withTimeout } from "./_harness"

/** A scripted LLM that emits a fat `usage` block then a benign tool call so the
 *  loop CONTINUES to the next turn (the stop condition is post-continue). Each
 *  turn bills the same token amount, so N turns accrue N× the per-turn cost. */
class UsageLLM implements LLMPort {
  readonly model = "budget-ledger-test-model"
  turns = 0
  constructor(
    private readonly perTurnTokens: number,
    private readonly maxScriptedTurns: number,
  ) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.turns += 1
    // Provider-authoritative usage — this is what `emit-helpers` forwards into
    // `config.budgetLedger.record(...)`.
    yield {
      type: "usage",
      inputTokens: this.perTurnTokens,
      outputTokens: this.perTurnTokens,
      model: this.model,
    }
    if (this.turns < this.maxScriptedTurns) {
      // A read tool call keeps the loop going (dispatch → next turn) so the
      // post-continue budget stop condition gets a chance to fire.
      yield { type: "tool_use_start", id: `r${this.turns}`, name: "read" }
      yield {
        type: "tool_use_end",
        id: `r${this.turns}`,
        input: { path: "/tmp/__budget_nope__.txt" },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "scripted budget run done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

// The ledger bills unknown models at the sonnet fallback (~$3/1M input,
// $15/1M output). 200k input + 200k output ≈ $0.6 + $3 = $3.6 per turn, so a
// $2 hard session cap is crossed on the FIRST turn.
const FAT_TOKENS = 200_000

describe("budget-ledger — REAL runAgent loop records usage + hard breach stops the run", () => {
  test("gate ON (hard session policy): streamed usage crosses the cap ⇒ loop stops budget_exhausted", async () => {
    const ledger = defaultBudgetLedger({
      policy: { sessionHardLimit: 2 }, // USD
    })
    const llm = new UsageLLM(FAT_TOKENS, 6)
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "burn budget" }] }],
          maxTurns: 6,
          // Wire the ledger + a session id (the record wire keys on it).
          budgetLedger: ledger,
          sessionId: "budget-session-A",
        } as never),
      ),
      15_000,
      "budget-ledger-on",
    )

    // EFFECT: the loop stopped on the budget ceiling — not on max_turns.
    expect(out.reason).toBe("budget_exhausted")
    // It stopped EARLY: far fewer turns than the 6 the script would have run.
    expect(out.turns).toBeLessThan(6)

    // GROUND TRUTH: the record wire actually ran — the injected ledger accrued
    // cost from the streamed usage, and its hard breach is live.
    const snap = ledger.snapshot()
    expect(snap.totalCost).toBeGreaterThan(2)
    expect(snap.perSession.get("budget-session-A")?.totalCost).toBeGreaterThan(2)
    const breach = ledger.hardBreach()
    expect(breach?.kind).toBe("session-hard")
    expect(breach?.scope).toBe("budget-session-A")
  })

  test("PAIRED CONTROL: same usage, NO hard policy ⇒ hardBreach undefined ⇒ loop runs to max_turns (NOT budget_exhausted)", async () => {
    // Pure-accountant ledger: it still RECORDS (cost accrues) but never breaches.
    const ledger = defaultBudgetLedger() // no policy
    const llm = new UsageLLM(FAT_TOKENS, 6)
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream: new RecordingStream(),
          registry: new ToolRegistry(defaultTools),
          messages: [{ role: "user", content: [{ type: "text", text: "burn budget" }] }],
          maxTurns: 3,
          budgetLedger: ledger,
          sessionId: "budget-session-B",
        } as never),
      ),
      15_000,
      "budget-ledger-off",
    )

    // No hard cap ⇒ the loop is never stopped on budget; it exhausts maxTurns.
    expect(out.reason).not.toBe("budget_exhausted")
    expect(out.reason).toBe("max_turns")

    // The RECORD wire still ran (isolates the stop-condition consumer as the sole
    // discriminator): cost accrued, but no hard breach exists to stop on.
    const snap = ledger.snapshot()
    expect(snap.totalCost).toBeGreaterThan(2) // way over $2, but no policy to enforce
    expect(ledger.hardBreach()).toBeUndefined()
  })
})
