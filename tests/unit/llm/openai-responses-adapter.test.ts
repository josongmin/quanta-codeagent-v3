import { describe, expect, test } from "bun:test"
import { OpenAIResponsesAdapter } from "@/llm/adapters/openai-responses"
import type { StreamEvent, StreamInput } from "@/llm/types"

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

const inputTurn1 = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  promptCacheKey: "lane-1",
})

const inputTurn2 = (): StreamInput => ({
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ],
  tools: [],
  promptCacheKey: "lane-1",
})

describe("OpenAIResponsesAdapter continuation", () => {
  test("second strict-extension turn uses previous_response_id with delta-only input", async () => {
    const bodies: Record<string, unknown>[] = []
    let call = 0
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
      call += 1
      if (call === 1) {
        return sseResponse([
          'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
          'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          "data: [DONE]\n\n",
        ])
      }
      return sseResponse([
        'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done","annotations":[]}]}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        "data: [DONE]\n\n",
      ])
    }

    const adapter = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-5",
      fetchImpl,
    })

    await collect(adapter.stream(inputTurn1()))
    const secondTurnEvents = await collect(adapter.stream(inputTurn2()))

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.previous_response_id).toBeUndefined()
    expect(bodies[1]?.previous_response_id).toBe("resp_1")
    expect(bodies[1]?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "next" }],
      },
    ])
    expect(secondTurnEvents.find((e) => e.type === "llm_continuation")).toEqual({
      type: "llm_continuation",
      surfaceId: "openai-responses",
      transportId: "public",
      phase: "prepare",
      mode: "resume",
      reason: "prepared_resume",
    })
  })

  test("reasoning activity disables resume and falls back to full input", async () => {
    const bodies: Record<string, unknown>[] = []
    let call = 0
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
      call += 1
      if (call === 1) {
        return sseResponse([
          'data: {"type":"response.reasoning.delta","delta":"thinking"}\n\n',
          'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_r","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":5,"output_tokens_details":{"reasoning_tokens":3}}}}\n\n',
          "data: [DONE]\n\n",
        ])
      }
      return sseResponse([
        'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        "data: [DONE]\n\n",
      ])
    }

    const adapter = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-5",
      fetchImpl,
    })

    await collect(adapter.stream(inputTurn1()))
    const secondTurnEvents = await collect(adapter.stream(inputTurn2()))

    expect(bodies).toHaveLength(2)
    expect(bodies[1]?.previous_response_id).toBeUndefined()
    expect((bodies[1]?.input as unknown[])?.length).toBe(3)
    expect(secondTurnEvents.find((e) => e.type === "llm_continuation")).toEqual({
      type: "llm_continuation",
      surfaceId: "openai-responses",
      transportId: "public",
      phase: "prepare",
      mode: "full",
      reason: "non_resumable",
    })
  })

  test("stale previous_response_id clears continuation state and retries once with full input", async () => {
    const bodies: Record<string, unknown>[] = []
    let call = 0
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
      call += 1
      if (call === 1) {
        return sseResponse([
          'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello","annotations":[]}]}}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_ok","model":"gpt-5","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          "data: [DONE]\n\n",
        ])
      }
      if (call === 2) {
        return new Response('{"error":{"message":"unknown previous response"}}', {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      }
      return sseResponse([
        'data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done","annotations":[]}]}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_full","model":"gpt-5","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        "data: [DONE]\n\n",
      ])
    }

    const adapter = new OpenAIResponsesAdapter({
      apiKey: "k",
      model: "gpt-5",
      fetchImpl,
    })

    await collect(adapter.stream(inputTurn1()))
    const secondTurnEvents = await collect(adapter.stream(inputTurn2()))

    expect(bodies).toHaveLength(3)
    expect(bodies[1]?.previous_response_id).toBe("resp_ok")
    expect((bodies[1]?.input as unknown[])?.length).toBe(1)
    expect(bodies[2]?.previous_response_id).toBeUndefined()
    expect((bodies[2]?.input as unknown[])?.length).toBe(3)
    expect(
      secondTurnEvents.filter((e) => e.type === "llm_continuation"),
    ).toEqual([
      {
        type: "llm_continuation",
        surfaceId: "openai-responses",
        transportId: "public",
        phase: "prepare",
        mode: "resume",
        reason: "prepared_resume",
      },
      {
        type: "llm_continuation",
        surfaceId: "openai-responses",
        transportId: "public",
        phase: "retry",
        mode: "full_retry",
        reason: "stale_previous_response",
        statusCode: 404,
      },
    ])
  })
})
