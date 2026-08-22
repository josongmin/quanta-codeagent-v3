import { describe, expect, test } from "bun:test"
import type { ResponsesInputItem } from "@/llm/openai-responses-wire"
import {
  defaultResponsesReasoningCarryoverStore,
  prepareResponsesContinuationRequest,
  type ResponsesFetchLike,
  type ResponsesReasoningCarryoverStore,
  streamResponsesSurface,
} from "@/llm/responses-stream"
import type { StreamEvent, StreamInput } from "@/llm/types"

/**
 * Hellgate (e2e) — H15 reasoning carry-over over a simulated 2-turn Responses
 * exchange via a FAKE transport.
 *
 *  turn-1 output carries an encrypted reasoning item ⇒ captured + persisted to
 *  the carry-over store. turn-2 input (built via
 *  `prepareResponsesContinuationRequest`) re-emits the captured reasoning item
 *  at its head (ON). OFF ⇒ turn-2 input contains NO reasoning items and is
 *  byte-identical to the legacy shape (no `include`).
 *
 * Provider scoping: this exercises the OpenAI-Responses surface ONLY (the
 * ChatGPT-OAuth subscription path). The Anthropic adapter and chat-completions
 * path never touch `prepareResponsesContinuationRequest` / `streamResponsesSurface`.
 */

const sse = (events: Record<string, unknown>[]): string =>
  `${events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n")}\n\n`

const sseResponse = (body: string): Response =>
  new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const turn1Stream = (): string =>
  sse([
    { type: "response.output_text.delta", delta: "answer" },
    {
      type: "response.output_item.done",
      item: { type: "reasoning", id: "rs_turn1", encrypted_content: "CIPHER_T1" },
    },
    {
      type: "response.completed",
      response: { id: "resp_turn1", model: "gpt-5", usage: { input_tokens: 10, output_tokens: 5 } },
    },
  ])

const input = (overrides: Partial<StreamInput> = {}): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "step 1" }] }],
  tools: [],
  promptCacheKey: "route-xyz",
  ...overrides,
})

const runTurn1 = async (args: {
  readonly reasoningCarryover: boolean
  readonly store?: ResponsesReasoningCarryoverStore
}): Promise<void> => {
  const fetchImpl: ResponsesFetchLike = async () => sseResponse(turn1Stream())
  const turn1Input = input()
  const prepared = prepareResponsesContinuationRequest({
    input: turn1Input,
    model: "gpt-5",
    transportId: "public",
    ...(args.reasoningCarryover ? { reasoningCarryover: true } : {}),
    ...(args.store !== undefined ? { reasoningCarryoverStore: args.store } : {}),
  })
  await drain(
    streamResponsesSurface({
      provider: "openai",
      transportId: "public",
      model: "gpt-5",
      input: turn1Input,
      request: prepared,
      fetchImpl,
      url: "https://example.test/responses",
      headers: { "content-type": "application/json" },
      timeoutMs: { firstChunkMs: 1000, idleMs: 1000 },
      ...(args.reasoningCarryover ? { reasoningCarryover: true } : {}),
      ...(args.store !== undefined ? { reasoningCarryoverStore: args.store } : {}),
    }),
  )
}

describe("H15 e2e — 2-turn Responses carry-over", () => {
  test("ON: turn-1 reasoning captured & persisted ⇒ turn-2 input re-emits it", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    await runTurn1({ reasoningCarryover: true, store })

    // The store now holds the turn-1 reasoning for the route.
    expect(store.get("route-xyz")).toEqual([
      { type: "reasoning", id: "rs_turn1", encrypted_content: "CIPHER_T1" },
    ])

    // Turn-2 input is built with the SAME route + store + gate on.
    const turn2Input = input({
      messages: [{ role: "user", content: [{ type: "text", text: "step 2" }] }],
    })
    const turn2 = prepareResponsesContinuationRequest({
      input: turn2Input,
      model: "gpt-5",
      transportId: "public",
      reasoningCarryover: true,
      reasoningCarryoverStore: store,
    })
    const body = turn2.fullBody
    const items = body.input as ResponsesInputItem[]
    expect(items[0]).toEqual({
      type: "reasoning",
      id: "rs_turn1",
      encrypted_content: "CIPHER_T1",
    })
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.store).toBe(false)
  })

  test("OFF: turn-2 input has NO reasoning items + byte-identical to legacy", async () => {
    // OFF turn-1: even though reasoning is streamed, nothing is captured.
    const store = defaultResponsesReasoningCarryoverStore()
    await runTurn1({ reasoningCarryover: false, store })
    expect(store.get("route-xyz")).toEqual([])

    const turn2Input = input({
      messages: [{ role: "user", content: [{ type: "text", text: "step 2" }] }],
    })
    const off = prepareResponsesContinuationRequest({
      input: turn2Input,
      model: "gpt-5",
      transportId: "public",
      // gate off, no store
    })
    // Legacy: no carry-over args at all.
    const legacy = prepareResponsesContinuationRequest({
      input: turn2Input,
      model: "gpt-5",
      transportId: "public",
    })
    expect(JSON.stringify(off.fullBody)).toBe(JSON.stringify(legacy.fullBody))
    expect(off.fullBody.include).toBeUndefined()
    const items = off.fullBody.input as ResponsesInputItem[]
    expect(items.some((i) => i.type === "reasoning")).toBe(false)
  })

  test("ON but a turn with NO reasoning clears the route (no stale re-feed)", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    // Seed a prior reasoning item.
    store.put("route-xyz", [{ type: "reasoning", id: "old", encrypted_content: "STALE" }])

    // Turn that produces NO reasoning item.
    const fetchImpl: ResponsesFetchLike = async () =>
      sseResponse(
        sse([
          { type: "response.output_text.delta", delta: "answer" },
          { type: "response.completed", response: { id: "resp_x", model: "gpt-5" } },
        ]),
      )
    const turnInput = input()
    const prepared = prepareResponsesContinuationRequest({
      input: turnInput,
      model: "gpt-5",
      transportId: "public",
      reasoningCarryover: true,
      reasoningCarryoverStore: store,
    })
    await drain(
      streamResponsesSurface({
        provider: "openai",
        transportId: "public",
        model: "gpt-5",
        input: turnInput,
        request: prepared,
        fetchImpl,
        url: "https://example.test/responses",
        headers: { "content-type": "application/json" },
        timeoutMs: { firstChunkMs: 1000, idleMs: 1000 },
        reasoningCarryover: true,
        reasoningCarryoverStore: store,
      }),
    )
    // The stale reasoning was cleared (a no-reasoning turn supersedes).
    expect(store.get("route-xyz")).toEqual([])
  })
})
