import { describe, expect, test } from "bun:test"
import { estimateTokens, runAgent } from "@/agent"
import type { Message } from "@/llm"
import { LLMError } from "@/shared"
import { cfg, ev, RecordingStream, ScriptedLLM, text, thr, withTimeout } from "./_harness"

/**
 * §13.3 (jun-08 long-tail) — DROP-OLDEST salvage driven through the REAL
 * `runAgent` loop. The companion `reactive-failfast-e2e.test.ts` proves the
 * DEFAULT (knob OFF) path: an oversized retained suffix ⇒ `reactiveCompact`
 * fail-fast ⇒ the loop ends in `error`. This file proves the OPT-IN salvage:
 * the SAME transcript + the SAME PTL, but with `compaction.dropOldestSalvage`,
 * sheds the oldest turns and the loop CONTINUES to completion instead of
 * aborting.
 *
 * Constants (compaction.ts):
 *   REACTIVE_MIN_INPUT_TOKENS = 4_000 ; REACTIVE_MIN_DROP_RATIO = 0.15
 * The last two assistant turns each carry a ~60k payload (kept by findBoundary,
 * REACTIVE_KEEP_TURNS = 2), so summarizing the tiny prefix frees < 15% and the
 * reactive squeeze fails — exactly the abort condition the salvage rescues.
 */
const big = "X".repeat(60_000)
const buildHistory = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "small task prefix" }] },
  { role: "assistant", content: [{ type: "text", text: "tiny prefix turn" }] },
  { role: "user", content: [{ type: "text", text: "u2 small" }] },
  { role: "assistant", content: [{ type: "text", text: `bigA ${big}` }] },
  { role: "user", content: [{ type: "text", text: "u3 small" }] },
  { role: "assistant", content: [{ type: "text", text: `bigB ${big}` }] },
  { role: "user", content: [{ type: "text", text: "current request small" }] },
]

describe("§13.3 — drop-oldest salvage through runAgent", () => {
  test("HELL-DROP-E2E: knob OFF (baseline) ⇒ loop aborts with the fail-fast reason", async () => {
    const history = buildHistory()
    expect(estimateTokens(history)).toBeGreaterThanOrEqual(4_000)
    const llm = new ScriptedLLM([
      thr(new LLMError("400 prompt is too long for this model")),
      ev(text("<summary>tiny summary</summary>")),
      ev(text("unreachable")),
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({ llm, stream, messages: history, maxTurns: 3, compactionBreaker: { disabled: true } }),
      ),
      15_000,
      "drop-salvage-off",
    )
    // Default fail-fast: the reactive squeeze can't shrink the giant suffix.
    expect(out.reason).toBe("error")
    const errEvt = stream.events.find((e) => e.type === "error")
    expect(errEvt?.type === "error" && errEvt.message).toContain(
      "reactive compaction freed no meaningful context",
    )
  })

  test("HELL-DROP-E2E2: knob ON ⇒ loop salvages (sheds oldest) and CONTINUES to completion", async () => {
    const history = buildHistory()
    const llm = new ScriptedLLM([
      // Turn 1: PTL → routes to compact.
      thr(new LLMError("400 prompt is too long for this model")),
      // The reactive squeeze's continuation-summary call (non-empty so it
      // reaches the drop-ratio guard, which fails ⇒ hard-drop fallback engages,
      // pure slicing, NO further summarizer call).
      ev(text("<summary>tiny summary</summary>")),
      // After salvage CONTINUE, the loop re-streams the (shed) transcript and
      // the model now completes the turn.
      ev(text("done after salvage")),
    ])
    const stream = new RecordingStream()
    const out = await withTimeout(
      runAgent(
        cfg({
          llm,
          stream,
          messages: history,
          maxTurns: 3,
          compactionBreaker: { disabled: true },
          // §13.3 opt-in. A tiny threshold makes the hard-drop target reachable
          // only after shedding the giant older turns, exercising the real shed.
          compaction: { dropOldestSalvage: true, thresholdTokens: 1_000 },
        }),
      ),
      15_000,
      "drop-salvage-on",
    )
    // Salvage succeeded ⇒ the loop did NOT abort; it completed the turn.
    expect(out.reason).toBe("completed")
    // No error event was emitted (contrast with the OFF baseline, which DID).
    expect(stream.events.some((e) => e.type === "error")).toBe(false)
    // The model was called the 3rd time (PTL throw + continuation-summary +
    // post-salvage completion) — proving the loop resumed past the salvage seam
    // rather than aborting at the reactive fail-fast.
    expect(llm.calls).toBe(3)
  })
})
