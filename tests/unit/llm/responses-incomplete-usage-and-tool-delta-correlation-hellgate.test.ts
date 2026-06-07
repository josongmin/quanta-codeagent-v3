import { describe, expect, test } from "bun:test"
import { buildToolInputSeam } from "@/agent/tool-input-streaming"
import { parseResponsesEvents } from "@/llm/openai-responses-wire"
import type { StreamEvent } from "@/llm/types"
import type { ToolRegistry } from "@/tool"

/**
 * Hellgate — two distinct OpenAI Responses wire defects (L1-responses-wire).
 *
 * #2 (incomplete-only usage drop): a REAL incomplete-only stream
 * (`response.incomplete` with NO preceding `response.completed`) leaves the
 * usage accumulator null, so the unfixed wire emitted NO usage event and the
 * most expensive turns (output capped at max_output_tokens) were undercounted
 * to zero. Fix folds `event.response.usage` carried on the incomplete event
 * into the canonical shape and emits THAT.
 *
 * #6 (tool-arg id-correlation): `output_item.added`/`output_item.done` carry
 * `call_id`, but `function_call_arguments.delta` carries `item_id`. The slot +
 * the downstream `buildToolInputSeam` consumer are keyed by `call_id`, so delta
 * lookups MISSED — `slot.args` never accumulated and per-tool `onInputDelta`
 * never fired. The bug was masked only because `output_item.done` happened to
 * carry full `arguments`. Fix captures item_id→call_id at `added` and resolves
 * deltas, and `done` no longer depends on carrying `arguments`.
 */

async function* frames(datas: string[]): AsyncIterable<{ data: string }> {
  for (const data of datas) yield { data }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("responses-wire incomplete-usage + tool-delta correlation hellgate", () => {
  test("#2: incomplete-only stream carrying usage emits a usage event with the right output tokens", async () => {
    // NO response.completed — the only terminal event is response.incomplete,
    // which carries its own usage counts (max_output_tokens turn).
    const events = await collect(
      parseResponsesEvents(
        frames([
          JSON.stringify({ type: "response.output_text.delta", delta: "partial output…" }),
          JSON.stringify({
            type: "response.incomplete",
            response: {
              id: "resp_x",
              model: "gpt-5",
              incomplete_details: { reason: "max_output_tokens" },
              usage: {
                input_tokens: 1200,
                output_tokens: 4096,
                input_tokens_details: { cached_tokens: 800 },
                output_tokens_details: { reasoning_tokens: 512 },
              },
            },
          }),
        ]),
        { provider: "openai", fallbackModel: "gpt-5" },
      ),
    )

    const usage = events.find((e) => e.type === "usage")
    // Pre-fix: usage accumulator is null → NO usage event (undercount to zero).
    expect(usage).toBeDefined()
    if (usage?.type !== "usage") throw new Error("unreachable")
    expect(usage.inputTokens).toBe(1200)
    expect(usage.outputTokens).toBe(4096)
    expect(usage.cacheReadTokens).toBe(800)
    expect(usage.model).toBe("gpt-5")

    const stop = events[events.length - 1]
    expect(stop?.type).toBe("message_stop")
    if (stop?.type === "message_stop") expect(stop.stop_reason).toBe("max_tokens")
  })

  test("#2: incomplete WITHOUT usage still no-ops (no fabricated zero-usage event)", async () => {
    const events = await collect(
      parseResponsesEvents(
        frames([
          JSON.stringify({
            type: "response.incomplete",
            response: { id: "r", model: "gpt-5", incomplete_details: { reason: "content_filter" } },
          }),
        ]),
        { provider: "openai", fallbackModel: "gpt-5" },
      ),
    )
    expect(events.some((e) => e.type === "usage")).toBe(false)
    const stop = events[events.length - 1]
    if (stop?.type === "message_stop") expect(stop.stop_reason).toBe("content_filtered")
  })

  test("#6: streamed tool call (deltas keyed by item_id, done WITHOUT arguments) accumulates full input and fires onInputDelta keyed by call_id", async () => {
    // Drive the wire's output through the SAME seam the loop wires up, with a
    // fake registry exposing a tool that records its onInputDelta payloads.
    const deltaSeen: string[] = []
    let availableInput: unknown
    const tool = {
      onInputDelta: (d: string) => deltaSeen.push(d),
      onInputAvailable: (i: unknown) => {
        availableInput = i
      },
    }
    const fakeRegistry = {
      get: (name: string) => (name === "bash" ? tool : undefined),
    } as unknown as ToolRegistry
    const seam = buildToolInputSeam(fakeRegistry)

    const events = await collect(
      parseResponsesEvents(
        frames([
          JSON.stringify({
            type: "response.output_item.added",
            // call_id (canonical) differs from item id (fc_…) as on real payloads.
            item: { type: "function_call", id: "fc_42", call_id: "call_42", name: "bash" },
          }),
          // Args arrive ONLY via deltas, keyed by item_id (not call_id).
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: "fc_42",
            delta: '{"cmd":',
          }),
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: "fc_42",
            delta: '"ls -la"}',
          }),
          // done carries NO arguments — must rely on accumulated slot.args.
          JSON.stringify({
            type: "response.output_item.done",
            item: { type: "function_call", id: "fc_42", call_id: "call_42", name: "bash" },
          }),
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_1",
              model: "gpt-5",
              usage: { input_tokens: 3, output_tokens: 5 },
            },
          }),
        ]),
        { provider: "openai", fallbackModel: "gpt-5" },
      ),
    )

    // Route the emitted tool_use_* events into the seam (mirrors the loop).
    for (const ev of events) {
      if (ev.type === "tool_use_start") seam.start(ev.id, ev.name)
      else if (ev.type === "tool_use_delta") seam.delta(ev.id, ev.delta)
      else if (ev.type === "tool_use_end") seam.available(ev.id, ev.input)
    }

    // Deltas must be emitted keyed by call_id (consistent with start/end), so
    // the seam — keyed by call_id — actually finds the tool and fires.
    const deltaEvents = events.filter((e) => e.type === "tool_use_delta")
    expect(deltaEvents.length).toBe(2)
    for (const de of deltaEvents) {
      if (de.type === "tool_use_delta") expect(de.id).toBe("call_42")
    }
    // Pre-fix: deltas were keyed by item_id ("fc_42") so the call_id-keyed seam
    // missed → deltaSeen stayed empty.
    expect(deltaSeen).toEqual(['{"cmd":', '"ls -la"}'])

    // tool_use_end input must be the FULL accumulated args (done had none).
    const end = events.find((e) => e.type === "tool_use_end")
    expect(end).toBeDefined()
    if (end?.type === "tool_use_end") expect(end.input).toEqual({ cmd: "ls -la" })
    expect(availableInput).toEqual({ cmd: "ls -la" })
  })
})
