/**
 * Hellgate — `providerFromEnv` (ADR-0142).
 *
 * Seal the env-var → `WebSearchProvider` selection:
 *   1. No env       → undefined.
 *   2. Brave key    → braveSearchProvider (duck-typed: has `.search`).
 *   3. Empty Brave  → undefined (treated as not set).
 *   4. DDG flag     → duckduckgoSearchProvider (duck-typed: has `.search`).
 *   5. Both set     → Brave wins (documented precedence).
 *
 * No real network — we only assert the SHAPE of the returned provider
 * (duck-typed via the `WebSearchProvider` port), never call `.search()`.
 * The provider impls themselves are sealed by their own hellgates.
 */

import { describe, expect, test } from "bun:test"
import { providerFromEnv } from "@/tool/web/providers"

/** Build a clean `NodeJS.ProcessEnv` snapshot — `process.env` carries every
 *  inherited shell var (PATH, HOME, …) which we do NOT want leaking into
 *  the assertion surface. Object literal cast — `NodeJS.ProcessEnv` is a
 *  dictionary type. */
const makeEnv = (entries: Record<string, string | undefined>): NodeJS.ProcessEnv => {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined) out[k] = v
  }
  return out as NodeJS.ProcessEnv
}

describe("providerFromEnv (ADR-0142)", () => {
  test("1. no env vars → undefined", () => {
    const provider = providerFromEnv(makeEnv({}))
    expect(provider).toBeUndefined()
  })

  test("2. BRAVE_SEARCH_API_KEY set → brave provider (duck-typed)", () => {
    const provider = providerFromEnv(makeEnv({ BRAVE_SEARCH_API_KEY: "test-brave-key-123" }))
    expect(provider).toBeDefined()
    expect(typeof provider?.search).toBe("function")
  })

  test("3. empty BRAVE_SEARCH_API_KEY → undefined (treated as not set)", () => {
    const provider = providerFromEnv(makeEnv({ BRAVE_SEARCH_API_KEY: "" }))
    expect(provider).toBeUndefined()
  })

  test("4. QUANTA_WEB_SEARCH_DUCKDUCKGO=1 → duckduckgo provider (duck-typed)", () => {
    const provider = providerFromEnv(makeEnv({ QUANTA_WEB_SEARCH_DUCKDUCKGO: "1" }))
    expect(provider).toBeDefined()
    expect(typeof provider?.search).toBe("function")
  })

  test("5. both set → Brave wins (precedence documented in ADR-0142)", async () => {
    // Distinguish Brave vs DDG by error SHAPE on a failing call:
    //   - Brave throws `BraveSearchError` (name === "BraveSearchError")
    //   - DDG throws a plain `Error` with a "duckduckgo " prefix
    // We inject a fake `process.env`-like and then exercise `.search()`
    // against a fake fetcher swapped onto `globalThis.fetch` so neither
    // provider escapes to real network.
    const both = providerFromEnv(
      makeEnv({
        BRAVE_SEARCH_API_KEY: "test-brave-key-456",
        QUANTA_WEB_SEARCH_DUCKDUCKGO: "1",
      }),
    )
    expect(both).toBeDefined()
    if (both === undefined) return

    const originalFetch = globalThis.fetch
    try {
      // Fake fetch that always 401s — Brave converts non-2xx into
      // `BraveSearchError`; DDG into plain `Error("duckduckgo HTTP 401")`.
      // We cast through `unknown` because `typeof fetch` carries a non-
      // standard `preconnect` overload on the Bun/undici types that we
      // don't model in this fake (the providers never call it).
      const fakeFetch = (async () =>
        new Response("unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        })) as unknown as typeof globalThis.fetch
      globalThis.fetch = fakeFetch

      try {
        await both.search("anything", 1)
        throw new Error("expected provider.search to throw")
      } catch (err) {
        // Brave wins ⇒ error.name === "BraveSearchError"
        expect(err).toBeInstanceOf(Error)
        expect((err as Error).name).toBe("BraveSearchError")
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
