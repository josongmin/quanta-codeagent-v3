import { describe, expect, test } from "bun:test"
import { compactIfNeeded, estimateTokens, findBoundary } from "@/agent"
import { dropOldestSalvage, reactiveCompact } from "@/agent/compaction"
import type { LLMPort, Message, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"

/** FakeLLM that records its StreamInput and yields a fixed summary text. */
class SummarizingLLM implements LLMPort {
  lastSystem: SystemPromptInput | undefined
  lastMessages: Message[] = []
  constructor(private readonly summary: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
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
const assistantToolUse = (id: string, text: string): Message => ({
  role: "assistant",
  content: [
    { type: "text", text },
    { type: "tool_use", id, name: "read", input: { path: "/x" } },
  ],
})
const toolResult = (id: string, content: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
})

describe("estimateTokens", () => {
  test("chars/4 heuristic", () => {
    expect(estimateTokens([userText("a".repeat(40))])).toBe(10)
  })
})

describe("findBoundary", () => {
  test("keeps last N assistant turns", () => {
    const msgs = [userText("seed"), assistantText("a1"), assistantText("a2"), assistantText("a3")]
    // keep 1 → boundary at index of last assistant (3)
    expect(findBoundary(msgs, 1)).toBe(3)
  })

  test("expands backward so a retained tool_result keeps its tool_use", () => {
    const msgs = [
      userText("seed"),
      assistantToolUse("t1", "calling"),
      toolResult("t1", "result data"),
      assistantText("done"),
    ]
    // keep 1 → scanning back: assistantText(#1), toolResult, assistantToolUse
    // (#2 → break) leaves naive boundary at the toolResult (idx 2). Its
    // tool_use t1 lives at idx 1 (prefix) → orphaned, so the boundary walks
    // back to idx 1 to keep the (tool_use, tool_result) pair together.
    expect(findBoundary(msgs, 1)).toBe(1)
    const b1 = findBoundary(msgs, 1)
    const suffix = msgs.slice(b1)
    const useIds = new Set(
      suffix.flatMap((m) =>
        m.content
          .filter((x) => x.type === "tool_use")
          .map((x) => (x.type === "tool_use" ? x.id : "")),
      ),
    )
    for (const m of suffix) {
      for (const x of m.content) {
        if (x.type === "tool_result") expect(useIds.has(x.tool_use_id)).toBe(true)
      }
    }

    // No tool calls → boundary is the plain keepTurns cut, no expansion.
    const plain = [userText("s"), assistantText("a1"), assistantText("a2")]
    expect(findBoundary(plain, 1)).toBe(2)
  })

  test("keepTurns=0 with an assistant tail does not crash (empty-suffix guard)", () => {
    // Regression: the initial scan can leave the boundary at messages.length
    // (empty suffix) when the (keepTurns+1)-th assistant is the LAST message —
    // the break fires before `idx = i`, so idx stays at the sentinel length.
    // The orphan-walk then dereferenced messages[length] (undefined) and threw
    // a TypeError. The walk must treat an empty suffix as already orphan-free.
    const msgs = [assistantText("a1"), assistantText("a2")]
    expect(() => findBoundary(msgs, 0)).not.toThrow()
    expect(findBoundary(msgs, 0)).toBe(msgs.length)
  })

  test("keepTurns=0 over a tool pair stays orphan-free and never out of bounds", () => {
    // TEETH (aug-22 test-quality audit): this test used to run ZERO assertions.
    // With an ASSISTANT tail the contract is an EMPTY suffix (`findBoundary`
    // returns `messages.length`, pinned by the test above), so every `expect`
    // lived inside a double loop over `[]`. Case (a) now asserts that emptiness
    // explicitly, and case (b) adds the tool_result-tail shape where the suffix
    // is NON-empty and the orphan walk actually executes.

    // (a) assistant tail ⇒ nothing retained. An empty suffix is trivially
    //     orphan-free; the CLAIM under test here is only "no out-of-bounds".
    const msgs = [
      assistantToolUse("t1", "calling"),
      toolResult("t1", "result"),
      assistantText("done"),
    ]
    const b = findBoundary(msgs, 0)
    expect(b).toBe(msgs.length)
    expect(msgs.slice(b)).toEqual([]) // the contract, asserted — not assumed

    // (b) tool_result TAIL ⇒ the initial cut retains the tool_result ALONE
    //     (its tool_use sits in the prefix), so the backward orphan walk must
    //     fire and pull the tool_use back in. This is the non-vacuous half:
    //     the suffix is non-empty and every retained tool_result is checked.
    const pair = [assistantToolUse("t2", "calling"), toolResult("t2", "result")]
    const b2 = findBoundary(pair, 0)
    const suffix = pair.slice(b2)
    expect(suffix.length).toBeGreaterThan(0) // pin: the loops below are NOT vacuous
    expect(b2).toBe(0) // walked back from 1 → 0 to keep the pair together
    const useIds = new Set(
      suffix.flatMap((m) =>
        m.content
          .filter((x) => x.type === "tool_use")
          .map((x) => (x.type === "tool_use" ? x.id : "")),
      ),
    )
    let resultsChecked = 0
    for (const m of suffix) {
      for (const x of m.content) {
        if (x.type === "tool_result") {
          resultsChecked += 1
          expect(useIds.has(x.tool_use_id)).toBe(true)
        }
      }
    }
    expect(resultsChecked).toBe(1) // exactly the one retained tool_result was checked
  })
})

describe("compactIfNeeded", () => {
  test("under threshold → unchanged, compacted:false", async () => {
    const msgs = [userText("hi"), assistantText("hello")]
    const llm = new SummarizingLLM("SUMMARY")
    const res = await compactIfNeeded({
      messages: msgs,
      llm,
      system: "sys",
      thresholdTokens: 100_000,
    })
    expect(res.compacted).toBe(false)
    expect(res.messages).toBe(msgs)
    expect(llm.lastMessages).toEqual([])
  })

  test("over threshold → old prefix replaced by one summary, recent preserved, no orphan", async () => {
    const msgs: Message[] = [
      userText("a".repeat(2000)),
      assistantToolUse("t1", "old1"),
      toolResult("t1", "b".repeat(2000)),
      assistantText("old2"),
      userText("recent ask"),
      assistantText("recent answer"),
    ]
    const llm = new SummarizingLLM("CONDENSED HISTORY")
    const res = await compactIfNeeded({
      messages: msgs,
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
    })
    expect(res.compacted).toBe(true)
    if (!res.compacted) return
    // First message is the synthetic summary user message.
    const first = res.messages[0]
    expect(first?.role).toBe("user")
    const firstText = first?.content[0]
    expect(firstText?.type).toBe("text")
    if (firstText?.type === "text") {
      expect(firstText.text).toContain("<conversation summary>")
      expect(firstText.text).toContain("CONDENSED HISTORY")
    }
    // Recent suffix preserved verbatim.
    expect(res.messages.at(-1)).toEqual(assistantText("recent answer"))
    // No orphaned tool_result: every tool_result has its tool_use in the suffix.
    const useIds = new Set(
      res.messages.flatMap((m) =>
        m.content
          .filter((b) => b.type === "tool_use")
          .map((b) => (b.type === "tool_use" ? b.id : "")),
      ),
    )
    for (const m of res.messages) {
      for (const b of m.content) {
        if (b.type === "tool_result") expect(useIds.has(b.tool_use_id)).toBe(true)
      }
    }
    // Summarizer received the original system prompt context.
    expect(llm.lastSystem).toBeDefined()
    expect(res.summaryTokens).toBeGreaterThan(0)
  })
})

/** ALBB-20 #13 — records the StreamInput.signal so the test can assert the
 *  caller's cancellation signal is threaded into the summarizer llm.stream(). */
class SignalRecordingLLM implements LLMPort {
  seenSignal: AbortSignal | undefined
  signalPresent = false
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.signalPresent = "signal" in input
    this.seenSignal = input.signal
    if (input.signal?.aborted === true) throw new Error("aborted-during-summary")
    yield { type: "text_delta", delta: "<summary>ok</summary>" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const bigTranscript = (): Message[] => [
  userText("a".repeat(2000)),
  assistantToolUse("t1", "old1"),
  toolResult("t1", "b".repeat(2000)),
  assistantText("old2"),
  userText("recent ask"),
  assistantText("recent answer"),
]

describe("reactiveCompact #13 interruptible summarizer", () => {
  test("threads the caller signal into llm.stream()", async () => {
    const llm = new SignalRecordingLLM()
    const ctrl = new AbortController()
    await reactiveCompact({
      messages: bigTranscript(),
      llm,
      system: "sys",
      keepRecentTurns: 1,
      signal: ctrl.signal,
    })
    expect(llm.signalPresent).toBe(true)
    expect(llm.seenSignal).toBe(ctrl.signal)
  })

  test("absent signal ⇒ byte-identical (no signal field forwarded)", async () => {
    const llm = new SignalRecordingLLM()
    await reactiveCompact({ messages: bigTranscript(), llm, system: "sys", keepRecentTurns: 1 })
    expect(llm.signalPresent).toBe(false)
    expect(llm.seenSignal).toBeUndefined()
  })

  test("an already-aborted signal reaches the summarizer stream (interruptible)", async () => {
    const llm = new SignalRecordingLLM()
    const ctrl = new AbortController()
    ctrl.abort()
    // With the signal threaded, the (adapter-mimicking) stream observes the
    // aborted signal and throws — the summarizer is interruptible rather than
    // running to completion ignoring the abort. Before the fix the signal never
    // reached the stream, so it would summarize to completion.
    await expect(
      reactiveCompact({
        messages: bigTranscript(),
        llm,
        system: "sys",
        keepRecentTurns: 1,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow("aborted-during-summary")
    expect(llm.seenSignal).toBe(ctrl.signal)
  })

  test("dropOldestSalvage forwards the signal into its single reactive summarizer call", async () => {
    const llm = new SignalRecordingLLM()
    const ctrl = new AbortController()
    await dropOldestSalvage({
      messages: bigTranscript(),
      llm,
      system: "sys",
      keepRecentTurns: 1,
      signal: ctrl.signal,
    })
    expect(llm.seenSignal).toBe(ctrl.signal)
  })
})
