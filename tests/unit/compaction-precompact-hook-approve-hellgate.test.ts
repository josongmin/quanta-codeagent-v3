/**
 * GAP-CLOSER (leaf audit, jul-18) — pre-compact HITL `preCompactHook`
 * (ADR-0133) AUTO-APPROVE + COMPOSE paths.
 *
 * The leaf invariant is "hook absent ⇒ auto-approve (NO silent block)". The
 * existing suite proves:
 *   - `compaction-precompact` — the OTHER hook (`preflight`) approve/defer;
 *   - `compaction-defer-notice` — `preCompactHook` returning a truthy
 *      `abortReason` (the BLOCK path) emits a defer notice.
 *
 * NEITHER pins the `preCompactHook` AUTO-APPROVE branch:
 *   - `preCompactHook` ABSENT ⇒ compaction proceeds (byte-identical legacy);
 *   - `preCompactHook` returns `{abortReason: null}` ⇒ proceeds (no silent
 *      block — the summarizer IS reached);
 *   - hook receives the right query (`messagesToCompact`, `isFirstCompaction`);
 *   - COMPOSE: hook approves (null) AND preflight approves ⇒ both consulted,
 *      compaction proceeds (the two HITL seams chain, hook FIRST).
 *
 * Without these a regression that made `preCompactHook` block on ANY return
 * (a silent compaction freeze) would pass every existing test. The
 * `SummarizingLLM.callCount` witnesses that the summarizer is genuinely
 * reached on the approve path (non-vacuous).
 */

import { describe, expect, test } from "bun:test"
import { compactIfNeeded } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"

class SummarizingLLM implements LLMPort {
  callCount = 0
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.callCount += 1
    yield { type: "text_delta", delta: "FOLDED" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const overThresholdMessages = (): Message[] => [
  userText("a".repeat(2_000)),
  assistantText("b".repeat(2_000)),
  userText("recent ask"),
  assistantText("recent answer"),
]

describe("preCompactHook auto-approve (ADR-0133, no silent block)", () => {
  test("ABSENT hook ⇒ compaction proceeds (byte-identical legacy)", async () => {
    const llm = new SummarizingLLM()
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

  test("abortReason:null ⇒ PROCEEDS to summarize (hook approved, not silently blocked)", async () => {
    const llm = new SummarizingLLM()
    let hookCalls = 0
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preCompactHook: async () => {
        hookCalls += 1
        return { abortReason: null }
      },
    })
    expect(hookCalls).toBe(1)
    expect(res.compacted).toBe(true) // NOT frozen — the summarizer was reached
    expect(llm.callCount).toBe(1)
  })

  test("hook query carries messagesToCompact + isFirstCompaction", async () => {
    const llm = new SummarizingLLM()
    const seen: Array<{ messagesToCompact: number; isFirstCompaction: boolean }> = []
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      isFirstCompaction: true,
      preCompactHook: async (q) => {
        seen.push(q)
        return { abortReason: null }
      },
    })
    expect(seen).toHaveLength(1)
    const q = seen[0]
    if (!q) throw new Error("hook not invoked")
    expect(q.isFirstCompaction).toBe(true)
    // The summarizable prefix is the two ~2k turns (keepRecentTurns:1 keeps the
    // trailing assistant), so messagesToCompact is a positive, real prefix len.
    expect(q.messagesToCompact).toBeGreaterThan(0)
  })

  test("COMPOSE: hook approves (null) AND preflight approves ⇒ BOTH consulted, hook FIRST, compaction proceeds", async () => {
    const llm = new SummarizingLLM()
    const order: string[] = []
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preCompactHook: async () => {
        order.push("hook")
        return { abortReason: null }
      },
      preflight: async () => {
        order.push("preflight")
        return "approve"
      },
    })
    // ADR-0133 orders the typed hook BEFORE the preflight (cheaper: no UI wake).
    expect(order).toEqual(["hook", "preflight"])
    expect(res.compacted).toBe(true)
    expect(llm.callCount).toBe(1)
  })

  test("COMPOSE red-on-injection: hook BLOCKS ⇒ preflight NEVER reached, summarizer NEVER called", async () => {
    // The block short-circuits BEFORE preflight — proves the compose ordering is
    // load-bearing, not two independent no-ops.
    const llm = new SummarizingLLM()
    let preflightCalls = 0
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preCompactHook: async () => ({ abortReason: "hook says wait" }),
      preflight: async () => {
        preflightCalls += 1
        return "approve"
      },
    })
    expect(res.compacted).toBe(false)
    if (res.compacted === false) expect(res.reason).toBe("deferred")
    expect(preflightCalls).toBe(0) // short-circuited before the UI wake
    expect(llm.callCount).toBe(0)
  })
})
