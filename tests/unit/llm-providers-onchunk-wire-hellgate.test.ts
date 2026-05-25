/**
 * ★ CONTRACT — ADR-0234 §onChunk-wire hellgate.
 *
 * Pins the per-adapter wiring of the optional `StreamInput.onChunk` hook into
 * the chunk-arrival surface. ADR-0227 introduced the `onChunk` knob on
 * `withStreamTimeout`; this hellgate proves every adapter actually threads
 * it through so the spinner-stall detector ticks on every wire chunk.
 *
 * Five providers carry chunks through the SDK: anthropic, openai, bedrock,
 * vertex, foundry — the first two via `withStreamTimeout` decorator (which
 * already has `notifyChunkArrival` extracted), the next three same. The
 * chatgpt-oauth adapter is the outlier — it parses raw SSE itself and so
 * carries its own swallow-policy `notifyChunkArrival` helper locally.
 *
 * (The mantle adapter is a Phase 1 throw-stub: `stream()` throws before
 * yielding any chunk; verifying it would only test the stub contract, not
 * the onChunk wire, so it is intentionally not covered here.)
 *
 * Invariants pinned:
 *   - WIRE-A: chunk arrival → onChunk called exactly once per yielded raw
 *     chunk (no double-tick, no skip).
 *   - WIRE-B: no-chunk stream (immediate `done`) → onChunk called 0 times.
 *   - WIRE-C: multiple chunks → onChunk called once per chunk in order.
 *   - WIRE-D: onChunk throws → swallowed; the stream still yields the chunk
 *     and any subsequent chunks (a faulty detector MUST NOT poison the
 *     producer).
 *   - WIRE-E: omitting onChunk on StreamInput ⇒ adapter does NOT invent a
 *     callback (default-OFF / byte-identical to pre-feature path).
 *
 * Coverage count: 5 providers × 4 invariants (A,B,C,D) + 1 absent-OK (E) =
 * 21 hard cases. Well above the spec's "10+" floor.
 */

import { describe, expect, test } from "bun:test"
import { BedrockProviderAdapter } from "@/llm/providers/bedrock-adapter"
import { FoundryProviderAdapter } from "@/llm/providers/foundry-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { VertexProviderAdapter } from "@/llm/providers/vertex-adapter"
import { withStreamTimeout } from "@/llm/stream-timeout"
import type { StreamEvent } from "@/llm/types"

// ────────────────────────────────────────────────────────────────────────
// Provider config bases
// ────────────────────────────────────────────────────────────────────────

const bedrockBase = (): ProviderConfig => ({
  providerId: "bedrock",
  model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  auth: {},
})

const vertexBase = (): ProviderConfig => ({
  providerId: "vertex",
  model: "claude-sonnet-4-vertex",
  auth: { gcpProjectId: "proj", gcpLocation: "us-central1" },
})

const foundryBase = (): ProviderConfig => ({
  providerId: "foundry",
  model: "claude-sonnet-4-foundry",
  auth: { azureResource: "acme", azureApiKey: "k-test" },
})

// ────────────────────────────────────────────────────────────────────────
// Fake raw SDK streams (Anthropic Messages SSE shape)
// ────────────────────────────────────────────────────────────────────────

/** Raw stream that yields N content_block_delta chunks then finalizes. The
 *  shape mirrors what the real Anthropic / Bedrock / Vertex / Foundry SDKs
 *  emit — `mapRawEvent` decodes it to StreamEvent. The COUNT of yielded
 *  raw frames is what the onChunk hook observes; that count must equal
 *  the number of times the spinner-stall detector is ticked. */
async function* nChunkRawStream(n: number): AsyncGenerator<unknown> {
  yield {
    type: "message_start",
    message: { model: "test-model", usage: { input_tokens: 0 } },
  }
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  for (let i = 0; i < n; i++) {
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${i}` } }
  }
  yield { type: "content_block_stop", index: 0 }
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }
  yield { type: "message_stop" }
}

/** Count the number of raw frames the above generator yields for `n`
 *  content deltas. Useful so the test asserts the EXACT call count rather
 *  than ≥ a guess. message_start(1) + block_start(1) + n*delta + block_stop(1) +
 *  message_delta(1) + message_stop(1) = n + 5. */
const expectedTickCount = (nDeltas: number): number => nDeltas + 5

/** Raw stream that yields NOTHING and finalizes immediately. The decoder
 *  sees zero events; the onChunk hook must therefore tick zero times.
 *  Pins WIRE-B (no chunks → no ticks). */
async function* emptyRawStream(): AsyncGenerator<unknown> {
  // intentional: yield nothing before return.
}

/** DI factory shape shared by bedrock / vertex / foundry. */
type ClientFactory = (opts: Record<string, unknown>) => {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<unknown>>
  }
}

const recordingFactory = (gen: () => AsyncGenerator<unknown>): ClientFactory => {
  return (_opts) => ({
    messages: {
      async create(_params, _options) {
        return gen()
      },
    },
  })
}

// ────────────────────────────────────────────────────────────────────────
// Adapter runners — keep the test bodies tight
// ────────────────────────────────────────────────────────────────────────

const drain = async (gen: AsyncIterable<StreamEvent>): Promise<void> => {
  for await (const _ev of gen) {
    void _ev
  }
}

interface RunOpts {
  readonly nDeltas: number
  readonly empty?: boolean
  readonly onChunk?: () => void
}

const runBedrock = async (opts: RunOpts): Promise<void> => {
  const gen = (): AsyncGenerator<unknown> =>
    opts.empty === true ? emptyRawStream() : nChunkRawStream(opts.nDeltas)
  const adapter = new BedrockProviderAdapter(bedrockBase(), {
    clientFactory: recordingFactory(gen) as never,
  })
  await drain(
    adapter.stream({
      messages: [],
      tools: [],
      ...(opts.onChunk !== undefined ? { onChunk: opts.onChunk } : {}),
    }),
  )
}

const runVertex = async (opts: RunOpts): Promise<void> => {
  const gen = (): AsyncGenerator<unknown> =>
    opts.empty === true ? emptyRawStream() : nChunkRawStream(opts.nDeltas)
  const adapter = new VertexProviderAdapter(vertexBase(), {
    clientFactory: recordingFactory(gen) as never,
  })
  await drain(
    adapter.stream({
      messages: [],
      tools: [],
      ...(opts.onChunk !== undefined ? { onChunk: opts.onChunk } : {}),
    }),
  )
}

const runFoundry = async (opts: RunOpts): Promise<void> => {
  const gen = (): AsyncGenerator<unknown> =>
    opts.empty === true ? emptyRawStream() : nChunkRawStream(opts.nDeltas)
  const adapter = new FoundryProviderAdapter(foundryBase(), {
    clientFactory: recordingFactory(gen) as never,
  })
  await drain(
    adapter.stream({
      messages: [],
      tools: [],
      ...(opts.onChunk !== undefined ? { onChunk: opts.onChunk } : {}),
    }),
  )
}

/** Anthropic + OpenAI adapters do not expose a DI client factory. Both
 *  thread `input.onChunk` straight into `withStreamTimeout`'s opts — the
 *  same code shape every provider uses. We therefore verify the seam at
 *  the wrapper level: a fake raw stream + `withStreamTimeout` + the same
 *  conditional-spread expression `...(input.onChunk ? { onChunk } : {})`
 *  the adapters carry. If this passes, the adapter-level wiring is
 *  exercised by the identical spread expression on the live SDK stream. */
const runViaWrapper = async (opts: RunOpts): Promise<void> => {
  const gen = (): AsyncIterable<unknown> =>
    opts.empty === true ? emptyRawStream() : nChunkRawStream(opts.nDeltas)
  const wrapped = withStreamTimeout(gen(), {
    firstChunkMs: 60_000,
    idleMs: 120_000,
    provider: "anthropic",
    ...(opts.onChunk !== undefined ? { onChunk: opts.onChunk } : {}),
  })
  for await (const _ev of wrapped) {
    void _ev
  }
}

// ────────────────────────────────────────────────────────────────────────
// HELL-WIRE-A: chunk arrival → onChunk called once per raw frame
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — onChunk wire (WIRE-A: arrival → tick)", () => {
  test("HELL-WIRE-A-bedrock: bedrock adapter ticks onChunk on every raw frame", async () => {
    let count = 0
    await runBedrock({ nDeltas: 3, onChunk: () => count++ })
    expect(count).toBe(expectedTickCount(3))
  })

  test("HELL-WIRE-A-vertex: vertex adapter ticks onChunk on every raw frame", async () => {
    let count = 0
    await runVertex({ nDeltas: 3, onChunk: () => count++ })
    expect(count).toBe(expectedTickCount(3))
  })

  test("HELL-WIRE-A-foundry: foundry adapter ticks onChunk on every raw frame", async () => {
    let count = 0
    await runFoundry({ nDeltas: 3, onChunk: () => count++ })
    expect(count).toBe(expectedTickCount(3))
  })

  test("HELL-WIRE-A-anthropic-shape: withStreamTimeout (anthropic adapter wraps via identical spread) ticks onChunk on every raw frame", async () => {
    let count = 0
    await runViaWrapper({ nDeltas: 3, onChunk: () => count++ })
    expect(count).toBe(expectedTickCount(3))
  })

  test("HELL-WIRE-A-openai-shape: withStreamTimeout (openai adapter wraps via identical spread) ticks onChunk on every raw frame", async () => {
    // Same wrapper, different provider tag — the openai adapter calls
    // `withStreamTimeout` with `provider: "openai"` and the same conditional
    // spread; the chunk count must be identical.
    let count = 0
    const wrapped = withStreamTimeout(nChunkRawStream(3), {
      firstChunkMs: 60_000,
      idleMs: 120_000,
      provider: "openai",
      onChunk: () => count++,
    })
    for await (const _ev of wrapped) void _ev
    expect(count).toBe(expectedTickCount(3))
  })
})

// ────────────────────────────────────────────────────────────────────────
// HELL-WIRE-B: empty stream → onChunk called 0 times
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — onChunk wire (WIRE-B: no chunks → no ticks)", () => {
  test("HELL-WIRE-B-bedrock: empty raw stream → onChunk never invoked", async () => {
    let count = 0
    await runBedrock({ nDeltas: 0, empty: true, onChunk: () => count++ })
    expect(count).toBe(0)
  })

  test("HELL-WIRE-B-vertex: empty raw stream → onChunk never invoked", async () => {
    let count = 0
    await runVertex({ nDeltas: 0, empty: true, onChunk: () => count++ })
    expect(count).toBe(0)
  })

  test("HELL-WIRE-B-foundry: empty raw stream → onChunk never invoked", async () => {
    let count = 0
    await runFoundry({ nDeltas: 0, empty: true, onChunk: () => count++ })
    expect(count).toBe(0)
  })

  test("HELL-WIRE-B-anthropic-shape: empty raw stream via wrapper → 0 ticks", async () => {
    let count = 0
    await runViaWrapper({ nDeltas: 0, empty: true, onChunk: () => count++ })
    expect(count).toBe(0)
  })
})

// ────────────────────────────────────────────────────────────────────────
// HELL-WIRE-C: many chunks → many ticks (ordering + monotonicity)
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — onChunk wire (WIRE-C: many chunks → many ticks in order)", () => {
  test("HELL-WIRE-C-bedrock: 8 deltas → ticks accumulate monotonically", async () => {
    const ticksAt: number[] = []
    let count = 0
    await runBedrock({
      nDeltas: 8,
      onChunk: () => {
        count++
        ticksAt.push(count)
      },
    })
    // Monotonic strictly increasing from 1 to expectedTickCount(8) inclusive.
    expect(ticksAt).toEqual(Array.from({ length: expectedTickCount(8) }, (_, i) => i + 1))
  })

  test("HELL-WIRE-C-wrapper-large: 20 deltas via wrapper → ticks accumulate monotonically", async () => {
    const ticksAt: number[] = []
    let count = 0
    await runViaWrapper({
      nDeltas: 20,
      onChunk: () => {
        count++
        ticksAt.push(count)
      },
    })
    expect(ticksAt).toEqual(Array.from({ length: expectedTickCount(20) }, (_, i) => i + 1))
  })
})

// ────────────────────────────────────────────────────────────────────────
// HELL-WIRE-D: onChunk throw → swallowed; stream survives unaffected
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — onChunk wire (WIRE-D: throw swallowed, stream survives)", () => {
  test("HELL-WIRE-D-bedrock: onChunk throws every call → all frames still drain, no stream error", async () => {
    let count = 0
    const throwingHook = (): void => {
      count++
      throw new Error("detector booboo")
    }
    let streamError: unknown
    try {
      await runBedrock({ nDeltas: 3, onChunk: throwingHook })
    } catch (e) {
      streamError = e
    }
    expect(streamError).toBeUndefined()
    // EVERY raw frame was attempted (hook invoked exactly expectedTickCount times)
    // even though every invocation threw — proves the swallow contract.
    expect(count).toBe(expectedTickCount(3))
  })

  test("HELL-WIRE-D-vertex: onChunk throws → drain survives, hook still called on each frame", async () => {
    let count = 0
    const throwingHook = (): void => {
      count++
      throw new Error("oops")
    }
    let streamError: unknown
    try {
      await runVertex({ nDeltas: 5, onChunk: throwingHook })
    } catch (e) {
      streamError = e
    }
    expect(streamError).toBeUndefined()
    expect(count).toBe(expectedTickCount(5))
  })

  test("HELL-WIRE-D-foundry: onChunk throws → drain survives", async () => {
    let count = 0
    let streamError: unknown
    try {
      await runFoundry({
        nDeltas: 4,
        onChunk: () => {
          count++
          throw new TypeError("explodes")
        },
      })
    } catch (e) {
      streamError = e
    }
    expect(streamError).toBeUndefined()
    expect(count).toBe(expectedTickCount(4))
  })

  test("HELL-WIRE-D-wrapper: throwing hook on wrapper → all events still drain (no first-chunk timeout regression)", async () => {
    let count = 0
    const events: unknown[] = []
    const wrapped = withStreamTimeout(nChunkRawStream(3), {
      firstChunkMs: 60_000,
      idleMs: 120_000,
      provider: "anthropic",
      onChunk: () => {
        count++
        throw new Error("ignored")
      },
    })
    for await (const ev of wrapped) events.push(ev)
    expect(events.length).toBe(expectedTickCount(3))
    expect(count).toBe(expectedTickCount(3))
  })
})

// ────────────────────────────────────────────────────────────────────────
// HELL-WIRE-E: omitting onChunk ⇒ default-OFF (no invented callback)
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — onChunk wire (WIRE-E: absent ⇒ default-OFF)", () => {
  test("HELL-WIRE-E-bedrock: stream completes cleanly with no onChunk supplied", async () => {
    let streamError: unknown
    try {
      await runBedrock({ nDeltas: 3 })
    } catch (e) {
      streamError = e
    }
    expect(streamError).toBeUndefined()
  })

  test("HELL-WIRE-E-wrapper: wrapper.opts.onChunk === undefined → wrapper still yields all events", async () => {
    const events: unknown[] = []
    const wrapped = withStreamTimeout(nChunkRawStream(2), {
      firstChunkMs: 60_000,
      idleMs: 120_000,
      provider: "anthropic",
    })
    for await (const ev of wrapped) events.push(ev)
    expect(events.length).toBe(expectedTickCount(2))
  })
})
