import { describe, expect, test } from "bun:test"
import {
  buildResponsesBody,
  normalizeResponsesReasoningItem,
  parseResponsesEvents,
  type ResponsesInputItem,
  type ResponsesOutputItemDone,
} from "@/llm/openai-responses-wire"
import type { StreamEvent, StreamInput } from "@/llm/types"

/**
 * Hellgate — H15 reasoning carry-over (OpenAI-Responses / o-series ONLY).
 *
 * Adversarial proofs that:
 *  - A reasoning output item carrying `encrypted_content` is CAPTURED (not
 *    dropped) when carry-over is ON.
 *  - The next turn's Responses INPUT re-emits captured reasoning items at its
 *    head with `store:false` + `include:["reasoning.encrypted_content"]`.
 *  - Knob OFF ⇒ reasoning DROPPED + input is BYTE-IDENTICAL (no include, no
 *    reasoning items, no `reasoningItem` key on the done payload).
 *  - Missing / empty `encrypted_content` ⇒ safe-skip (null, no crash).
 *  - Multiple reasoning items preserve order.
 *  - The capture key is never added on non-reasoning items.
 */

async function* frames(datas: string[]): AsyncIterable<{ data: string }> {
  for (const data of datas) yield { data }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const baseInput = (overrides: Partial<StreamInput> = {}): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  ...overrides,
})

const reasoningOutputItemDoneFrame = (item: Record<string, unknown>): string =>
  JSON.stringify({ type: "response.output_item.done", item })

describe("H15 normalizeResponsesReasoningItem", () => {
  test("captures encrypted_content + id + summary into a re-emittable input item", () => {
    const out = normalizeResponsesReasoningItem({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "OPAQUE_CIPHERTEXT",
      summary: [{ type: "summary_text", text: "thinking…" }],
    })
    expect(out).toEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "OPAQUE_CIPHERTEXT",
      summary: [{ type: "summary_text", text: "thinking…" }],
    })
  })

  test("missing encrypted_content ⇒ null (safe-skip, no crash)", () => {
    expect(normalizeResponsesReasoningItem({ type: "reasoning", id: "rs_1" })).toBeNull()
  })

  test("empty encrypted_content ⇒ null", () => {
    expect(normalizeResponsesReasoningItem({ type: "reasoning", encrypted_content: "" })).toBeNull()
  })

  test("non-string encrypted_content ⇒ null", () => {
    expect(normalizeResponsesReasoningItem({ type: "reasoning", encrypted_content: 42 })).toBeNull()
  })

  test("non-reasoning item ⇒ null", () => {
    expect(normalizeResponsesReasoningItem({ type: "message", encrypted_content: "x" })).toBeNull()
  })

  test("non-array summary is dropped, id omitted when empty", () => {
    expect(
      normalizeResponsesReasoningItem({
        type: "reasoning",
        id: "",
        encrypted_content: "C",
        summary: "not-an-array",
      }),
    ).toEqual({ type: "reasoning", encrypted_content: "C" })
  })
})

describe("H15 parseResponsesEvents capture (gated)", () => {
  test("ON: reasoning item with encrypted_content surfaced on reasoningItem", async () => {
    const done: ResponsesOutputItemDone[] = []
    await collect(
      parseResponsesEvents(
        frames([
          reasoningOutputItemDoneFrame({
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "CIPHER1",
          }),
          JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }),
        ]),
        {
          provider: "openai",
          fallbackModel: "gpt-5",
          reasoningCarryover: true,
          onOutputItemDone: (item) => done.push(item),
        },
      ),
    )
    const reasoning = done.find((d) => d.rawType === "reasoning")
    expect(reasoning?.reasoningItem).toEqual({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "CIPHER1",
    })
  })

  test("OFF: reasoning item is DROPPED — no reasoningItem key (byte-identical payload)", async () => {
    const done: ResponsesOutputItemDone[] = []
    await collect(
      parseResponsesEvents(
        frames([
          reasoningOutputItemDoneFrame({
            type: "reasoning",
            id: "rs_1",
            encrypted_content: "CIPHER1",
          }),
          JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }),
        ]),
        {
          provider: "openai",
          fallbackModel: "gpt-5",
          // reasoningCarryover omitted ⇒ OFF
          onOutputItemDone: (item) => done.push(item),
        },
      ),
    )
    const reasoning = done.find((d) => d.rawType === "reasoning")
    expect(reasoning).toBeDefined()
    expect(reasoning?.reasoningItem).toBeUndefined()
    // The done payload is the legacy 2-field shape (no extra key).
    expect(Object.keys(reasoning ?? {}).sort()).toEqual(["normalized", "rawType"])
  })

  test("ON but no encrypted_content ⇒ safe-skip (no reasoningItem)", async () => {
    const done: ResponsesOutputItemDone[] = []
    await collect(
      parseResponsesEvents(
        frames([
          reasoningOutputItemDoneFrame({ type: "reasoning", id: "rs_1" }),
          JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }),
        ]),
        {
          provider: "openai",
          fallbackModel: "gpt-5",
          reasoningCarryover: true,
          onOutputItemDone: (item) => done.push(item),
        },
      ),
    )
    const reasoning = done.find((d) => d.rawType === "reasoning")
    expect(reasoning?.reasoningItem).toBeUndefined()
  })

  test("ON: non-reasoning (function_call) item never carries reasoningItem", async () => {
    const done: ResponsesOutputItemDone[] = []
    await collect(
      parseResponsesEvents(
        frames([
          JSON.stringify({
            type: "response.output_item.done",
            item: { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
          }),
          JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }),
        ]),
        {
          provider: "openai",
          fallbackModel: "gpt-5",
          reasoningCarryover: true,
          onOutputItemDone: (item) => done.push(item),
        },
      ),
    )
    const fc = done.find((d) => d.rawType === "function_call")
    expect(fc?.reasoningItem).toBeUndefined()
  })
})

describe("H15 buildResponsesBody re-emit (gated)", () => {
  const priorReasoning: ResponsesInputItem[] = [
    { type: "reasoning", id: "rs_1", encrypted_content: "CIPHER1" },
    { type: "reasoning", id: "rs_2", encrypted_content: "CIPHER2" },
  ]

  test("ON: prior reasoning prepended to input + include + store:false", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningCarryover: true,
      priorReasoningItems: priorReasoning,
    })
    const input = body.input as ResponsesInputItem[]
    // Reasoning items LEAD the input, in order.
    expect(input[0]).toEqual({ type: "reasoning", id: "rs_1", encrypted_content: "CIPHER1" })
    expect(input[1]).toEqual({ type: "reasoning", id: "rs_2", encrypted_content: "CIPHER2" })
    expect(input[2]).toMatchObject({ type: "message", role: "user" })
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.store).toBe(false)
  })

  test("OFF: byte-identical to no-options body (no include, no reasoning items)", () => {
    const off = buildResponsesBody(baseInput(), "gpt-5", {
      // gate off, but prior items supplied — must be ignored
      priorReasoningItems: priorReasoning,
    })
    const legacy = buildResponsesBody(baseInput(), "gpt-5")
    expect(JSON.stringify(off)).toBe(JSON.stringify(legacy))
    expect(off.include).toBeUndefined()
  })

  test("ON but EMPTY prior items ⇒ byte-identical (gate alone adds nothing)", () => {
    const on = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningCarryover: true,
      priorReasoningItems: [],
    })
    const legacy = buildResponsesBody(baseInput(), "gpt-5")
    expect(JSON.stringify(on)).toBe(JSON.stringify(legacy))
    expect(on.include).toBeUndefined()
  })

  test("multiple reasoning items preserve order", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningCarryover: true,
      priorReasoningItems: [
        { type: "reasoning", id: "a", encrypted_content: "A" },
        { type: "reasoning", id: "b", encrypted_content: "B" },
        { type: "reasoning", id: "c", encrypted_content: "C" },
      ],
    })
    const input = body.input as ResponsesInputItem[]
    expect(input.slice(0, 3).map((i) => i.id)).toEqual(["a", "b", "c"])
  })
})
