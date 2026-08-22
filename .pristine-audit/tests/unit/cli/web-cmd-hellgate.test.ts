/**
 * Hellgate — `/web` slash command (ADR-0224).
 *
 * 11 cases pinning the slash-dispatch contract — argument parsing, tool
 * delegation, header stripping, inbox routing, default-OFF parity, error
 * paths.
 *
 *  HELL-WEB-01: missing URL ⇒ usage + exit 1
 *  HELL-WEB-02: unknown flag ⇒ typed error + exit 1
 *  HELL-WEB-03: extra positional argument ⇒ typed error + exit 1
 *  HELL-WEB-04: invalid --max-bytes ⇒ typed error + exit 1
 *  HELL-WEB-05: http:// URL ⇒ tool refuses, exit 1
 *  HELL-WEB-06: SSRF deny (127.0.0.1) ⇒ tool refuses, exit 1
 *  HELL-WEB-07: 4xx response ⇒ exit 1 with HTTP status line
 *  HELL-WEB-08: happy-path with inbox wired ⇒ queued + size advances
 *  HELL-WEB-09: happy-path WITHOUT inbox ⇒ printed inline + exit 0 (default-OFF)
 *  HELL-WEB-10: --no-markdown strips the 4-line header
 *  HELL-WEB-11: inbox over-cap ⇒ typed error + exit 1
 */

import { describe, expect, test } from "bun:test"
import { createTextInbox } from "../../../src/apps/cli/text-inbox"
import { __test, webCmd } from "../../../src/apps/cli/web-cmd"

const collectOut = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
} => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, outFn: (s) => out.push(s), errFn: (s) => err.push(s) }
}

const fakeFetch = (responses: Record<string, Response | (() => Response)>): typeof fetch => {
  // Accept the structural minimum: a `string`, a `URL`, or any object with
  // a `url: string` property (the Request shape) — avoids depending on the
  // DOM lib's `RequestInfo` symbol which isn't in our @types/node config.
  return (async (input: string | URL | { url: string }) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const r = responses[url]
    if (r === undefined) throw new Error(`fakeFetch: no stub for ${url}`)
    return typeof r === "function" ? r() : r
  }) as unknown as typeof fetch
}

const html200 = (body: string, contentType = "text/html"): Response =>
  new Response(body, { status: 200, headers: { "content-type": contentType } })

describe("/web hellgate (ADR-0224)", () => {
  test("HELL-WEB-01: missing URL ⇒ usage + exit 1", async () => {
    const io = collectOut()
    const code = await webCmd.run([], { out: io.outFn, err: io.errFn, cwd: "/" })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("missing required <url>")
    expect(io.err.join("")).toContain("usage:")
  })

  test("HELL-WEB-02: unknown flag ⇒ typed error + exit 1", async () => {
    const io = collectOut()
    const code = await webCmd.run(["--bogus"], { out: io.outFn, err: io.errFn, cwd: "/" })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("unknown flag: --bogus")
  })

  test("HELL-WEB-03: extra positional argument ⇒ typed error + exit 1", async () => {
    const io = collectOut()
    const code = await webCmd.run(["https://a.com", "https://b.com"], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("unexpected extra argument")
  })

  test("HELL-WEB-04: invalid --max-bytes ⇒ typed error + exit 1", async () => {
    const io = collectOut()
    const code = await webCmd.run(["--max-bytes=abc", "https://a.com"], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("invalid --max-bytes")
  })

  test("HELL-WEB-05: http:// URL ⇒ tool refuses, exit 1", async () => {
    const io = collectOut()
    const code = await webCmd.run(["http://example.com"], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      webFetcher: fakeFetch({}),
    })
    expect(code).toBe(1)
    expect(io.err.join("").toLowerCase()).toContain("https")
  })

  test("HELL-WEB-06: SSRF deny (127.0.0.1) ⇒ tool refuses, exit 1", async () => {
    const io = collectOut()
    const code = await webCmd.run(["https://127.0.0.1/x"], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      webFetcher: fakeFetch({}),
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("SSRF")
  })

  test("HELL-WEB-07: 4xx response ⇒ exit 1 with HTTP status line", async () => {
    const io = collectOut()
    const url = "https://example.com/404"
    const code = await webCmd.run([url], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      webFetcher: fakeFetch({
        [url]: new Response("not found", {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "text/plain" },
        }),
      }),
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("HTTP 404")
  })

  test("HELL-WEB-08: happy-path with inbox wired ⇒ queued + size advances", async () => {
    const io = collectOut()
    const inbox = createTextInbox()
    const url = "https://example.com/post"
    const code = await webCmd.run([url], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      textInbox: inbox,
      webFetcher: fakeFetch({ [url]: html200("<h1>hi</h1><p>body</p>") }),
    })
    expect(code).toBe(0)
    expect(io.out.join("")).toMatch(/queued.*1 in inbox/)
    expect(inbox.size()).toBe(1)
    const drained = inbox.drain()
    expect(drained[0]?.kind).toBe("web")
    expect(drained[0]?.label).toBe(url)
    expect(drained[0]?.text).toContain("hi")
  })

  test("HELL-WEB-09: happy-path WITHOUT inbox ⇒ printed inline + exit 0", async () => {
    const io = collectOut()
    const url = "https://example.com/inline"
    const code = await webCmd.run([url], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      webFetcher: fakeFetch({ [url]: html200("<p>hello</p>") }),
    })
    expect(code).toBe(0)
    const joined = io.out.join("")
    expect(joined).toContain("hello")
    expect(joined).toContain("inbox not wired — printed inline")
  })

  test("HELL-WEB-10: --no-markdown strips the 4-line header", async () => {
    const url = "https://example.com/raw"
    const headed = "URL: x\nStatus: 200\nContent-Type: text/html\nLength: 5\n\nbody"
    const strip = __test.stripFetchHeader(headed)
    expect(strip).toBe("body")
    // and the full slash path:
    const io = collectOut()
    const inbox = createTextInbox()
    const code = await webCmd.run(["--no-markdown", url], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      textInbox: inbox,
      webFetcher: fakeFetch({
        [url]: new Response("plain text body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      }),
    })
    expect(code).toBe(0)
    const drained = inbox.drain()
    expect(drained[0]?.text).toBe("plain text body")
    expect(drained[0]?.text.startsWith("URL:")).toBe(false)
  })

  test("HELL-WEB-11: inbox over-cap ⇒ typed error + exit 1", async () => {
    const io = collectOut()
    const inbox = createTextInbox({ maxSize: 1 })
    inbox.add({ kind: "other", label: "x", text: "x" })
    const url = "https://example.com/full"
    const code = await webCmd.run([url], {
      out: io.outFn,
      err: io.errFn,
      cwd: "/",
      textInbox: inbox,
      webFetcher: fakeFetch({ [url]: html200("<p>x</p>") }),
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("inbox full")
  })

  test("HELL-WEB-12: parseArgs accepts --no-markdown + --max-bytes + url in any order", () => {
    const a = __test.parseArgs(["--no-markdown", "--max-bytes=2048", "https://a.com"])
    expect(typeof a).toBe("object")
    if (typeof a === "object") {
      expect(a.url).toBe("https://a.com")
      expect(a.markdown).toBe(false)
      expect(a.maxBytes).toBe(2048)
    }
    const b = __test.parseArgs(["https://b.com", "--max-bytes=4096"])
    if (typeof b === "object") {
      expect(b.url).toBe("https://b.com")
      expect(b.markdown).toBe(true)
      expect(b.maxBytes).toBe(4096)
    }
  })
})
