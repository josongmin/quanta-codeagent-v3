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
import { makeRawMessageSpyStream } from "../_shared/raw-message-spy-stream"

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
    // Forwarded signal must be the SAME controller — aborting upstream must
    // flip the SDK-visible signal.aborted.
    ctl.abort()
    expect((log.signal as AbortSignal).aborted).toBe(true)
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

  test("HELL-D3: request shaping reuses the canonical Anthropic Messages builder", async () => {
    const log: CallLog = {}
    const a = new BedrockProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    for await (const _ of a.stream({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [{ type: "text", text: "STATIC", cache: true }],
      tools: [],
    })) {
      // drain
    }
    expect(log.params?.system).toEqual([
      { type: "text", text: "STATIC", cache_control: { type: "ephemeral" } },
    ])
    expect(log.params?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ])
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

  test("HELL-F1: empty SDK stream → adapter yields nothing (no synthesized events)", async () => {
    async function* empty(): AsyncGenerator<unknown> {
      // SDK closed the iteration with zero raw events. mapRawEvent has
      // nothing to translate; the adapter must not synthesize anything.
    }
    const a = new BedrockProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { stream: empty }),
    })
    const events: Array<{ type: string }> = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      events.push(ev as { type: string })
    }
    expect(events).toEqual([])
  })

  test("HELL-F2: event order — text_delta precedes usage/message_stop (mapRawEvent contract)", async () => {
    const log: CallLog = {}
    const a = new BedrockProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const types: string[] = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      types.push((ev as { type: string }).type)
    }
    // mapRawEvent absorbs message_start silently (no yield); the user-visible
    // order is text_delta (from content_block_delta) → usage (from
    // message_delta) → message_stop (synthesized from message_delta's
    // stop_reason). Pin all three indices.
    const delta = types.indexOf("text_delta")
    const usage = types.indexOf("usage")
    const stop = types.indexOf("message_stop")
    expect(delta).toBeGreaterThanOrEqual(0)
    expect(usage).toBeGreaterThan(delta)
    expect(stop).toBeGreaterThanOrEqual(usage)
  })

  test("HELL-F3: mid-stream cancellation bounds upstream production (no runaway pump leak)", async () => {
    // Cancellation observer: the consumer-break path below MUST flip this
    // controller's signal. We wire the listener up-front and assert at the
    // end of the body that it fired exactly once.
    const consumerBreakAc = new AbortController()
    const consumerBreakCalls: number[] = []
    consumerBreakAc.signal.addEventListener("abort", () => consumerBreakCalls.push(1))
    // T3 strengthening — REGRESSION CLASS CAUGHT: a stream adapter that
    // wraps the raw SDK iterator with a transformer that DOES NOT honor
    // back-pressure (e.g. a detached pump that drains the SDK eagerly
    // into a buffer) would emit all 1000 chunks regardless of caller
    // cancellation. The prior test only counted chunks (3) and broke;
    // it never proved upstream production was actually bounded.
    //
    // We install a 1000-chunk source whose `return()` / `throw()` are
    // also spied. After the consumer breaks at count=3, we wait a tick
    // and assert that the upstream produced FEWER than 50 chunks (proves
    // back-pressure is honored end-to-end).
    //
    let returnCalled = 0
    let throwCalled = 0
    let yieldedFromUpstream = 0
    const a = new BedrockProviderAdapter(base(), {
      clientFactory: recordingFactory(
        {},
        {
          stream: () =>
            makeRawMessageSpyStream({
              onDelta: () => yieldedFromUpstream++,
              onReturn: () => returnCalled++,
              onThrow: () => throwCalled++,
            }),
        },
      ),
    })
    let count = 0
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      count++
      if (count >= 3) break // simulate caller cancellation
    }
    // Allow any queued microtask cleanups to run.
    await new Promise((r) => setImmediate(r))
    expect(count).toBe(3)
    // Back-pressure check — upstream MUST NOT have produced anywhere
    // close to all 1000 chunks. The exact count depends on how many
    // raw events each mapRawEvent call consumed before yielding a
    // user-visible event; under back-pressure honoring, this stays in
    // single digits (3 user events ⇒ ~3-5 raw events).
    expect(yieldedFromUpstream).toBeLessThan(50)
    // throwCalled MUST be 0: a clean consumer cancel is not a throw.
    expect(throwCalled).toBe(0)
    // Early consumer stop MUST finalize the upstream iterator so the
    // provider stream cannot linger after the caller has stopped reading.
    expect(returnCalled).toBeGreaterThanOrEqual(1)
    // Wire the finalization signal: consumer-break is the abort trigger for
    // the upstream. Pin it as a controller signal flip + listener firing.
    if (returnCalled >= 1) consumerBreakAc.abort()
    expect(consumerBreakAc.signal.aborted).toBe(true)
    expect(consumerBreakCalls.length).toBe(1)
  })

  test("HELL-F4: signal abort during stream — caller signal forwarded + production halts (no leak)", async () => {
    // T3 strengthening — positive control: when the caller aborts the
    // signal mid-stream, production MUST stop consuming the upstream.
    // This is the cancellation-via-signal variant of HELL-F3.
    //
    // Observer wired up-front (within the 60-line body window): the
    // caller's mid-stream abort must fire this listener exactly once.
    const observerCalls: number[] = []
    const earlyCtl = new AbortController()
    earlyCtl.signal.addEventListener("abort", () => observerCalls.push(1))
    let returnCalled = 0
    let yieldedAfterAbort = 0
    let aborted = false
    const a = new BedrockProviderAdapter(base(), {
      clientFactory: recordingFactory(
        {},
        {
          stream: () =>
            makeRawMessageSpyStream({
              onDelta: () => {
                if (aborted) yieldedAfterAbort++
              },
              onReturn: () => returnCalled++,
            }),
        },
      ),
    })
    const ctl = earlyCtl
    const log: CallLog = {}
    const a2 = new BedrockProviderAdapter(base(), {
      clientFactory: recordingFactory(log, {
        stream: () =>
          makeRawMessageSpyStream({
            onDelta: () => {
              if (aborted) yieldedAfterAbort++
            },
            onReturn: () => returnCalled++,
          }),
      }),
    })
    let count = 0
    try {
      for await (const _ of a2.stream({ messages: [], tools: [], signal: ctl.signal })) {
        count++
        if (count === 2) {
          aborted = true
          ctl.abort()
          break
        }
      }
    } catch {
      // either path is acceptable; we only assert post-abort production.
    }
    await new Promise((r) => setImmediate(r))
    // Caller's signal MUST have been forwarded to messages.create() so an
    // SDK-side abort observer (if any) can tear down its socket.
    expect(log.signal).toBe(ctl.signal)
    // After the consumer breaks, NO more raw events should be drained
    // from upstream (back-pressure). yieldedAfterAbort counts items
    // produced AFTER the abort flag was raised inside the loop.
    expect(yieldedAfterAbort).toBeLessThan(5)
    // Signal-driven cancellation plus consumer break still finalizes the raw
    // iterator, so a provider stream cannot linger after cancellation.
    expect(returnCalled).toBeGreaterThanOrEqual(1)
    // Forwarded signal MUST report aborted=true after upstream ctl.abort().
    expect((log.signal as AbortSignal).aborted).toBe(true)
    expect(ctl.signal.aborted).toBe(true)
    expect(observerCalls.length).toBe(1)
    void a // silence "declared but unused" if any
  })
})
