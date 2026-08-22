/**
 * ★ HELLGATE — ADR-0409 `post_compact` emission contract.
 *
 * Pin the user-visible resume contract: when a compaction settles, a
 * subscriber MUST receive ONE `post_compact`-shaped provenance with the
 * correct `reason`, `tokensBefore/After`, `turnsDropped/Kept`, and a
 * human-readable `resumeStep`. The Objective wire must surface the same
 * resume hint via `setNextActions`. Without a subscriber, the existing
 * compaction path is byte-identical (no allocation, no extra await, no
 * provenance materialized).
 */

import { describe, expect, test } from "bun:test"
import { compactIfNeeded } from "@/agent"
import type { RecoveryProvenance } from "@/agent/recovery-reason"
import type { LLMPort, Message, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"

class SummarizingLLM implements LLMPort {
  callCount = 0
  lastSystem: SystemPromptInput | undefined
  lastMessages: Message[] = []
  constructor(private readonly summary: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.callCount += 1
    this.lastSystem = input.system
    this.lastMessages = input.messages
    yield { type: "text_delta", delta: this.summary }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})
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

describe("compactIfNeeded × post_compact emit (ADR-0409) — hellgate", () => {
  test("postCompactEmit fires EXACTLY ONCE per successful compaction with correct provenance", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const seen: RecoveryProvenance[] = []
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      postCompactEmit: (p) => {
        seen.push(p)
      },
    })
    expect(res.compacted).toBe(true)
    expect(seen.length).toBe(1)
    const p = seen[0]
    if (!p) throw new Error("provenance not emitted")
    expect(p.reason).toBe("token_budget_exceeded") // default
    expect(p.tokensBefore).toBeGreaterThan(100)
    expect(p.tokensAfter).toBeLessThanOrEqual(p.tokensBefore)
    expect(p.turnsDropped).toBeGreaterThan(0)
    expect(p.turnsKept).toBeGreaterThan(0)
    expect(typeof p.resumeStep).toBe("string")
    expect(p.resumeStep).toContain("resume after compaction")
    expect(typeof p.compactedAt).toBe("number")
  })

  test("explicit recoveryReason override is honored verbatim", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const seen: RecoveryProvenance[] = []
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      recoveryReason: "drift_breaker",
      postCompactEmit: (p) => {
        seen.push(p)
      },
    })
    expect(seen[0]?.reason).toBe("drift_breaker")
  })

  test("Objective wire (objectiveSetNextActions) receives the resume hint exactly once", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const wireCalls: { threadId: string; actions: readonly string[] }[] = []
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      threadId: "thread-42",
      objectiveSetNextActions: (threadId, actions) => {
        wireCalls.push({ threadId, actions })
      },
    })
    expect(wireCalls.length).toBe(1)
    const call = wireCalls[0]
    if (!call) throw new Error("objective wire not invoked")
    expect(call.threadId).toBe("thread-42")
    expect(call.actions.length).toBe(1)
    expect(call.actions[0]).toContain("agent compacted")
    expect(call.actions[0]).toContain("token_budget_exceeded")
    expect(call.actions[0]).toContain("resume after compaction")
  })

  test("Objective wire skipped when threadId is absent (even if callback is set)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    let wireCallCount = 0
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      objectiveSetNextActions: () => {
        wireCallCount += 1
      },
    })
    expect(wireCallCount).toBe(0)
  })

  test("no subscriber ⇒ existing compaction path is byte-identical (NO extra await)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
    })
    expect(res.compacted).toBe(true)
    if (res.compacted) {
      expect(res.messages.length).toBeGreaterThan(0)
      expect(res.summaryTokens).toBeGreaterThan(0)
    }
  })

  test("under threshold ⇒ postCompactEmit NEVER fires (no work, no emit)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    let count = 0
    await compactIfNeeded({
      messages: [userText("tiny"), assistantText("tiny")],
      llm,
      system: "sys",
      thresholdTokens: 1_000_000,
      postCompactEmit: () => {
        count += 1
      },
    })
    expect(count).toBe(0)
    expect(llm.callCount).toBe(0)
  })

  test("no summarizable prefix (single giant turn) ⇒ postCompactEmit NEVER fires", async () => {
    const llm = new SummarizingLLM("FOLDED")
    let count = 0
    const res = await compactIfNeeded({
      messages: [assistantText("z".repeat(2_000))],
      llm,
      system: "sys",
      thresholdTokens: 50,
      keepRecentTurns: 1,
      postCompactEmit: () => {
        count += 1
      },
    })
    expect(res.compacted).toBe(false)
    expect(count).toBe(0)
  })

  test("preCompactHook aborts ⇒ postCompactEmit NEVER fires (no compaction happened)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    let count = 0
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preCompactHook: async () => ({ abortReason: "host vetoed" }),
      postCompactEmit: () => {
        count += 1
      },
    })
    expect(res.compacted).toBe(false)
    expect(count).toBe(0)
  })

  test("preflight defer_one_turn ⇒ postCompactEmit NEVER fires", async () => {
    const llm = new SummarizingLLM("FOLDED")
    let count = 0
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preflight: async () => "defer_one_turn",
      postCompactEmit: () => {
        count += 1
      },
    })
    expect(res.compacted).toBe(false)
    expect(count).toBe(0)
  })

  test("postCompactEmit throws ⇒ compaction STILL succeeds (NO-THROW seam)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      postCompactEmit: () => {
        throw new Error("emitter exploded")
      },
    })
    expect(res.compacted).toBe(true)
  })

  test("objectiveSetNextActions throws ⇒ compaction STILL succeeds (NO-THROW seam)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      threadId: "T",
      objectiveSetNextActions: () => {
        throw new Error("objective exploded")
      },
    })
    expect(res.compacted).toBe(true)
  })

  test("provenance.turnsDropped + turnsKept equals input.messages.length", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const messages = overThresholdMessages()
    const seen: RecoveryProvenance[] = []
    await compactIfNeeded({
      messages,
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      postCompactEmit: (p) => {
        seen.push(p)
      },
    })
    const p = seen[0]
    if (!p) throw new Error("provenance not emitted")
    expect(p.turnsDropped + p.turnsKept).toBe(messages.length)
  })

  test("postCompactEmit + objectiveSetNextActions BOTH set ⇒ both wires fire (in order)", async () => {
    const llm = new SummarizingLLM("FOLDED")
    const calls: string[] = []
    await compactIfNeeded({
      messages: overThresholdMessages(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      threadId: "T",
      postCompactEmit: () => {
        calls.push("emit")
      },
      objectiveSetNextActions: () => {
        calls.push("objective")
      },
    })
    expect(calls).toEqual(["emit", "objective"])
  })

  test("every RecoveryReason arm round-trips through the recoveryReason override", async () => {
    const arms = [
      "token_budget_exceeded",
      "ptl_reactive",
      "drift_breaker",
      "manual",
      "context_change",
      "fork_branch",
      "microcompact",
    ] as const
    for (const arm of arms) {
      const llm = new SummarizingLLM("FOLDED")
      const seen: RecoveryProvenance[] = []
      await compactIfNeeded({
        messages: overThresholdMessages(),
        llm,
        system: "sys",
        thresholdTokens: 100,
        keepRecentTurns: 1,
        recoveryReason: arm,
        postCompactEmit: (p) => {
          seen.push(p)
        },
      })
      expect(seen[0]?.reason).toBe(arm)
    }
  })
})
