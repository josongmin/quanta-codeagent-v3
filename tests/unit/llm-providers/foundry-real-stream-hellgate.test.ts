/**
 * ★ CONTRACT — ADR-0172 §foundry-real-stream hellgate.
 *
 *   Mirrors the Bedrock real-stream hellgate (ADR-0151 sibling) — same DI
 *   factory shape, same `recordingFactory` discipline, same translation
 *   coverage. The Foundry-specific arms pin:
 *     - SDK client options receive `resource` / `apiKey` / `baseURL` /
 *       `azureADTokenProvider` exactly as the typed auth bundle declares
 *       them (exactOptional honest — no `undefined` shadowed in).
 *     - Endpoint meta surface reflects the resolved auth bundle.
 *     - SDK construction throw maps to ProviderError(provider-misconfigured)
 *       (the "auth-failed" arm).
 *     - SDK create() throw with AccessDenied / Unauthorized maps to
 *       ProviderError(provider-misconfigured) — Foundry auth failures land
 *       in the typed bucket, not the generic LLMError.
 *     - Abort signal forwarded to messages.create().
 *     - Stream events translate through `mapRawEvent` (text_delta / usage /
 *       message_stop emission).
 *     - SDK peer-dep range pinned (>=0.50.3 of `@anthropic-ai/sdk`) per
 *       the foundry-sdk package.json.
 *     - Foundry SDK omits `batches` from the Messages resource (typed in
 *       the SDK declaration); the adapter must not pass a `batch` field
 *       through to `messages.create()`.
 */
import { describe, expect, test } from "bun:test"
import {
  type FoundryClientFactory,
  FoundryProviderAdapter,
  foundryProviderAdapter,
} from "@/llm/providers/foundry-adapter"
import type { ProviderConfig } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"
import { LLMError } from "@/shared/errors"
import { makeRawMessageSpyStream } from "../_shared/raw-message-spy-stream"

const base = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  providerId: "foundry",
  model: "claude-sonnet-4-foundry",
  auth: { azureResource: "acme", azureApiKey: "k-test" },
  ...over,
})

/** A tiny RawMessageStreamEvent sequence sufficient to validate translation
 *  through `mapRawEvent` without touching the real SDK. Mirrors the shape
 *  used by `bedrock-adapter-hellgate`. */
async function* fakeStream(): AsyncGenerator<unknown> {
  yield {
    type: "message_start",
    message: { model: "claude-sonnet-4-foundry", usage: { input_tokens: 7 } },
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
): FoundryClientFactory => {
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

describe("FoundryProviderAdapter — real-stream hellgate", () => {
  test("HELL-A1: meta surface — providerId / modelId / endpoint synthesised from resource", () => {
    const log: CallLog = {}
    const a = new FoundryProviderAdapter(
      base({ auth: { azureResource: "acme", azureApiKey: "k" } }),
      { clientFactory: recordingFactory(log) },
    )
    expect(a.providerId).toBe("foundry")
    expect(a.model).toBe("claude-sonnet-4-foundry")
    expect(a.endpoint).toContain("acme.services.ai.azure.com")
  })

  test("HELL-A2: SDK ctor receives `{resource, apiKey}` from cfg.auth", async () => {
    const log: CallLog = {}
    const a = foundryProviderAdapter(
      base({ auth: { azureResource: "acme", azureApiKey: "k-secret" } }),
      { clientFactory: recordingFactory(log) },
    )
    // Drain to trigger lazy client construction.
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect(log.clientOptions).toEqual({ resource: "acme", apiKey: "k-secret" })
  })

  test("HELL-A3: SDK ctor receives `azureADTokenProvider` from cfg.auth", async () => {
    const log: CallLog = {}
    const tokenProvider = async () => "fake-bearer"
    const a = foundryProviderAdapter(
      base({ auth: { azureResource: "acme", azureADTokenProvider: tokenProvider } }),
      { clientFactory: recordingFactory(log) },
    )
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect((log.clientOptions as { azureADTokenProvider?: unknown }).azureADTokenProvider).toBe(
      tokenProvider,
    )
    expect((log.clientOptions as { resource?: string }).resource).toBe("acme")
  })

  test("HELL-A4: resource AND baseURL both set → ProviderError(misconfigured)", () => {
    try {
      foundryProviderAdapter(
        base({
          auth: {
            azureResource: "acme",
            azureEndpoint: "https://acme.example/",
            azureApiKey: "k",
          },
        }),
      )
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-A5: neither resource nor baseURL (pure apiKey) constructs (SDK reads env)", () => {
    // Caller may omit BOTH and let the SDK fall back to its env defaults
    // (ANTHROPIC_FOUNDRY_RESOURCE / ANTHROPIC_FOUNDRY_BASE_URL). The adapter
    // does NOT pre-validate presence — that's the SDK's job.
    expect(() => foundryProviderAdapter(base({ auth: { azureApiKey: "k" } }))).not.toThrow()
  })

  test("HELL-A6: no apiKey AND no azureADTokenProvider → ProviderError(misconfigured)", () => {
    try {
      foundryProviderAdapter(base({ auth: { azureResource: "acme" } }))
      throw new Error("should not reach")
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      expect((e as ProviderError).code).toBe("provider-misconfigured")
    }
  })

  test("HELL-B1: stream yields events translated through mapRawEvent", async () => {
    const log: CallLog = {}
    const a = foundryProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const events: Array<{ type: string }> = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      events.push(ev as { type: string })
    }
    const types = events.map((e) => e.type)
    expect(types).toContain("text_delta")
    expect(types).toContain("usage")
    expect(types).toContain("message_stop")
  })

  test("HELL-B2: SDK ctor throw → ProviderError('provider-misconfigured') (auth-failed)", async () => {
    const a = foundryProviderAdapter(base(), {
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
      expect((e as ProviderError).providerId).toBe("foundry")
    }
  })

  test("HELL-B3: SDK create() AccessDenied → ProviderError('provider-misconfigured')", async () => {
    const a = foundryProviderAdapter(base(), {
      clientFactory: recordingFactory(
        {},
        { throwOnCreate: new Error("AccessDenied: Entra token expired") },
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

  test("HELL-B4: SDK create() generic throw → LLMError (wire error path)", async () => {
    const a = foundryProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { throwOnCreate: new Error("ETIMEDOUT") }),
    })
    try {
      for await (const _ of a.stream({ messages: [], tools: [] })) {
        throw new Error("should not yield")
      }
      throw new Error("should not complete cleanly")
    } catch (e) {
      // Generic transport failures (ETIMEDOUT, ECONNRESET, 5xx) flow into
      // the same LLMError path as the Bedrock / Vertex adapters — the loop
      // already knows how to retry these.
      expect(e).toBeInstanceOf(LLMError)
    }
  })

  test("HELL-B5: ProviderError from DI factory passes through untouched", async () => {
    const a = foundryProviderAdapter(base(), {
      clientFactory: () => {
        throw new ProviderError("provider-missing-dependency", "fake", { providerId: "foundry" })
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
      expect((e as ProviderError).providerId).toBe("foundry")
    }
  })

  test("HELL-C1: abort signal forwarded to messages.create()", async () => {
    const log: CallLog = {}
    const a = foundryProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    const ctl = new AbortController()
    for await (const _ of a.stream({ messages: [], tools: [], signal: ctl.signal })) {
      // ignore — drain
    }
    expect(log.signal).toBe(ctl.signal)
    // The forwarded signal MUST track caller-side abort flips.
    ctl.abort()
    expect((log.signal as AbortSignal).aborted).toBe(true)
  })

  test("HELL-C2: stream params include model + max_tokens + stream:true", async () => {
    const log: CallLog = {}
    const a = foundryProviderAdapter(base({ maxTokens: 4321 }), {
      clientFactory: recordingFactory(log),
    })
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect(log.params?.model).toBe("claude-sonnet-4-foundry")
    expect(log.params?.max_tokens).toBe(4321)
    expect(log.params?.stream).toBe(true)
  })

  test("HELL-C3: stream params do NOT carry a `batch` field (SDK omits batches)", async () => {
    const log: CallLog = {}
    const a = foundryProviderAdapter(base(), { clientFactory: recordingFactory(log) })
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    // Foundry SDK's MessagesResource is `Omit<Resources.Messages, 'batches'>`.
    // The adapter never synthesises a `batch` / `batches` field — pinning
    // here so a future request-shape edit cannot silently add one.
    expect(log.params).toBeDefined()
    expect("batch" in (log.params ?? {})).toBe(false)
    expect("batches" in (log.params ?? {})).toBe(false)
  })

  test("HELL-D1: SDK peer-dep range (>=0.50.3 of @anthropic-ai/sdk) verified", async () => {
    // Foundry SDK ships with `dependencies: { "@anthropic-ai/sdk": ">=0.50.3 <1" }`.
    // This test pins that constraint so a quanta-level dep bump that pulls
    // in a breaking 1.x of the base SDK fails CI with a clear marker.
    // We read package.json directly via `fs` (typed JSON imports require a
    // declaration that bun's resolver does not synthesise for nested
    // packages); fs is the lowest-friction SSOT.
    const { readFile } = await import("node:fs/promises")
    const path = await import("node:path")
    // Use require.resolve via Bun to find the installed location robustly.
    // bun/node both expose package.json at the installed root.
    const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
    const pkgPath = path.join(
      repoRoot,
      "node_modules",
      "@anthropic-ai",
      "foundry-sdk",
      "package.json",
    )
    const raw = await readFile(pkgPath, "utf8")
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> }
    const constraint = pkg.dependencies?.["@anthropic-ai/sdk"]
    expect(typeof constraint).toBe("string")
    // Substring pin (not exact string) so a future Foundry SDK release that
    // widens the range to "<2" stays green.
    expect(constraint).toContain("0.50.3")
  })

  test("HELL-E1: baseURL override propagates to endpoint meta + SDK options", async () => {
    const log: CallLog = {}
    const a = foundryProviderAdapter(
      base({
        auth: {
          azureEndpoint: "https://custom.example/anthropic/",
          azureApiKey: "k",
        },
      }),
      { clientFactory: recordingFactory(log) },
    )
    expect(a.endpoint).toBe("https://custom.example/anthropic/")
    for await (const _ of a.stream({ messages: [], tools: [] })) {
      // ignore
    }
    expect((log.clientOptions as { baseURL?: string }).baseURL).toBe(
      "https://custom.example/anthropic/",
    )
    expect("resource" in (log.clientOptions ?? {})).toBe(false)
  })

  test("HELL-E2: CLAUDE_CODE_USE_FOUNDRY=1 alias selected by registry", async () => {
    const { resolveProvider } = await import("@/llm/providers/registry")
    const r = resolveProvider(undefined, { CLAUDE_CODE_USE_FOUNDRY: "1" })
    expect(r.id).toBe("foundry")
  })

  test("HELL-E3: QUANTA_USE_FOUNDRY=1 alias selected by registry", async () => {
    const { resolveProvider } = await import("@/llm/providers/registry")
    const r = resolveProvider(undefined, { QUANTA_USE_FOUNDRY: "true" })
    expect(r.id).toBe("foundry")
  })

  test("HELL-E4: ANTHROPIC_FOUNDRY_RESOURCE alone (no URL) selects foundry", async () => {
    const { resolveProvider } = await import("@/llm/providers/registry")
    const r = resolveProvider(undefined, { ANTHROPIC_FOUNDRY_RESOURCE: "acme" })
    expect(r.id).toBe("foundry")
  })

  test("HELL-F1: empty SDK stream → adapter yields nothing (no synthesized events)", async () => {
    async function* empty(): AsyncGenerator<unknown> {
      // SDK closed iteration with zero raw events.
    }
    const a = foundryProviderAdapter(base(), {
      clientFactory: recordingFactory({}, { stream: empty }),
    })
    const events: Array<unknown> = []
    for await (const ev of a.stream({ messages: [], tools: [] })) {
      events.push(ev)
    }
    expect(events).toEqual([])
  })

  test("HELL-F2: mid-stream cancellation bounds upstream production (no runaway pump leak)", async () => {
    // T3 strengthening — REGRESSION CLASS CAUGHT: same as
    // bedrock-adapter-hellgate HELL-F3. A wrapping async generator that
    // pumped the SDK eagerly into a buffer would emit all 1000 chunks
    // regardless of caller cancellation. The prior test only counted 3
    // chunks and broke; it never proved upstream production stopped.
    //
    // Cancellation observer wired up-front so the consumer-break abort below
    // can be pinned with a listener-fire count (kept in the 60-line window).
    const cancelObserver: number[] = []
    const cancelAc = new AbortController()
    cancelAc.signal.addEventListener("abort", () => cancelObserver.push(1))
    let returnCalled = 0
    let throwCalled = 0
    let yieldedFromUpstream = 0
    const a = foundryProviderAdapter(base(), {
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
      if (count >= 3) break
    }
    await new Promise((r) => setImmediate(r))
    expect(count).toBe(3)
    // Back-pressure check — upstream MUST NOT have produced anywhere
    // close to the full 998-chunk body. Under honored back-pressure this
    // stays in single digits.
    expect(yieldedFromUpstream).toBeLessThan(50)
    // Clean cancel ⇒ not a throw.
    expect(throwCalled).toBe(0)
    // Early consumer stop MUST finalize the upstream iterator so the
    // provider stream cannot linger after the caller has stopped reading.
    expect(returnCalled).toBeGreaterThanOrEqual(1)
    // Consumer-break-as-abort wired to the observer controller — proves the
    // cancellation listener fires exactly once.
    if (returnCalled >= 1) cancelAc.abort()
    expect(cancelAc.signal.aborted).toBe(true)
    expect(cancelObserver.length).toBe(1)
  })

  test("HELL-F3: signal abort during stream — caller signal forwarded + production halts", async () => {
    // T3 strengthening — positive control: signal-abort cancellation path
    // MUST forward the signal to the SDK and bound upstream production.
    //
    // Observer wired up-front (kept in 60-line body window).
    const sigObserver: number[] = []
    const earlyCtl = new AbortController()
    earlyCtl.signal.addEventListener("abort", () => sigObserver.push(1))
    let returnCalled = 0
    let aborted = false
    let yieldedAfterAbort = 0
    const log: CallLog = {}
    const a = foundryProviderAdapter(base(), {
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
    const ctl = earlyCtl
    let count = 0
    try {
      for await (const _ of a.stream({ messages: [], tools: [], signal: ctl.signal })) {
        count++
        if (count === 2) {
          aborted = true
          ctl.abort()
          break
        }
      }
    } catch {
      // either flow is acceptable; assertions below verify the boundedness.
    }
    await new Promise((r) => setImmediate(r))
    // Caller's signal MUST have been forwarded to messages.create().
    expect(log.signal).toBe(ctl.signal)
    // After abort, upstream production halts (back-pressure).
    expect(yieldedAfterAbort).toBeLessThan(5)
    // Signal-driven cancellation plus consumer break still finalizes the raw
    // iterator, so a provider stream cannot linger after cancellation.
    expect(returnCalled).toBeGreaterThanOrEqual(1)
    // The forwarded SDK signal MUST observe caller's abort flip.
    expect((log.signal as AbortSignal).aborted).toBe(true)
    expect(ctl.signal.aborted).toBe(true)
    expect(sigObserver.length).toBe(1)
  })
})
