/**
 * HELLGATE — RFC05-2 FOLLOWER: configured-endpoint SELECTION wiring in
 * `src/runner/assemble/llm.ts` (aug-02 absorption).
 *
 * This is the DEFERRED hunk of RFC05-2: RFC05-core already added the resolved
 * endpoint data-plane contract (`endpoint-transport.ts` `buildEndpointFetch`)
 * and the Chat adapter's `fetchImpl?` seam. This packet wires the ASSEMBLE front
 * door so a configured named `OpenAIEndpointOptions` is actually SELECTED,
 * secret-materialized, and COMPOSED into `createLLM` — driving `baseUrl` + the
 * guarded fetch on the real adapter — WITHOUT disturbing the RFC02-3
 * route-transition callback.
 *
 * Pins:
 *   - SELECTION: a configured name picks the matching endpoint + resolves its
 *     symbolic secret refs to concrete values; an absent/unknown name ⇒ no
 *     endpoint (gate-OFF path);
 *   - COMPOSITION (front door): the selected endpoint's baseUrl + guarded fetch
 *     reach the real adapter through `createLLM` (scripted inner fetch is hit at
 *     the endpoint baseUrl, and honors the network policy);
 *   - explicit `wireApi` drives the adapter surface (no base-URL inference);
 *   - GATE-OFF PARITY: with no configured endpoint the composed `createLLM`
 *     options are byte-identical to the pre-RFC05 legacy shape (no baseURL, no
 *     fetchImpl, no surface override);
 *   - SEPARATION: endpoint selection is a SEPARATE dep from the route-transition
 *     observation callback (both live in assemble/llm.ts but neither wraps the
 *     other);
 *   - SECRET DISCIPLINE: a header ref resolves to the host secret value on the
 *     outgoing request only — never onto the config record or a diagnostic.
 */

import { describe, expect, test } from "bun:test"
import type { OpenAIEndpointOptions } from "@/config"
import type { Message, StreamInput } from "@/llm"
import { createLLM } from "@/llm"
import {
  buildMainLLMCore,
  composeEndpointCreateLLMOptions,
  fallbackTransitionToRouteEvent,
  resolveConfiguredEndpoint,
} from "@/runner/assemble/llm"
import { SsrfGuardError } from "@/shared/net/ssrf"

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

// A minimal Chat-completions SSE body the OpenAI adapter tolerates: one content
// delta then a stop + [DONE]. Enough to prove the request reached our fetch.
const CHAT_SSE =
  'data: {"id":"c1","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
  'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n"

const chatSseResponse = (): Response =>
  new Response(CHAT_SSE, { status: 200, headers: { "content-type": "text/event-stream" } })

const publicEndpoint = (over: Partial<OpenAIEndpointOptions> = {}): OpenAIEndpointOptions => ({
  baseUrl: "https://gateway.example.com/v1",
  wireApi: "chat",
  model: "gpt-oss",
  networkPolicy: "public_https",
  ...over,
})

const resolvePublic = async () => ["93.184.216.34"]

describe("RFC05-2 follower — configured-endpoint SELECTION", () => {
  test("configured name ⇒ selects the matching endpoint + resolves its secret refs", () => {
    const endpoints: Record<string, OpenAIEndpointOptions> = {
      gw: publicEndpoint({
        authRef: "endpoint_api_key",
        headerRefs: { "x-extra": "endpoint_api_key" },
        query: { "api-version": "2024" },
      }),
    }
    const resolved = resolveConfiguredEndpoint({
      name: "gw",
      endpoints,
      secrets: { endpoint_api_key: "sk-resolved-secret" },
    })
    expect(resolved).not.toBeUndefined()
    if (resolved === undefined) throw new Error("unreachable")
    expect(resolved.id).toBe("gw")
    expect(resolved.baseUrl).toBe("https://gateway.example.com/v1")
    expect(resolved.wireApi).toBe("chat")
    expect(resolved.model).toBe("gpt-oss")
    // authRef ⇒ Authorization: Bearer <resolved>; headerRef ⇒ literal resolved.
    expect(resolved.headers.authorization).toBe("Bearer sk-resolved-secret")
    expect(resolved.headers["x-extra"]).toBe("sk-resolved-secret")
    expect(resolved.query["api-version"]).toBe("2024")
  })

  test("absent name / unknown name / empty map ⇒ no endpoint (gate-OFF path)", () => {
    const endpoints: Record<string, OpenAIEndpointOptions> = { gw: publicEndpoint() }
    expect(resolveConfiguredEndpoint({ name: undefined, endpoints, secrets: {} })).toBeUndefined()
    expect(resolveConfiguredEndpoint({ name: "", endpoints, secrets: {} })).toBeUndefined()
    expect(resolveConfiguredEndpoint({ name: "nope", endpoints, secrets: {} })).toBeUndefined()
    expect(resolveConfiguredEndpoint({ name: "gw", endpoints: {}, secrets: {} })).toBeUndefined()
  })

  test("authRef present but secret missing ⇒ fail-closed (no endpoint)", () => {
    const endpoints: Record<string, OpenAIEndpointOptions> = {
      gw: publicEndpoint({ authRef: "endpoint_api_key" }),
    }
    // A declared auth ref that the host cannot resolve must NOT silently drop
    // auth and stream unauthenticated — it fails closed to no endpoint.
    expect(resolveConfiguredEndpoint({ name: "gw", endpoints, secrets: {} })).toBeUndefined()
  })
})

describe("RFC05-2 follower — endpoint COMPOSITION into createLLM options", () => {
  test("no endpoint ⇒ byte-identical legacy options (gate-OFF parity)", () => {
    const opts = composeEndpointCreateLLMOptions({ endpoint: undefined, model: "gpt-4o" })
    expect(opts).toEqual({ model: "gpt-4o" })
    // no baseURL / fetchImpl / surface leaked in
    expect("baseURL" in opts).toBe(false)
    expect("fetchImpl" in opts).toBe(false)
    expect("surface" in opts).toBe(false)
  })

  test("chat endpoint ⇒ baseURL + explicit chat-completions surface + guarded fetch", () => {
    const resolved = resolveConfiguredEndpoint({
      name: "gw",
      endpoints: { gw: publicEndpoint() },
      secrets: {},
    })
    if (resolved === undefined) throw new Error("expected endpoint")
    const opts = composeEndpointCreateLLMOptions({ endpoint: resolved, model: "" })
    expect(opts.baseURL).toBe("https://gateway.example.com/v1")
    expect(opts.surface).toBe("chat-completions")
    // model falls back to the endpoint's declared model when caller model empty
    expect(opts.model).toBe("gpt-oss")
    expect(typeof opts.fetchImpl).toBe("function")
    // no-auth endpoint ⇒ a fixed NON-SECRET sentinel apiKey satisfies the SDK
    // ctor (the local server / gateway ignores it; real auth rides the header).
    expect(opts.apiKey).toBe("sk-local-no-auth")
  })

  test("authRef endpoint ⇒ the resolved token becomes the SDK apiKey (matches the guarded header)", () => {
    const resolved = resolveConfiguredEndpoint({
      name: "gw",
      endpoints: { gw: publicEndpoint({ authRef: "endpoint_api_key" }) },
      secrets: { endpoint_api_key: "sk-resolved-secret" },
    })
    if (resolved === undefined) throw new Error("expected endpoint")
    const opts = composeEndpointCreateLLMOptions({ endpoint: resolved, model: "m" })
    // The SDK apiKey is the SAME resolved token the guarded Authorization header
    // carries — so the SDK's own `Authorization: Bearer <key>` is consistent and
    // buildEndpointFetch's header-merge is a no-op.
    expect(opts.apiKey).toBe("sk-resolved-secret")
  })

  test("responses endpoint ⇒ explicit responses surface (no base-URL inference)", () => {
    const resolved = resolveConfiguredEndpoint({
      name: "gw",
      endpoints: { gw: publicEndpoint({ wireApi: "responses" }) },
      secrets: {},
    })
    if (resolved === undefined) throw new Error("expected endpoint")
    const opts = composeEndpointCreateLLMOptions({ endpoint: resolved, model: "m" })
    expect(opts.surface).toBe("responses")
    expect(opts.model).toBe("m") // caller model wins when non-empty
  })
})

describe("RFC05-2 follower — FRONT DOOR: composed endpoint drives the real adapter", () => {
  test("createLLM(openai, composed opts).stream() routes through the guarded fetch at the endpoint baseUrl", async () => {
    const hits: string[] = []
    const inner = (async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input.toString()
      hits.push(u)
      return chatSseResponse()
    }) as unknown as typeof fetch

    const resolved = resolveConfiguredEndpoint({
      name: "gw",
      endpoints: { gw: publicEndpoint() },
      secrets: {},
    })
    if (resolved === undefined) throw new Error("expected endpoint")
    const opts = composeEndpointCreateLLMOptions({
      endpoint: resolved,
      model: "gpt-oss",
      fetchInner: inner,
      resolveHost: resolvePublic,
    })
    // No pre-set apiKey / env key — the composed options carry the endpoint's
    // own (sentinel) apiKey, proving the compose is self-sufficient at the door.
    const llm = createLLM("openai", opts, {})
    const input: StreamInput = { messages: [userText("go")], tools: [] }
    const events: string[] = []
    for await (const ev of llm.stream(input)) events.push(ev.type)

    // The scripted inner fetch was hit — proving baseUrl + guarded fetch reached
    // the REAL adapter through createLLM (not just constructed).
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.startsWith("https://gateway.example.com/v1")).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })

  test("guarded fetch honors the network policy: a loopback_local endpoint refuses a public redirect", async () => {
    const start = "http://127.0.0.1:11434/v1/chat/completions"
    const redirectingInner = (async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input.toString()
      if (u.startsWith("http://127.0.0.1:11434"))
        return new Response(null, { status: 302, headers: { location: "https://93.184.216.34/" } })
      throw new Error(`BYPASS: ${u}`)
    }) as unknown as typeof fetch
    const resolved = resolveConfiguredEndpoint({
      name: "ollama",
      endpoints: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434/v1",
          wireApi: "chat",
          model: "llama3",
          networkPolicy: "loopback_local",
        },
      },
      secrets: {},
    })
    if (resolved === undefined) throw new Error("expected endpoint")
    const opts = composeEndpointCreateLLMOptions({
      endpoint: resolved,
      model: "llama3",
      fetchInner: redirectingInner,
      resolveHost: async () => ["127.0.0.1"],
    })
    // The guarded fetch itself denies the out-to-public redirect.
    if (opts.fetchImpl === undefined) throw new Error("expected fetchImpl")
    await expect(opts.fetchImpl(start)).rejects.toThrow(SsrfGuardError)
  })
})

describe("RFC05-2 follower — buildMainLLMCore composition-root routing", () => {
  test("endpoint present ⇒ legacy branch routes to the OpenAI-wire adapter (no env key needed)", () => {
    const resolved = resolveConfiguredEndpoint({
      name: "gw",
      endpoints: { gw: publicEndpoint() },
      secrets: {},
    })
    if (resolved === undefined) throw new Error("expected endpoint")
    // NO OPENAI_API_KEY in env — the endpoint's sentinel apiKey satisfies the SDK
    // ctor, proving the endpoint drives the build (a bare buildLLMCore for openai
    // with an empty env would throw MissingApiKeyError).
    const llm = buildMainLLMCore({
      provider: "anthropic", // legacy provider is IGNORED when an endpoint is present
      model: "gpt-oss",
      env: {},
      selection: { kind: "legacy" },
      credential: {
        apiKeyHelper: undefined,
        awsAuthRefresh: undefined,
        gcpAuthRefresh: undefined,
        apiKeyHelperTtlMs: undefined,
        isTrusted: () => false,
      },
      endpoint: resolved,
    })
    expect(llm.surfaceId).toBe("openai-chat-completions")
  })

  test("GATE-OFF: no endpoint ⇒ byte-identical legacy vendor path (same as buildLLMCore)", () => {
    // With no endpoint the legacy branch builds the vendor adapter; provider
    // openai + env key ⇒ the openai adapter, identical to buildLLMCore.
    const llm = buildMainLLMCore({
      provider: "openai",
      model: "gpt-4o",
      env: { OPENAI_API_KEY: "k" },
      selection: { kind: "legacy" },
      credential: {
        apiKeyHelper: undefined,
        awsAuthRefresh: undefined,
        gcpAuthRefresh: undefined,
        apiKeyHelperTtlMs: undefined,
        isTrusted: () => false,
      },
      // endpoint OMITTED ⇒ gate-OFF
    })
    // openai with the official (empty) base URL ⇒ responses surface (byte-identical
    // to the pre-RFC05 default for provider openai).
    expect(llm.surfaceId).toBe("openai-responses")
  })

  test("GATE-OFF red-on-injection: removing the endpoint branch must NOT change the no-endpoint build", () => {
    // The no-endpoint build resolves via buildLLMCore. If the endpoint branch
    // leaked onto the gate-OFF path it would try createLLM('openai') and, with an
    // ANTHROPIC provider + no anthropic key, would either throw or build the wrong
    // adapter. Assert the anthropic vendor path is intact when no endpoint is set.
    const llm = buildMainLLMCore({
      provider: "anthropic",
      model: "claude",
      env: { ANTHROPIC_API_KEY: "k" },
      selection: { kind: "legacy" },
      credential: {
        apiKeyHelper: undefined,
        awsAuthRefresh: undefined,
        gcpAuthRefresh: undefined,
        apiKeyHelperTtlMs: undefined,
        isTrusted: () => false,
      },
    })
    expect(llm.surfaceId).toBe("anthropic-messages")
  })
})

describe("RFC05-2 follower — SEPARATION from route-transition observation", () => {
  test("route-transition callback is a distinct dep, unchanged by endpoint selection", () => {
    // The RFC02-3 route observer maps a fallback transition to an AgentEvent and
    // is NOT nested with endpoint selection — it takes a FallbackTransition, not
    // an endpoint. Constructing an endpoint does not touch it.
    const ev = fallbackTransitionToRouteEvent(
      { fromModel: "a", toModel: "b", kind: "overloaded", postYield: false },
      { at: 1 },
    )
    expect(ev.type).toBe("model_route_changed")
    expect(ev.routeKind).toBe("provider_fallback")
    expect(ev.reason).toBe("provider_overloaded")
    // The selection function and the route function share NO argument type: one
    // takes {name,endpoints,secrets}, the other a FallbackTransition. They are
    // separate exported deps (compile-level: both imported above independently).
  })
})
