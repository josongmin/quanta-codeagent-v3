/**
 * Hellgate — `read_image_url` tool (ADR-0132).
 *
 * Seal:
 *   A. Tool metadata (name / read-only=true / concurrency-safe=true)
 *   B. Input schema (zod url validation)
 *   C. URL safety (non-https / SSRF: localhost / 127.x / 192.168.x)
 *   D. Fetch happy (PNG / JPEG / WebP / GIF — magic-byte sniff each)
 *   E. Fetch sad (404 / oversize body > 5 MB / non-image bytes)
 *   F. Signal forwarded to fetcher
 *
 * Network is fully mocked via the `{ fetcher }` DI seam — no real I/O.
 */

import { describe, expect, test } from "bun:test"
import { readImageUrlTool } from "@/tool/image/from-url"
import { MAX_IMAGE_BYTES } from "@/tool/image/read"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

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
  const tool = fetcher === undefined ? readImageUrlTool() : readImageUrlTool({ fetcher })
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

/** Build a `Response` whose body is a single Uint8Array. */
const responseFromBytes = (bytes: Uint8Array, init: ResponseInit = {}): Response =>
  new Response(bytes, { status: 200, ...init })

const fakeFetch = (response: Response): typeof fetch =>
  (async () => response) as unknown as typeof fetch

/* ------------------------------------------------------------------ */
/* magic-byte fixture builders (same as read-image-hellgate)           */
/* ------------------------------------------------------------------ */

/** Minimal 1×1 PNG (67 bytes) — magic + IHDR + IDAT + IEND. */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/** Minimal JPEG header — `FF D8 FF E0` (JFIF) + tiny body. */
const JPEG_MIN = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
])

/** Minimal GIF — `GIF89a` + 7-byte LSD + `3B` trailer. */
const GIF_MIN = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x3b,
])

/** Minimal WebP — `RIFF` + size + `WEBP` + VP8L. */
const WEBP_MIN = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x00, 0x88, 0x88, 0x08, 0x07, 0x10, 0x10, 0x11,
  0x11,
])

/* ------------------------------------------------------------------ */
/* A. Tool metadata                                                    */
/* ------------------------------------------------------------------ */

describe("A. metadata", () => {
  test("1. name === 'read_image_url'", () => {
    expect(readImageUrlTool().name).toBe("read_image_url")
  })
  test("2. isReadOnly() === true", () => {
    expect(readImageUrlTool().isReadOnly()).toBe(true)
  })
  test("3. isConcurrencySafe() === true", () => {
    expect(readImageUrlTool().isConcurrencySafe({ url: "https://example.com/x.png" })).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* B. Input validation                                                 */
/* ------------------------------------------------------------------ */

describe("B. input validation", () => {
  test("4. {} → ok:false invalid input", async () => {
    const r = await collect({})
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
  test("5. {url:'not-a-url'} → ok:false (zod url validation)", async () => {
    const r = await collect({ url: "not-a-url" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })
})

/* ------------------------------------------------------------------ */
/* C. URL safety                                                       */
/* ------------------------------------------------------------------ */

describe("C. URL safety", () => {
  test("6. http:// → ok:false (only https)", async () => {
    const r = await collect({ url: "http://example.com/img.png" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/only https/i)
  })
  test("7. https://localhost/img.png → ok:false (SSRF)", async () => {
    const r = await collect({ url: "https://localhost/img.png" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/SSRF|denied|localhost/i)
    expect(r.failure?.mode).toBe("permission_denied")
    expect(r.failure?.isReadonly).toBe(true)
  })
  test("8. https://127.0.0.1/img.png → ok:false (SSRF)", async () => {
    const r = await collect({ url: "https://127.0.0.1/img.png" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/SSRF|denied|127/i)
  })
  test("9. https://192.168.1.1/img.png → ok:false (SSRF)", async () => {
    const r = await collect({ url: "https://192.168.1.1/img.png" })
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/SSRF|denied|192\.168/i)
  })
})

/* ------------------------------------------------------------------ */
/* D. Fetch happy path                                                 */
/* ------------------------------------------------------------------ */

describe("D. fetch happy", () => {
  test("10. PNG bytes → ok:true, mediaType image/png", async () => {
    const r = await collect(
      { url: "https://example.com/x.png" },
      fakeFetch(responseFromBytes(PNG_1x1)),
    )
    expect(r.ok).toBe(true)
    expect(r.images?.length).toBe(1)
    const img = r.images?.[0]
    expect(img?.type).toBe("image")
    expect(img?.mediaType).toBe("image/png")
    const decoded = Buffer.from(img?.data ?? "", "base64")
    expect(decoded.length).toBe(PNG_1x1.length)
    expect(decoded[0]).toBe(0x89)
    expect(r.output).toContain("image/png")
    expect(r.output).toContain("https://example.com/x.png")
  })
  test("11. JPEG bytes → mediaType image/jpeg", async () => {
    const r = await collect(
      { url: "https://example.com/x.jpg" },
      fakeFetch(responseFromBytes(JPEG_MIN)),
    )
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/jpeg")
  })
  test("12. WebP bytes → mediaType image/webp", async () => {
    const r = await collect(
      { url: "https://example.com/x.webp" },
      fakeFetch(responseFromBytes(WEBP_MIN)),
    )
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/webp")
  })
  test("13. GIF bytes → mediaType image/gif", async () => {
    const r = await collect(
      { url: "https://example.com/x.gif" },
      fakeFetch(responseFromBytes(GIF_MIN)),
    )
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/gif")
  })
})

/* ------------------------------------------------------------------ */
/* E. Fetch sad paths                                                  */
/* ------------------------------------------------------------------ */

describe("E. fetch sad", () => {
  test("14. 404 → ok:false with status", async () => {
    const r = await collect(
      { url: "https://example.com/missing.png" },
      fakeFetch(new Response("nope", { status: 404, statusText: "Not Found" })),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("404")
    expect(r.failure?.mode).toBe("error")
  })
  test("15. response > 5 MB → ok:false image too large", async () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
    // Lead with PNG signature so the size check is the rejection cause,
    // not the magic-byte sniff.
    big[0] = 0x89
    big[1] = 0x50
    big[2] = 0x4e
    big[3] = 0x47
    big[4] = 0x0d
    big[5] = 0x0a
    big[6] = 0x1a
    big[7] = 0x0a
    const r = await collect(
      { url: "https://example.com/big.png" },
      fakeFetch(responseFromBytes(big)),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("image too large")
  })
  test("16. non-image bytes → ok:false unsupported or unrecognized", async () => {
    const random = new TextEncoder().encode("not actually an image, just text")
    const r = await collect(
      { url: "https://example.com/decoy.png" },
      fakeFetch(responseFromBytes(random)),
    )
    expect(r.ok).toBe(false)
    expect(r.output).toContain("unsupported or unrecognized")
  })
})

/* ------------------------------------------------------------------ */
/* F. Signal forwarded                                                 */
/* ------------------------------------------------------------------ */

describe("F. signal", () => {
  test("17. ctx.signal is forwarded to fetcher", async () => {
    let seen: AbortSignal | undefined
    const spyFetch = (async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return responseFromBytes(PNG_1x1)
    }) as unknown as typeof fetch
    const ac = new AbortController()
    await collect({ url: "https://example.com/x.png" }, spyFetch, ctx(ac.signal))
    expect(seen).toBe(ac.signal)
  })
})
