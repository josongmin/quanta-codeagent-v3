/**
 * TDD — S3 (jul-03): reasoning-token split must FLOW from the Responses wire
 * through the `usage` StreamEvent, not get dropped.
 *
 * CONFIRMED gap: `extractResponsesUsage` parses
 * `response.usage.output_tokens_details.reasoning_tokens` into
 * `AccumulatedUsage.reasoning`, but `emitUsage` (openai-responses-wire.ts) only
 * forwarded input/output/cached — the reasoning split was silently dropped on
 * the `usage` StreamEvent, so no downstream sink (gauge/recorder/ledger) could
 * see how many output tokens were reasoning.
 *
 * The fix: `emitUsage` forwards `reasoningTokens?` on the `usage` StreamEvent
 * (OPTIONAL ⇒ Anthropic byte-identical — Anthropic bills thinking as output and
 * emits no reasoning split, so the field is simply omitted, never guessed).
 *
 * These are LEAF tests: they drive the exported `parseResponsesEvents` with a
 * synthetic `response.completed` SSE frame and assert on the emitted `usage`
 * StreamEvent — the wire→event seam, end to end, with no fabrication.
 */
import { describe, expect, test } from "bun:test"
import { parseResponsesEvents } from "./openai-responses-wire"
import type { StreamEvent } from "./types"

type Frame = { event?: string; data: string }

async function* framesFrom(frames: readonly Frame[]): AsyncGenerator<Frame> {
  for (const f of frames) yield f
}

const collect = async (frames: readonly Frame[]): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of parseResponsesEvents(framesFrom(frames), {
    provider: "openai",
    fallbackModel: "gpt-5",
  })) {
    out.push(ev)
  }
  return out
}

const usageOf = (events: StreamEvent[]): Extract<StreamEvent, { type: "usage" }> => {
  const usage = events.find((e): e is Extract<StreamEvent, { type: "usage" }> => e.type === "usage")
  if (usage === undefined) throw new Error("no usage event emitted")
  return usage
}

describe("Responses wire — reasoning-token split on the usage StreamEvent", () => {
  test("forwards reasoning_tokens as reasoningTokens on the usage event", async () => {
    const events = await collect([
      {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            model: "gpt-5",
            usage: {
              input_tokens: 100,
              output_tokens: 40,
              output_tokens_details: { reasoning_tokens: 30 },
            },
          },
        }),
      },
    ])
    const usage = usageOf(events)
    // Baseline assertions that would be true regardless (avoid a vacuous test).
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(40)
    // The load-bearing assertion: the reasoning split survives to the event.
    expect(usage.reasoningTokens).toBe(30)
  })

  test("omits reasoningTokens entirely when the provider reports no split (Anthropic byte-identical)", async () => {
    const events = await collect([
      {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_2",
            model: "gpt-5",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
      },
    ])
    const usage = usageOf(events)
    expect(usage.outputTokens).toBe(5)
    // No synthetic/guessed split — the key must be ABSENT, not 0.
    expect("reasoningTokens" in usage).toBe(false)
    expect(usage.reasoningTokens).toBeUndefined()
  })

  test("forwards a zero reasoning split verbatim (0 is a real provider value, not omission)", async () => {
    const events = await collect([
      {
        data: JSON.stringify({
          type: "response.completed",
          response: {
            model: "gpt-5",
            usage: {
              input_tokens: 20,
              output_tokens: 20,
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        }),
      },
    ])
    const usage = usageOf(events)
    // reasoning_tokens:0 is an explicit provider datum — must be forwarded, not
    // dropped by a truthiness check.
    expect(usage.reasoningTokens).toBe(0)
    expect("reasoningTokens" in usage).toBe(true)
  })
})
