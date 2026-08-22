/**
 * Hellgate — `braveSearchProvider` + `duckduckgoSearchProvider`
 * (ADR-0133). Concrete `WebSearchProvider` implementations of the
 * closed port shipped in ADR-0127.
 *
 * Seal:
 *   A. brave: happy / limit clamping / URL shape / headers / query
 *      params / signal forwarding / HTTP errors / parse errors / graceful
 *      empty
 *   B. duckduckgo: happy mapping / empty / signal forwarding / network
 *      throw
 *
 * No real network — every test injects a fake `fetch` via the provider's
 * DI seam.
 */

import { describe, expect, test } from "bun:test"
import {
  BRAVE_DEFAULT_ENDPOINT,
  BraveSearchError,
  braveSearchProvider,
  DDG_DEFAULT_ENDPOINT,
  duckduckgoSearchProvider,
} from "@/tool/web/providers"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

interface Capture {
  url: string
  init: RequestInit | undefined
}

/** Fake-fetch factory that captures every call. The `responder` returns
 *  the `Response` (or throws) per-call. */
const makeFakeFetch = (
  responder: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: Capture[] } => {
  const calls: Capture[] = []
  const fetcher = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : ""
    calls.push({ url, init })
    return Promise.resolve(responder(url, init))
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

/** Build a JSON Response with the given body. */
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

/* ====================================================================== */
/* A. braveSearchProvider                                                  */
/* ====================================================================== */

describe("A. braveSearchProvider", () => {
  /* ----- 1. happy ----- */
  test("1. happy: 200 JSON with 3 web.results → 3 WebSearchHit returned", async () => {
    const { fetcher } = makeFakeFetch(() =>
      jsonResponse(200, {
        web: {
          results: [
            { title: "T1", url: "https://a.example/1", description: "D1" },
            { title: "T2", url: "https://a.example/2", description: "D2" },
            { title: "T3", url: "https://a.example/3", description: "D3" },
          ],
        },
      }),
    )
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    const hits = await p.search("anthropic api", 10)
    expect(hits.length).toBe(3)
    expect(hits[0]).toEqual({ title: "T1", url: "https://a.example/1", snippet: "D1" })
    expect(hits[2]?.snippet).toBe("D3")
  })

  /* ----- 2. respects limit ----- */
  test("2. respects limit: response has 10, limit=3 → 3 returned", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      title: `T${i}`,
      url: `https://x/${i}`,
      description: `D${i}`,
    }))
    const { fetcher } = makeFakeFetch(() => jsonResponse(200, { web: { results: rows } }))
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    const hits = await p.search("q", 3)
    expect(hits.length).toBe(3)
    expect(hits[0]?.title).toBe("T0")
    expect(hits[2]?.title).toBe("T2")
  })

  /* ----- 3. limit < 1 clamped to 1 ----- */
  test("3. limit < 1 clamped to 1 in URL (count=1)", async () => {
    const { fetcher, calls } = makeFakeFetch(() =>
      jsonResponse(200, { web: { results: [{ title: "T", url: "u", description: "d" }] } }),
    )
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    await p.search("q", 0)
    expect(calls[0]?.url).toContain("count=1")
  })

  /* ----- 4. limit > 20 clamped to 20 ----- */
  test("4. limit > 20 clamped to 20 in URL (count=20)", async () => {
    const { fetcher, calls } = makeFakeFetch(() => jsonResponse(200, { web: { results: [] } }))
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    await p.search("q", 9999)
    expect(calls[0]?.url).toContain("count=20")
  })

  /* ----- 5. URL contains query (encoded) ----- */
  test("5. URL contains URL-encoded query", async () => {
    const { fetcher, calls } = makeFakeFetch(() => jsonResponse(200, { web: { results: [] } }))
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    await p.search("hello world & friends", 5)
    expect(calls[0]?.url).toContain("q=hello%20world%20%26%20friends")
    expect(calls[0]?.url.startsWith(BRAVE_DEFAULT_ENDPOINT)).toBe(true)
  })

  /* ----- 6. API key in header (NOT URL) ----- */
  test("6. apiKey travels in X-Subscription-Token header, NEVER in URL", async () => {
    const { fetcher, calls } = makeFakeFetch(() => jsonResponse(200, { web: { results: [] } }))
    const p = braveSearchProvider({ apiKey: "SECRET-KEY-123", fetcher })
    await p.search("q", 5)
    const call = calls[0]
    expect(call).toBeDefined()
    const headers = call?.init?.headers as Record<string, string>
    expect(headers["X-Subscription-Token"]).toBe("SECRET-KEY-123")
    expect(headers.Accept).toBe("application/json")
    expect(headers["Accept-Encoding"]).toBe("gzip")
    // Key MUST NOT leak into the URL (would land in proxy / referrer logs).
    expect(call?.url).not.toContain("SECRET-KEY-123")
  })

  /* ----- 7. country / safesearch in URL ----- */
  test("7. country + safesearch flow into URL", async () => {
    const { fetcher, calls } = makeFakeFetch(() => jsonResponse(200, { web: { results: [] } }))
    const p = braveSearchProvider({
      apiKey: "k",
      fetcher,
      country: "gb",
      safesearch: "strict",
    })
    await p.search("q", 5)
    expect(calls[0]?.url).toContain("country=gb")
    expect(calls[0]?.url).toContain("safesearch=strict")
  })

  /* ----- 8. signal forwarded ----- */
  test("8. AbortSignal forwarded to fetch", async () => {
    const { fetcher, calls } = makeFakeFetch(() => jsonResponse(200, { web: { results: [] } }))
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    const ac = new AbortController()
    await p.search("q", 5, ac.signal)
    expect(calls[0]?.init?.signal).toBe(ac.signal)
  })

  /* ----- 9. 401 → throws BraveSearchError ----- */
  test("9. 401 → throws BraveSearchError with status 401", async () => {
    const { fetcher } = makeFakeFetch(() => new Response("Unauthorized: bad key", { status: 401 }))
    const p = braveSearchProvider({ apiKey: "bad", fetcher })
    try {
      await p.search("q", 5)
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      const be = err as BraveSearchError
      expect(be.status).toBe(401)
      expect(be.message).toContain("401")
    }
  })

  /* ----- 10. 5xx → throws BraveSearchError ----- */
  test("10. 503 → throws BraveSearchError with status 503", async () => {
    const { fetcher } = makeFakeFetch(() => new Response("upstream down", { status: 503 }))
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    try {
      await p.search("q", 5)
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      expect((err as BraveSearchError).status).toBe(503)
    }
  })

  /* ----- 11. malformed JSON → throws BraveSearchError parse-failed ----- */
  test("11. malformed JSON → throws BraveSearchError('parse-failed: ...')", async () => {
    const { fetcher } = makeFakeFetch(
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    )
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    try {
      await p.search("q", 5)
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      expect((err as BraveSearchError).message).toContain("parse-failed")
    }
  })

  /* ----- 12. missing web.results → empty array (graceful) ----- */
  test("12. missing web.results → empty array, no throw (graceful)", async () => {
    const { fetcher } = makeFakeFetch(() => jsonResponse(200, { query: { original: "q" } }))
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    const hits = await p.search("q", 5)
    expect(hits).toEqual([])
  })

  /* ----- 12b. network failure → wrapped BraveSearchError ----- */
  test("12b. network failure → BraveSearchError('network: ...')", async () => {
    const { fetcher } = makeFakeFetch(() => {
      throw new Error("ECONNREFUSED")
    })
    const p = braveSearchProvider({ apiKey: "k", fetcher })
    try {
      await p.search("q", 5)
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(BraveSearchError)
      expect((err as BraveSearchError).message).toContain("network")
    }
  })
})

/* ====================================================================== */
/* B. duckduckgoSearchProvider                                             */
/* ====================================================================== */

describe("B. duckduckgoSearchProvider", () => {
  /* ----- 13. happy ----- */
  test("13. happy: RelatedTopics → mapped to hits", async () => {
    const { fetcher, calls } = makeFakeFetch(() =>
      jsonResponse(200, {
        RelatedTopics: [
          { Text: "Anthropic – AI safety co", FirstURL: "https://en.wikipedia.org/wiki/Anthropic" },
          { Text: "Claude model family", FirstURL: "https://anthropic.com/claude" },
        ],
      }),
    )
    const p = duckduckgoSearchProvider({ fetcher })
    const hits = await p.search("anthropic", 5)
    expect(hits.length).toBe(2)
    expect(hits[0]?.url).toBe("https://en.wikipedia.org/wiki/Anthropic")
    expect(hits[0]?.title).toBe("Anthropic")
    expect(hits[0]?.snippet).toContain("AI safety")
    // Verify endpoint shape (format=json + no_html).
    expect(calls[0]?.url.startsWith(DDG_DEFAULT_ENDPOINT)).toBe(true)
    expect(calls[0]?.url).toContain("format=json")
    expect(calls[0]?.url).toContain("no_html=1")
  })

  /* ----- 14. empty RelatedTopics → [] ----- */
  test("14. empty RelatedTopics → []", async () => {
    const { fetcher } = makeFakeFetch(() => jsonResponse(200, { RelatedTopics: [] }))
    const p = duckduckgoSearchProvider({ fetcher })
    const hits = await p.search("q", 5)
    expect(hits).toEqual([])
  })

  /* ----- 14b. missing RelatedTopics → [] (graceful) ----- */
  test("14b. payload without RelatedTopics → []", async () => {
    const { fetcher } = makeFakeFetch(() => jsonResponse(200, { Abstract: "x" }))
    const p = duckduckgoSearchProvider({ fetcher })
    const hits = await p.search("q", 5)
    expect(hits).toEqual([])
  })

  /* ----- 15. signal forwarded ----- */
  test("15. AbortSignal forwarded to fetch", async () => {
    const { fetcher, calls } = makeFakeFetch(() => jsonResponse(200, { RelatedTopics: [] }))
    const p = duckduckgoSearchProvider({ fetcher })
    const ac = new AbortController()
    await p.search("q", 5, ac.signal)
    expect(calls[0]?.init?.signal).toBe(ac.signal)
  })

  /* ----- 16. network error → typed throw ----- */
  test("16. network error → throws Error('duckduckgo network: ...')", async () => {
    const { fetcher } = makeFakeFetch(() => {
      throw new Error("ENOTFOUND api.duckduckgo.com")
    })
    const p = duckduckgoSearchProvider({ fetcher })
    try {
      await p.search("q", 5)
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("duckduckgo network")
    }
  })

  /* ----- 16b. flatten nested Topics one level ----- */
  test("16b. nested Topics[] flattened one level deep", async () => {
    const { fetcher } = makeFakeFetch(() =>
      jsonResponse(200, {
        RelatedTopics: [
          {
            Name: "Disambig",
            Topics: [
              { Text: "Nested A", FirstURL: "https://a.example" },
              { Text: "Nested B", FirstURL: "https://b.example" },
            ],
          },
          { Text: "Flat C", FirstURL: "https://c.example" },
        ],
      }),
    )
    const p = duckduckgoSearchProvider({ fetcher })
    const hits = await p.search("q", 5)
    expect(hits.length).toBe(3)
    expect(hits[0]?.url).toBe("https://a.example")
    expect(hits[2]?.url).toBe("https://c.example")
  })
})
