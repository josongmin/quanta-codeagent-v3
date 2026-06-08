import { describe, expect, test } from "bun:test"
import {
  defaultResponsesContinuationStore,
  type ResponsesContinuationStore,
} from "@/llm/responses-continuation-store"
import {
  prepareResponsesContinuationRequest,
  type ResponsesFetchLike,
  streamResponsesSurface,
} from "@/llm/responses-stream"
import type { StreamEvent, StreamInput } from "@/llm/types"

/**
 * Hellgate (e2e) — TICKET 23: `reasoning.summary:"auto"` + `text.verbosity`
 * reach the POSTED WIRE BODY on BOTH the full-turn path and the resume-tail
 * path, through `prepareResponsesContinuationRequest` → `streamResponsesSurface`.
 *
 * RED-ON-INJECTION: the assertions read the body the adapter ACTUALLY POSTs
 * (captured by a fetch spy). If the threading is removed at any of the five
 * responses-surface points, or the wire shape regresses to a FLAT `verbosity`
 * key (which the OpenAI API silently ignores), these go red.
 *
 * OFF case: omitting both knobs yields a body byte-identical to the legacy
 * shape (no `text` key, no `summary` inside `reasoning`).
 *
 * Provider scoping: OpenAI-Responses surface ONLY — the same prepare/stream
 * seam both the BYOK Responses adapter and the ChatGPT-OAuth adapter call.
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

/** A turn that completes cleanly with a responseId so the continuation store
 *  records a RESUMABLE entry (no reasoning ⇒ resumable stays true). */
const completedStream = (responseId: string): string =>
  sse([
    { type: "response.output_text.delta", delta: "answer" },
    {
      type: "response.completed",
      response: { id: responseId, model: "gpt-5", usage: { input_tokens: 10, output_tokens: 5 } },
    },
  ])

const input = (overrides: Partial<StreamInput> = {}): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "step 1" }] }],
  tools: [],
  promptCacheKey: "route-ticket23",
  ...overrides,
})

/** Capture every POSTed body. Returns the spy fetch + the recorded bodies. */
const spyFetch = (
  responder: () => string,
): { fetchImpl: ResponsesFetchLike; bodies: Record<string, unknown>[] } => {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl: ResponsesFetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return sseResponse(responder())
  }
  return { fetchImpl, bodies }
}

const knobs = { reasoningSummary: true as const, reasoningVerbosity: "high" }

const runTurn = async (args: {
  readonly fetchImpl: ResponsesFetchLike
  readonly turnInput: StreamInput
  readonly store: ResponsesContinuationStore
  readonly withKnobs: boolean
}): Promise<void> => {
  const prepared = prepareResponsesContinuationRequest({
    input: args.turnInput,
    model: "gpt-5",
    transportId: "public",
    continuationStore: args.store,
    ...(args.withKnobs ? knobs : {}),
  })
  await drain(
    streamResponsesSurface({
      provider: "openai",
      transportId: "public",
      model: "gpt-5",
      input: args.turnInput,
      request: prepared,
      fetchImpl: args.fetchImpl,
      url: "https://example.test/responses",
      headers: { "content-type": "application/json" },
      timeoutMs: { firstChunkMs: 1000, idleMs: 1000 },
      continuationStore: args.store,
    }),
  )
}

describe("TICKET 23 e2e — reasoning.summary + text.verbosity reach the wire", () => {
  test("ON: FULL-turn posted body carries reasoning.summary==='auto' + text.verbosity==='high'", async () => {
    const { fetchImpl, bodies } = spyFetch(() => completedStream("resp_t1"))
    const store = defaultResponsesContinuationStore()
    await runTurn({ fetchImpl, turnInput: input(), store, withKnobs: true })

    expect(bodies).toHaveLength(1)
    const body = bodies[0] as Record<string, unknown>
    expect(body.reasoning).toEqual({ summary: "auto" })
    expect(body.text).toEqual({ verbosity: "high" })
    // FLAT verbosity is silently dropped by the API — must never appear.
    expect(body.verbosity).toBeUndefined()
  })

  test("ON: RESUME-TAIL posted body ALSO carries summary + verbosity (turn-2)", async () => {
    const store = defaultResponsesContinuationStore()
    // Turn 1 — completes, records a resumable continuation entry for the route.
    const t1 = spyFetch(() => completedStream("resp_t1"))
    await runTurn({ fetchImpl: t1.fetchImpl, turnInput: input(), store, withKnobs: true })

    // Turn 2 — strict extension of turn 1's input ⇒ prepare produces a
    // resume-tail body (previous_response_id set). The knobs must thread into
    // THAT path too, or the resume body silently drops them.
    const t2 = spyFetch(() => completedStream("resp_t2"))
    const turn2Input = input({
      messages: [
        { role: "user", content: [{ type: "text", text: "step 1" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "step 2" }] },
      ],
    })
    await runTurn({ fetchImpl: t2.fetchImpl, turnInput: turn2Input, store, withKnobs: true })

    expect(t2.bodies).toHaveLength(1)
    const body = t2.bodies[0] as Record<string, unknown>
    // Confirm we are actually on the resume-tail path (previous_response_id set).
    expect(body.previous_response_id).toBe("resp_t1")
    expect(body.reasoning).toEqual({ summary: "auto" })
    expect(body.text).toEqual({ verbosity: "high" })
    expect(body.verbosity).toBeUndefined()
  })

  test("OFF: omitting both knobs ⇒ posted body has NO text key, NO reasoning key", async () => {
    const { fetchImpl, bodies } = spyFetch(() => completedStream("resp_off"))
    const store = defaultResponsesContinuationStore()
    await runTurn({ fetchImpl, turnInput: input(), store, withKnobs: false })

    const offBody = bodies[0] as Record<string, unknown>
    expect(offBody.text).toBeUndefined()
    expect(offBody.reasoning).toBeUndefined()
    expect(offBody.verbosity).toBeUndefined()

    // Byte-identity: the OFF body matches a body built with NO knob args at all.
    const legacy = prepareResponsesContinuationRequest({
      input: input(),
      model: "gpt-5",
      transportId: "public",
    })
    expect(JSON.stringify(offBody)).toBe(JSON.stringify(legacy.fullBody))
  })
})
