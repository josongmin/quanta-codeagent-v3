import { describe, expect, test } from "bun:test"
import { reactiveCompact } from "@/agent/compaction"
import { decideOnAssembled, decideOnStreamError, freshRecovery } from "@/agent/loop"
import { backoffDelayMs, classifyLLMError, isPromptTooLong } from "@/agent/retry"
import type { LLMPort, Message, StreamEvent } from "@/llm"
import { LLMError } from "@/shared"

const assistant = (...content: Message["content"]): Message => ({ role: "assistant", content })
const textMsg = (text: string): Message => assistant({ type: "text", text })
const toolMsg = (id: string): Message =>
  assistant({ type: "tool_use", id, name: "read", input: { path: "/x" } })
const empty = (): Message => assistant()

describe("classifyLLMError / PTL precedence", () => {
  test("PTL beats fatal even when message also reads as a 400", () => {
    const e = new LLMError("400 Bad Request: prompt is too long for this model")
    expect(isPromptTooLong(e)).toBe(true)
    expect(classifyLLMError(e)).toBe("prompt_too_long")
  })

  test("transient → retryable, auth → fatal, non-LLMError → fatal", () => {
    expect(classifyLLMError(new LLMError("HTTP 529 overloaded"))).toBe("retryable")
    expect(classifyLLMError(new LLMError("401 invalid api key"))).toBe("fatal")
    expect(classifyLLMError(new Error("socket hang up"))).toBe("fatal")
  })
})

describe("backoffDelayMs", () => {
  test("full-jitter, monotone ceiling, deterministic with injected random", () => {
    expect(backoffDelayMs(0, 500, () => 0)).toBe(0)
    expect(backoffDelayMs(3, 500, () => 1 - Number.EPSILON)).toBeLessThanOrEqual(4000)
    expect(backoffDelayMs(50, 500, () => 1 - Number.EPSILON)).toBeLessThanOrEqual(15_000)
  })
})

describe("decideOnStreamError", () => {
  test("retryable backs off until budget exhausted, then errors", () => {
    const rec = freshRecovery()
    const e = new LLMError("503 service unavailable")
    expect(decideOnStreamError(e, "503", rec)).toEqual({ do: "backoff", attempt: 0 })
    expect(decideOnStreamError(e, "503", rec)).toEqual({ do: "backoff", attempt: 1 })
    expect(decideOnStreamError(e, "503", rec)).toEqual({ do: "backoff", attempt: 2 })
    const final = decideOnStreamError(e, "503", rec)
    expect(final.do).toBe("error")
  })

  test("PTL → compact, fatal → error", () => {
    const rec = freshRecovery()
    expect(decideOnStreamError(new LLMError("prompt too long"), "ptl", rec)).toEqual({
      do: "compact",
    })
    expect(decideOnStreamError(new LLMError("404 not found"), "nf", rec)).toEqual({
      do: "error",
      reason: "nf",
    })
  })
})

describe("decideOnAssembled", () => {
  test("max_tokens → bounded nudge then proceed/complete", () => {
    const rec = freshRecovery()
    for (let i = 0; i < 3; i++) {
      const a = decideOnAssembled("max_tokens", textMsg("partial"), rec)
      expect(a.do).toBe("nudge")
    }
    // Budget spent: max_tokens with text now treated as a normal turn.
    expect(decideOnAssembled("max_tokens", textMsg("done"), rec).do).toBe("proceed")
  })

  test("malformed tool_use: one nudge, then completed", () => {
    const rec = freshRecovery()
    const a1 = decideOnAssembled("tool_use", textMsg("oops"), rec)
    expect(a1.do).toBe("nudge")
    expect(decideOnAssembled("tool_use", textMsg("oops"), rec).do).toBe("completed")
  })

  test("empty turn: capped nudges then completed", () => {
    const rec = freshRecovery()
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("nudge")
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("nudge")
    expect(decideOnAssembled("end_turn", empty(), rec).do).toBe("completed")
  })

  test("real tool call → proceed; plain text → proceed (loop decides completion)", () => {
    const rec = freshRecovery()
    expect(decideOnAssembled("tool_use", toolMsg("t1"), rec).do).toBe("proceed")
    expect(decideOnAssembled("end_turn", textMsg("answer"), rec).do).toBe("proceed")
  })
})

class FixedLLM implements LLMPort {
  constructor(private readonly summary: string) {}
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: this.summary }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("reactiveCompact", () => {
  test("summarizes prefix, keeps recent tail, no orphaned tool_result", async () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "task" }] },
      assistant({ type: "tool_use", id: "t1", name: "read", input: {} }),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] },
      textMsg("older"),
      { role: "user", content: [{ type: "text", text: "recent" }] },
      textMsg("recent answer"),
    ]
    const res = await reactiveCompact({
      messages: msgs,
      llm: new FixedLLM("<summary>resume here</summary>"),
      system: "sys",
      keepRecentTurns: 1,
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const first = res.messages[0]
    expect(first?.role).toBe("user")
    expect(first?.content[0]?.type === "text" && first.content[0].text).toContain(
      "continuation summary",
    )
    expect(res.messages.at(-1)).toEqual(textMsg("recent answer"))
    const useIds = new Set(
      res.messages.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_use").map((b) => (b.type === "tool_use" ? b.id : "")),
      ),
    )
    for (const m of res.messages) {
      for (const b of m.content) {
        if (b.type === "tool_result") expect(useIds.has(b.tool_use_id)).toBe(true)
      }
    }
  })

  test("nothing summarizable → ok:false with reason", async () => {
    const res = await reactiveCompact({
      messages: [textMsg("only one giant turn")],
      llm: new FixedLLM("x"),
      system: "sys",
      keepRecentTurns: 6,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("no summarizable prefix")
  })

  test("empty summary → ok:false", async () => {
    const res = await reactiveCompact({
      messages: [textMsg("a"), textMsg("b"), textMsg("c")],
      llm: new FixedLLM("   "),
      system: "sys",
      keepRecentTurns: 1,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain("empty")
  })
})
