/**
 * Hellgate — `web_fetch` tool + SSRF defense + HTML→Markdown (ADR-0127 Part 1).
 *
 * Seal:
 *   A. Tool metadata (name / read-only=true / concurrency-safe=true / no hitlTier)
 *   B. Input schema (zod url + https-only refine + maxBytes ceiling)
 *   C. SSRF defense (localhost / 127.x / 10.x / 192.168.x / 169.254.x)
 *   D. Mocked fetch happy + sad (200 / 404 / binary content / oversize body)
 *   E. HTML→Markdown pure conversion (heading / link / script-strip)
 *
 * The fetcher is injected via `webFetchTool({ fetcher })` so no real network
 * I/O happens in this suite.
 */

import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"
import { htmlToMarkdown, turndown, WEB_FETCH_MAX_BYTES_CEILING, webFetchTool } from "@/tool/web"

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: "/tmp",
  signal: signal ?? new AbortController().signal,
})

const collect = async (
  input: unknown,
  fetcher?: typeof fetch,
  c: ToolContext = ctx(),
): Promise<ToolResult> => {
  const tool = fetcher === undefined ? webFetchTool() : webFetchTool({ fetcher })
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

/** Build a `Response` whose body streams from a single Uint8Array. */
const responseFromBytes = (
  bytes: Uint8Array,
  init: ResponseInit & { contentType?: string } = {},
): Response => {
  const { contentType = "text/plain", ...rest } = init
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    ...rest,
    headers: {
      "content-type": contentType,
      ...((rest.headers as Record<string, string> | undefined) ?? {}),
    },
  })
}

const fakeFetch = (response: Response): typeof fetch => {
  return (async () => response) as unknown as typeof fetch
}

const fakeFetchThrows = (msg: string): typeof fetch => {
  return (async () => {
    throw new Error(msg)
  }) as unknown as typeof fetch
}

/* ------------------------------------------------------------------ */
/* A. Tool metadata                                                    */
/* ------------------------------------------------------------------ */

describe("A. metadata", () => {
  test("1. name === 'web_fetch'", () => {
    expect(webFetchTool().name).toBe("web_fetch")
  })
  test("2. isReadOnly() === true", () => {
    expect(webFetchTool().isReadOnly()).toBe(true)
  })
  test("3. isConcurrencySafe() === true", () => {
    expect(webFetchTool().isConcurrencySafe({ url: "https://example.com" })).toBe(true)
  })
  test("4. no hitlTier hook (defaults to none via isReadOnly inference)", () => {
    expect(webFetchTool().hitlTier).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* B. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("B. input validation", () => {
  test("5. {} → ok:false invalid input", async () => {
    const r = await collect({})
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
  test("6. http:// URL → ok:false 'only https://'", async () => {
    const r = await collect({ url: "http://example.com" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("only https://")
  })
  test("7. file:// URL → ok:false (not https)", async () => {
    const r = await collect({ url: "file:///etc/passwd" })
    expect(r.ok).toBe(false)
    // Could fail either at the refine (only https://) or the protocol check.
    expect(r.output.toLowerCase()).toMatch(/https|invalid/)
  })
  test("8. maxBytes > 5MB ceiling → ok:false invalid input", async () => {
    const r = await collect({
      url: "https://example.com",
      maxBytes: WEB_FETCH_MAX_BYTES_CEILING + 1,
    })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
})

/* ------------------------------------------------------------------ */
/* C. SSRF defense                                                     */
/* ------------------------------------------------------------------ */

describe("C. SSRF defense", () => {
  test("9. https://localhost → ok:false", async () => {
    const r = await collect({ url: "https://localhost/x" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("ssrf")
  })
  test("10. https://127.0.0.1 → ok:false (loopback)", async () => {
    const r = await collect({ url: "https://127.0.0.1/x" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("ssrf")
    expect(r.failure?.mode).toBe("permission_denied")
    expect(r.failure?.isReadonly).toBe(true)
  })
  test("11. https://10.0.0.5 → ok:false (RFC1918 private)", async () => {
    const r = await collect({ url: "https://10.0.0.5/x" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("ssrf")
  })
  test("12. https://192.168.1.1 → ok:false", async () => {
    const r = await collect({ url: "https://192.168.1.1/x" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("ssrf")
  })
  test("13. https://169.254.169.254 → ok:false (AWS metadata link-local)", async () => {
    const r = await collect({ url: "https://169.254.169.254/x" })
    expect(r.ok).toBe(false)
    expect(r.output.toLowerCase()).toContain("ssrf")
  })
})

/* ------------------------------------------------------------------ */
/* D. Mocked fetch (DI seam)                                           */
/* ------------------------------------------------------------------ */

describe("D. mocked fetch", () => {
  test("14. 200 text/html → ok:true, output starts with URL: and contains converted markdown", async () => {
    const html = "<h1>Hello</h1><p>world</p>"
    const fetcher = fakeFetch(
      responseFromBytes(new TextEncoder().encode(html), { contentType: "text/html" }),
    )
    const r = await collect({ url: "https://example.com/page" }, fetcher)
    expect(r.ok).toBe(true)
    expect(r.output.startsWith("URL:")).toBe(true)
    expect(r.output).toContain("# Hello")
    expect(r.output).toContain("world")
  })
  test("15. 404 → ok:false with status", async () => {
    const fetcher = fakeFetch(
      new Response("not found body", { status: 404, statusText: "Not Found" }),
    )
    const r = await collect({ url: "https://example.com/missing" }, fetcher)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("404")
  })
  test("16. binary content (image/png) → ok:false 'non-text content'", async () => {
    const fetcher = fakeFetch(
      responseFromBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { contentType: "image/png" }),
    )
    const r = await collect({ url: "https://example.com/img.png" }, fetcher)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("non-text content")
  })
  test("17. body exceeds maxBytes → response truncated, body-truncated note in header", async () => {
    // 100 KB body, maxBytes 1 KB.
    const big = new Uint8Array(100_000).fill(0x41) // 'A'
    const fetcher = fakeFetch(responseFromBytes(big, { contentType: "text/plain" }))
    const r = await collect({ url: "https://example.com/big", maxBytes: 1000 }, fetcher)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("(body truncated to cap)")
    // The truncated body length should be <= maxBytes.
    const lengthMatch = /Length: (\d+) bytes/.exec(r.output)
    expect(lengthMatch).not.toBeNull()
    expect(Number(lengthMatch?.[1] ?? "0")).toBeLessThanOrEqual(1000)
  })
  test("17b. network throws → ok:false typed error", async () => {
    const fetcher = fakeFetchThrows("ECONNREFUSED")
    const r = await collect({ url: "https://example.com" }, fetcher)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("fetch failed")
    expect(r.failure?.mode).toBe("error")
  })
})

/* ------------------------------------------------------------------ */
/* E. HTML→Markdown pure conversion                                    */
/* ------------------------------------------------------------------ */

describe("E. htmlToMarkdown", () => {
  test("18. <h1>Title</h1> → '# Title'", () => {
    expect(htmlToMarkdown("<h1>Title</h1>")).toContain("# Title")
  })
  test("19. <a href='X'>Y</a> → '[Y](X)'", () => {
    expect(htmlToMarkdown('<a href="X">Y</a>')).toContain("[Y](X)")
  })
  test("20. <script>BAD</script> → emptied (no 'BAD' in output)", () => {
    expect(htmlToMarkdown("<script>BAD_PAYLOAD</script>hello")).not.toContain("BAD_PAYLOAD")
  })
  test("20b. <style>x{color:red}</style> stripped", () => {
    const out = htmlToMarkdown("<style>x{color:red}</style>visible")
    expect(out).not.toContain("color:red")
    expect(out).toContain("visible")
  })
  test("20c. entities decoded (turndown-backed, ADR-0186 — domino DOM decodes natively)", () => {
    // turndown parses entities through its underlying HTML DOM; the
    // resulting markdown contains the decoded characters. The prior
    // self-impl asserted a literal byte-for-byte string `'<a>&"'`, but
    // once entities are decoded `<a>` becomes a real anchor tag which
    // the parser may render differently. We assert the decoded
    // characters appear; the exact ordering / wrapping is an internal
    // turndown detail.
    const out = htmlToMarkdown("&lt;a&gt;&amp;&quot;")
    expect(out).toContain("&")
    expect(out).toContain('"')
  })
  test("20d. 3+ newlines collapsed to 2 (turndown-backed — no triple-newline runs survive)", () => {
    // The prior self-impl operated on raw text and produced `'a\n\nb'`.
    // turndown's DOM parser wraps loose text differently, but our
    // post-processing step still guarantees the *invariant* (no triple+
    // newline run); the exact bytes between `a` and `b` are an
    // internal detail. The OLD bytes-exact form (`'a\n\nb'`) is no
    // longer a public contract — see ADR-0186.
    const out = htmlToMarkdown("a\n\n\n\n\nb")
    expect(out).not.toContain("\n\n\n")
    expect(out).toContain("a")
    expect(out).toContain("b")
  })
  test("20e. <code>x</code> → backtick", () => {
    expect(htmlToMarkdown("<code>x</code>")).toContain("`x`")
  })
  test("20f. <h2>Sub</h2> → '## Sub'", () => {
    expect(htmlToMarkdown("<h2>Sub</h2>")).toContain("## Sub")
  })
  test("20g. <noscript> / <iframe> stripped", () => {
    expect(htmlToMarkdown("<noscript>FALLBACK</noscript>visible")).not.toContain("FALLBACK")
    expect(htmlToMarkdown("<iframe>FRAMED</iframe>visible")).not.toContain("FRAMED")
  })
  test("20h. <pre><code> → fenced block", () => {
    const out = htmlToMarkdown("<pre><code>multi\nline</code></pre>")
    expect(out).toContain("```")
    expect(out).toContain("multi")
  })
  test("20i. <ul><li> list + <strong>/<em>", () => {
    const list = htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")
    expect(list).toMatch(/^-\s+a$/m)
    const emph = htmlToMarkdown("<strong>bold</strong> <em>it</em>")
    expect(emph).toContain("**bold**")
    expect(emph).toContain("_it_")
  })
  test("20j. trim + empty string", () => {
    const out = htmlToMarkdown("   <p>hello</p>   ")
    expect(out.startsWith(" ")).toBe(false)
    expect(htmlToMarkdown("")).toBe("")
  })
  test("20k. turndown singleton exported", () => {
    expect(typeof turndown.turndown).toBe("function")
    expect(typeof turndown.addRule).toBe("function")
  })
})

/* ------------------------------------------------------------------ */
/* F. Abort                                                            */
/* ------------------------------------------------------------------ */

describe("F. abort", () => {
  test("21. pre-aborted signal → ok:false 'aborted before start'", async () => {
    const ac = new AbortController()
    ac.abort()
    let fetchCalls = 0
    const fetcher = (async () => {
      fetchCalls += 1
      return new Response("unexpected")
    }) as unknown as typeof fetch
    const r = await collect({ url: "https://example.com" }, fetcher, ctx(ac.signal))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("aborted before start")
    expect(fetchCalls).toBe(0)
  })
})
