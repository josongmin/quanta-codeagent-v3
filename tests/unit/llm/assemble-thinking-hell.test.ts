/**
 * ADR-0076 Gap-2 — `assembleFromEvents` reasoning carry-over HELL-GATE.
 *
 * Pins the structural invariants of the assemble switch (`src/llm/assemble.ts`),
 * specifically `findLastThinking` + `appendThinkingDelta` + `appendSignatureDelta`
 * + `stream_reset` tombstone, under adversarial event sequences:
 *
 *   I-A  signature_delta WITHOUT a preceding thinking_delta is SILENTLY DROPPED
 *        — no synthetic ThinkingBlock is fabricated. A fabricated block would
 *        ship `signature` back on the next turn with no `thinking` body and the
 *        provider would 400. The assemble.ts comment makes this explicit:
 *          "if it ever occurs we drop it rather than fabricate a content block."
 *   I-B  thinking_delta sequence reset by `stream_reset` ⇒ tombstone the dead
 *        partial; the replacement stream rebuilds from zero.
 *   I-C  redacted vs plaintext NEVER merge — even when consecutive — because
 *        the ciphertext block must round-trip as `redacted_thinking` not
 *        plaintext `thinking`.
 *   I-D  block ordering is provider-faithful (thinking → text → tool_use, or
 *        thinking → thinking → … if interleaved by text/tool_use blocks).
 *   I-E  redacted_thinking → plaintext thinking emits TWO blocks; never one.
 *   I-F  Memory-bounded: 10MB+ thinking text accumulates without truncation
 *        (assemble.ts does no length policy).
 *   I-G  Multi-byte unicode + non-ASCII signatures round-trip bytewise.
 *   I-H  signature_delta accumulates by CONCAT (the test in the baseline
 *        already pins this for two deltas; the hell-gate widens to 4KB+ and
 *        non-ASCII signatures).
 *   I-I  text_delta interleaved BETWEEN two thinking_delta runs ⇒ two separate
 *        ThinkingBlocks (the text "closes" the trailing thinking run).
 *   I-J  thinking_delta followed by tool_use ⇒ ThinkingBlock precedes
 *        ToolUseBlock (carry-over: thinking sits at the front of the
 *        assistant Message).
 *   I-K  Event-burst stress (1000+ thinking_deltas in a single turn) folds
 *        into ONE ThinkingBlock (no per-event allocation cliff).
 */
import { describe, expect, test } from "bun:test"
import type { StreamEvent, ThinkingBlock } from "@/llm"
import { assembleFromEvents } from "@/llm"

describe("ADR-0076 Gap-2 HELL — orphan signature_delta", () => {
  test("I-A: signature_delta with NO preceding thinking_delta is dropped silently", () => {
    // The baseline already pins single-orphan drop; we pin MULTIPLE orphans +
    // mixed with content so the contract is unambiguous: orphans NEVER create
    // a ThinkingBlock, no matter how many arrive.
    const events: StreamEvent[] = [
      { type: "signature_delta", signature: "orphan1" },
      { type: "signature_delta", signature: "orphan2" },
      { type: "text_delta", delta: "actual text" },
      { type: "signature_delta", signature: "orphan3" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    // ADR-0077: every text block now carries a structural `phase`
    // ({"commentary"|"final_answer"}) computed by a deterministic backward
    // scan; a turn with no tool_use after the text ⇒ phase: "final_answer".
    expect(message.content).toEqual([{ type: "text", text: "actual text", phase: "final_answer" }])
    expect(message.content.some((b) => b.type === "thinking")).toBe(false)
  })

  test("I-A2: orphan signature_delta + later thinking_delta does NOT back-attach", () => {
    // Critical: the orphan signature is dropped at the moment it arrives. A
    // LATER thinking_delta opens a fresh block with NO signature — the orphan
    // does not retroactively attach to the new block.
    const events: StreamEvent[] = [
      { type: "signature_delta", signature: "should-be-dropped" },
      { type: "thinking_delta", text: "real" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([{ type: "thinking", thinking: "real" }])
    const t = message.content[0] as ThinkingBlock
    expect(t.signature).toBeUndefined()
  })
})

describe("ADR-0076 Gap-2 HELL — stream_reset tombstone mid-thinking", () => {
  test("I-B: stream_reset MID thinking_delta run drops the partial and starts fresh", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "DEAD partial 1" },
      { type: "thinking_delta", text: "DEAD partial 2" },
      { type: "signature_delta", signature: "DEADSIG" },
      { type: "stream_reset" },
      { type: "thinking_delta", text: "live" },
      { type: "signature_delta", signature: "livesig" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([{ type: "thinking", thinking: "live", signature: "livesig" }])
  })

  test("I-B2: stream_reset BETWEEN thinking_delta and signature_delta tombstones signature too", () => {
    // The signature attaches to the LAST thinking block; after stream_reset
    // wipes content, the next signature_delta has nothing to bind to and is
    // silently dropped (orphan-signature invariant). Replacement thinking
    // starts a fresh, signature-less block.
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "dead" },
      { type: "stream_reset" },
      { type: "signature_delta", signature: "should-be-dropped" },
      { type: "thinking_delta", text: "live" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([{ type: "thinking", thinking: "live" }])
    expect((message.content[0] as ThinkingBlock).signature).toBeUndefined()
  })

  test("I-B3: multiple stream_resets ⇒ only the FINAL run survives", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "v1" },
      { type: "stream_reset" },
      { type: "thinking_delta", text: "v2" },
      { type: "stream_reset" },
      { type: "thinking_delta", text: "v3" },
      { type: "signature_delta", signature: "sig3" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([{ type: "thinking", thinking: "v3", signature: "sig3" }])
  })
})

describe("ADR-0076 Gap-2 HELL — redacted × plaintext separation", () => {
  test("I-C: redacted block then plaintext ⇒ TWO blocks (never merge)", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "CIPHER", redacted: true },
      { type: "thinking_delta", text: "plain" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([
      { type: "thinking", thinking: "CIPHER", redacted: true },
      { type: "thinking", thinking: "plain" },
    ])
  })

  test("I-C2: plaintext then redacted ⇒ TWO blocks (order preserved)", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "plain" },
      { type: "thinking_delta", text: "ENC", redacted: true },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([
      { type: "thinking", thinking: "plain" },
      { type: "thinking", thinking: "ENC", redacted: true },
    ])
  })

  test("I-E: redacted → plaintext → redacted ⇒ THREE blocks (never collapses)", () => {
    // Note: `redacted: false` is NOT representable on StreamEvent
    // (`redacted?: true` — absent ⇒ plaintext). The plaintext middle delta
    // simply omits the field; the assembler reads `ev.redacted === true`.
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "C1", redacted: true },
      { type: "thinking_delta", text: "p" },
      { type: "thinking_delta", text: "C2", redacted: true },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([
      { type: "thinking", thinking: "C1", redacted: true },
      { type: "thinking", thinking: "p" },
      { type: "thinking", thinking: "C2", redacted: true },
    ])
  })

  test("I-C3: signature on a redacted block attaches normally", () => {
    // findLastThinking does not discriminate by `redacted`; a signature after
    // a redacted block binds to it (rare in practice — Anthropic typically
    // ships redacted whole on the start event — but the policy must be
    // structural, not heuristic).
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "ENC", redacted: true },
      { type: "signature_delta", signature: "sig" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([
      { type: "thinking", thinking: "ENC", redacted: true, signature: "sig" },
    ])
  })
})

describe("ADR-0076 Gap-2 HELL — block ordering invariants", () => {
  test("I-D: thinking → text → tool_use preserved exactly (provider order)", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "think" },
      { type: "signature_delta", signature: "s" },
      { type: "text_delta", delta: "speak" },
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: { path: "a.ts" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"])
  })

  test("I-I: text_delta BETWEEN thinking runs ⇒ two ThinkingBlocks separated by text", () => {
    // The text_delta closes the trailing thinking_delta run by being a
    // non-thinking block at the tail; a subsequent thinking_delta opens a
    // fresh block.
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "A" },
      { type: "text_delta", delta: " mid " },
      { type: "thinking_delta", text: "B" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    // ADR-0077: text block carries structural `phase: "final_answer"` because
    // no tool_use follows it in the assembled content[].
    expect(message.content).toEqual([
      { type: "thinking", thinking: "A" },
      { type: "text", text: " mid ", phase: "final_answer" },
      { type: "thinking", thinking: "B" },
    ])
  })

  test("I-J: thinking_delta + tool_use ⇒ ThinkingBlock precedes ToolUseBlock", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "choose tool" },
      { type: "tool_use_start", id: "t1", name: "glob" },
      { type: "tool_use_end", id: "t1", input: { pattern: "**" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content[0]?.type).toBe("thinking")
    expect(message.content[1]?.type).toBe("tool_use")
  })

  test("I-I2: tool_use BETWEEN thinking runs ⇒ two thinking blocks bracketing the tool", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "preflight" },
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: {} },
      { type: "thinking_delta", text: "postflight" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content.map((b) => b.type)).toEqual(["thinking", "tool_use", "thinking"])
  })

  test("I-J2: signature_delta after tool_use attaches to the LAST ThinkingBlock (which is BEFORE the tool)", () => {
    // findLastThinking walks back across non-thinking blocks. A signature
    // streamed after the tool_use binds to the thinking block that PRECEDES
    // the tool. This is provider-faithful: Anthropic emits signature_delta
    // as the closing event of the thinking content block, before subsequent
    // blocks start.
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "think" },
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: {} },
      { type: "signature_delta", signature: "late_sig" },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content[0]).toEqual({
      type: "thinking",
      thinking: "think",
      signature: "late_sig",
    })
  })
})

describe("ADR-0076 Gap-2 HELL — signature accumulation modes", () => {
  test("I-H: signature_delta multi ⇒ concatenated into one signature string (not last-wins)", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "x" },
      { type: "signature_delta", signature: "p1" },
      { type: "signature_delta", signature: "p2" },
      { type: "signature_delta", signature: "p3" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content).toEqual([{ type: "thinking", thinking: "x", signature: "p1p2p3" }])
  })

  test("I-G: 4KB+ signature roundtrip (no truncation)", () => {
    const sig = "S".repeat(4096) + "_TAIL"
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "t" },
      { type: "signature_delta", signature: sig },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect((message.content[0] as ThinkingBlock).signature).toBe(sig)
    expect((message.content[0] as ThinkingBlock).signature?.length).toBe(4096 + 5)
  })

  test("I-G2: non-ASCII binary-like signature roundtrip bytewise", () => {
    // Anthropic signatures are opaque; treat as a byte bag.
    const sig = "sig:\x00ÿ​\u{1F600}_end"
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "t" },
      { type: "signature_delta", signature: sig },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect((message.content[0] as ThinkingBlock).signature).toBe(sig)
  })

  test("I-H2: empty-string signature_delta sets `signature: ''` on the block (truthy presence)", () => {
    // `last.signature = (last.signature ?? '') + ''` ⇒ '' — concretely set,
    // not undefined. This matters for carry-over: the Anthropic adapter only
    // re-serializes thinking blocks whose signature is `!== undefined`.
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "t" },
      { type: "signature_delta", signature: "" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect((message.content[0] as ThinkingBlock).signature).toBe("")
  })

  test("I-H3: only the LAST ThinkingBlock receives subsequent signature_delta", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "A" },
      { type: "text_delta", delta: "mid" },
      { type: "thinking_delta", text: "B" },
      { type: "signature_delta", signature: "sigB" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    const tBlocks = message.content.filter((b): b is ThinkingBlock => b.type === "thinking")
    expect(tBlocks[0]).toEqual({ type: "thinking", thinking: "A" })
    expect(tBlocks[1]).toEqual({ type: "thinking", thinking: "B", signature: "sigB" })
  })
})

describe("ADR-0076 Gap-2 HELL — content stress", () => {
  test("I-F: 10MB+ thinking text accumulates without truncation", () => {
    // Memory-bounded but never truncated: 10MB is well within v8 heap.
    const big = "X".repeat(10 * 1024 * 1024)
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: big },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect((message.content[0] as ThinkingBlock).thinking.length).toBe(big.length)
  })

  test("I-K: 1000+ thinking_delta events fold into ONE ThinkingBlock (no per-event allocation cliff)", () => {
    const events: StreamEvent[] = []
    for (let i = 0; i < 2000; i++) events.push({ type: "thinking_delta", text: "x" })
    events.push({ type: "signature_delta", signature: "s" })
    events.push({ type: "message_stop", stop_reason: "end_turn" })
    const { message } = assembleFromEvents(events)
    expect(message.content).toHaveLength(1)
    expect((message.content[0] as ThinkingBlock).thinking.length).toBe(2000)
    expect((message.content[0] as ThinkingBlock).signature).toBe("s")
  })

  test("multi-byte unicode in thinking text roundtrips losslessly", () => {
    const text = "한국어 reasoning · 思考 · حُجَّة · 🧠✨ end"
    const events: StreamEvent[] = [
      { type: "thinking_delta", text },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect((message.content[0] as ThinkingBlock).thinking).toBe(text)
  })

  test("control chars (\\x00 / \\x1b) inside thinking text preserved verbatim", () => {
    const text = "before\x00midend"
    const events: StreamEvent[] = [
      { type: "thinking_delta", text },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect((message.content[0] as ThinkingBlock).thinking).toBe(text)
  })
})

describe("ADR-0076 Gap-2 HELL — no-thinking byte-identical (NI-4 cross-check)", () => {
  test("NI-4: zero thinking_delta + zero signature_delta ⇒ no ThinkingBlock appears", () => {
    // Pre-feature path. The byte-identical invariant: an unset thinking budget
    // means adapters emit zero thinking events; assemble must emit zero
    // ThinkingBlocks.
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "answer" },
      { type: "tool_use_start", id: "t1", name: "read" },
      { type: "tool_use_end", id: "t1", input: {} },
      { type: "message_stop", stop_reason: "tool_use" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content.some((b) => b.type === "thinking")).toBe(false)
  })

  test("NI-4: only signature_delta (no thinking_delta at all) ⇒ no ThinkingBlock fabricated", () => {
    // The most adversarial slice: a misbehaving adapter that synthesizes
    // signature_deltas without companion thinking deltas. assemble must NOT
    // fabricate a thinking block — fabricating one would 400 the next turn.
    const events: StreamEvent[] = [
      { type: "signature_delta", signature: "lone" },
      { type: "signature_delta", signature: "another" },
      { type: "text_delta", delta: "answer" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    expect(message.content.some((b) => b.type === "thinking")).toBe(false)
  })
})

describe("ADR-0076 Gap-2 HELL — stopReason preservation under thinking", () => {
  test("stopReason flows through unchanged when thinking is present", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "t" },
      { type: "message_stop", stop_reason: "refusal" },
    ]
    const { stopReason } = assembleFromEvents(events)
    // Note: this stop_reason will be routed to `error` by decideOnAssembled
    // (refusal terminal). assemble just preserves the literal — branching is
    // the loop's job.
    expect(stopReason).toBe("refusal")
  })

  test("response_in_progress between thinking_deltas does not split the block", () => {
    const events: StreamEvent[] = [
      { type: "thinking_delta", text: "first " },
      { type: "response_in_progress", message: "still thinking" },
      { type: "thinking_delta", text: "second" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { message } = assembleFromEvents(events)
    // response_in_progress is not content; the two thinking_deltas remain
    // structurally adjacent and fold into ONE block.
    expect(message.content).toEqual([{ type: "thinking", thinking: "first second" }])
  })
})
