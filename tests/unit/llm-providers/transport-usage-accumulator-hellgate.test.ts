/**
 * ★ CONTRACT — G7-01 §transport usage accumulator.
 *
 *   All 4 Anthropic transport adapters (Bedrock / Vertex / Mantle / Foundry)
 *   MUST thread ONE `UsageAccumulator` per stream through `mapRawEvent`,
 *   exactly as `AnthropicAdapter.stream` does (anthropic.ts hoists the
 *   accumulator above the for-await loop). `absorbMessageStart` mutates the
 *   accumulator at `message_start` (inputTokens / cacheReadTokens /
 *   cacheCreationTokens / resolved model) and `finishOnMessageDelta` reads it
 *   back at the terminal `message_delta` to build the `usage` StreamEvent.
 *
 *   The defect this pins: passing a FRESH `{ model }` literal per event
 *   discards everything absorbed at `message_start`, so the emitted `usage`
 *   event carries `inputTokens: 0`, no cache buckets, and the config model
 *   instead of the stream-resolved one — a silent cost under-count on every
 *   non-public transport (the usage/cost campaign prices off this event).
 */
import { describe, expect, test } from "bun:test"
import { type BedrockClientFactory, BedrockProviderAdapter } from "@/llm/providers/bedrock-adapter"
import { type FoundryClientFactory, FoundryProviderAdapter } from "@/llm/providers/foundry-adapter"
import { type MantleClientFactory, MantleProviderAdapter } from "@/llm/providers/mantle-adapter"
import type { LlmProvider } from "@/llm/providers/provider-port"
import { type VertexClientFactory, VertexProviderAdapter } from "@/llm/providers/vertex-adapter"

/** Raw SDK event sequence: `message_start` carries the prompt-side counts
 *  (input + both cache buckets) and the RESOLVED model; the terminal
 *  `message_delta` carries only the completion count. A per-event fresh
 *  accumulator loses everything from the first event by the time the last
 *  one builds the usage event. */
async function* fakeUsageStream(): AsyncGenerator<unknown> {
  yield {
    type: "message_start",
    message: {
      model: "claude-resolved-on-wire",
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 8,
      },
    },
  }
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }
  yield { type: "content_block_stop", index: 0 }
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 57 } }
  yield { type: "message_stop" }
}

/** Minimal fake SDK client shared by all 4 transports (same messages.create
 *  surface). Each case casts it to its adapter's factory type. */
const fakeClient = {
  messages: {
    async create(): Promise<AsyncIterable<never>> {
      return fakeUsageStream() as AsyncIterable<never>
    },
  },
}

const cases: ReadonlyArray<{ name: string; build: () => LlmProvider }> = [
  {
    name: "bedrock",
    build: () =>
      new BedrockProviderAdapter(
        { providerId: "bedrock", model: "anthropic.claude-3-5-sonnet-20241022-v2:0", auth: {} },
        { clientFactory: (() => fakeClient) as BedrockClientFactory },
      ),
  },
  {
    name: "vertex",
    build: () =>
      new VertexProviderAdapter(
        {
          providerId: "vertex",
          model: "claude-sonnet-4@20250514",
          auth: { gcpProjectId: "my-proj", gcpLocation: "us-east5" },
        },
        { clientFactory: (() => fakeClient) as VertexClientFactory },
      ),
  },
  {
    name: "mantle",
    build: () =>
      new MantleProviderAdapter(
        { providerId: "mantle", model: "claude-sonnet-4-6", auth: { mantleToken: "t" } },
        { clientFactory: (() => fakeClient) as MantleClientFactory },
      ),
  },
  {
    name: "foundry",
    build: () =>
      new FoundryProviderAdapter(
        {
          providerId: "foundry",
          model: "claude-sonnet-4-foundry",
          auth: { azureResource: "acme", azureApiKey: "k-test" },
        },
        { clientFactory: (() => fakeClient) as FoundryClientFactory },
      ),
  },
]

describe("transport adapters — usage accumulator hoisted per stream (G7-01)", () => {
  for (const c of cases) {
    test(`${c.name}: usage event carries message_start input/cache tokens + resolved model`, async () => {
      const a = c.build()
      const events: Array<Record<string, unknown> & { type: string }> = []
      for await (const ev of a.stream({ messages: [], tools: [] })) {
        events.push(ev as Record<string, unknown> & { type: string })
      }
      const usage = events.filter((e) => e.type === "usage")
      expect(usage).toEqual([
        {
          type: "usage",
          inputTokens: 120,
          outputTokens: 57,
          cacheReadTokens: 40,
          cacheCreationTokens: 8,
          model: "claude-resolved-on-wire",
        },
      ])
      // Ordering invariant (mirrors anthropic.ts): usage precedes message_stop.
      const usageIdx = events.findIndex((e) => e.type === "usage")
      const stopIdx = events.findIndex((e) => e.type === "message_stop")
      expect(usageIdx).toBeGreaterThanOrEqual(0)
      expect(stopIdx).toBeGreaterThan(usageIdx)
    })
  }
})
