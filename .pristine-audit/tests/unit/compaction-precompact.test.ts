/**
 * compactIfNeeded × preflight HITL hook (ADR-0069, Cursor absorption).
 *
 * The preflight callback is consulted ONLY AFTER:
 *   1. the threshold guard fires (currentTokens > threshold), AND
 *   2. a summarizable boundary exists (findBoundary > 0).
 *
 * These tests pin:
 *   - approve / force_now → proceed to summarize (compacted:true);
 *   - defer_one_turn      → skip THIS compaction (compacted:false, NO LLM call);
 *   - query payload carries the right token / threshold / keep / proposed values;
 *   - under-threshold case: preflight NEVER called (no UI noise for noise);
 *   - no-summarizable-prefix: preflight NEVER called (UI shouldn't ask about
 *     a no-op decision).
 *
 * SummarizingLLM records whether it was invoked so we can assert the deferral
 * branch never reaches the summarizer (the contract the loop relies on for
 * "host said no = zero side effects").
 */
import { describe, expect, test } from "bun:test"
import { compactIfNeeded } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"

class SummarizingLLM implements LLMPort {
  lastSystem: SystemPromptInput | undefined
  lastMessages: Message[] = []
  callCount = 0
  constructor(private readonly summary: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.callCount += 1
    this.lastSystem = input.system
    this.lastMessages = input.messages
    yield { type: "text_delta", delta: this.summary }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const overThresholdMessages = (): Message[] => [
  // Two ~2k-char turns push us well over a low threshold; one recent turn
  // is kept verbatim so the boundary is summarizable.
  userText("a".repeat(2_000)),
  assistantText("b".repeat(2_000)),
  userText("recent ask"),
  assistantText("recent answer"),
]

describe("compactIfNeeded preflight (ADR-0069)", () => {
  test("approve → compaction proceeds, preflight invoked once with correct query", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const seen: Array<{
      currentTokens: number
      threshold: number
      proposedKeep: number
      proposedSummaryTokens: number
    }> = []
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preflight: async (q) => {
        seen.push(q)
        return "approve"
      },
    })
    expect(res.compacted).toBe(true)
    expect(llm.callCount).toBe(1)
    expect(seen.length).toBe(1)
    const q = seen[0]
    if (!q) throw new Error("preflight not invoked")
    expect(q.threshold).toBe(100)
    expect(q.proposedKeep).toBe(1)
    expect(q.currentTokens).toBeGreaterThan(100)
    // The summarizable prefix is well over zero tokens here.
    expect(q.proposedSummaryTokens).toBeGreaterThan(0)
  })

  test("force_now → same effect as approve (compacted:true, llm invoked)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preflight: async () => "force_now",
    })
    expect(res.compacted).toBe(true)
    expect(llm.callCount).toBe(1)
  })

  test("defer_one_turn → compacted:false, original messages, summarizer NEVER called", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const msgs = overThresholdMessages()
    const res = await compactIfNeeded({
      messages: msgs,
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preflight: async () => "defer_one_turn",
    })
    expect(res.compacted).toBe(false)
    expect(res.messages).toBe(msgs)
    expect(llm.callCount).toBe(0)
  })

  test("under threshold → preflight NEVER called (no UI noise)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    let calls = 0
    const res = await compactIfNeeded({
      messages: [userText("tiny"), assistantText("tiny")],
      llm,
      system: "sys",
      thresholdTokens: 1_000_000,
      preflight: async () => {
        calls += 1
        return "approve"
      },
    })
    expect(res.compacted).toBe(false)
    expect(calls).toBe(0)
    expect(llm.callCount).toBe(0)
  })

  test("no summarizable prefix (one giant turn) → preflight NEVER called", async () => {
    const llm = new SummarizingLLM("FOLDED")
    let calls = 0
    // Exactly ONE assistant message that itself blows past the threshold —
    // findBoundary returns 0 so compaction would no-op anyway; the host
    // should NOT be woken to decide about a no-op.
    const res = await compactIfNeeded({
      messages: [assistantText("z".repeat(2_000))],
      llm,
      system: "sys",
      thresholdTokens: 50,
      keepRecentTurns: 1,
      preflight: async () => {
        calls += 1
        return "approve"
      },
    })
    expect(res.compacted).toBe(false)
    expect(calls).toBe(0)
    expect(llm.callCount).toBe(0)
  })

  test("preflight throws → error propagates (loop wraps in its own try/catch)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const boom = new Error("user cancelled")
    let threw: unknown
    try {
      await compactIfNeeded({
        messages: overThresholdMessages(),
        llm,
        system: "sys",
        thresholdTokens: 100,
        keepRecentTurns: 1,
        preflight: async () => {
          throw boom
        },
      })
    } catch (e) {
      threw = e
    }
    expect(threw).toBe(boom)
    // Summarizer must not have been touched.
    expect(llm.callCount).toBe(0)
  })

  test("absent preflight → byte-identical to legacy path (no extra await)", async () => {
    // Behavior parity: when `preflight` is omitted, compaction proceeds
    // exactly as it would have pre-ADR-0069. This is the byte-identical
    // default the rest of the codebase relies on.
    const llm = new SummarizingLLM("FOLDED")
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
    })
    expect(res.compacted).toBe(true)
    expect(llm.callCount).toBe(1)
  })
})
