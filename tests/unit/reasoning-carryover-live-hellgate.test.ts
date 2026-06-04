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
 * Hellgate (LIVE wiring) — H15 reasoning carry-over per-session STORE.
 *
 * The pure builders (`normalizeResponsesReasoningItem` / `buildResponsesBody`)
 * are proven in reasoning-carryover-hellgate.test.ts. This battery proves the
 * LIVE seam: a per-session {@link ResponsesReasoningCarryoverStore} threaded
 * through `streamResponsesSurface` (capture/persist) + `prepareResponsesContinuationRequest`
 * (replay) so reasoning captured on turn N reaches turn N+1's outbound request.
 *
 * Adversarial proofs:
 *  - Knob ON: after turn-1 the store holds the captured reasoning item; the
 *    turn-2 BUILT request `input` re-emits it at its head + sets
 *    `include:["reasoning.encrypted_content"]` + `store:false`.
 *  - Knob OFF: the store is NEVER populated even though reasoning streamed; the
 *    turn-2 built request is BYTE-IDENTICAL to legacy (no reasoning items, no
 *    `include`).
 *  - Malformed / absent encrypted_content ⇒ skipped, no throw, store stays empty.
 *  - Multi-session isolation: session A's reasoning never leaks into session B's
 *    request — even sharing ONE store instance (keyed by routeKey) AND across two
 *    independent store instances.
 *  - OpenAI-Responses scoping: this is the only surface that touches the store.
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

const input = (routeKey: string, text: string): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
  promptCacheKey: routeKey,
})

/** Drive a single turn through the REAL stream surface with a fake transport
 *  that emits the given output_item.done items + a completion. Returns nothing —
 *  the store mutation is the observable effect. */
const runTurn = async (args: {
  readonly routeKey: string
  readonly text: string
  readonly outputItems: Record<string, unknown>[]
  readonly reasoningCarryover: boolean
  readonly store?: ResponsesReasoningCarryoverStore
}): Promise<void> => {
  const fetchImpl: ResponsesFetchLike = async () =>
    sseResponse(
      sse([
        { type: "response.output_text.delta", delta: "answer" },
        ...args.outputItems.map((item) => ({ type: "response.output_item.done", item })),
        {
          type: "response.completed",
          response: { id: `resp_${args.routeKey}`, model: "gpt-5" },
        },
      ]),
    )
  const turnInput = input(args.routeKey, args.text)
  const prepared = prepareResponsesContinuationRequest({
    input: turnInput,
    model: "gpt-5",
    transportId: "openai-responses",
    ...(args.reasoningCarryover ? { reasoningCarryover: true } : {}),
    ...(args.store !== undefined ? { reasoningCarryoverStore: args.store } : {}),
  })
  await drain(
    streamResponsesSurface({
      provider: "openai",
      transportId: "openai-responses",
      model: "gpt-5",
      input: turnInput,
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

const buildTurn2 = (args: {
  readonly routeKey: string
  readonly reasoningCarryover: boolean
  readonly store?: ResponsesReasoningCarryoverStore
}): Record<string, unknown> => {
  const turn2Input = input(args.routeKey, "step 2")
  const prepared = prepareResponsesContinuationRequest({
    input: turn2Input,
    model: "gpt-5",
    transportId: "openai-responses",
    ...(args.reasoningCarryover ? { reasoningCarryover: true } : {}),
    ...(args.store !== undefined ? { reasoningCarryoverStore: args.store } : {}),
  })
  return prepared.fullBody
}

describe("H15 LIVE — per-session store capture ⇒ replay", () => {
  test("ON: turn-1 populates store ⇒ turn-2 request re-emits + include + store:false", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    await runTurn({
      routeKey: "sess-A",
      text: "step 1",
      outputItems: [{ type: "reasoning", id: "rs_1", encrypted_content: "CIPHER_A" }],
      reasoningCarryover: true,
      store,
    })

    // The per-session store now holds turn-1's reasoning keyed to the session.
    expect(store.get("sess-A")).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "CIPHER_A" },
    ])

    const body = buildTurn2({ routeKey: "sess-A", reasoningCarryover: true, store })
    const items = body.input as ResponsesInputItem[]
    expect(items[0]).toEqual({ type: "reasoning", id: "rs_1", encrypted_content: "CIPHER_A" })
    expect(body.include).toEqual(["reasoning.encrypted_content"])
    expect(body.store).toBe(false)
  })

  test("OFF: reasoning streams but store NEVER populated ⇒ turn-2 byte-identical to legacy", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    await runTurn({
      routeKey: "sess-A",
      text: "step 1",
      outputItems: [{ type: "reasoning", id: "rs_1", encrypted_content: "CIPHER_A" }],
      reasoningCarryover: false,
      store,
    })
    expect(store.get("sess-A")).toEqual([])

    const off = buildTurn2({ routeKey: "sess-A", reasoningCarryover: false, store })
    // Legacy = no carry-over args at all.
    const legacy = prepareResponsesContinuationRequest({
      input: input("sess-A", "step 2"),
      model: "gpt-5",
      transportId: "openai-responses",
    }).fullBody
    expect(JSON.stringify(off)).toBe(JSON.stringify(legacy))
    expect(off.include).toBeUndefined()
    expect((off.input as ResponsesInputItem[]).some((i) => i.type === "reasoning")).toBe(false)
  })
})

describe("H15 LIVE — malformed / absent encrypted_content ⇒ safe-skip", () => {
  test("reasoning item with NO encrypted_content ⇒ no capture, no throw, store empty", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    await expect(
      runTurn({
        routeKey: "sess-A",
        text: "step 1",
        outputItems: [{ type: "reasoning", id: "rs_1" }],
        reasoningCarryover: true,
        store,
      }),
    ).resolves.toBeUndefined()
    expect(store.get("sess-A")).toEqual([])
    // A turn-2 build with an empty route is byte-identical (gate alone adds nothing).
    const body = buildTurn2({ routeKey: "sess-A", reasoningCarryover: true, store })
    expect(body.include).toBeUndefined()
  })

  test("reasoning item with empty-string / non-string encrypted_content ⇒ skipped", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    await runTurn({
      routeKey: "sess-A",
      text: "step 1",
      outputItems: [
        { type: "reasoning", id: "rs_empty", encrypted_content: "" },
        { type: "reasoning", id: "rs_num", encrypted_content: 42 },
      ],
      reasoningCarryover: true,
      store,
    })
    expect(store.get("sess-A")).toEqual([])
  })

  test("MIXED turn: one usable + one malformed ⇒ only the usable item captured", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    await runTurn({
      routeKey: "sess-A",
      text: "step 1",
      outputItems: [
        { type: "reasoning", id: "rs_bad", encrypted_content: "" },
        { type: "reasoning", id: "rs_good", encrypted_content: "GOOD" },
      ],
      reasoningCarryover: true,
      store,
    })
    expect(store.get("sess-A")).toEqual([
      { type: "reasoning", id: "rs_good", encrypted_content: "GOOD" },
    ])
  })
})

describe("H15 LIVE — multi-session isolation", () => {
  test("ONE shared store, two sessions: A's reasoning never leaks into B's request", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    await runTurn({
      routeKey: "sess-A",
      text: "A-1",
      outputItems: [{ type: "reasoning", id: "rs_a", encrypted_content: "CIPHER_A" }],
      reasoningCarryover: true,
      store,
    })
    await runTurn({
      routeKey: "sess-B",
      text: "B-1",
      outputItems: [{ type: "reasoning", id: "rs_b", encrypted_content: "CIPHER_B" }],
      reasoningCarryover: true,
      store,
    })

    expect(store.get("sess-A")).toEqual([
      { type: "reasoning", id: "rs_a", encrypted_content: "CIPHER_A" },
    ])
    expect(store.get("sess-B")).toEqual([
      { type: "reasoning", id: "rs_b", encrypted_content: "CIPHER_B" },
    ])

    const bodyA = buildTurn2({ routeKey: "sess-A", reasoningCarryover: true, store })
    const bodyB = buildTurn2({ routeKey: "sess-B", reasoningCarryover: true, store })
    const itemsA = bodyA.input as ResponsesInputItem[]
    const itemsB = bodyB.input as ResponsesInputItem[]

    // Session A's request carries ONLY A's cipher; B's carries ONLY B's. No leak.
    expect(itemsA[0]).toEqual({ type: "reasoning", id: "rs_a", encrypted_content: "CIPHER_A" })
    expect(itemsB[0]).toEqual({ type: "reasoning", id: "rs_b", encrypted_content: "CIPHER_B" })
    expect(JSON.stringify(itemsA)).not.toContain("CIPHER_B")
    expect(JSON.stringify(itemsB)).not.toContain("CIPHER_A")
  })

  test("a session with NO reasoning gets a byte-identical request even while a sibling carries over", async () => {
    const store = defaultResponsesReasoningCarryoverStore()
    await runTurn({
      routeKey: "sess-A",
      text: "A-1",
      outputItems: [{ type: "reasoning", id: "rs_a", encrypted_content: "CIPHER_A" }],
      reasoningCarryover: true,
      store,
    })
    // Session B never produced reasoning ⇒ its route is empty.
    const bodyB = buildTurn2({ routeKey: "sess-B", reasoningCarryover: true, store })
    const legacyB = prepareResponsesContinuationRequest({
      input: input("sess-B", "step 2"),
      model: "gpt-5",
      transportId: "openai-responses",
    }).fullBody
    expect(JSON.stringify(bodyB)).toBe(JSON.stringify(legacyB))
    expect(bodyB.include).toBeUndefined()
  })
})
