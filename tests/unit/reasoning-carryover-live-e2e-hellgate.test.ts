import { describe, expect, test } from "bun:test"
import { OpenAIResponsesAdapter } from "@/llm/adapters/openai-responses"
import type { ResponsesInputItem } from "@/llm/openai-responses-wire"
import type { StreamEvent, StreamInput } from "@/llm/types"

/**
 * Hellgate (LIVE e2e) — H15 reasoning carry-over through the REAL adapter.
 *
 * Unlike reasoning-carryover-live-hellgate.test.ts (which threads an explicit
 * store into `streamResponsesSurface`), this battery drives the actual
 * {@link OpenAIResponsesAdapter} — which allocates ONE per-session carry-over
 * store at construction time when `reasoningCarryover` is on. It proves that
 * reasoning captured on turn-1's outbound→response round-trip is re-emitted on
 * turn-2's OUTBOUND request body, observed straight off the fake transport (the
 * real bytes the adapter would POST).
 *
 *  - Knob ON ⇒ turn-2 body carries turn-1's encrypted reasoning at the head +
 *    `include:["reasoning.encrypted_content"]` + `store:false`.
 *  - Knob OFF ⇒ turn-2 body is BYTE-IDENTICAL to the same adapter with no gate
 *    (no reasoning items, no `include`).
 *  - Multi-session: two INDEPENDENT adapters (separate per-session stores) never
 *    cross-feed reasoning.
 *  - Chatgpt-oauth shares the same Responses wire ⇒ identical behavior (covered
 *    structurally via the shared `streamResponsesSurface` path; the BYOK adapter
 *    is the deterministic, token-free surface to drive here).
 */

const sseResponse = (chunks: readonly string[]): Response => {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const collect = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

/** Turn-1 stream: emits an encrypted reasoning item then completes. NOTE the
 *  reasoning item makes the turn non-resumable (no `previous_response_id` reuse),
 *  so carry-over is the ONLY mechanism re-feeding the chain on turn-2. */
const turn1Chunks = (cipher: string): readonly string[] => [
  'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
  `data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_t1","encrypted_content":"${cipher}"}}\n\n`,
  'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_t1","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":5,"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
  "data: [DONE]\n\n",
]

const turn2Chunks = (): readonly string[] => [
  'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done","annotations":[]}]}}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_t2","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
  "data: [DONE]\n\n",
]

const turn1Input = (routeKey = "lane-1"): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "step 1" }] }],
  tools: [],
  promptCacheKey: routeKey,
})

const turn2Input = (routeKey = "lane-1"): StreamInput => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "step 1" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "user", content: [{ type: "text", text: "step 2" }] },
  ],
  tools: [],
  promptCacheKey: routeKey,
})

/** Build a fake fetch that records each outbound body and replays the turn
 *  scripts in order. The reasoning turn-1 forces non-resumable so the only path
 *  for turn-1 thinking to reach turn-2 is the carry-over store. */
const recordingFetch = (
  bodies: Record<string, unknown>[],
  cipher: string,
): ((url: string | URL | Request, init?: RequestInit) => Promise<Response>) => {
  let call = 0
  return async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
    call += 1
    return sseResponse(call === 1 ? turn1Chunks(cipher) : turn2Chunks())
  }
}

describe("H15 LIVE e2e — real OpenAIResponsesAdapter carry-over", () => {
  test("ON: turn-2 outbound body re-emits turn-1 reasoning + include + store:false", async () => {
    const bodies: Record<string, unknown>[] = []
    const adapter = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-5",
      fetchImpl: recordingFetch(bodies, "CIPHER_T1"),
      reasoningCarryover: true,
    })

    await collect(adapter.stream(turn1Input()))
    await collect(adapter.stream(turn2Input()))

    expect(bodies).toHaveLength(2)
    const turn2Body = bodies[1]
    const items = turn2Body?.input as ResponsesInputItem[]
    // turn-1 reasoning leads turn-2's input — re-fed purely by the adapter's
    // own per-session store (the reasoning turn was non-resumable).
    expect(items[0]).toEqual({ type: "reasoning", id: "rs_t1", encrypted_content: "CIPHER_T1" })
    expect(turn2Body?.include).toEqual(["reasoning.encrypted_content"])
    expect(turn2Body?.store).toBe(false)
    // turn-1 itself never re-emits prior reasoning (store was empty).
    expect(bodies[0]?.include).toBeUndefined()
    expect((bodies[0]?.input as ResponsesInputItem[]).some((i) => i.type === "reasoning")).toBe(
      false,
    )
  })

  test("OFF: turn-2 outbound body is byte-identical to the no-gate adapter", async () => {
    const onBodies: Record<string, unknown>[] = []
    const offBodies: Record<string, unknown>[] = []

    const offAdapter = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-5",
      fetchImpl: recordingFetch(offBodies, "CIPHER_T1"),
      // gate omitted ⇒ OFF
    })
    await collect(offAdapter.stream(turn1Input()))
    await collect(offAdapter.stream(turn2Input()))

    // A second adapter, also OFF, to assert determinism of the baseline.
    const baselineAdapter = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-5",
      fetchImpl: recordingFetch(onBodies, "CIPHER_T1"),
    })
    await collect(baselineAdapter.stream(turn1Input()))
    await collect(baselineAdapter.stream(turn2Input()))

    expect(JSON.stringify(offBodies[1])).toBe(JSON.stringify(onBodies[1]))
    expect(offBodies[1]?.include).toBeUndefined()
    expect((offBodies[1]?.input as ResponsesInputItem[]).some((i) => i.type === "reasoning")).toBe(
      false,
    )
  })

  test("multi-session: two independent adapters never cross-feed reasoning", async () => {
    const bodiesA: Record<string, unknown>[] = []
    const bodiesB: Record<string, unknown>[] = []
    const adapterA = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-5",
      fetchImpl: recordingFetch(bodiesA, "CIPHER_A"),
      reasoningCarryover: true,
    })
    const adapterB = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-5",
      fetchImpl: recordingFetch(bodiesB, "CIPHER_B"),
      reasoningCarryover: true,
    })

    await collect(adapterA.stream(turn1Input("lane-A")))
    await collect(adapterB.stream(turn1Input("lane-B")))
    await collect(adapterA.stream(turn2Input("lane-A")))
    await collect(adapterB.stream(turn2Input("lane-B")))

    const itemsA = bodiesA[1]?.input as ResponsesInputItem[]
    const itemsB = bodiesB[1]?.input as ResponsesInputItem[]
    expect(itemsA[0]).toEqual({ type: "reasoning", id: "rs_t1", encrypted_content: "CIPHER_A" })
    expect(itemsB[0]).toEqual({ type: "reasoning", id: "rs_t1", encrypted_content: "CIPHER_B" })
    // No leak across the two adapters' independent per-session stores.
    expect(JSON.stringify(itemsA)).not.toContain("CIPHER_B")
    expect(JSON.stringify(itemsB)).not.toContain("CIPHER_A")
  })
})
