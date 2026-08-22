import { describe, expect, test } from "bun:test"
import { finalizeCalls } from "@/llm/adapters/openai"
import { parseResponsesEvents } from "@/llm/openai-responses-wire"
import type { StreamEvent } from "@/llm/types"

/**
 * T07 hellgate — LLM wire best-effort callbacks must not abort primary delivery.
 *
 * Audit L6 H1: `onReasoning` / `onOutputItemDone` / `onCompleted` in
 * `parseResponsesEvents` were bare optional-chained calls (only
 * `notifyChunkArrival` was wrapped). A throwing checkpoint/observability sink
 * propagated out of the generator, corrupting the toolCalls map + continuation
 * store. Post-fix every host callback routes through the shared no-throw
 * dispatcher: the stream still completes and yields its full event sequence.
 *
 * Audit L6 H2: `finalizeCalls` exists as a generator surface so the adapter can
 * yield it INSIDE its stream try/catch (structured-error preservation).
 */

async function* frames(datas: string[]): AsyncIterable<{ data: string }> {
  for (const data of datas) yield { data }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const toolCallStream = (): string[] => [
  JSON.stringify({
    type: "response.output_item.added",
    item: { type: "function_call", call_id: "c1", name: "bash" },
  }),
  JSON.stringify({
    type: "response.function_call_arguments.delta",
    item_id: "c1",
    delta: '{"cmd":"ls"}',
  }),
  JSON.stringify({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "c1", name: "bash", arguments: '{"cmd":"ls"}' },
  }),
  JSON.stringify({
    type: "response.completed",
    response: { id: "resp_1", model: "gpt-5", usage: { input_tokens: 3, output_tokens: 5 } },
  }),
]

describe("T07 wire-callbacks hellgate", () => {
  test("H1: a throwing onCompleted does not abort the stream", async () => {
    const events = await collect(
      parseResponsesEvents(frames(toolCallStream()), {
        provider: "openai",
        fallbackModel: "gpt-5",
        onCompleted: () => {
          throw new Error("hostile checkpoint sink")
        },
      }),
    )
    // Full sequence still delivered: tool start/delta/end + usage + message_stop.
    const types = events.map((e) => e.type)
    expect(types).toContain("tool_use_start")
    expect(types).toContain("tool_use_end")
    expect(types).toContain("usage")
    expect(types[types.length - 1]).toBe("message_stop")
  })

  test("H1: a throwing onOutputItemDone does not abort the stream", async () => {
    const events = await collect(
      parseResponsesEvents(frames(toolCallStream()), {
        provider: "openai",
        fallbackModel: "gpt-5",
        onOutputItemDone: () => {
          throw new Error("hostile observability sink")
        },
      }),
    )
    const end = events.find((e) => e.type === "tool_use_end")
    expect(end).toBeDefined()
    expect(events[events.length - 1]?.type).toBe("message_stop")
  })

  test("H1: a throwing onReasoning does not abort the stream", async () => {
    const events = await collect(
      parseResponsesEvents(
        frames([
          JSON.stringify({ type: "response.reasoning.delta", delta: "thinking" }),
          JSON.stringify({ type: "response.completed", response: { id: "r", model: "gpt-5" } }),
        ]),
        {
          provider: "openai",
          fallbackModel: "gpt-5",
          onReasoning: () => {
            throw new Error("hostile reasoning sink")
          },
        },
      ),
    )
    expect(events.some((e) => e.type === "thinking_delta")).toBe(true)
    expect(events[events.length - 1]?.type).toBe("message_stop")
  })

  test("H2: finalizeCalls is a generator surface (yield-able inside try/catch)", () => {
    const pending = new Map([[0, { id: "c1", name: "bash", args: '{"cmd":"ls"}', started: true }]])
    const out = [...finalizeCalls(pending)]
    expect(out[0]).toMatchObject({ type: "tool_use_end", id: "c1" })
  })
})
