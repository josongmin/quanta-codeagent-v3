/**
 * Hellgate — `web_search` tool + provider DI (ADR-0127 Part 2).
 *
 * Seal:
 *   A. Tool metadata (name / read-only=true / concurrency-safe=true)
 *   B. No-provider degrade (graceful ok:false, never crashes)
 *   C. Input validation (zod min/max on query + limit ceiling)
 *   D. Provider routing (delegation + zero-hit + throw)
 *   E. Output formatting (hit numbering + snippet truncation + multi-hit order)
 *   F. Signal forwarding (ctx.signal plumbed through verbatim)
 *
 * No real network: every test injects a fake `WebSearchProvider`.
 */

import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"
import {
  WEB_SEARCH_SNIPPET_MAX,
  type WebSearchHit,
  type WebSearchProvider,
  webSearchTool,
} from "@/tool/web"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/tmp",
  signal: signal ?? new AbortController().signal,
})

const collect = async (
  input: unknown,
  provider?: WebSearchProvider,
  c: ToolContext = ctx(),
): Promise<ToolResult> => {
  const tool = webSearchTool(provider)
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

/** Record-and-respond provider — captures every call's args. */
const recordingProvider = (
  hits: readonly WebSearchHit[],
): WebSearchProvider & { calls: Array<{ query: string; limit: number; signal?: AbortSignal }> } => {
  const calls: Array<{ query: string; limit: number; signal?: AbortSignal }> = []
  return {
    calls,
    search: async (query, limit, signal) => {
      calls.push({ query, limit, ...(signal !== undefined ? { signal } : {}) })
      return hits
    },
  }
}

const throwingProvider = (msg: string): WebSearchProvider => ({
  search: async () => {
    throw new Error(msg)
  },
})

/* ------------------------------------------------------------------ */
/* A. Tool metadata                                                    */
/* ------------------------------------------------------------------ */

describe("A. metadata", () => {
  test("1. name === 'web_search'", () => {
    expect(webSearchTool().name).toBe("web_search")
  })
  test("2. isReadOnly() === true", () => {
    expect(webSearchTool().isReadOnly()).toBe(true)
  })
  test("3. isConcurrencySafe() === true", () => {
    expect(webSearchTool().isConcurrencySafe({ query: "x" })).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* B. No-provider degrade                                              */
/* ------------------------------------------------------------------ */

describe("B. no-provider degrade", () => {
  test("4. webSearchTool() (no provider) → ok:false 'no web_search provider wired'", async () => {
    const r = await collect({ query: "anthropic api" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("no web_search provider wired")
    expect(r.failure?.mode).toBe("error")
  })
})

/* ------------------------------------------------------------------ */
/* C. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("C. input validation", () => {
  const p = recordingProvider([])
  test("5. {} → ok:false invalid input", async () => {
    const r = await collect({}, p)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
  test("6. {query:''} → ok:false", async () => {
    const r = await collect({ query: "" }, p)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
  test("7. {query:'x', limit:50} → ok:false invalid (max 20)", async () => {
    const r = await collect({ query: "x", limit: 50 }, p)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
})

/* ------------------------------------------------------------------ */
/* D. Provider routing                                                 */
/* ------------------------------------------------------------------ */

describe("D. provider routing", () => {
  test("8. valid input → provider.search called with (query, limit, signal)", async () => {
    const p = recordingProvider([{ title: "T", url: "https://e.com", snippet: "s" }])
    const ac = new AbortController()
    await collect({ query: "anthropic api", limit: 3 }, p, ctx(ac.signal))
    expect(p.calls.length).toBe(1)
    expect(p.calls[0]?.query).toBe("anthropic api")
    expect(p.calls[0]?.limit).toBe(3)
    expect(p.calls[0]?.signal).toBe(ac.signal)
  })
  test("9. zero hits → output '0 results for ...' (no throw)", async () => {
    const p = recordingProvider([])
    const r = await collect({ query: "nothing" }, p)
    expect(r.ok).toBe(true)
    expect(r.output).toContain('0 results for "nothing"')
  })
  test("10. provider throws → ok:false 'provider error:' + msg", async () => {
    const p = throwingProvider("rate_limited")
    const r = await collect({ query: "x" }, p)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("provider error:")
    expect(r.output).toContain("rate_limited")
  })
})

/* ------------------------------------------------------------------ */
/* E. Output formatting                                                */
/* ------------------------------------------------------------------ */

describe("E. output formatting", () => {
  test("11. 1 hit → output contains '1. <title>', URL, snippet", async () => {
    const p = recordingProvider([
      { title: "Anthropic API", url: "https://docs.anthropic.com/api", snippet: "Claude API ref" },
    ])
    const r = await collect({ query: "anthropic" }, p)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("1. Anthropic API")
    expect(r.output).toContain("https://docs.anthropic.com/api")
    expect(r.output).toContain("Claude API ref")
  })
  test("12. snippet > 200 chars → truncated at 200", async () => {
    const longSnippet = "a".repeat(WEB_SEARCH_SNIPPET_MAX + 100)
    const p = recordingProvider([{ title: "T", url: "https://e.com", snippet: longSnippet }])
    const r = await collect({ query: "x" }, p)
    expect(r.ok).toBe(true)
    // We expect a horizontal-ellipsis suffix and the body capped.
    expect(r.output).toContain("…")
    // Find the snippet line — count exactly N 'a' chars + …
    const aRun = r.output.match(/a+/)?.[0] ?? ""
    expect(aRun.length).toBe(WEB_SEARCH_SNIPPET_MAX)
  })
  test("13. multi-hit ordering preserved (input order)", async () => {
    const p = recordingProvider([
      { title: "First", url: "https://1", snippet: "1" },
      { title: "Second", url: "https://2", snippet: "2" },
      { title: "Third", url: "https://3", snippet: "3" },
    ])
    const r = await collect({ query: "x" }, p)
    expect(r.ok).toBe(true)
    const firstIdx = r.output.indexOf("First")
    const secondIdx = r.output.indexOf("Second")
    const thirdIdx = r.output.indexOf("Third")
    expect(firstIdx).toBeGreaterThan(-1)
    expect(secondIdx).toBeGreaterThan(firstIdx)
    expect(thirdIdx).toBeGreaterThan(secondIdx)
    // Numbered prefixes
    expect(r.output).toContain("1. First")
    expect(r.output).toContain("2. Second")
    expect(r.output).toContain("3. Third")
  })
})

/* ------------------------------------------------------------------ */
/* F. Signal forwarding                                                */
/* ------------------------------------------------------------------ */

describe("F. signal forwarding", () => {
  test("14. provider.search called with ctx.signal exactly", async () => {
    const p = recordingProvider([])
    const ac = new AbortController()
    await collect({ query: "x" }, p, ctx(ac.signal))
    expect(p.calls[0]?.signal).toBe(ac.signal)
  })
  test("14b. pre-aborted signal → ok:false 'aborted before start' (provider not called)", async () => {
    const p = recordingProvider([])
    const ac = new AbortController()
    ac.abort()
    const r = await collect({ query: "x" }, p, ctx(ac.signal))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("aborted")
    expect(p.calls.length).toBe(0)
  })
})
