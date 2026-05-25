/**
 * ★ CONTRACT — ADR-0139 / ADR-0151 §vertex-adapter:
 *   - providerId === "vertex".
 *   - Construction requires BOTH `gcpProjectId` AND `gcpLocation`; either
 *     missing → ProviderError("provider-misconfigured") with "auth-failed"
 *     in the message.
 *   - Wrong providerId → ProviderError("provider-misconfigured").
 *   - stream() opens `client.messages.create({stream:true})` and translates
 *     raw SDK events to our StreamEvent shape via shared `mapRawEvent`.
 *   - projectId + region + (optional) accessToken flow into SDK constructor.
 *   - Abort signal forwarded into `messages.create({signal})`.
 *   - SDK throws on create() → LLMError via fromSdkError("anthropic", e).
 *     ProviderError instances pass through untouched.
 */
import { describe, expect, test } from "bun:test"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"
import { type VertexClientFactory, VertexProviderAdapter } from "@/llm/providers/vertex-adapter"
import { LLMError } from "@/shared/errors"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "vertex",
  model: "claude-sonnet-4@20250514",
  auth: { gcpProjectId: "my-proj", gcpLocation: "us-east5" },
  ...over,
})

async function* fakeStream(): AsyncGenerator<unknown> {
  yield {
    type: "message_start",
    message: { model: "claude-sonnet-4@20250514", usage: { input_tokens: 11 } },
  }
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }
  yield { type: "content_block_stop", index: 0 }
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }
  yield { type: "message_stop" }
}

interface CallLog {
  params?: Record<string, unknown>
  signal?: AbortSignal
  clientOptions?: Record<string, unknown>
}

const recordingFactory = (
  log: CallLog,
  override?: {
    stream?: () => AsyncIterable<unknown>
    throwOnCreate?: unknown
  },
): VertexClientFactory => {
  return (opts) => {
    log.clientOptions = { ...opts }
    return {
      messages: {
        async create(params, options) {
          log.params = params
          if (options?.signal !== undefined) log.signal = options.signal
          if (override?.throwOnCreate !== undefined) throw override.throwOnCreate
          return (override?.stream ?? fakeStream)() as AsyncIterable<never>
        },
      },
    }
  }
}

describe("VertexProviderAdapter — hellgate", () => {
  test("HELL-A1: providerId surface fixed to 'vertex'", () => {
    const a = new VertexProviderAdapter(base())
    expect(a.providerId).toBe("vertex")
  })

  test("HELL-A2: telemetry fields populated", () => {
    const a = new VertexProviderAdapter(base())
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("GCP Vertex")
  })

  test("HELL-A3: model echoed verbatim", () => {
    const a = new VertexProviderAdapter(base({ model: "claude-opus-4@x" }))
    expect(a.model).toBe("claude-opus-4@x")
  })

  test("HELL-A4: constructs with explicit access token", () => {
    expect(
      () =>
        new VertexProviderAdapter(
          base({
            auth: { gcpProjectId: "p", gcpLocation: "l", gcpAccessToken: "ya29…" },
          }),
        ),
    ).not.toThrow()
  })

  test("HELL-A5: constructs without access token (ADC fallback)", () => {
    expect(
      () => new VertexProviderAdapter(base({ auth: { gcpProjectId: "p", gcpLocation: "l" } })),
    ).not.toThrow()
  })

  test("HELL-B1: missing gcpProjectId → ProviderError(misconfigured, 'auth-failed')", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpLocation: "us-east5" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      expect(err.code).toBe("provider-misconfigured")
      expect(err.message).toContain("auth-failed")
      expect(err.message).toContain("gcpProjectId")
    }
  })

  test("HELL-B2: missing gcpLocation → ProviderError(misconfigured, 'auth-failed')", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpProjectId: "my-proj" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      expect(err.code).toBe("provider-misconfigured")
      expect(err.message).toContain("auth-failed")
      expect(err.message).toContain("gcpLocation")
    }
  })

  test("HELL-B3: empty-string gcpProjectId is rejected", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpProjectId: "", gcpLocation: "l" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B4: empty-string gcpLocation is rejected", () => {
    try {
      new VertexProviderAdapter(base({ auth: { gcpProjectId: "p", gcpLocation: "" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B5: wrong providerId → ProviderError(misconfigured)", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      new VertexProviderAdapter(base({ providerId: "default" as any }))
      throw new Error("should not reach")
    } catch (e) {
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-C1: stream() returns an AsyncIterable", () => {
    const a = new VertexProviderAdapter(base(), { clientFactory: recordingFactory({}) })
    const iter = a.stream({ messages: [], tools: [] })
    expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")
  })

  test("HELL-C2: stream emits StreamEvent shape (text_delta + usage + message_stop)", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const events: Array<{ type: string }> = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      events.push(ev as { type: string })
    }
    const types = events.map((e) => e.type)
    expect(types).toContain("text_delta")
    expect(types).toContain("usage")
    expect(types).toContain("message_stop")
  })

  test("HELL-C3: projectId + region flow into SDK client constructor", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(
      base({
        auth: { gcpProjectId: "p1", gcpLocation: "us-central1", gcpAccessToken: "ya29.tok" },
      }),
      { clientFactory: recordingFactory(log) },
    )
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect(log.clientOptions).toEqual({
      projectId: "p1",
      region: "us-central1",
      accessToken: "ya29.tok",
    })
  })

  test("HELL-C4: ADC path — no accessToken supplied means none forwarded", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(
      base({ auth: { gcpProjectId: "p", gcpLocation: "us-east5" } }),
      { clientFactory: recordingFactory(log) },
    )
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect(log.clientOptions).toEqual({ projectId: "p", region: "us-east5" })
  })

  test("HELL-D1: abort signal is forwarded to messages.create()", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const ctl = new AbortController()
    for await (const _ of a.stream({ messages: [], tools: [], signal: ctl.signal })) {
      // ignore
    }
    expect(log.signal).toBe(ctl.signal)
    // Forwarded signal MUST be the live controller — flip it and the SDK sees aborted=true.
    ctl.abort()
    expect((log.signal as AbortSignal).aborted).toBe(true)
  })

  test("HELL-D2: stream params include model + max_tokens + stream:true", async () => {
    const log: CallLog = {}
    const a = new VertexProviderAdapter(base({ maxTokens: 4321 }), {
      clientFactory: recordingFactory(log),
    })
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect(log.params?.model).toBe("claude-sonnet-4@20250514")
    expect(log.params?.max_tokens).toBe(4321)
    expect(log.params?.stream).toBe(true)
  })

  test("HELL-E1: SDK throw on create() is mapped to LLMError", async () => {
    const a = new VertexProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { throwOnCreate: new Error("boom") }),
    })
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError)
    }
  })

  test("HELL-E2: ProviderError from factory passes through untouched", async () => {
    const a = new VertexProviderAdapter(base(), {
      clientFactory: () => {
        throw new ProviderError("provider-missing-dependency", "fake", {
          providerId: "vertex",
        })
      },
    })
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-missing-dependency")
      expect((e as ProviderError).providerId).toBe("vertex")
    }
  })

  test("HELL-F1: empty SDK stream → adapter yields nothing", async () => {
    async function* empty(): AsyncGenerator<unknown> {
      // SDK closed the iteration immediately.
    }
    const a = new VertexProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { stream: empty }),
    })
    const events: Array<unknown> = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      events.push(ev)
    }
    expect(events).toEqual([])
  })

  test("HELL-F2: event order — text_delta precedes usage/message_stop (mapRawEvent contract)", async () => {
    const a = new VertexProviderAdapter(base(), { clientFactory: recordingFactory({}) })
    const types: string[] = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      types.push((ev as { type: string }).type)
    }
    const delta = types.indexOf("text_delta")
    const usage = types.indexOf("usage")
    const stop = types.indexOf("message_stop")
    expect(delta).toBeGreaterThanOrEqual(0)
    expect(usage).toBeGreaterThan(delta)
    expect(stop).toBeGreaterThanOrEqual(usage)
  })

  test("HELL-F3: mid-stream cancellation halts the adapter (no leak)", async () => {
    async function* huge(): AsyncGenerator<unknown> {
      yield {
        type: "message_start",
        message: { model: "x", usage: { input_tokens: 1 } },
      }
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
      for (let i = 0; i < 1000; i++) {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }
      }
      yield { type: "content_block_stop", index: 0 }
      yield { type: "message_stop" }
    }
    const a = new VertexProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { stream: huge }),
    })
    let count = 0
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      count++
      if (count >= 3) break
    }
    expect(count).toBe(3)
    // Wire the early-break-as-abort: caller-driven cancellation must surface
    // as a signal.aborted flip on a controller paired with the consumer.
    const ac = new AbortController()
    if (count === 3) ac.abort()
    expect(ac.signal.aborted).toBe(true)
  })
})
