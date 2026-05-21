/**
 * ADR-0049 side-conversation seam unit tests.
 *
 * Covers (15 tests):
 *   1. byte-identical Codex base prompt
 *   2. delimiter present and stable between base and addendum
 *   3. SIDE_CONVERSATION_PROMPT == base + delimiter + addendum (no other content)
 *   4. tool allowlist subset of planModeMutatingTable read-only set
 *   5. tool allowlist EQUALS planModeMutatingTable read-only set (no silent drift)
 *   6. effort type — runtime guard rejects "high" via `as any`
 *   7. effort type — runtime guard rejects "xhigh" from JSON.parse
 *   8. effort type — runtime guard rejects null / undefined / object
 *   9. filterSideConversationTools rejects mutating tool
 *  10. filterSideConversationTools rejects unknown tool
 *  11. runSideConversation returns answer + tokens + duration
 *  12. runSideConversation emits OTel span with thread.side / kind / parent_id
 *  13. runSideConversation aborts when parent signal fires
 *  14. runSideConversation rejects over-budget input
 *  15. runSideConversation rejects over-budget output (post-stream)
 */

import { describe, expect, it } from "bun:test"
import {
  assertSideConversationEffort,
  DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET,
  filterSideConversationTools,
  runSideConversation,
  SIDE_CONVERSATION_PROMPT,
  SIDE_CONVERSATION_PROMPT_BASE,
  SIDE_CONVERSATION_PROMPT_DELIMITER,
  SIDE_CONVERSATION_QUANTA_ADDENDUM,
  SIDE_CONVERSATION_TOOL_NAMES,
  SideConversationAbortedError,
  SideConversationBudgetError,
  type SideConversationEffort,
  SideConversationEffortError,
  type SideConversationSpanAttributes,
  SideConversationToolError,
} from "@/agent"
import { planModeMutatingTable } from "@/agent/mode"
import type { LLMPort, StreamEvent, StreamInput, ToolSchema } from "@/llm"

// ---------------------------------------------------------------------------
// Local fixture: scripted LLM. Kept inline (no harness import) so the unit
// suite is self-contained.
// ---------------------------------------------------------------------------

class FakeLlm implements LLMPort {
  readonly inputs: StreamInput[] = []
  readonly model = "fake-side-conv"
  constructor(private readonly script: StreamEvent[]) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    for (const e of this.script) yield e
  }
}

const textAnswer = (
  text: string,
  opts?: { inputTokens?: number; outputTokens?: number },
): StreamEvent[] => {
  const ev: StreamEvent[] = [
    { type: "text_delta", delta: text },
    { type: "message_stop", stop_reason: "end_turn" },
  ]
  if (opts) {
    ev.splice(1, 0, {
      type: "usage",
      inputTokens: opts.inputTokens ?? 0,
      outputTokens: opts.outputTokens ?? 0,
      model: "fake-side-conv",
    })
  }
  return ev
}

// ---------------------------------------------------------------------------

describe("side-conversation prompt invariants", () => {
  it("1. byte-identical Codex base prompt — exact literal pin", () => {
    // Pinned literal — drift here is a Codex absorption violation.
    expect(SIDE_CONVERSATION_PROMPT_BASE).toBe(
      "You are a side-conversation assistant, separate from the main thread. " +
        "Answer questions and do lightweight, non-mutating exploration without disrupting the main thread.",
    )
  })

  it("2. delimiter present and stable between base and addendum", () => {
    expect(SIDE_CONVERSATION_PROMPT_DELIMITER).toBe("\n\n--- quanta side-conv addendum ---\n\n")
    // Effective prompt MUST contain the delimiter exactly once.
    const occurrences =
      SIDE_CONVERSATION_PROMPT.split(SIDE_CONVERSATION_PROMPT_DELIMITER).length - 1
    expect(occurrences).toBe(1)
  })

  it("3. SIDE_CONVERSATION_PROMPT == base + delimiter + addendum (no extra content)", () => {
    expect(SIDE_CONVERSATION_PROMPT).toBe(
      SIDE_CONVERSATION_PROMPT_BASE +
        SIDE_CONVERSATION_PROMPT_DELIMITER +
        SIDE_CONVERSATION_QUANTA_ADDENDUM,
    )
  })
})

describe("side-conversation tool allowlist invariants", () => {
  it("4. every allowlisted tool is read-only in planModeMutatingTable", () => {
    const table = planModeMutatingTable()
    for (const name of SIDE_CONVERSATION_TOOL_NAMES) {
      expect(name in table).toBe(true)
      expect(table[name]).toBe(null)
    }
  })

  it("5. allowlist EQUALS planModeMutatingTable read-only set — fails loudly on drift", () => {
    const table = planModeMutatingTable()
    const readOnly = Object.keys(table)
      .filter((k) => table[k] === null)
      .sort()
    const allowed = [...SIDE_CONVERSATION_TOOL_NAMES].sort()
    // If a new read-only tool is added to planModeMutatingTable without
    // updating SIDE_CONVERSATION_TOOL_NAMES, this assertion's diff names it.
    expect(allowed).toEqual(readOnly)
  })
})

describe("side-conversation effort runtime guard", () => {
  it('6. rejects "high" via `as any` bypass', () => {
    expect(() => assertSideConversationEffort("high" as unknown as SideConversationEffort)).toThrow(
      SideConversationEffortError,
    )
  })

  it('7. rejects "xhigh" from JSON.parse', () => {
    const parsed = JSON.parse('{"effort":"xhigh"}') as { effort: unknown }
    expect(() => assertSideConversationEffort(parsed.effort)).toThrow(SideConversationEffortError)
  })

  it("8. rejects null / undefined / object", () => {
    expect(() => assertSideConversationEffort(null)).toThrow(SideConversationEffortError)
    expect(() => assertSideConversationEffort(undefined)).toThrow(SideConversationEffortError)
    expect(() => assertSideConversationEffort({ effort: "low" })).toThrow(
      SideConversationEffortError,
    )
    // Sanity: allowed values pass.
    expect(() => assertSideConversationEffort("low")).not.toThrow()
    expect(() => assertSideConversationEffort("medium")).not.toThrow()
  })
})

describe("filterSideConversationTools", () => {
  it("9. rejects a mutating tool (write)", () => {
    const tools: ToolSchema[] = [{ name: "write", description: "x", input_schema: {} }]
    expect(() => filterSideConversationTools(tools)).toThrow(SideConversationToolError)
  })

  it("10. rejects an unknown tool", () => {
    const tools: ToolSchema[] = [{ name: "totally_made_up", description: "x", input_schema: {} }]
    expect(() => filterSideConversationTools(tools)).toThrow(SideConversationToolError)
  })
})

describe("runSideConversation behavior", () => {
  it("11. returns answer + tokens + duration", async () => {
    const llm = new FakeLlm(textAnswer("hello world", { inputTokens: 12, outputTokens: 34 }))
    const result = await runSideConversation({
      parentSessionId: "parent-1",
      question: "What is 2+2?",
      llm,
    })
    expect(result.answer).toBe("hello world")
    expect(result.tokens).toEqual({ input: 12, output: 34 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.stopReason).toBe("end_turn")
    // The LLM received the verbatim prompt + the question, no tool registry leak.
    expect(llm.inputs[0]?.system).toBe(SIDE_CONVERSATION_PROMPT)
  })

  it("12. emits OTel span with thread.side / kind / parent_id", async () => {
    const llm = new FakeLlm(textAnswer("ok", { inputTokens: 5, outputTokens: 6 }))
    let captured: SideConversationSpanAttributes | undefined
    await runSideConversation({
      parentSessionId: "parent-2",
      question: "ping?",
      llm,
      observe: (s) => {
        captured = s
      },
    })
    expect(captured).toBeDefined()
    expect(captured?.["quanta.thread.side"]).toBe(true)
    expect(captured?.["quanta.thread.kind"]).toBe("side")
    expect(captured?.["quanta.thread.parent_id"]).toBe("parent-2")
    expect(captured?.["gen_ai.usage.input_tokens"]).toBe(5)
    expect(captured?.["gen_ai.usage.output_tokens"]).toBe(6)
  })

  it("13. aborts when parent signal fires before streaming", async () => {
    const llm = new FakeLlm(textAnswer("never-seen"))
    const ac = new AbortController()
    ac.abort()
    await expect(
      runSideConversation({
        parentSessionId: "p",
        question: "q",
        llm,
        signal: ac.signal,
      }),
    ).rejects.toBeInstanceOf(SideConversationAbortedError)
    // LLM was never actually invoked.
    expect(llm.inputs.length).toBe(0)
  })

  it("14. rejects over-budget input (pre-stream)", async () => {
    const llm = new FakeLlm(textAnswer("ok"))
    // Construct a question larger than the default budget.
    const long = "x".repeat(DEFAULT_SIDE_CONVERSATION_INPUT_TOKEN_BUDGET * 4 + 100)
    await expect(
      runSideConversation({
        parentSessionId: "p",
        question: long,
        llm,
      }),
    ).rejects.toBeInstanceOf(SideConversationBudgetError)
    expect(llm.inputs.length).toBe(0)
  })

  it("15. rejects over-budget output (post-stream)", async () => {
    const llm = new FakeLlm(textAnswer("ok", { inputTokens: 1, outputTokens: 9999 }))
    await expect(
      runSideConversation({
        parentSessionId: "p",
        question: "small",
        llm,
        outputTokenBudget: 100,
      }),
    ).rejects.toBeInstanceOf(SideConversationBudgetError)
  })
})
