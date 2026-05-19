import { describe, expect, test } from "bun:test"
import type { StreamEvent, StreamInput, SystemBlock } from "@/llm"
import type { ChatParam, RawChunk } from "@/llm/adapters/openai"
import { OpenAIAdapter } from "@/llm/adapters/openai"

/**
 * Drive the integrated `OpenAIAdapter.stream` against a fake OpenAI client.
 * The adapter builds `new OpenAI(...)` internally; we swap the private
 * `client` for a fake whose `chat.completions.create` returns a scripted
 * async-iterable of chunks and records the request it was handed. This keeps
 * the mock fully local (no global module mock) so sibling adapter tests are
 * unaffected.
 */

interface CapturedRequest {
  model: string
  max_tokens: number
  stream: boolean
  messages: ChatParam[]
  tools: { type: "function"; function: { name: string } }[]
}

class FakeOpenAI {
  readonly requests: CapturedRequest[] = []
  constructor(private readonly chunks: RawChunk[]) {}
  readonly chat = {
    completions: {
      create: async (req: CapturedRequest): Promise<AsyncIterable<RawChunk>> => {
        this.requests.push(req)
        const chunks = this.chunks
        return {
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield c
          },
        }
      },
    },
  }
}

/** Build an adapter whose internal client is `fake`. */
const adapterWith = (fake: FakeOpenAI): OpenAIAdapter => {
  const a = new OpenAIAdapter({ apiKey: "test", model: "gpt-x", maxTokens: 1234 })
  ;(a as unknown as { client: FakeOpenAI }).client = fake
  return a
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const baseInput = (over: Partial<StreamInput> = {}): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  ...over,
})

const textChunk = (delta: string): RawChunk => ({
  choices: [{ delta: { content: delta }, finish_reason: null }],
})
const stopChunk = (finish: string): RawChunk => ({
  choices: [{ delta: {}, finish_reason: finish }],
})

describe("OpenAIAdapter.stream — tool_call reconstruction across deltas", () => {
  test("name in first delta, arguments fragmented across later deltas → one tool_use", async () => {
    const fake = new FakeOpenAI([
      // id + name arrive first (no args yet)
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read" } }] },
            finish_reason: null,
          },
        ],
      },
      // arguments streamed in 3 fragments, same index
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"/' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: 'x"}' } }] },
            finish_reason: null,
          },
        ],
      },
      stopChunk("tool_calls"),
    ])
    const events = await collect(adapterWith(fake).stream(baseInput()))

    expect(events).toEqual([
      { type: "tool_use_start", id: "call_1", name: "read" },
      { type: "tool_use_delta", id: "call_1", delta: '{"pa' },
      { type: "tool_use_delta", id: "call_1", delta: 'th":"/' },
      { type: "tool_use_delta", id: "call_1", delta: 'x"}' },
      { type: "tool_use_end", id: "call_1", input: { path: "/x" } },
      { type: "message_stop", stop_reason: "tool_use" },
    ])
  })

  test("two tool calls on distinct indexes are finalized in index order", async () => {
    const fake = new FakeOpenAI([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "read", arguments: "{}" } },
                { index: 1, id: "b", function: { name: "list", arguments: '{"p":1}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      stopChunk("tool_calls"),
    ])
    const events = await collect(adapterWith(fake).stream(baseInput()))
    const ends = events.filter((e) => e.type === "tool_use_end")
    expect(ends).toEqual([
      { type: "tool_use_end", id: "a", input: {} },
      { type: "tool_use_end", id: "b", input: { p: 1 } },
    ])
  })
})

describe("OpenAIAdapter.stream — finish_reason mapping", () => {
  test("tool_calls → tool_use, stop → end_turn, length → max_tokens", async () => {
    for (const [finish, mapped] of [
      ["tool_calls", "tool_use"],
      ["stop", "end_turn"],
      ["length", "max_tokens"],
    ] as const) {
      const fake = new FakeOpenAI([textChunk("ok"), stopChunk(finish)])
      const events = await collect(adapterWith(fake).stream(baseInput()))
      const last = events.at(-1)
      expect(last).toEqual({ type: "message_stop", stop_reason: mapped })
    }
  })

  test("unknown finish_reason passes through verbatim; absent → end_turn", async () => {
    const unknown = new FakeOpenAI([textChunk("x"), stopChunk("content_filter")])
    expect((await collect(adapterWith(unknown).stream(baseInput()))).at(-1)).toEqual({
      type: "message_stop",
      stop_reason: "content_filter",
    })
    const none = new FakeOpenAI([textChunk("x")])
    expect((await collect(adapterWith(none).stream(baseInput()))).at(-1)).toEqual({
      type: "message_stop",
      stop_reason: "end_turn",
    })
  })
})

describe("OpenAIAdapter.stream — text deltas", () => {
  test("content deltas surface as text_delta events in order", async () => {
    const fake = new FakeOpenAI([textChunk("Hello "), textChunk("world"), stopChunk("stop")])
    const events = await collect(adapterWith(fake).stream(baseInput()))
    expect(events).toEqual([
      { type: "text_delta", delta: "Hello " },
      { type: "text_delta", delta: "world" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
  })
})

describe("OpenAIAdapter.stream — system flattening (inspect captured request)", () => {
  test("SystemBlock[] flattened to ONE system message, order preserved, cache ignored", async () => {
    const fake = new FakeOpenAI([textChunk("a"), stopChunk("stop")])
    const system: SystemBlock[] = [
      { type: "text", text: "ALPHA", cache: true },
      { type: "text", text: "BETA" },
      { type: "text", text: "GAMMA", cache: false },
    ]
    await collect(adapterWith(fake).stream(baseInput({ system })))
    const req = fake.requests[0]
    expect(req).toBeDefined()
    const systemMsgs = (req?.messages ?? []).filter((m) => m.role === "system")
    expect(systemMsgs).toHaveLength(1)
    // Deterministic join with block order preserved; `cache` flag absent from output.
    expect(systemMsgs[0]).toEqual({ role: "system", content: "ALPHA\n\nBETA\n\nGAMMA" })
  })

  test("empty/undefined system ⇒ NO system message in the outgoing payload", async () => {
    const fakeUndef = new FakeOpenAI([textChunk("a"), stopChunk("stop")])
    await collect(adapterWith(fakeUndef).stream(baseInput()))
    expect((fakeUndef.requests[0]?.messages ?? []).some((m) => m.role === "system")).toBe(false)

    const fakeEmpty = new FakeOpenAI([textChunk("a"), stopChunk("stop")])
    await collect(adapterWith(fakeEmpty).stream(baseInput({ system: "" })))
    expect((fakeEmpty.requests[0]?.messages ?? []).some((m) => m.role === "system")).toBe(false)

    const fakeEmptyBlocks = new FakeOpenAI([textChunk("a"), stopChunk("stop")])
    await collect(adapterWith(fakeEmptyBlocks).stream(baseInput({ system: [] })))
    expect((fakeEmptyBlocks.requests[0]?.messages ?? []).some((m) => m.role === "system")).toBe(
      false,
    )
  })
})
