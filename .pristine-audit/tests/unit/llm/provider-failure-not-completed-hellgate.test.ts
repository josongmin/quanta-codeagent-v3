import { describe, expect, test } from "bun:test"
import { parseResponsesEvents } from "@/llm/openai-responses-wire"
import type { StreamEvent } from "@/llm/types"
import { LLMError } from "@/shared"

/**
 * Provider-failure-not-completed hellgate (adapter layer).
 *
 * Root-cause defect: a provider FAILURE surfaced by the Responses SSE stream was
 * silently converted to a benign completed turn. Fixed at the adapter boundary
 * (the correct layer — recovery.decideOnAssembled keeps ADR-0076 open-set
 * tolerance and is NOT changed here):
 *
 *   (b) openai-responses-wire `response.failed` — was converted to a benign
 *       `message_stop`. Now THROWS a structured `server_error` LLMError so the
 *       loop's classifyLLMError routes it through stream-error recovery.
 *   (c) openai-responses-wire `response.incomplete` — flattened every early
 *       stop into one opaque `"incomplete"` and DROPPED usage. Now reads
 *       `incomplete_details.reason` (max_output_tokens → max_tokens /
 *       content_filter → content_filtered) and emits usage BEFORE returning.
 *
 * NOTE: an earlier revision also rewrote decideOnAssembled to surface unknown
 * stop reasons + added content_filter/function_call to the OpenAI STOP_REASON
 * table. Both were reverted — they violate ADR-0076's documented open-set /
 * NI-2 negative invariants (see recovery-hell.test.ts). The genuine bug is the
 * provider-error event below, which throws regardless of stop-reason routing.
 */

async function* frames(datas: string[]): AsyncIterable<{ data: string }> {
  for (const data of datas) yield { data }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// ─── (b) response.failed ⇒ throw a structured LLMError ───────────────────────

describe("HELL-PF-B — response.failed throws (not message_stop)", () => {
  test("throws a server_error LLMError carrying the error payload", async () => {
    const stream = parseResponsesEvents(
      frames([
        JSON.stringify({
          type: "response.failed",
          response: { id: "r1", error: { code: "server_overloaded", message: "boom" } },
        }),
      ]),
      { provider: "openai", fallbackModel: "gpt-5" },
    )
    let caught: unknown
    try {
      await collect(stream)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMError)
    const err = caught as LLMError
    expect(err.kind).toBe("server_error")
    expect(err.message).toContain("server_overloaded")
  })
})

// ─── (c) response.incomplete ⇒ reason-mapped stop + usage preserved ──────────

describe("HELL-PF-C — response.incomplete maps reason and preserves usage", () => {
  const completedThenIncomplete = (reason: string): string[] => [
    JSON.stringify({
      type: "response.completed",
      response: { id: "r1", model: "gpt-5", usage: { input_tokens: 11, output_tokens: 7 } },
    }),
    JSON.stringify({
      type: "response.incomplete",
      response: { incomplete_details: { reason } },
    }),
  ]

  // Drive ONLY the incomplete event but with usage accumulated earlier in the
  // same stream — usage is captured at response.completed.
  const usageThenIncomplete = (reason: string): string[] => completedThenIncomplete(reason)

  test("max_output_tokens ⇒ stop_reason max_tokens (recovery will continue-nudge)", async () => {
    const events = await collect(
      parseResponsesEvents(frames(usageThenIncomplete("max_output_tokens")), {
        provider: "openai",
        fallbackModel: "gpt-5",
      }),
    )
    const stop = events.find((e) => e.type === "message_stop")
    expect(stop && "stop_reason" in stop ? stop.stop_reason : undefined).toBe("max_tokens")
  })

  test("content_filter ⇒ stop_reason content_filtered (terminal refusal downstream)", async () => {
    const events = await collect(
      parseResponsesEvents(frames(usageThenIncomplete("content_filter")), {
        provider: "openai",
        fallbackModel: "gpt-5",
      }),
    )
    const stop = events.find((e) => e.type === "message_stop")
    expect(stop && "stop_reason" in stop ? stop.stop_reason : undefined).toBe("content_filtered")
  })

  test("unknown incomplete reason ⇒ stop_reason error (does NOT flatten to a benign stop)", async () => {
    const events = await collect(
      parseResponsesEvents(frames(usageThenIncomplete("some_new_reason")), {
        provider: "openai",
        fallbackModel: "gpt-5",
      }),
    )
    const stop = events.find((e) => e.type === "message_stop")
    expect(stop && "stop_reason" in stop ? stop.stop_reason : undefined).toBe("error")
  })

  test("usage event is emitted BEFORE the message_stop on incomplete (no dropped accounting)", async () => {
    const events = await collect(
      parseResponsesEvents(frames(usageThenIncomplete("max_output_tokens")), {
        provider: "openai",
        fallbackModel: "gpt-5",
      }),
    )
    const usageIdx = events.findIndex((e) => e.type === "usage")
    const stopIdx = events.findIndex((e) => e.type === "message_stop")
    expect(usageIdx).toBeGreaterThanOrEqual(0)
    expect(stopIdx).toBeGreaterThan(usageIdx)
    const usage = events[usageIdx]
    expect(usage && usage.type === "usage" ? usage.outputTokens : undefined).toBe(7)
  })
})
