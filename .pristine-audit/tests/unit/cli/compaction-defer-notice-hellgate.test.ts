/**
 * WS-G item 5 (UUX-5-16) — compaction defer was SILENT: `compactIfNeeded`
 * returns `{compacted:false, reason:"deferred"}` (host preflight said
 * defer_one_turn, or a pre_compact hook aborted) and NOTHING told the operator
 * that history was NOT folded — over threshold, every turn, invisibly.
 *
 * Fix: both `deferred` return branches emit one INFO notice on the
 * operator-notice bus (the CLI sink renders it dim). Controls pin that the
 * benign non-defer outcomes (`under_threshold`, approve-path compaction)
 * emit NOTHING — the notice must mean "a fold you were due was skipped".
 */

import { afterEach, describe, expect, test } from "bun:test"
import { compactIfNeeded } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"

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

const notices: OperatorNotice[] = []

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
  notices.length = 0
})

describe("compaction defer notice (UUX-5-16)", () => {
  test("preflight defer_one_turn ⇒ one info notice", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM(),
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preflight: async () => "defer_one_turn",
    })
    expect(res.compacted).toBe(false)
    const defers = notices.filter((n) => n.source === "compaction")
    expect(defers).toHaveLength(1)
    expect(defers[0]?.severity).toBe("info")
    expect(defers[0]?.message).toContain("deferred")
  })

  test("pre_compact hook abort ⇒ one info notice", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const res = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM(),
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preCompactHook: async () => ({ abortReason: "hook said wait" }),
    })
    expect(res.compacted).toBe(false)
    const defers = notices.filter((n) => n.source === "compaction")
    expect(defers).toHaveLength(1)
    expect(defers[0]?.severity).toBe("info")
  })

  test("paired control: under-threshold and approved compaction emit NOTHING", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const under = await compactIfNeeded({
      messages: [userText("tiny"), assistantText("tiny")],
      llm: new SummarizingLLM(),
      system: "sys",
      thresholdTokens: 1_000_000,
    })
    expect(under.compacted).toBe(false)
    const approved = await compactIfNeeded({
      messages: overThresholdMessages(),
      llm: new SummarizingLLM(),
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 1,
      preflight: async () => "approve",
    })
    expect(approved.compacted).toBe(true)
    expect(notices).toHaveLength(0)
  })
})
