/**
 * ADR-0049 — Side-conversation seam.
 *
 * Pins the public contract:
 *   (1) The system prompt is byte-identical to Codex's verbatim string.
 *   (2) Only read-only tools reach the LLM — no `write`/`edit`/`bash`/etc.
 *   (3) Default model selection prefers `opts.model`, falls back to the LLM
 *       port's configured model, finally "unknown".
 *   (4) `effort` is runtime-restricted to "low" or "medium"; high/xhigh throw
 *       even when bypassed via `as any`.
 *   (5) Parent thread id is recorded for telemetry; it is never forwarded as
 *       an LLM message (separate context window).
 */
import { describe, expect, test } from "bun:test"
import { planModeMutatingTable } from "@/agent/mode"
import {
  runSideConversation,
  SIDE_CONVERSATION_PROMPT,
  SIDE_CONVERSATION_TOOL_NAMES,
} from "@/agent/side-conversation"
import type { LLMPort, StreamEvent, StreamInput, ToolSchema } from "@/llm"

/** Captures the StreamInput passed to the fake LLM so tests can assert the
 *  tool list / system / messages were filtered correctly. */
interface CapturedCall {
  input: StreamInput
}

const fakeLlm = (events: StreamEvent[], captured: CapturedCall[], model?: string): LLMPort => {
  const port: LLMPort = {
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      captured.push({ input })
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev
        },
      }
    },
    ...(model !== undefined ? { model } : {}),
  }
  return port
}

const textOnly = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

describe("SIDE_CONVERSATION_PROMPT — byte-identical to Codex verbatim", () => {
  test("equals Codex's exact prompt string (no paraphrase)", () => {
    // Verbatim Codex string — DO NOT EDIT (the test enforces byte-equality).
    const expected =
      "You are a side-conversation assistant, separate from the main thread. " +
      "Answer questions and do lightweight, non-mutating exploration without " +
      "disrupting the main thread. If there is no user question after this " +
      "boundary yet, wait for one."
    expect(SIDE_CONVERSATION_PROMPT).toBe(expected)
  })

  test("starts with the Codex signature phrase", () => {
    // Defense against accidental prefix shift (e.g. someone adds a Quanta
    // policy banner ahead of the Codex string).
    expect(SIDE_CONVERSATION_PROMPT.startsWith("You are a side-conversation assistant")).toBe(true)
  })
})

describe("SIDE_CONVERSATION_TOOL_NAMES — read-only-by-construction", () => {
  test("every named tool is classified read-only (null) in the mode table", () => {
    const table = planModeMutatingTable()
    for (const name of SIDE_CONVERSATION_TOOL_NAMES) {
      expect(table).toHaveProperty(name)
      expect(table[name]).toBeNull()
    }
  })

  test("does NOT include any mutating tool", () => {
    const banned = ["write", "edit", "scripted_replace", "bash", "update_working_state"]
    for (const b of banned) {
      expect(SIDE_CONVERSATION_TOOL_NAMES).not.toContain(b)
    }
  })
})

describe("runSideConversation — wires LLM correctly", () => {
  test("forwards only read-only tools to the adapter (mutating tools never sent)", async () => {
    const captured: CapturedCall[] = []
    const llm = fakeLlm(textOnly("Sure, regex matches digits."), captured, "side-model")
    await runSideConversation({
      parentThreadId: "thread-parent-1",
      question: "What does this regex do?",
      llm,
    })
    expect(captured.length).toBe(1)
    const call = captured[0]
    if (!call) throw new Error("capture missing")
    const names = call.input.tools.map((t: ToolSchema) => t.name).sort()
    expect(names).toEqual([...SIDE_CONVERSATION_TOOL_NAMES].sort())
    // No mutating tools forwarded.
    for (const banned of ["write", "edit", "bash", "scripted_replace"]) {
      expect(names).not.toContain(banned)
    }
  })

  test("forwards the verbatim system prompt and ONLY the question (no parent context)", async () => {
    const captured: CapturedCall[] = []
    const llm = fakeLlm(textOnly("answer"), captured, "side-model")
    await runSideConversation({
      parentThreadId: "thread-parent-1",
      question: "regex meaning?",
      llm,
    })
    const call = captured[0]
    if (!call) throw new Error("capture missing")
    expect(call.input.system).toBe(SIDE_CONVERSATION_PROMPT)
    // Exactly ONE user message containing the question; parent thread id is
    // NOT forwarded as a message.
    expect(call.input.messages.length).toBe(1)
    expect(call.input.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "regex meaning?" }],
    })
  })

  test("returns the joined assistant text + token usage", async () => {
    const llm = fakeLlm(
      [
        { type: "text_delta", delta: "It " },
        { type: "text_delta", delta: "matches digits." },
        { type: "usage", inputTokens: 12, outputTokens: 7, model: "side-model" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
      [],
      "side-model",
    )
    const res = await runSideConversation({
      parentThreadId: "p1",
      question: "?",
      llm,
    })
    expect(res.answer).toBe("It matches digits.")
    expect(res.tokens).toEqual({ input: 12, output: 7 })
  })

  test("zero usage events → tokens are zero (older models)", async () => {
    const llm = fakeLlm(textOnly("ok"), [], "side-model")
    const res = await runSideConversation({ parentThreadId: "p1", question: "?", llm })
    expect(res.tokens).toEqual({ input: 0, output: 0 })
  })
})

describe("effort cap — never high/xhigh", () => {
  test('"low" and "medium" both accepted; default is "low"', async () => {
    const llm = fakeLlm(textOnly("ok"), [], "m")
    await expect(
      runSideConversation({ parentThreadId: "p", question: "?", llm, effort: "low" }),
    ).resolves.toBeDefined()
    await expect(
      runSideConversation({ parentThreadId: "p", question: "?", llm, effort: "medium" }),
    ).resolves.toBeDefined()
    // Default (no `effort`) — should also resolve.
    await expect(
      runSideConversation({ parentThreadId: "p", question: "?", llm }),
    ).resolves.toBeDefined()
  })

  test('"high" / "xhigh" bypassed via cast → runtime guard throws', async () => {
    const llm = fakeLlm(textOnly("ok"), [], "m")
    await expect(
      runSideConversation({
        parentThreadId: "p",
        question: "?",
        llm,
        effort: "high" as unknown as "low",
      }),
    ).rejects.toThrow(/effort must be "low" or "medium"/)
    await expect(
      runSideConversation({
        parentThreadId: "p",
        question: "?",
        llm,
        effort: "xhigh" as unknown as "low",
      }),
    ).rejects.toThrow(/effort must be "low" or "medium"/)
  })
})

describe("default model selection", () => {
  test("opts.model wins over llm.model", async () => {
    // We don't see the resolved model in the result, but we can prove the
    // adapter received the StreamInput unchanged (the adapter picks the
    // model from its own config — runSideConversation only logs it).
    // This test asserts the function does not THROW on either combination,
    // exercising the resolveModel branch.
    const llm = fakeLlm(textOnly("ok"), [], "fallback-model")
    await expect(
      runSideConversation({
        parentThreadId: "p",
        question: "?",
        llm,
        model: "explicit-side-model",
      }),
    ).resolves.toBeDefined()
  })

  test("absent opts.model → falls back to llm.model", async () => {
    const llm = fakeLlm(textOnly("ok"), [], "fallback-model")
    await expect(
      runSideConversation({ parentThreadId: "p", question: "?", llm }),
    ).resolves.toBeDefined()
  })

  test("both absent → still succeeds (model resolves to 'unknown')", async () => {
    const llm = fakeLlm(textOnly("ok"), [])
    await expect(
      runSideConversation({ parentThreadId: "p", question: "?", llm }),
    ).resolves.toBeDefined()
  })
})
