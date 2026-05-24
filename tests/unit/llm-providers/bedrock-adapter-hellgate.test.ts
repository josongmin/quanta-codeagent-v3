/**
 * ★ CONTRACT — ADR-0139 / ADR-0151 §bedrock-adapter:
 *   - providerId === "bedrock".
 *   - Construction succeeds with EMPTY auth (SDK default cred chain).
 *   - Wrong providerId → ProviderError("provider-misconfigured").
 *   - stream() opens `client.messages.create({stream:true})` and translates
 *     raw SDK events to our StreamEvent shape via the shared `mapRawEvent`.
 *   - Auth fields flow into the SDK client constructor (awsAccessKey /
 *     awsSecretKey / awsSessionToken / awsRegion), exactOptional honest.
 *   - `signal` from StreamInput is forwarded to `messages.create()` so the
 *     SDK can abort the in-flight HTTP request.
 *   - SDK throws on create() are wrapped into LLMError via fromSdkError
 *     (provider="anthropic"); thrown ProviderError instances pass through
 *     untouched (so missing-dependency / misconfigured still flow up typed).
 *   - exactOptional credentials: only supplied keys are forwarded (no
 *     `undefined` shadowed onto the SDK options).
 */
import { describe, expect, test } from "bun:test"
import { type BedrockClientFactory, BedrockProviderAdapter } from "@/llm/providers/bedrock-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"
import { LLMError } from "@/shared/errors"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "bedrock",
  model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  auth: {},
  ...over,
})

/** A tiny RawMessageStreamEvent sequence sufficient to validate translation
 *  through `mapRawEvent` without touching the real SDK. */
async function* fakeStream(): AsyncGenerator<unknown> {
  yield {
    type: "message_start",
    message: { model: "anthropic.claude-3-5-sonnet-20241022-v2:0", usage: { input_tokens: 7 } },
  }
  yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }
  yield { type: "content_block_stop", index: 0 }
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }
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
): BedrockClientFactory => {
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

describe("BedrockProviderAdapter — hellgate", () => {
  test("HELL-A1: providerId surface fixed to 'bedrock'", () => {
    const a = new BedrockProviderAdapter(base())
    expect(a.providerId).toBe("bedrock")
  })

  test("HELL-A2: telemetry fields populated", () => {
    const a = new BedrockProviderAdapter(base())
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("AWS Bedrock")
  })

  test("HELL-A3: model echoed verbatim", () => {
    const a = new BedrockProviderAdapter(base({ model: "custom-model" }))
    expect(a.model).toBe("custom-model")
  })

  test("HELL-A4: constructs with empty auth (default cred chain)", () => {
    expect(() => new BedrockProviderAdapter(base({ auth: {} }))).not.toThrow()
  })

  test("HELL-A5: constructs with full static AWS creds", () => {
    expect(
      () =>
        new BedrockProviderAdapter(
          base({
            auth: {
              awsAccessKeyId: "AKIA…",
              awsSecretAccessKey: "secret",
              awsSessionToken: "session",
              awsRegion: "us-west-2",
            },
          }),
        ),
    ).not.toThrow()
  })

  test("HELL-B1: wrong providerId → ProviderError(misconfigured)", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      new BedrockProviderAdapter(base({ providerId: "default" as any }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-C1: stream() returns an AsyncIterable", () => {
    const a = new BedrockProviderAdapter(base(), { clientFactory: recordingFactory({}) })
    const iter = a.stream({ messages: [], tools: [] })
    expect(typeof (iter as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function")
  })

  test("HELL-C2: stream emits StreamEvent shape (text_delta + usage + message_stop)", async () => {
    const log: CallLog = {}
    const a = new BedrockProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const events: Array<{ type: string }> = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      events.push(ev as { type: string })
    }
    const types = events.map((e) => e.type)
    // text_delta from the content_block_delta arm, usage from message_delta,
    // message_stop from message_delta's stop_reason synthesizer (mapRawEvent).
    expect(types).toContain("text_delta")
    expect(types).toContain("usage")
    expect(types).toContain("message_stop")
  })

  test("HELL-C3: auth fields flow into SDK client constructor (exactOptional honest)", async () => {
    const log: CallLog = {}
    const a = new BedrockProviderAdapter(
      base({
        auth: {
          awsAccessKeyId: "AKIA",
          awsSecretAccessKey: "shh",
          awsSessionToken: "tok",
          awsRegion: "us-west-2",
        },
      }),
      { clientFactory: recordingFactory(log) },
    )
    // Drain once to trigger lazy client construction.
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect(log.clientOptions).toEqual({
      awsAccessKey: "AKIA",
      awsSecretKey: "shh",
      awsSessionToken: "tok",
      awsRegion: "us-west-2",
    })
  })

  test("HELL-C4: empty auth → empty SDK options (no `undefined` shadowed in)", async () => {
    const log: CallLog = {}
    const a = new BedrockProviderAdapter(base({ auth: {} }), {
      clientFactory: recordingFactory(log),
    })
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect(log.clientOptions).toEqual({})
  })

  test("HELL-D1: abort signal is forwarded to messages.create()", async () => {
    const log: CallLog = {}
    const a = new BedrockProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const ctl = new AbortController()
    for await (const _ of a.stream({ messages: [], tools: [], signal: ctl.signal })) {
      // ignore
    }
    expect(log.signal).toBe(ctl.signal)
  })

  test("HELL-D2: stream params include model + max_tokens + stream:true", async () => {
    const log: CallLog = {}
    const a = new BedrockProviderAdapter(base({ maxTokens: 1234 }), {
      clientFactory: recordingFactory(log),
    })
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect(log.params?.model).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0")
    expect(log.params?.max_tokens).toBe(1234)
    expect(log.params?.stream).toBe(true)
  })

  test("HELL-E1: SDK throw on create() is mapped to LLMError", async () => {
    const a = new BedrockProviderAdapter(base(), {
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

  test("HELL-E2: ProviderError from factory passes through untouched (missing-dep typed-flow)", async () => {
    const a = new BedrockProviderAdapter(base(), {
      clientFactory: () => {
        throw new ProviderError("provider-missing-dependency", "fake", {
          providerId: "bedrock",
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
      expect((e as ProviderError).providerId).toBe("bedrock")
    }
  })
})
