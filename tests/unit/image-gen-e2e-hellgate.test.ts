/**
 * Hellgate e2e — `image_gen` through the REAL registration path (H14a).
 *
 * Drives the ACTUAL tool built by `buildDefaultTools({ imageGen })` with a
 * key-bound `openAiImagePort({ apiKey, fetcher })` whose `fetcher` returns a
 * CANNED OpenAI images response (`data[].b64_json`). The decode + jailed write
 * use the real `@/storage` write port (`defaultImageWritePort`) against a tmp
 * jail, then we re-read the file from disk and assert PNG magic bytes — proving
 * the whole seam (registration → provider port → base64 decode → FS-jail write)
 * end to end with NO real network.
 *
 * Also asserts the default-OFF posture: `buildDefaultTools()` with no port does
 * NOT register `image_gen` (byte-identical default menu).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDefaultTools } from "@/tool"
import { openAiImagePort } from "@/tool/image-gen"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/** Minimal 1×1 PNG (67 bytes). */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

/** Fake fetch returning a canned OpenAI images response (records the request). */
const cannedImagesFetch = (
  b64: string,
): { fetcher: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) })
    return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetcher, calls }
}

let jail: string
beforeEach(() => {
  jail = mkdtempSync(join(tmpdir(), "image-gen-e2e-"))
})
afterEach(() => {
  try {
    rmSync(jail, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

const ctx = (): ToolContext => ({ cwd: jail, signal: new AbortController().signal })

describe("image_gen e2e — registration + real write", () => {
  test("knob OFF (no port) ⇒ image_gen NOT registered (byte-identical menu)", () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).not.toContain("image_gen")
  })

  test("knob ON (port wired) ⇒ image_gen registered and writes a valid PNG", async () => {
    const b64 = Buffer.from(PNG_1x1).toString("base64")
    const { fetcher, calls } = cannedImagesFetch(b64)
    // Real port, key-bound, fake fetch — exactly what the composition root wires
    // when QUANTA_IMAGE_GEN is on and OPENAI_API_KEY resolves.
    const port = openAiImagePort({ apiKey: "sk-test-key", fetcher })

    const tools = buildDefaultTools({ imageGen: port })
    const tool = tools.find((t) => t.name === "image_gen")
    expect(tool).toBeDefined()
    if (tool === undefined) throw new Error("image_gen not registered")
    expect(tool.isReadOnly?.()).toBe(false)

    let result: ToolResult | undefined
    for await (const ev of tool.execute(
      { prompt: "a red square", outputPath: "assets/square.png", size: "1024x1024" } as never,
      ctx(),
    ) as AsyncIterable<ToolEvent>) {
      if (ev.type === "result") result = ev.result
    }
    expect(result?.ok).toBe(true)

    // The provider was actually hit at the generations endpoint.
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain("/images/generations")

    // Re-read the written file from disk and verify PNG magic bytes.
    const written = join(jail, "assets", "square.png")
    const bytes = new Uint8Array(readFileSync(written))
    expect([...bytes.slice(0, 4)]).toEqual(PNG_MAGIC)
    expect([...bytes]).toEqual([...PNG_1x1])
  })

  test("key-less real port ⇒ typed no_key failure, no network call", async () => {
    const { fetcher, calls } = cannedImagesFetch(Buffer.from(PNG_1x1).toString("base64"))
    const port = openAiImagePort({ fetcher }) // NO apiKey
    const tool = buildDefaultTools({ imageGen: port }).find((t) => t.name === "image_gen")
    if (tool === undefined) throw new Error("image_gen not registered")

    let result: ToolResult | undefined
    for await (const ev of tool.execute(
      { prompt: "x", outputPath: "x.png" } as never,
      ctx(),
    ) as AsyncIterable<ToolEvent>) {
      if (ev.type === "result") result = ev.result
    }
    expect(result?.ok).toBe(false)
    expect((result?.failure as { modelVisibleError?: string }).modelVisibleError).toBe(
      "no_provider_key",
    )
    // No HTTP call was made — key check short-circuits before fetch.
    expect(calls.length).toBe(0)
  })

  test("provider non-2xx ⇒ typed ok:false through the real port", async () => {
    const fetcher = (async () =>
      new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
      })) as unknown as typeof fetch
    const port = openAiImagePort({ apiKey: "sk-test", fetcher })
    const tool = buildDefaultTools({ imageGen: port }).find((t) => t.name === "image_gen")
    if (tool === undefined) throw new Error("image_gen not registered")

    let result: ToolResult | undefined
    for await (const ev of tool.execute(
      { prompt: "x", outputPath: "x.png" } as never,
      ctx(),
    ) as AsyncIterable<ToolEvent>) {
      if (ev.type === "result") result = ev.result
    }
    expect(result?.ok).toBe(false)
    expect(result?.output).toContain("429")
  })
})
