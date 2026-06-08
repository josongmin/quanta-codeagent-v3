import { describe, expect, test } from "bun:test"
import {
  buildResponsesBody,
  messageToResponsesItems,
  normalizeResponsesOutputItem,
  normalizeResponsesReasoningEffort,
  normalizeResponsesReasoningVerbosity,
  strictExtensionTail,
  toResponsesToolChoice,
} from "@/llm/openai-responses-wire"
import type { Message, StreamInput } from "@/llm/types"
import { LLMError } from "@/shared"

const baseInput = (overrides: Partial<StreamInput> = {}): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  ...overrides,
})

describe("messageToResponsesItems", () => {
  test("preserves assistant text -> tool_use order", () => {
    const message: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "call_1", name: "bash", input: { cmd: "ls" } },
      ],
    }

    expect(messageToResponsesItems(message)).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Let me check." }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "bash",
        arguments: '{"cmd":"ls"}',
      },
    ])
  })

  test("preserves user text -> tool_result order", () => {
    const message: Message = {
      role: "user",
      content: [
        { type: "text", text: "Here is the output." },
        { type: "tool_result", tool_use_id: "call_1", content: "ok" },
      ],
    }

    expect(messageToResponsesItems(message)).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Here is the output." }],
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "ok",
      },
    ])
  })
})

describe("buildResponsesBody", () => {
  test("maps toolChoice onto Responses tool_choice", () => {
    const body = buildResponsesBody(
      baseInput({
        tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
        toolChoice: { kind: "tool", name: "bash" },
      }),
      "gpt-5",
    )

    expect(body.tool_choice).toEqual({ type: "function", name: "bash" })
  })
})

describe("toResponsesToolChoice", () => {
  test("invalid named tool throws loudly", () => {
    expect(() => toResponsesToolChoice({ kind: "tool", name: "missing" }, ["bash"])).toThrow(
      LLMError,
    )
  })
})

// ─── TICKET 23 — reasoning summary:"auto" + verbosity + effort xhigh ──────────

describe("normalizeResponsesReasoningEffort — xhigh forward-compat", () => {
  test("accepts the existing closed set (case-insensitive)", () => {
    expect(normalizeResponsesReasoningEffort("minimal")).toBe("minimal")
    expect(normalizeResponsesReasoningEffort("LOW")).toBe("low")
    expect(normalizeResponsesReasoningEffort("Medium")).toBe("medium")
    expect(normalizeResponsesReasoningEffort("high")).toBe("high")
  })
  test("accepts 'xhigh' (forward-compat) lowercased, incl. 'XHIGH'", () => {
    expect(normalizeResponsesReasoningEffort("xhigh")).toBe("xhigh")
    expect(normalizeResponsesReasoningEffort("XHIGH")).toBe("xhigh")
  })
  test("rejects out-of-set values ('ultra' / undefined) ⇒ undefined", () => {
    expect(normalizeResponsesReasoningEffort("ultra")).toBeUndefined()
    expect(normalizeResponsesReasoningEffort(undefined)).toBeUndefined()
    expect(normalizeResponsesReasoningEffort("")).toBeUndefined()
  })
})

describe("normalizeResponsesReasoningVerbosity", () => {
  test("accepts low|medium|high (case-insensitive, lowercased)", () => {
    expect(normalizeResponsesReasoningVerbosity("low")).toBe("low")
    expect(normalizeResponsesReasoningVerbosity("MEDIUM")).toBe("medium")
    expect(normalizeResponsesReasoningVerbosity("High")).toBe("high")
  })
  test("rejects out-of-set ('verbose' / undefined / '') ⇒ undefined", () => {
    expect(normalizeResponsesReasoningVerbosity("verbose")).toBeUndefined()
    expect(normalizeResponsesReasoningVerbosity(undefined)).toBeUndefined()
    expect(normalizeResponsesReasoningVerbosity("")).toBeUndefined()
  })
})

describe("buildResponsesBody — reasoning summary + verbosity wire shape", () => {
  test("summary:true ⇒ reasoning.summary === 'auto' (no effort) ", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", { reasoningSummary: true })
    expect(body.reasoning).toEqual({ summary: "auto" })
    // NEVER a flat verbosity key, never a text key when verbosity absent.
    expect(body.verbosity).toBeUndefined()
    expect(body.text).toBeUndefined()
  })

  test("effort + summary ⇒ reasoning carries BOTH", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningEffort: "high",
      reasoningSummary: true,
    })
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" })
  })

  test("xhigh effort threads through to reasoning.effort", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", { reasoningEffort: "xhigh" })
    expect(body.reasoning).toEqual({ effort: "xhigh" })
  })

  test("verbosity:'low' ⇒ text === { verbosity:'low' } AND NO flat verbosity key", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", { reasoningVerbosity: "low" })
    expect(body.text).toEqual({ verbosity: "low" })
    // CRITICAL drift guard — a FLAT verbosity key is silently ignored by the API.
    expect(body.verbosity).toBeUndefined()
    // verbosity is independent of reasoning — no reasoning key when effort/summary absent.
    expect(body.reasoning).toBeUndefined()
  })

  test("out-of-set verbosity ⇒ no text key (API default honored)", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", { reasoningVerbosity: "verbose" })
    expect(body.text).toBeUndefined()
  })

  test("all three together ⇒ reasoning{effort,summary} + text{verbosity}", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningEffort: "xhigh",
      reasoningSummary: true,
      reasoningVerbosity: "high",
    })
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" })
    expect(body.text).toEqual({ verbosity: "high" })
  })
})

describe("buildResponsesBody — DEFAULT-OFF byte-identity hellgate (TICKET 23)", () => {
  // RED-ON-INJECTION: if buildResponsesBody ever injected a default verbosity
  // (e.g. text:{verbosity:'medium'}) or a default summary, these go red.
  test("knobs absent ⇒ NO text key, NO reasoning key (effort also absent)", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", {})
    expect(body.text).toBeUndefined()
    expect(body.reasoning).toBeUndefined()
    expect(body.verbosity).toBeUndefined()
  })

  test("summary:false (+ verbosity absent) deep-equals the no-options body", () => {
    // exactOptionalPropertyTypes forbids passing `reasoningVerbosity: undefined`
    // explicitly (it is `?: string`, not `?: string | undefined`) — absent IS the
    // undefined case, so the byte-identity guarantee is the same.
    const withFalsey = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningSummary: false,
    })
    const legacy = buildResponsesBody(baseInput(), "gpt-5", {})
    expect(JSON.stringify(withFalsey)).toBe(JSON.stringify(legacy))
  })

  test("effort-only spread shape is UNCHANGED (no summary key leaks in)", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", { reasoningEffort: "medium" })
    // Exactly the legacy effort-only shape — no summary, no text.
    expect(body.reasoning).toEqual({ effort: "medium" })
    expect(body.text).toBeUndefined()
  })

  test("legacy full-body snapshot is byte-identical (no new keys when knobs off)", () => {
    const body = buildResponsesBody(
      baseInput({
        tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
      }),
      "gpt-5",
    )
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        model: "gpt-5",
        instructions: "You are a helpful assistant.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: true,
        tools: [
          { type: "function", name: "bash", description: "run", parameters: { type: "object" } },
        ],
        parallel_tool_calls: false,
        store: false,
      }),
    )
  })
})

describe("normalizeResponsesOutputItem", () => {
  test("canonicalizes assistant output text message", () => {
    expect(
      normalizeResponsesOutputItem({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [{ id: 1 }] }],
      }),
    ).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hello" }],
    })
  })

  test("unsupported output content fails closed", () => {
    expect(
      normalizeResponsesOutputItem({
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", text: "no" }],
      }),
    ).toBeNull()
  })
})

describe("strictExtensionTail", () => {
  test("returns only the new suffix on a strict extension", () => {
    const baseline = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    ]
    const current = [
      ...baseline,
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
    ]

    expect(strictExtensionTail(current, baseline)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
    ])
  })

  test("non-extension returns null", () => {
    const baseline = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]
    const current = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "changed" }] },
    ]
    expect(strictExtensionTail(current, baseline)).toBeNull()
  })
})
