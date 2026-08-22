/**
 * Hellgate (Gap 4) — prove the failing layer is NOT the chatgpt-oauth adapter.
 *
 * The earlier RCA blamed the adapter for emitting no usage. This pins the truth:
 * the shared Responses parser (`chatgpt-oauth` delegates straight to it) reads
 * `response.completed.usage` — including OpenAI's `input_tokens_details.cached_tokens`
 * — and emits a canonical `type:"usage"` StreamEvent with `cacheReadTokens`.
 *
 * If a refactor ever drops usage parsing here, THIS fails — narrowing the bug to
 * the stream layer instead of mis-blaming report serialization.
 */
import { describe, expect, test } from "bun:test"
import { parseResponsesEvents } from "@/../src/llm/openai-responses-wire"
import type { StreamEvent } from "@/llm"

type SSEEvent = { event?: string; data: string }

async function* frames(payloads: object[]): AsyncGenerator<SSEEvent> {
  for (const p of payloads) yield { data: JSON.stringify(p) }
  yield { data: "[DONE]" }
}

const collect = async (payloads: object[]): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of parseResponsesEvents(frames(payloads), {
    provider: "chatgpt-oauth",
    fallbackModel: "gpt-5.4",
  })) {
    out.push(ev)
  }
  return out
}

describe("Gap 4 — Responses wire emits usage incl. cache read", () => {
  test("response.completed.usage → type:usage with cacheReadTokens", async () => {
    const events = await collect([
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "gpt-5.4",
          usage: {
            input_tokens: 1200,
            output_tokens: 340,
            input_tokens_details: { cached_tokens: 800 },
            output_tokens_details: { reasoning_tokens: 120 },
          },
        },
      },
    ])
    const usage = events.find((e) => e.type === "usage")
    expect(usage).toBeDefined()
    expect(usage).toMatchObject({
      type: "usage",
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
      model: "gpt-5.4",
    })
  })

  test("no usage payload → NO fabricated zero-usage event", async () => {
    const events = await collect([
      { type: "response.completed", response: { id: "resp_2", model: "gpt-5.4" } },
    ])
    expect(events.find((e) => e.type === "usage")).toBeUndefined()
  })
})
