/**
 * HELLGATE — RFC05-2 Chat/Responses endpoint parity (aug-02 absorption).
 *
 * Both OpenAI wire surfaces consume the SAME resolved endpoint contract through
 * ONE guarded-fetch seam. The factory builds the base URL / network policy /
 * headers ONCE; each adapter keeps only its own body/stream decode. NO second
 * SSRF path, NO URL-shape wire inference, NO new retry loop.
 *
 * Pins (red-on-injection):
 *   - `buildEndpointFetch` wraps the injected fetcher with the SAME
 *     `fetchWithSsrfGuard` + endpoint `networkPolicy` — a loopback_local
 *     endpoint refuses a redirect out to a public host, a public_https endpoint
 *     refuses http, on BOTH wires (same helper);
 *   - the Chat adapter accepts an injected guarded fetch (parity with the
 *     Responses `fetchImpl` seam) and actually USES it;
 *   - diagnostics carry only id/wire/model/policy/host — never a resolved
 *     header/query secret.
 */

import { describe, expect, test } from "bun:test"
import { OpenAIAdapter } from "@/llm/adapters/openai"
import {
  buildEndpointFetch,
  type EndpointFetch,
  type ResolvedEndpoint,
  redactEndpointForDiagnostics,
} from "@/llm/endpoint-transport"
import type { ResponsesFetchLike } from "@/llm/responses-stream"
import { SsrfGuardError } from "@/shared/net/ssrf"

const publicEndpoint = (over: Partial<ResolvedEndpoint> = {}): ResolvedEndpoint => ({
  id: "gw",
  baseUrl: "https://gateway.example.com/v1",
  wireApi: "chat",
  model: "gpt-oss",
  networkPolicy: "public_https",
  headers: {},
  query: {},
  ...over,
})

const loopbackEndpoint = (over: Partial<ResolvedEndpoint> = {}): ResolvedEndpoint => ({
  id: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  wireApi: "chat",
  model: "llama3",
  networkPolicy: "loopback_local",
  headers: {},
  query: {},
  ...over,
})

const resolveLoopback = async () => ["127.0.0.1"]
const resolvePublic = async () => ["93.184.216.34"]

describe("buildEndpointFetch — shared guarded fetch (both wires)", () => {
  test("public_https endpoint: http request ⇒ SsrfGuardError (scheme enforced)", async () => {
    const inner = (async () => new Response("ok")) as unknown as typeof fetch
    const guarded = buildEndpointFetch(publicEndpoint(), { resolveHost: resolvePublic, inner })
    await expect(guarded("http://gateway.example.com/v1/chat")).rejects.toThrow(SsrfGuardError)
  })

  test("loopback_local endpoint: http to loopback ⇒ allowed; redirect OUT to public ⇒ denied", async () => {
    const start = "http://127.0.0.1:11434/v1/chat"
    const scripted = (async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input.toString()
      if (u === start) return new Response("ok", { status: 200 })
      throw new Error(`UNEXPECTED FETCH (bypass!): ${u}`)
    }) as unknown as typeof fetch
    const guarded = buildEndpointFetch(loopbackEndpoint(), {
      resolveHost: resolveLoopback,
      inner: scripted,
    })
    const ok = await guarded(start)
    expect(ok.status).toBe(200)

    // redirect out to a public literal — must be denied under loopback_local
    const scriptedRedirect = (async (input: string | URL | Request) => {
      const u = typeof input === "string" ? input : input.toString()
      if (u === start)
        return new Response(null, { status: 302, headers: { location: "https://93.184.216.34/" } })
      throw new Error(`UNEXPECTED FETCH (bypass!): ${u}`)
    }) as unknown as typeof fetch
    const guarded2 = buildEndpointFetch(loopbackEndpoint(), {
      resolveHost: resolveLoopback,
      inner: scriptedRedirect,
    })
    await expect(guarded2(start)).rejects.toThrow(SsrfGuardError)
  })

  test("resolved headers are attached to the outgoing request", async () => {
    const seenAuth: (string | null)[] = []
    const inner = (async (_input: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      seenAuth.push(h.get("authorization"))
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch
    const guarded = buildEndpointFetch(
      publicEndpoint({ headers: { authorization: "Bearer sk-resolved" } }),
      { resolveHost: resolvePublic, inner },
    )
    await guarded("https://gateway.example.com/v1/chat", { method: "POST" })
    expect(seenAuth).toEqual(["Bearer sk-resolved"])
  })
})

describe("redactEndpointForDiagnostics — no secret leakage", () => {
  test("diagnostic carries id/wire/model/policy/host but NEVER a resolved header value", () => {
    const diag = redactEndpointForDiagnostics(
      publicEndpoint({
        headers: { authorization: "Bearer sk-secret-xyz" },
        query: { key: "q-secret" },
      }),
    )
    const s = JSON.stringify(diag)
    expect(diag.id).toBe("gw")
    expect(diag.wireApi).toBe("chat")
    expect(diag.networkPolicy).toBe("public_https")
    // RED-ON-INJECTION: a resolved secret must never surface in diagnostics.
    expect(s).not.toContain("sk-secret-xyz")
    expect(s).not.toContain("q-secret")
    expect(s).not.toContain("Bearer")
  })
})

describe("one seam drives BOTH wires (single-owner parity)", () => {
  test("the SAME buildEndpointFetch output is assignable to Responses fetchImpl AND Chat fetchImpl", () => {
    const guarded: EndpointFetch = buildEndpointFetch(publicEndpoint())
    // Compile-level parity: the one guarded fetch is a valid Responses fetchImpl
    // (a Request/URL-accepting supertype of the string-only ResponsesFetchLike)
    // AND a valid Chat adapter fetchImpl. If the seam diverged per wire, one of
    // these assignments would fail to typecheck (checked by `typecheck:all`).
    const asResponses: ResponsesFetchLike = guarded
    // no cast — the Chat OpenAIConfig `fetchImpl` field must accept `guarded`
    const chat = new OpenAIAdapter({ apiKey: "k", model: "m", fetchImpl: guarded })
    expect(typeof asResponses).toBe("function")
    expect(chat.surfaceId).toBe("openai-chat-completions")
  })
})

describe("Chat adapter — guarded fetch injection seam (parity with Responses fetchImpl)", () => {
  test("an injected fetchImpl is used by the Chat adapter's SDK client", async () => {
    let called = false
    const inner = (async () => {
      called = true
      // minimal SSE-less error path is fine — we only prove the fetch is wired.
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch
    const adapter = new OpenAIAdapter({
      apiKey: "k",
      model: "gpt-x",
      baseURL: "https://gateway.example.com/v1",
      fetchImpl: inner,
    })
    // Drive one stream; the SDK client should call our injected fetch. We don't
    // assert on the (garbage) body — only that the injected fetch was reached,
    // proving the seam is wired (not the default global fetch).
    try {
      for await (const _ev of adapter.stream({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        signal: new AbortController().signal,
      })) {
        // drain
      }
    } catch {
      // a malformed body throws — irrelevant to the wiring proof
    }
    // RED-ON-INJECTION: if the adapter ignores `fetchImpl` and uses global fetch,
    // `called` stays false.
    expect(called).toBe(true)
  })

  test("gate-OFF parity: no fetchImpl ⇒ SDK client uses the GLOBAL fetch (byte-identical); with ⇒ injected", () => {
    // The SDK stores `fetch` privately, defaulting to the global when the
    // ClientOptions omits it. Proving parity: WITHOUT fetchImpl the private fetch
    // IS the global fetch (the pre-RFC05 construction); WITH fetchImpl it is our
    // injected function. RED-ON-INJECTION: if the adapter unconditionally set
    // `fetch`, the gate-OFF client's private fetch would NOT be the global one.
    const withOut = new OpenAIAdapter({ apiKey: "k", model: "m" })
    const clientOut = (withOut as unknown as { client: { fetch: unknown } }).client
    expect(clientOut.fetch).toBe(globalThis.fetch)

    const injected = (async () => new Response("")) as unknown as typeof fetch
    const withIn = new OpenAIAdapter({ apiKey: "k", model: "m", fetchImpl: injected })
    const clientIn = (withIn as unknown as { client: { fetch: unknown } }).client
    expect(clientIn.fetch).toBe(injected)
    expect(clientIn.fetch).not.toBe(globalThis.fetch)
  })
})
