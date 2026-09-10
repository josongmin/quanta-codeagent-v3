/**
 * ★ CONTRACT — Composition of SAME-TURN recovery types in one `runAgent` run.
 *   - src/agent/recovery.ts caps: stream≤3 / output≤3 / malformed≤1 / empty≤2 (per-kind, no refund across types)
 *   - src/agent/loop.ts:1557-1560 documents `turn-1` accounting: a no-work
 *     error/abort reports turns-1 and does NOT count as a model turn.
 *   - freshRecovery() per logical turn → budgets reset between turns, not within.
 *   Each assertion is labeled inline: CONTRACT (invariant) vs CHARACTERIZATION
 *   (observed exact .calls / events; change = behavior change to review).
 *
 * HELLGATE — recovery COMPOSITION across the REAL `runAgent` loop.
 *
 * The existing `agent-recovery-e2e.test.ts` + `recovery-hellgate.test.ts`
 * already pin each recovery KIND in isolation and a couple of single-turn
 * multi-kind storms. This suite closes the COMPOSITION delta they leave open:
 *
 *   - Case 1: a strict CHAIN of DIFFERENT recovery types in ONE logical turn
 *     (transient backoff → max_tokens continue → empty nudge → end_turn) with
 *     the EXACT call count AND the ordered recovery-event trace pinned, proving
 *     none of the three recoveries consumed a turn slot.
 *   - Case 2: BUDGET COMPOSITION — mixing recovery types does NOT refund a
 *     budget. Spend the output-continue budget partially, then blow the stream
 *     budget; the run must terminate with a stream `error` (terminating proven
 *     by `withTimeout`), and the stream-retry cap is NOT extended by the
 *     output-continue spend.
 *   - Case 3: CONTROL discriminator — a clean tool turn then end_turn emits
 *     ZERO recovery events. Without this, the assertions above could be
 *     vacuously true.
 *   - Case 4: a real TOOL turn BETWEEN recoveries, crossing a turn boundary —
 *     proving the per-turn `freshRecovery()` reset (each logical turn gets a
 *     fresh budget) AND that `out.turns` counts ONLY the tool-bearing turns,
 *     recoveries excluded.
 *
 * Budgets (verbatim from src/agent/recovery.ts):
 *   MAX_TURN_STREAM_RETRIES = 3
 *   MAX_OUTPUT_CONTINUES    = 3
 *   MAX_MALFORMED_RETRIES   = 1
 *   MAX_CONSECUTIVE_EMPTIES = 2
 *
 * No src/ file is touched. Reuses tests/integration/_harness.ts exclusively.
 */
import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent/loop/entry"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { LLMError } from "@/shared/errors"
import {
  ev,
  cfg as harnessCfg,
  RecordingStream,
  ScriptedLLM,
  type Step,
  text,
  thr,
  toolUse,
  withTimeout,
} from "./_harness"

const seededRecoveryBackoff = (seed = 0x5eed1234) => {
  let state = seed >>> 0
  const delays: number[] = []
  return {
    delays,
    config: {
      random: (): number => {
        state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0
        return state / 0x1_0000_0000
      },
      sleep: async (delayMs: number, signal: AbortSignal): Promise<void> => {
        if (!signal.aborted) delays.push(delayMs)
      },
    },
  }
}

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig =>
  harnessCfg({ recoveryBackoff: seededRecoveryBackoff().config, ...over })

const empty: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]

const recoveryReasons = (stream: RecordingStream): string[] =>
  stream.events
    .filter((e) => e.type === "recovery")
    .map((e) => (e.type === "recovery" ? e.reason : ""))

describe("recovery COMPOSITION hellgate — different kinds chained in one run", () => {
  // ───────────────────────────────────────────────────────────────────────
  // CASE 1 — CHAIN three DIFFERENT recovery types in ONE logical turn.
  // ───────────────────────────────────────────────────────────────────────
  test("1. chain: transient backoff → max_tokens continue → empty nudge → end_turn = ONE turn", async () => {
    const backoff = seededRecoveryBackoff()
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      thr(new LLMError("503 service unavailable")), // call 1 → backoff retry
      ev(text("partial output", "max_tokens")), // call 2 → output-continue nudge
      ev(empty), // call 3 → empty nudge
      ev(text("composed final answer")), // call 4 → end_turn
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 1, recoveryBackoff: backoff.config })),
      15_000,
      "compose-chain",
    )
    // The whole chain composed inside a SINGLE turn slot (maxTurns=1) and still
    // completed — proving NONE of the three recoveries consumed the turn.
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(1)
    // Every retry is reflected: 4 LLM calls (3 recoveries + 1 real end).
    expect(llm.calls).toBe(4)
    expect(backoff.delays).toHaveLength(1)
    expect(backoff.delays[0]).toBeLessThan(500)

    // The recovery TRACE proves the recoveries actually fired (not just final
    // state). Three DIFFERENT reasons, in chain order.
    const reasons = recoveryReasons(stream)
    expect(reasons).toContain("backoff")
    expect(reasons).toContain("nudge") // output-limit continue
    expect(reasons).toContain("empty")
    // Ordering: backoff (call-1 error) precedes the nudge (call-2 assembled)
    // precedes the empty (call-3 assembled).
    expect(reasons.indexOf("backoff")).toBeLessThan(reasons.indexOf("nudge"))
    expect(reasons.indexOf("nudge")).toBeLessThan(reasons.indexOf("empty"))

    // The final assistant turn is the composed answer, and the kept partial
    // from the max_tokens nudge survives in the transcript.
    const last = out.messages.findLast((m) => m.role === "assistant")
    expect(last?.content.some((b) => b.type === "text" && b.text === "composed final answer")).toBe(
      true,
    )
    expect(
      out.messages.some(
        (m) =>
          m.role === "assistant" &&
          m.content.some((b) => b.type === "text" && b.text === "partial output"),
      ),
    ).toBe(true)
  }, 20_000)

  // ───────────────────────────────────────────────────────────────────────
  // CASE 2 — BUDGET COMPOSITION: one type's spend does NOT refund another's
  // cap. Spend 2 of 3 output-continues, then 4 transient throws. The stream
  // budget (3) must still hard-fail on the 4th throw — the prior output spend
  // does NOT buy extra stream retries.
  // ───────────────────────────────────────────────────────────────────────
  test("2. budget composition: output-continue spend does NOT refund the stream-retry cap", async () => {
    const backoff = seededRecoveryBackoff()
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(text("p1", "max_tokens")), // call 1 → output nudge (outputContinues 0→1)
      ev(text("p2", "max_tokens")), // call 2 → output nudge (outputContinues 1→2)
      thr(new LLMError("503 a")), // call 3 → backoff (streamRetries 0→1)
      thr(new LLMError("503 b")), // call 4 → backoff (streamRetries 1→2)
      thr(new LLMError("503 c")), // call 5 → backoff (streamRetries 2→3)
      thr(new LLMError("503 d")), // call 6 → budget exhausted → HARD error
      ev(text("must-not-reach")),
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 1, recoveryBackoff: backoff.config })),
      20_000,
      "compose-budget-no-refund",
    )
    // Terminates (withTimeout proves no infinite loop) with a stream error.
    expect(out.reason).toBe("error")
    // EXACTLY 6 calls: 2 output continues + 3 backoffs + the 4th throw that
    // exhausted the stream budget. If output-continues had "refunded" stream
    // retries we'd see a 7th call (or completion); we must NOT.
    expect(llm.calls).toBe(6)
    expect(backoff.delays).toHaveLength(3)
    // First-turn error reports turn-1 = 0; no productive turn was produced.
    expect(out.turns).toBe(0)

    const errMsg = stream.events.find((e) => e.type === "error")
    expect(errMsg).toBeDefined()
    if (errMsg?.type === "error") expect(errMsg.message.toLowerCase()).toContain("retries")

    // The trace shows BOTH kinds composed: 2 output nudges + EXACTLY 3 backoffs
    // (the stream cap, independent of the 2 output spends).
    const reasons = recoveryReasons(stream)
    expect(reasons.filter((r) => r === "nudge")).toHaveLength(2)
    expect(reasons.filter((r) => r === "backoff")).toHaveLength(3)
  }, 30_000)

  // ───────────────────────────────────────────────────────────────────────
  // CASE 3 — CONTROL discriminator: a clean tool turn then end_turn emits ZERO
  // recovery events. Proves the recovery assertions above aren't vacuous.
  // ───────────────────────────────────────────────────────────────────────
  test("3. control: clean tool turn then end_turn → ZERO recovery events, real turn counted", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      ev(toolUse("t0", "read", { path: "/tmp/probe" })), // turn 1: real tool turn
      ev(text("clean answer, no recovery")), // turn 2: end_turn
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 5 })),
      15_000,
      "compose-control",
    )
    expect(out.reason).toBe("completed")
    // One tool round (turn 1) + the final text turn (turn 2).
    expect(out.turns).toBe(2)
    expect(llm.calls).toBe(2)
    // The discriminator: NOT A SINGLE recovery event fired on a clean path.
    expect(recoveryReasons(stream)).toHaveLength(0)
    // Sanity: the tool round really ran (one tool_result user message present).
    expect(
      out.messages.some(
        (m) => m.role === "user" && m.content.some((b) => b.type === "tool_result"),
      ),
    ).toBe(true)
  }, 20_000)

  // ───────────────────────────────────────────────────────────────────────
  // CASE 4 — a real TOOL turn BETWEEN recoveries, crossing a turn boundary.
  // Turn 1: throw→backoff→success-with-tool. Tool result drives Turn 2, which
  // hits max_tokens→nudge→end. Proves: (a) maxTurns counts only the two tool-
  // bearing/text turns, recoveries excluded; (b) per-turn freshRecovery resets
  // the budget — the backoff in turn 1 does not pre-spend turn 2's budget.
  // ───────────────────────────────────────────────────────────────────────
  test("4. tool turn between recoveries: maxTurns counts only real turns; budgets reset per turn", async () => {
    const stream = new RecordingStream()
    const steps: Step[] = [
      thr(new LLMError("timeout while reading")), // turn 1, call 1 → backoff
      ev(toolUse("t0", "read", { path: "/tmp/probe" })), // turn 1, call 2 → tool turn (success)
      // tool_result feeds turn 2:
      ev(text("partial in turn two", "max_tokens")), // turn 2, call 3 → output nudge
      ev(text("done after second-turn nudge")), // turn 2, call 4 → end_turn
    ]
    const llm = new ScriptedLLM(steps)
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 10 })),
      20_000,
      "compose-tool-between-recoveries",
    )
    expect(out.reason).toBe("completed")
    // Exactly TWO real turns: the tool round (turn 1) + the final text turn
    // (turn 2). The backoff (turn 1) and the output nudge (turn 2) are SAME-
    // TURN recoveries and excluded from the count.
    expect(out.turns).toBe(2)
    // 4 LLM calls: 1 backoff retry + 1 tool turn + 1 output nudge + 1 final.
    expect(llm.calls).toBe(4)

    // Both recovery kinds fired, one in each turn — proving the budget reset:
    // turn 2's output nudge happened AFTER turn 1's backoff with no
    // cross-turn leakage that would have suppressed it.
    const reasons = recoveryReasons(stream)
    expect(reasons).toContain("backoff")
    expect(reasons).toContain("nudge")
    expect(reasons.indexOf("backoff")).toBeLessThan(reasons.indexOf("nudge"))

    // Transcript: one tool_use assistant block + one tool_result, the final
    // assistant turn is the post-nudge answer, and the turn-2 partial survived.
    const toolUses = out.messages.filter(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "tool_use"),
    ).length
    expect(toolUses).toBe(1)
    const last = out.messages.findLast((m) => m.role === "assistant")
    expect(
      last?.content.some((b) => b.type === "text" && b.text === "done after second-turn nudge"),
    ).toBe(true)
    expect(
      out.messages.some(
        (m) =>
          m.role === "assistant" &&
          m.content.some((b) => b.type === "text" && b.text === "partial in turn two"),
      ),
    ).toBe(true)
  }, 25_000)

  // ───────────────────────────────────────────────────────────────────────
  // CASE 4b — the budget RESET made falsifiable: a backoff storm in turn 1
  // would, if budgets leaked across turns, leave turn 2 with no stream retries.
  // Spend the FULL stream budget (3) in turn 1, succeed, then throw ONCE in
  // turn 2. A fresh budget means that single throw recovers; a leaked budget
  // would hard-fail. The run completing proves the per-turn reset.
  // ───────────────────────────────────────────────────────────────────────
  test("4b. full backoff storm in turn 1 does not starve turn 2's fresh stream budget", async () => {
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      thr(new LLMError("503 a")), // turn 1: backoff 1
      thr(new LLMError("503 b")), // turn 1: backoff 2
      thr(new LLMError("503 c")), // turn 1: backoff 3 (cap reached, not exceeded)
      ev(toolUse("t0", "read", { path: "/tmp/probe" })), // turn 1: success tool turn
      thr(new LLMError("503 in turn two")), // turn 2: backoff on a FRESH budget
      ev(text("survived a fresh-budget retry in turn two")), // turn 2: end_turn
    ])
    const out = await withTimeout(
      runAgent(cfg({ llm, stream, maxTurns: 10 })),
      20_000,
      "compose-budget-reset",
    )
    expect(out.reason).toBe("completed")
    expect(out.turns).toBe(2)
    // 3 backoffs (turn1) + 1 tool turn + 1 backoff (turn2) + 1 final = 6.
    expect(llm.calls).toBe(6)
    // FOUR backoff recoveries total: 3 in turn 1 + 1 in turn 2.
    expect(recoveryReasons(stream).filter((r) => r === "backoff")).toHaveLength(4)
  }, 25_000)
})
