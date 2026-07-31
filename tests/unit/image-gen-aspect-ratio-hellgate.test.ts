/**
 * §5.2 (long-tail) — image_gen `aspectRatio` enum.
 *
 * A model-friendly way to express output shape WITHOUT computing raw
 * `WIDTHxHEIGHT` pixels. The input schema gains an `aspectRatio` enum
 * (`1:1`|`16:9`|`9:16`|`4:3`|`3:4`|`auto`); the provider port's
 * `ImageGenRequest` carries it (provider-agnostic). The default OpenAI adapter
 * resolves it to a concrete gpt-image-1 `size` ONLY when the caller left `size`
 * at `auto` (explicit `size` always wins).
 *
 * Default-OFF / byte-identity (HARD): absent `aspectRatio` ⇒ the request and
 * the resolved provider `size` are BYTE-IDENTICAL to legacy (`auto`).
 *
 * Hellgate: drive the REAL tool built by `buildDefaultTools({ imageGen })`
 * with a key-bound `openAiImagePort({ apiKey, fetcher })` and assert the wire
 * `size` the provider receives (no real network).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDefaultTools } from "@/tool"
import {
  type GeneratedImage,
  type ImageGenOutcome,
  type ImageGenPort,
  type ImageGenRequest,
  imageGenInputSchema,
  openAiImagePort,
} from "@/tool/image-gen"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/** Minimal 1×1 PNG. */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
const PNG_B64 = Buffer.from(PNG_1x1).toString("base64")
const pngImage: GeneratedImage = { b64: PNG_B64, mediaType: "image/png" }

let jail: string
beforeEach(() => {
  jail = mkdtempSync(join(tmpdir(), "img-aspect-"))
})
afterEach(() => rmSync(jail, { recursive: true, force: true }))

const ctx = (): ToolContext => ({ cwd: jail, signal: new AbortController().signal })

/** Fake provider that records the request the tool builds. */
const recordingPort = (): ImageGenPort & { last?: ImageGenRequest } => {
  const p: ImageGenPort & { last?: ImageGenRequest } = {
    async generate(req: ImageGenRequest): Promise<ImageGenOutcome> {
      p.last = req
      return { kind: "ok", images: [pngImage] }
    },
  }
  return p
}

const runTool = async (
  port: ImageGenPort,
  input: Record<string, unknown>,
): Promise<ToolResult | undefined> => {
  const tool = buildDefaultTools({ imageGen: port as never }).find((t) => t.name === "image_gen")
  if (tool === undefined) throw new Error("image_gen not registered")
  let res: ToolResult | undefined
  for await (const ev of tool.execute(
    { prompt: "p", outputPath: "out.png", ...input } as never,
    ctx(),
  ) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") res = ev.result
  }
  return res
}

/** Canned-fetch OpenAI adapter that captures the JSON body the adapter posts. */
const cannedFetch = (): {
  fetcher: typeof fetch
  bodies: Array<Record<string, unknown>>
} => {
  const bodies: Array<Record<string, unknown>> = []
  const fetcher = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof init?.body === "string")
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
    return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetcher, bodies }
}

describe("§5.2 — image_gen aspectRatio schema", () => {
  test("accepts each enum member", () => {
    for (const aspectRatio of ["1:1", "16:9", "9:16", "4:3", "3:4", "auto"]) {
      const p = imageGenInputSchema.safeParse({ prompt: "x", outputPath: "o.png", aspectRatio })
      expect(p.success).toBe(true)
    }
  })
  test("rejects a non-enum aspectRatio", () => {
    const p = imageGenInputSchema.safeParse({
      prompt: "x",
      outputPath: "o.png",
      aspectRatio: "21:9",
    })
    expect(p.success).toBe(false)
  })
})

describe("§5.2 — aspectRatio flows to the provider request (e2e via recording port)", () => {
  test("aspectRatio is passed through on the request", async () => {
    const port = recordingPort()
    const res = await runTool(port, { aspectRatio: "16:9" })
    expect(res?.ok).toBe(true)
    expect(port.last?.aspectRatio).toBe("16:9")
  })

  test("ABSENT aspectRatio ⇒ request.aspectRatio is `auto` AND size is `auto` (byte-identical legacy)", async () => {
    const port = recordingPort()
    const res = await runTool(port, {})
    expect(res?.ok).toBe(true)
    expect(port.last?.aspectRatio).toBe("auto")
    expect(port.last?.size).toBe("auto")
  })
})

describe("§5.2 — OpenAI adapter resolves aspectRatio→size (real port, canned fetch)", () => {
  test("aspectRatio 16:9 with size auto ⇒ adapter posts size 1536x1024", async () => {
    const { fetcher, bodies } = cannedFetch()
    const port = openAiImagePort({ apiKey: "sk-test", fetcher })
    const res = await runTool(port, { aspectRatio: "16:9" })
    expect(res?.ok).toBe(true)
    expect(bodies[0]?.size).toBe("1536x1024")
  })

  test("aspectRatio 9:16 ⇒ 1024x1536; 1:1 ⇒ 1024x1024", async () => {
    const a = cannedFetch()
    await runTool(openAiImagePort({ apiKey: "sk-test", fetcher: a.fetcher }), {
      aspectRatio: "9:16",
    })
    expect(a.bodies[0]?.size).toBe("1024x1536")
    const b = cannedFetch()
    await runTool(openAiImagePort({ apiKey: "sk-test", fetcher: b.fetcher }), {
      aspectRatio: "1:1",
    })
    expect(b.bodies[0]?.size).toBe("1024x1024")
  })

  test("EXPLICIT size wins over aspectRatio (size is authoritative)", async () => {
    const { fetcher, bodies } = cannedFetch()
    const port = openAiImagePort({ apiKey: "sk-test", fetcher })
    const res = await runTool(port, { aspectRatio: "16:9", size: "512x512" })
    expect(res?.ok).toBe(true)
    expect(bodies[0]?.size).toBe("512x512")
  })

  test("BYTE-IDENTITY: no aspectRatio, no size ⇒ adapter posts size `auto` (unchanged wire)", async () => {
    const { fetcher, bodies } = cannedFetch()
    const port = openAiImagePort({ apiKey: "sk-test", fetcher })
    const res = await runTool(port, {})
    expect(res?.ok).toBe(true)
    expect(bodies[0]?.size).toBe("auto")
  })
})
