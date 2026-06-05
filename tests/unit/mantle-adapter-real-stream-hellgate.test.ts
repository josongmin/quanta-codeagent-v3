/**
 * ★ CONTRACT — ADR-0172 (Mantle graduation) §mantle-real-stream hellgate.
 *
 *   Mirrors the Foundry real-stream hellgate (ADR-0172 sibling) — same DI
 *   factory shape, same `recordingFactory` discipline, same translation
 *   coverage. The Mantle-specific arms pin:
 *     - SDK client options receive `authToken` / `baseURL` exactly as the
 *       typed auth bundle declares them (exactOptional honest — no `undefined`
 *       shadowed in).
 *     - Endpoint meta surface reflects the resolved auth bundle.
 *     - `mantleToken` REQUIRED → absent ⇒ ProviderError(provider-misconfigured)
 *       at construction.
 *     - DI client-ctor throw maps to ProviderError(provider-misconfigured).
 *     - SDK create() throw with AccessDenied / Unauthorized maps to
 *       ProviderError(provider-misconfigured); generic throw ⇒ LLMError.
 *     - Missing SDK (no clientFactory, package unpublished) ⇒ typed
 *       ProviderError(provider-missing-dependency) — NOT a crash.
 *     - Abort signal forwarded to messages.create(); pre-aborted ⇒ LLMError.
 *     - Stream events translate through `mapRawEvent` (text_delta / usage /
 *       message_stop emission).
 */
import { describe, expect, test } from "bun:test"
import {
  isMantleAdapterReady,
  MANTLE_SDK_NPM_URL,
  MANTLE_SDK_PACKAGE,
  type MantleClientFactory,
  MantleProviderAdapter,
  mantleProviderAdapter,
  tryImportMantleSdk,
} from "@/llm/providers/mantle-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"
import { LLMError } from "@/shared/errors"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "mantle",
  model: "claude-sonnet-4-6",
  auth: { mantleToken: "mantle-bearer-test" },
  ...over,
})

/** A tiny RawMessageStreamEvent sequence sufficient to validate translation
 *  through `mapRawEvent` without touching any real SDK. Mirrors the shape
 *  used by `foundry-real-stream-hellgate`. */
async function* fakeStream(): AsyncGenerator<unknown> {
  yield {
    type: "message_start",
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 7 } },
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
    throwOnCtor?: unknown
  },
): MantleClientFactory => {
  return (opts) => {
    log.clientOptions = { ...opts }
    if (override?.throwOnCtor !== undefined) throw override.throwOnCtor
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

describe("MantleProviderAdapter — real-stream hellgate (A: meta surface)", () => {
  test("HELL-A1: providerId / model / authMode surfaced", () => {
    const a = mantleProviderAdapter(base(), { clientFactory: recordingFactory({}) })
    expect(a.providerId).toBe("mantle")
    expect(a.provider).toBe("anthropic")
    expect(a.authMode).toBe("Anthropic Mantle")
    expect(a.model).toBe("claude-sonnet-4-6")
  })

  test("HELL-A2: SDK ctor receives `{authToken}` from cfg.auth.mantleToken", async () => {
    const log: CallLog = {}
    const a = mantleProviderAdapter(base({ auth: { mantleToken: "k-secret" } }), {
      clientFactory: recordingFactory(log),
    })
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // drain to trigger lazy client construction
    }
    expect(log.clientOptions).toEqual({ authToken: "k-secret" })
  })

  test("HELL-A3: mantleEndpoint propagates to endpoint meta + SDK baseURL", async () => {
    const log: CallLog = {}
    const a = mantleProviderAdapter(
      base({ auth: { mantleToken: "k", mantleEndpoint: "https://gw.mantle.internal/v1" } }),
      { clientFactory: recordingFactory(log) },
    )
    expect(a.endpoint).toBe("https://gw.mantle.internal/v1")
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // drain
    }
    expect((log.clientOptions as { baseURL?: string }).baseURL).toBe(
      "https://gw.mantle.internal/v1",
    )
    expect((log.clientOptions as { authToken?: string }).authToken).toBe("k")
  })

  test("HELL-A4: no mantleEndpoint ⇒ endpoint meta empty (SDK resolves env)", () => {
    const a = mantleProviderAdapter(base(), { clientFactory: recordingFactory({}) })
    expect(a.endpoint).toBe("")
  })
})

describe("MantleProviderAdapter — real-stream hellgate (B: misconfig / auth)", () => {
  test("HELL-B1: wrong providerId → ProviderError('provider-misconfigured')", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      mantleProviderAdapter(base({ providerId: "default" as any }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B2: missing mantleToken → ProviderError('provider-misconfigured')", () => {
    try {
      mantleProviderAdapter(base({ auth: {} }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
      expect((e as ProviderError).message).toMatch(/mantleToken/)
    }
  })

  test("HELL-B3: empty-string mantleToken → ProviderError('provider-misconfigured')", () => {
    try {
      mantleProviderAdapter(base({ auth: { mantleToken: "" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B4: misconfig error does NOT leak the token value", () => {
    const secret = "sk-MANTLE-LEAKY-TOKEN-DO-NOT-SHIP"
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate type-escape
      mantleProviderAdapter(base({ providerId: "bedrock" as any, auth: { mantleToken: secret } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const msg = (e as ProviderError).message
      expect(msg.includes(secret)).toBe(false)
      const stack = (e as Error).stack ?? ""
      expect(stack.includes(secret)).toBe(false)
    }
  })
})

describe("MantleProviderAdapter — real-stream hellgate (C: DI / wire errors)", () => {
  test("HELL-C1: stream yields events translated through mapRawEvent", async () => {
    const a = mantleProviderAdapter(base(), { clientFactory: recordingFactory({}) })
    const events: Array<{ type: string }> = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      events.push(ev as { type: string })
    }
    const types = events.map((e) => e.type)
    expect(types).toContain("text_delta")
    expect(types).toContain("usage")
    expect(types).toContain("message_stop")
  })

  test("HELL-C2: DI ctor throw → ProviderError('provider-misconfigured')", async () => {
    const a = mantleProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { throwOnCtor: new Error("AccessDenied: bad creds") }),
    })
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
      expect((e as ProviderError).providerId).toBe("mantle")
    }
  })

  test("HELL-C3: SDK create() AccessDenied → ProviderError('provider-misconfigured')", async () => {
    const a = mantleProviderAdapter(base(), {
      clientFactory: recordingFactory(
        {},
        { throwOnCreate: new Error("AccessDenied: Mantle token expired") },
      ),
    })
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-C4: SDK create() generic throw → LLMError (wire error path)", async () => {
    const a = mantleProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { throwOnCreate: new Error("ETIMEDOUT") }),
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

  test("HELL-C5: ProviderError from DI factory passes through untouched", async () => {
    const a = mantleProviderAdapter(base(), {
      clientFactory: () => {
        throw new ProviderError("provider-missing-dependency", "fake", { providerId: "mantle" })
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
      expect((e as ProviderError).providerId).toBe("mantle")
    }
  })
})

describe("MantleProviderAdapter — real-stream hellgate (D: stream params / abort)", () => {
  test("HELL-D1: abort signal forwarded to messages.create()", async () => {
    const log: CallLog = {}
    const a = mantleProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const ctl = new AbortController()
    for await (const _ of a.stream({ messages: [], tools: [], signal: ctl.signal })) {
      // drain
    }
    expect(log.signal).toBe(ctl.signal)
    ctl.abort()
    expect((log.signal as AbortSignal).aborted).toBe(true)
  })

  test("HELL-D2: stream params include model + max_tokens + stream:true", async () => {
    const log: CallLog = {}
    const a = mantleProviderAdapter(base({ maxTokens: 4321 }), {
      clientFactory: recordingFactory(log),
    })
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // drain
    }
    expect(log.params?.model).toBe("claude-sonnet-4-6")
    expect(log.params?.max_tokens).toBe(4321)
    expect(log.params?.stream).toBe(true)
  })

  test("HELL-D3: pre-aborted signal short-circuits BEFORE SDK touch (LLMError aborted)", async () => {
    const log: CallLog = {}
    const a = mantleProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const ctl = new AbortController()
    ctl.abort()
    try {
      for await (const _ of a.stream({ messages: [], tools: [], signal: ctl.signal })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError)
      expect((e as LLMError).kind).toBe("aborted")
      expect((e as LLMError).message).toContain("aborted")
    }
    // The SDK client must never have been constructed (no clientOptions logged).
    expect(log.clientOptions).toBeUndefined()
  })

  test("HELL-D4: empty SDK stream → adapter yields nothing (no synthesized events)", async () => {
    async function* empty(): AsyncGenerator<unknown> {
      // SDK closed iteration with zero raw events.
    }
    const a = mantleProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { stream: empty }),
    })
    const events: Array<unknown> = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      events.push(ev)
    }
    expect(events).toEqual([])
  })
})

describe("MantleProviderAdapter — real-stream hellgate (E: missing-SDK seam)", () => {
  test("HELL-E1: no clientFactory + unpublished SDK ⇒ provider-missing-dependency (no crash)", async () => {
    // The package `@anthropic-ai/mantle-sdk` is NOT on npm. With no DI factory,
    // the lazy import collapses to null and the adapter throws a TYPED
    // provider-missing-dependency — the fallback chain advances, no crash.
    const a = mantleProviderAdapter(base())
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-missing-dependency")
      expect((e as ProviderError).providerId).toBe("mantle")
      expect((e as ProviderError).message).toContain(MANTLE_SDK_PACKAGE)
    }
  })

  test("HELL-E2: tryImportMantleSdk() returns null today (SDK unpublished) — NEVER throws", async () => {
    const mod = await tryImportMantleSdk()
    expect(mod).toBeNull()
  })

  test("HELL-E3: isMantleAdapterReady() is false today (SDK unpublished)", async () => {
    const ready = await isMantleAdapterReady()
    expect(ready).toBe(false)
  })

  test("HELL-E4: package coordinates exported verbatim for watcher SSOT", () => {
    expect(MANTLE_SDK_PACKAGE).toBe("@anthropic-ai/mantle-sdk")
    expect(MANTLE_SDK_NPM_URL).toBe(`https://registry.npmjs.org/${MANTLE_SDK_PACKAGE}`)
  })
})

describe("MantleProviderAdapter — real-stream hellgate (F: function/class parity)", () => {
  test("HELL-F1: function-style returns MantleProviderAdapter instance", () => {
    const a = mantleProviderAdapter(base(), { clientFactory: recordingFactory({}) })
    expect(a).toBeInstanceOf(MantleProviderAdapter)
  })

  test("HELL-F2: fresh instance per call (no shared state)", () => {
    const a = mantleProviderAdapter(base({ model: "mantle-x" }), {
      clientFactory: recordingFactory({}),
    })
    const b = mantleProviderAdapter(base({ model: "mantle-y" }), {
      clientFactory: recordingFactory({}),
    })
    expect(a.model).toBe("mantle-x")
    expect(b.model).toBe("mantle-y")
    expect(a).not.toBe(b)
  })

  test("HELL-F3: model echoed verbatim (NUL bytes, no munging)", () => {
    const modelWithNul = "claude\x00mantle\x00rm-rf"
    const a = mantleProviderAdapter(base({ model: modelWithNul }), {
      clientFactory: recordingFactory({}),
    })
    expect(a.model).toBe(modelWithNul)
  })
})

describe("MantleProviderAdapter — differential parity vs Foundry decode", () => {
  test("HELL-G1: 50 RawEvent sequences decode byte-identically across transports", async () => {
    // ADR-0139 invariant — the ONLY difference between Mantle and Foundry is
    // transport, not grammar. Feed the SAME RawEvent sequences through the
    // Mantle fake and the Foundry fake; the StreamEvent outputs MUST match.
    const { foundryProviderAdapter } = await import("@/llm/providers/foundry-adapter")

    const makeSeq = (i: number): unknown[] => [
      { type: "message_start", message: { model: "m", usage: { input_tokens: i } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `chunk-${i}` },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: i + 1 },
      },
      { type: "message_stop" },
    ]

    const drain = async (it: AsyncIterable<unknown>): Promise<string> => {
      const out: unknown[] = []
      for await (const ev of it) out.push(ev)
      return JSON.stringify(out)
    }

    for (let i = 0; i < 50; i++) {
      const seq = makeSeq(i)
      const seqStream = (): AsyncIterable<unknown> => {
        async function* g() {
          for (const ev of seq) yield ev
        }
        return g()
      }

      const mantle = mantleProviderAdapter(base({ model: "m" }), {
        clientFactory: recordingFactory({}, { stream: seqStream }),
      })
      const foundry = foundryProviderAdapter(
        { providerId: "foundry", model: "m", auth: { azureApiKey: "k" } },
        {
          clientFactory: (opts) => {
            void opts
            return {
              messages: {
                async create() {
                  return seqStream() as AsyncIterable<never>
                },
              },
            }
          },
        },
      )

      const mOut = await drain(mantle.stream({ messages: [], tools: [] }))
      const fOut = await drain(foundry.stream({ messages: [], tools: [] }))
      expect(mOut).toBe(fOut)
    }
  })
})
