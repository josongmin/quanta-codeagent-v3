import { describe, expect, test } from "bun:test"
import {
  buildResponsesBody,
  messageToResponsesItems,
  normalizeResponsesOutputItem,
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
    expect(() =>
      toResponsesToolChoice({ kind: "tool", name: "missing" }, ["bash"]),
    ).toThrow(LLMError)
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
    const baseline = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]
    const current = [{ type: "message", role: "user", content: [{ type: "input_text", text: "changed" }] }]
    expect(strictExtensionTail(current, baseline)).toBeNull()
  })
})
