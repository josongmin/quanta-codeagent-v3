/**
 * HELLGATE — `LLMPort.listModels` on the TWO OpenAI adapters (aug-28, finding #5).
 *
 * THE DEFECT. `/model`'s candidate set is the provider's live catalog, probed via
 * `LLMPort.listModels`. Anthropic and chatgpt-oauth implemented it; NEITHER
 * OpenAI adapter did. So on an `OPENAI_API_KEY` session the picker could only
 * ever offer the boot model plus whatever `QUANTA_RETRY_MODELS` named (unset by
 * default) — the picker existed with nothing to pick.
 *
 * WHY BOTH ADAPTERS. `factory#resolveOpenAISurface` returns `"responses"` for the
 * default/absent base URL, so a plain BYOK-OpenAI session boots
 * `OpenAIResponsesAdapter`, NOT the chat-completions one. A probe on only
 * `openai.ts` would have left the DEFAULT OpenAI session exactly as broken; that
 * asymmetry is what the per-adapter cases below pin.
 *
 * WHAT THIS SUITE PROVES (and what it refuses to accept as proof):
 *   - the REAL adapters are driven end-to-end against a stubbed TRANSPORT (the
 *     `fetchImpl` seam both adapters already expose — the chat one hands it to
 *     the OpenAI SDK's `fetch` option, so the SDK's own request building, header
 *     assembly and error classification all run). No `(adapter as any).client`
 *     swap: that would test a hand-written fake, not the wire;
 *   - the probe rides the CONFIGURED base URL and the SAME credential (an
 *     operator endpoint's `QUANTA_LLM_ENDPOINT` base must not be bypassed by a
 *     probe that hard-codes api.openai.com);
 *   - a failure REJECTS with a typed `LLMError` per the port contract (the
 *     caller degrades; the adapter never resolves `[]` for "we could not ask");
 *   - and the CONSUMER wire really widens: `buildModelCatalogWire` over the real
 *     adapter offers the probed ids after `refresh()`.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { OpenAIAdapter } from "@/llm/adapters/openai"
import { OpenAIResponsesAdapter } from "@/llm/adapters/openai-responses"
import { buildModelCatalogWire } from "@/llm/model-catalog"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { LLMError } from "@/shared"

/** One recorded transport call. `url` + `headers` are what the "respects the
 *  configured endpoint / credential" cases assert on. */
interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
}

/** A stub transport: records every request and answers with `respond(url)`.
 *  Shape-compatible with BOTH adapter seams (the SDK `Fetch` option and
 *  `ResponsesFetchLike`) — one stub, both surfaces. */
const stubTransport = (
  respond: (url: string) => Response,
): {
  readonly calls: Call[]
  readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
} => {
  const calls: Call[] = []
  return {
    calls,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const headers: Record<string, string> = {}
      // The SDK may pass headers on the init OR on a Request object.
      const raw =
        init?.headers ??
        (typeof input === "object" && "headers" in input ? input.headers : undefined)
      if (raw !== undefined) {
        new Headers(raw as Record<string, string>).forEach((v, k) => {
          headers[k.toLowerCase()] = v
        })
      }
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers })
      return respond(url)
    },
  }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

/** The real `GET /v1/models` payload shape, trimmed to what any endpoint sends. */
const modelsPayload = (ids: readonly string[]): unknown => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", created: 1, owned_by: "openai" })),
})

const CFG = { apiKey: "sk-test-key", model: "gpt-5.6-terra" }

/** Await a probe that MUST reject; returns the thrown value (never the ids). */
const rejection = async (p: Promise<unknown> | undefined): Promise<unknown> =>
  await (p ?? Promise.reject(new Error("adapter exposes no listModels"))).then(
    () => undefined,
    (e: unknown) => e,
  )

describe("OpenAI chat-completions adapter — listModels", () => {
  test("returns the provider's ids, via the SDK client's own transport", async () => {
    const t = stubTransport(() => jsonResponse(modelsPayload(["gpt-4o", "gpt-5.6-terra", "o3"])))
    const adapter = new OpenAIAdapter({ ...CFG, fetchImpl: t.fetchImpl })

    // ids ONLY — no objects, no `owned_by` leaking into the picker.
    expect(await adapter.listModels?.()).toEqual(["gpt-4o", "gpt-5.6-terra", "o3"])
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]?.method).toBe("GET")
    expect(t.calls[0]?.url).toBe("https://api.openai.com/v1/models")
  })

  test("rides the CONFIGURED baseURL and the session credential", async () => {
    const t = stubTransport(() => jsonResponse(modelsPayload(["local-model"])))
    const adapter = new OpenAIAdapter({
      ...CFG,
      baseURL: "https://endpoint.internal/v1",
      fetchImpl: t.fetchImpl,
    })

    expect(await adapter.listModels?.()).toEqual(["local-model"])
    expect(t.calls[0]?.url).toBe("https://endpoint.internal/v1/models")
    expect(t.calls[0]?.headers.authorization).toBe("Bearer sk-test-key")
  })

  test("a 401 REJECTS with a typed LLMError (kind=auth), never an empty list", async () => {
    const t = stubTransport(() => jsonResponse({ error: { message: "bad key" } }, 401))
    const adapter = new OpenAIAdapter({ ...CFG, fetchImpl: t.fetchImpl })

    const err = await rejection(adapter.listModels?.())
    expect(err).toBeInstanceOf(LLMError)
    expect((err as LLMError).kind).toBe("auth")
    expect((err as LLMError).provider).toBe("openai")
  })

  test("a garbage (non-JSON) 200 body REJECTS rather than resolving", async () => {
    const t = stubTransport(
      () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    )
    const adapter = new OpenAIAdapter({ ...CFG, fetchImpl: t.fetchImpl })

    expect(await rejection(adapter.listModels?.())).toBeInstanceOf(LLMError)
  })

  test("a transport that THROWS is wrapped, not leaked raw", async () => {
    const adapter = new OpenAIAdapter({
      ...CFG,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:443")
      },
    })

    const err = await rejection(adapter.listModels?.())
    expect(err).toBeInstanceOf(LLMError)
    expect((err as LLMError).provider).toBe("openai")
  })
})

describe("OpenAI responses adapter — listModels (the surface a plain OPENAI_API_KEY session boots)", () => {
  test("returns the provider's ids from the same base URL the turn wire uses", async () => {
    const t = stubTransport(() => jsonResponse(modelsPayload(["gpt-5.6-terra", "gpt-4o"])))
    const adapter = new OpenAIResponsesAdapter({ ...CFG, fetchImpl: t.fetchImpl })

    expect(await adapter.listModels?.()).toEqual(["gpt-5.6-terra", "gpt-4o"])
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]?.method).toBe("GET")
    expect(t.calls[0]?.url).toBe("https://api.openai.com/v1/models")
    expect(t.calls[0]?.headers.authorization).toBe("Bearer sk-test-key")
  })

  test("rides a CONFIGURED endpoint base (no hard-coded api.openai.com egress)", async () => {
    const t = stubTransport(() => jsonResponse(modelsPayload(["endpoint-model"])))
    const adapter = new OpenAIResponsesAdapter({
      ...CFG,
      baseURL: "https://gateway.internal/openai/v1/",
      fetchImpl: t.fetchImpl,
    })

    expect(await adapter.listModels?.()).toEqual(["endpoint-model"])
    expect(t.calls[0]?.url).toBe("https://gateway.internal/openai/v1/models")
  })

  test("a 429 REJECTS with the classified kind (rate_limit) and the status code", async () => {
    const t = stubTransport(() => jsonResponse({ error: "slow down" }, 429))
    const adapter = new OpenAIResponsesAdapter({ ...CFG, fetchImpl: t.fetchImpl })

    const err = await rejection(adapter.listModels?.())
    expect(err).toBeInstanceOf(LLMError)
    expect((err as LLMError).kind).toBe("rate_limit")
    expect((err as LLMError).statusCode).toBe(429)
  })

  test("a well-formed 200 with NO `data` array REJECTS (we could not ask != no models)", async () => {
    const t = stubTransport(() => jsonResponse({ object: "list", models: ["x"] }))
    const adapter = new OpenAIResponsesAdapter({ ...CFG, fetchImpl: t.fetchImpl })

    const err = await rejection(adapter.listModels?.())
    expect(err).toBeInstanceOf(LLMError)
    expect((err as LLMError).kind).toBe("bad_request")
  })

  test("junk ENTRIES inside a well-formed array are skipped, not fatal", async () => {
    const t = stubTransport(() =>
      jsonResponse({ data: [{ id: "gpt-4o" }, { id: 42 }, {}, { id: "" }, { id: "o3" }] }),
    )
    const adapter = new OpenAIResponsesAdapter({ ...CFG, fetchImpl: t.fetchImpl })

    expect(await adapter.listModels?.()).toEqual(["gpt-4o", "o3"])
  })

  test("a non-JSON 200 body REJECTS", async () => {
    const t = stubTransport(() => new Response("<!doctype html>", { status: 200 }))
    const adapter = new OpenAIResponsesAdapter({ ...CFG, fetchImpl: t.fetchImpl })

    expect(await rejection(adapter.listModels?.())).toBeInstanceOf(LLMError)
  })
})

describe("CONSUMER wire — the catalog actually widens off the new probe", () => {
  const built: string[] = []
  afterEach(() => {
    built.length = 0
  })

  const portFor = (id: string): LLMPort => ({
    model: id,
    provider: "openai",
    stream: (_input: StreamInput): AsyncIterable<StreamEvent> => {
      throw new Error("not streamed in this test")
    },
  })

  test("buildModelCatalogWire over the REAL responses adapter offers the probed ids", async () => {
    const t = stubTransport(() => jsonResponse(modelsPayload(["gpt-4o", "o3", "gpt-5.6-terra"])))
    const boot = new OpenAIResponsesAdapter({ ...CFG, fetchImpl: t.fetchImpl })
    const wire = buildModelCatalogWire({
      provider: "openai",
      bootModel: "gpt-5.6-terra",
      llm: boot,
      seeded: [],
      buildPort: (id) => {
        built.push(id)
        return portFor(id)
      },
      env: {},
    })

    // Before the probe: the boot model only — the pre-fix steady state.
    expect(wire.ids()).toEqual(["gpt-5.6-terra"])
    await wire.refresh()

    expect(wire.probeSucceeded()).toBe(true)
    expect(wire.ids()).toEqual(["gpt-5.6-terra", "gpt-4o", "o3"])
    // Invariant A: the boot model gets NO candidate port.
    expect(built).toEqual(["gpt-4o", "o3"])
  })

  test("a REJECTED probe leaves the seeded set standing (fail-open, no throw)", async () => {
    const t = stubTransport(() => jsonResponse({ error: "expired" }, 401))
    const boot = new OpenAIResponsesAdapter({ ...CFG, fetchImpl: t.fetchImpl })
    const wire = buildModelCatalogWire({
      provider: "openai",
      bootModel: "gpt-5.6-terra",
      llm: boot,
      seeded: [{ id: "seeded-model", port: portFor("seeded-model") }],
      buildPort: (id) => portFor(id),
      env: {},
    })

    await wire.refresh()
    expect(wire.probeSucceeded()).toBe(false)
    expect(wire.ids()).toEqual(["gpt-5.6-terra", "seeded-model"])
  })
})
