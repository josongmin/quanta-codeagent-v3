/**
 * Hellgate — STRUCTURAL throttle-swallow fix (jun-20 overnight RCA).
 *
 * Under OAuth load the Responses endpoint accepts the request (HTTP 200) then
 * closes the stream in ~220ms having emitted ZERO content events and no
 * `response.completed` — a silently-swallowed throttle. Pre-fix
 * `streamResponsesSurface` returned normally, so the agent loop saw a completed-
 * empty turn and immediately fired the NEXT request into the same throttle
 * window (measured: ~12 prepare-only calls in 10s, no backoff → burned turns →
 * empty patch). The fix reclassifies the empty/truncated stream as a RETRYABLE
 * `rate_limit` LLMError so the loop's exponential-jitter backoff actually fires.
 *
 * Teeth:
 *  1. empty stream (0 content, no completion) ⇒ throws `rate_limit` AND
 *     `isRetryable(thrown) === true` (so backoff engages — the whole point).
 *  2. RED-ON-INJECTION: a normal stream (content + completion) does NOT throw.
 *  3. a PARTIAL stream (content then drop, no completion) does NOT throw — only
 *     the truly-empty prepare-only case is reclassified.
 */
import { describe, expect, test } from "bun:test"
import { isRetryable } from "@/agent/retry"
import {
  prepareResponsesContinuationRequest,
  type ResponsesFetchLike,
  streamResponsesSurface,
} from "@/llm/responses-stream"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { LLMError } from "@/shared"

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

const input = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  tools: [],
  promptCacheKey: "route-throttle",
})

const run = (fetchImpl: ResponsesFetchLike): AsyncIterable<StreamEvent> => {
  const inp = input()
  const prepared = prepareResponsesContinuationRequest({
    input: inp,
    model: "gpt-5",
    transportId: "public",
  })
  return streamResponsesSurface({
    provider: "openai",
    transportId: "public",
    model: "gpt-5",
    input: inp,
    request: prepared,
    fetchImpl,
    url: "https://example.test/responses",
    headers: { "content-type": "application/json" },
    timeoutMs: { firstChunkMs: 1000, idleMs: 1000 },
  })
}

const NORMAL = (): string =>
  sse([
    { type: "response.output_text.delta", delta: "hi" },
    {
      type: "response.completed",
      response: { id: "resp_ok", model: "gpt-5", usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ])

const catchErr = async (it: AsyncIterable<StreamEvent>): Promise<unknown> => {
  try {
    await drain(it)
    return undefined
  } catch (e) {
    return e
  }
}

describe("responses-stream throttle-swallow", () => {
  test("THE FIX: empty stream (0 content, no completion) ⇒ RETRYABLE rate_limit", async () => {
    const err = await catchErr(run(async () => sseResponse("")))
    expect(err).toBeInstanceOf(LLMError)
    expect((err as LLMError).kind).toBe("rate_limit")
    // The whole point: the loop's backoff retry path must engage on this.
    expect(isRetryable(err)).toBe(true)
  })

  test("a whitespace-only SSE body (zero parseable frames) is also reclassified", async () => {
    const err = await catchErr(run(async () => sseResponse(sse([]))))
    expect(err).toBeInstanceOf(LLMError)
    expect((err as LLMError).kind).toBe("rate_limit")
  })

  test("RED-ON-INJECTION: a normal stream (content + completion) does NOT throw", async () => {
    const events = await drain(run(async () => sseResponse(NORMAL())))
    expect(events.length).toBeGreaterThan(0)
    // No reclassification — at least one real content event flowed through.
    expect(events.some((e) => e.type !== "llm_continuation")).toBe(true)
  })

  test("a PARTIAL stream (content, NO completion) does NOT throw (only empty is reclassified)", async () => {
    // content event but no response.completed ⇒ sawContentEvent=true ⇒ guard skipped.
    const partial = sse([{ type: "response.output_text.delta", delta: "partial..." }])
    const err = await catchErr(run(async () => sseResponse(partial)))
    expect(err).toBeUndefined()
  })

  // AUDIT FIX (Round 1d) — an INTENTIONAL early terminator with no content and no
  // usage (content_filter / max_tokens) terminates via `response.incomplete` →
  // a NON-end_turn message_stop. It must route to its real terminal path, NOT be
  // misclassified as a retryable throttle. Guarded by terminalStopReason==="end_turn".
  test("content_filter incomplete (no content/usage) does NOT throw (real terminal, not throttle)", async () => {
    const body = sse([
      {
        type: "response.incomplete",
        response: { id: "r", model: "gpt-5", incomplete_details: { reason: "content_filter" } },
      },
    ])
    expect(await catchErr(run(async () => sseResponse(body)))).toBeUndefined()
  })

  test("max_output_tokens incomplete (no content/usage) does NOT throw", async () => {
    const body = sse([
      {
        type: "response.incomplete",
        response: { id: "r", model: "gpt-5", incomplete_details: { reason: "max_output_tokens" } },
      },
    ])
    expect(await catchErr(run(async () => sseResponse(body)))).toBeUndefined()
  })
})
