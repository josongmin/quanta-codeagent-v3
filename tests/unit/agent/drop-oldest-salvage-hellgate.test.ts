/**
 * §13.3 (jun-08 long-tail) — compaction DROP-OLDEST salvage hellgate.
 *
 * The fail-fast `reactiveCompact` aborts the turn the moment summarization
 * cannot shrink the transcript. §13.3 layers a DROP-OLDEST salvage on top:
 * shed the oldest turns to fit the budget rather than abort. Locks:
 *
 *   1. dropOldestTurn purity + ORPHAN-SAFETY: never leaves a head tool_result
 *      whose tool_use was just dropped; respects the floor; returns null when
 *      nothing can be shed.
 *   2. dropOldestSalvage strategy ordering: reactive squeeze first; hard-drop
 *      fallback only when the squeeze fails; stops as soon as the budget fits.
 *   3. exhaustion: an irreducible giant tail (single current request) ⇒ ok:false.
 *   4. round cap bounds the loop.
 */
import { describe, expect, test } from "bun:test"
import {
  dropOldestSalvage,
  dropOldestTurn,
  estimateTokens,
  MAX_DROP_OLDEST_ROUNDS,
} from "@/agent"
import type { LLMPort, Message } from "@/llm"

/** A summarizer that always returns a small non-empty summary, so reactive
 *  squeeze success depends purely on the drop-ratio arithmetic, not the LLM.
 *  Uses the canonical StreamEvent shape (`text_delta`/`message_stop`) the real
 *  `assembleFromEvents` consumes. */
const tinySummaryLlm = (): LLMPort =>
  ({
    model: "fake-summarizer",
    stream: async function* () {
      yield { type: "text_delta", delta: "<summary>tiny</summary>" } as never
      yield { type: "message_stop", stop_reason: "end_turn" } as never
    },
  }) as unknown as LLMPort

const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const asstMsg = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

describe("§13.3 — dropOldestTurn (pure, orphan-safe)", () => {
  test("drops the oldest user+assistant turn", () => {
    const msgs = [userMsg("u1"), asstMsg("a1"), userMsg("u2"), asstMsg("a2")]
    const out = dropOldestTurn(msgs, 1)
    expect(out).not.toBeNull()
    expect(out).toEqual([userMsg("u2"), asstMsg("a2")])
  })

  test("sweeps an orphaned tool_result head left by the drop", () => {
    const msgs: Message[] = [
      userMsg("u1"),
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] },
      userMsg("u2"),
      asstMsg("a2"),
    ]
    const out = dropOldestTurn(msgs, 1)
    // The leading [u1, assistant(tool_use t1)] turn is dropped AND the orphaned
    // tool_result for t1 is swept so the head is self-consistent.
    expect(out).not.toBeNull()
    const head = (out as Message[])[0]
    expect(head?.role).toBe("user")
    expect(head?.content[0]?.type).toBe("text")
    // No orphaned tool_result remains at the head.
    expect((out as Message[]).some((m) => m.content.some((b) => b.type === "tool_result"))).toBe(
      false,
    )
  })

  test("respects the floor — returns null when at/below keepFloor", () => {
    expect(dropOldestTurn([userMsg("only")], 1)).toBeNull()
    expect(dropOldestTurn([userMsg("u"), asstMsg("a")], 2)).toBeNull()
  })

  test("never drops below the floor in one step (giant first turn, floor 2)", () => {
    const msgs = [userMsg("u1"), asstMsg("a1"), userMsg("u2")]
    // Dropping the first turn would leave 1 message (< floor 2) ⇒ null.
    expect(dropOldestTurn(msgs, 2)).toBeNull()
  })
})

describe("§13.3 — dropOldestSalvage strategy", () => {
  test("reactive squeeze success returns strategy:reactive, droppedRounds 0", async () => {
    const big = "X".repeat(80_000)
    // Giant OLD turn (prefix) + small recent turns ⇒ summarizing the prefix
    // achieves a big drop ⇒ reactive succeeds on the first try.
    const msgs = [
      userMsg("u1"),
      asstMsg(`old ${big}`),
      userMsg("u2"),
      asstMsg("recent a2 small"),
      userMsg("u3 current small"),
      asstMsg("recent a3 small"),
    ]
    const r = await dropOldestSalvage({ messages: msgs, llm: tinySummaryLlm(), system: "sys" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.strategy).toBe("reactive")
      expect(r.droppedRounds).toBe(0)
    }
  })

  test("hard-drop fallback engages when the giant payload is in the retained suffix", async () => {
    const big = "X".repeat(60_000)
    // The last two assistant turns (kept by reactiveCompact) BOTH carry giant
    // payloads ⇒ summarizing the tiny prefix frees < 15% ⇒ reactive fails. The
    // hard-drop fallback then sheds oldest turns until the estimate fits the
    // target.
    const msgs = [
      userMsg("u1 small"),
      asstMsg("a1 small"),
      userMsg("u2 small"),
      asstMsg(`bigA ${big}`),
      userMsg("u3 small"),
      asstMsg(`bigB ${big}`),
      userMsg("current small"),
    ]
    expect(estimateTokens(msgs)).toBeGreaterThanOrEqual(4_000)
    // Target small enough that at least one drop is needed but reachable by
    // shedding the giant older turns.
    const target = Math.ceil(estimateTokens([userMsg("current small")]) + 100)
    const r = await dropOldestSalvage({
      messages: msgs,
      llm: tinySummaryLlm(),
      system: "sys",
      targetTokens: target,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.strategy).toBe("hard-drop")
      expect(r.droppedRounds).toBeGreaterThanOrEqual(1)
      expect(estimateTokens(r.messages)).toBeLessThanOrEqual(target)
      // The current request is preserved.
      expect(r.messages.at(-1)).toEqual(userMsg("current small"))
    }
  })

  test("exhaustion: a single irreducible giant current request ⇒ ok:false", async () => {
    const big = "X".repeat(120_000)
    // Only one message and it's the (giant) current request — cannot be summarized
    // (no prefix) and cannot be dropped (floor 1). Genuine dead end.
    const msgs = [userMsg(`current ${big}`)]
    const r = await dropOldestSalvage({
      messages: msgs,
      llm: tinySummaryLlm(),
      system: "sys",
      targetTokens: 10,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain("drop-oldest salvage exhausted")
    }
  })

  test("round cap bounds the loop (reactive fails, giant unreachable suffix)", async () => {
    const big = "X".repeat(60_000)
    // Tiny prefix + giant last-2 turns ⇒ reactive squeeze fails (drop-ratio).
    // The giant suffix dominates and cannot be shed below the floor, and the
    // target is far below it ⇒ the loop MUST terminate ok:false (bounded), never
    // spin. We assert the BOUNDED INVARIANT (terminates, droppedRounds ≤ cap),
    // not which specific terminal arm fires.
    const msgs: Message[] = [
      userMsg("u1 small"),
      asstMsg("a1 small"),
      userMsg("u2 small"),
      asstMsg(`bigA ${big}`),
      userMsg("u3 small"),
      asstMsg(`bigB ${big}`),
      userMsg("current small"),
    ]
    // cap=2 is fewer than the ~3 drops needed to shed both giant turns down to
    // a 5-token target ⇒ the loop bails at the cap.
    const cap = 2
    const r = await dropOldestSalvage({
      messages: msgs,
      llm: tinySummaryLlm(),
      system: "sys",
      targetTokens: 5,
      maxRounds: cap,
    })
    expect(r.ok).toBe(false)
    expect(r.droppedRounds).toBeLessThanOrEqual(cap)
    // MAX_DROP_OLDEST_ROUNDS is the production default the wire relies on.
    expect(MAX_DROP_OLDEST_ROUNDS).toBeGreaterThan(0)
  })
})
