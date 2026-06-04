/**
 * Hellgate — `image_gen` tool (H14a, jun-3-misc §3).
 *
 * Seal (fake ImageGenPort + in-memory ImageWritePort — NO real network/disk):
 *   A. Tool metadata (name / isReadOnly=FALSE (mutating) / concurrency-safe=false)
 *   B. generate writes a PNG to the jailed path; base64 decoded correctly
 *   C. never overwrites — a second call writes the `-v2` sibling
 *   D. path outside cwd → permission_denied (FS-jail escape)
 *   E. missing provider key (no_key outcome) → typed failure, no crash
 *   F. provider error outcome → typed ok:false
 *   G. per-image size cap enforced
 *   H. edit mode with reference image (reference read through the jail + passed
 *      to the port); edit without referenceImagePath → typed rejected
 *   I. n>1 writes indexed siblings; inlinePreview surfaces ToolResult.images
 *
 * All provider + write I/O is injected — the tool never touches a real provider.
 * Reference reads use a real tmp file (the tool reads the edit target via
 * Bun.file through resolveJailed).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type GeneratedImage,
  IMAGE_GEN_MAX_BYTES,
  type ImageGenOutcome,
  type ImageGenPort,
  type ImageGenRequest,
  type ImageWritePort,
  imageGenTool,
} from "@/tool/image-gen"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Minimal 1×1 PNG (67 bytes) — magic + IHDR + IDAT + IEND. */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
const PNG_B64 = Buffer.from(PNG_1x1).toString("base64")

const pngImage: GeneratedImage = { b64: PNG_B64, mediaType: "image/png" }

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

/** In-memory write port — records bytes by absolute path. */
class MemWritePort implements ImageWritePort {
  readonly files = new Map<string, Uint8Array>()
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes)
  }
}

/** Provider port that returns a fixed outcome and records the last request. */
const fakePort = (outcome: ImageGenOutcome): ImageGenPort & { last?: ImageGenRequest } => {
  const p: ImageGenPort & { last?: ImageGenRequest } = {
    async generate(req: ImageGenRequest): Promise<ImageGenOutcome> {
      p.last = req
      return outcome
    },
  }
  return p
}

/* ------------------------------------------------------------------ */
/* harness                                                            */
/* ------------------------------------------------------------------ */

let jail: string

beforeEach(() => {
  jail = mkdtempSync(join(tmpdir(), "image-gen-hellgate-"))
})
afterAll(() => {
  // best-effort cleanup of any leftover jail roots
})

const ctx = (signal?: AbortSignal): ToolContext => ({
  cwd: jail,
  signal: signal ?? new AbortController().signal,
})

const run = async (
  options: Parameters<typeof imageGenTool>[0],
  input: unknown,
  c?: ToolContext,
): Promise<ToolResult> => {
  const tool = imageGenTool(options)
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c ?? ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

/* ------------------------------------------------------------------ */
/* A. metadata                                                        */
/* ------------------------------------------------------------------ */

describe("image_gen — metadata", () => {
  test("name / mutating / not concurrency-safe", () => {
    const t = imageGenTool()
    expect(t.name).toBe("image_gen")
    expect(t.isReadOnly?.()).toBe(false)
    expect(t.isConcurrencySafe?.()).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* B. generate happy path + base64 correctness                        */
/* ------------------------------------------------------------------ */

describe("image_gen — generate", () => {
  test("writes a PNG to the jailed path with byte-correct decode", async () => {
    const writePort = new MemWritePort()
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort },
      { prompt: "a cat", outputPath: "out/cat.png" },
    )
    expect(res.ok).toBe(true)
    expect(writePort.files.size).toBe(1)
    const [path, bytes] = [...writePort.files.entries()][0] as [string, Uint8Array]
    expect(path.endsWith("out/cat.png")).toBe(true)
    // base64 round-trips to the exact PNG bytes
    expect([...bytes]).toEqual([...PNG_1x1])
    expect(res.output).toContain(path)
  })

  test("port receives the normalized request (mode/size/quality/n defaults)", async () => {
    const port = fakePort({ kind: "ok", images: [pngImage] })
    await run({ port, writePort: new MemWritePort() }, { prompt: "x", outputPath: "x.png" })
    expect(port.last?.mode).toBe("generate")
    expect(port.last?.size).toBe("auto")
    expect(port.last?.quality).toBe("auto")
    expect(port.last?.n).toBe(1)
    expect(port.last?.format).toBe("png")
  })
})

/* ------------------------------------------------------------------ */
/* C. never overwrites — versioned sibling                            */
/* ------------------------------------------------------------------ */

describe("image_gen — non-overwriting versioned siblings", () => {
  test("second write to the same path lands on -v2", async () => {
    const writePort = new MemWritePort()
    const opts = { port: fakePort({ kind: "ok", images: [pngImage] }), writePort }
    const r1 = await run(opts, { prompt: "a", outputPath: "hero.png" })
    const r2 = await run(opts, { prompt: "a", outputPath: "hero.png" })
    expect(r1.ok && r2.ok).toBe(true)
    const paths = [...writePort.files.keys()]
    expect(paths.some((p) => p.endsWith("hero.png"))).toBe(true)
    expect(paths.some((p) => p.endsWith("hero-v2.png"))).toBe(true)
    expect(writePort.files.size).toBe(2)
  })

  test("third write lands on -v3 (probe continues)", async () => {
    const writePort = new MemWritePort()
    const opts = { port: fakePort({ kind: "ok", images: [pngImage] }), writePort }
    await run(opts, { prompt: "a", outputPath: "x.png" })
    await run(opts, { prompt: "a", outputPath: "x.png" })
    const r3 = await run(opts, { prompt: "a", outputPath: "x.png" })
    expect(r3.ok).toBe(true)
    expect([...writePort.files.keys()].some((p) => p.endsWith("x-v3.png"))).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* D. FS-jail escape                                                  */
/* ------------------------------------------------------------------ */

describe("image_gen — FS jail", () => {
  test("path outside cwd → permission_denied, nothing written", async () => {
    const writePort = new MemWritePort()
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort },
      { prompt: "a", outputPath: "../escape.png" },
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("permission_denied")
    expect(writePort.files.size).toBe(0)
  })

  test("absolute path outside the jail → permission_denied", async () => {
    const writePort = new MemWritePort()
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort },
      { prompt: "a", outputPath: "/etc/passwd.png" },
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("permission_denied")
    expect(writePort.files.size).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* E/F. provider failure modes                                        */
/* ------------------------------------------------------------------ */

describe("image_gen — provider failures (no-throw, typed)", () => {
  test("no_key outcome → typed ok:false, no crash, nothing written", async () => {
    const writePort = new MemWritePort()
    const res = await run(
      { port: fakePort({ kind: "no_key" }), writePort },
      { prompt: "a", outputPath: "x.png" },
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("error")
    expect((res.failure as { modelVisibleError?: string }).modelVisibleError).toBe(
      "no_provider_key",
    )
    expect(writePort.files.size).toBe(0)
  })

  test("provider error outcome → typed ok:false", async () => {
    const res = await run(
      {
        port: fakePort({ kind: "error", message: "HTTP 429 rate limited" }),
        writePort: new MemWritePort(),
      },
      { prompt: "a", outputPath: "x.png" },
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("error")
    expect(res.output).toContain("429")
  })

  test("a port that THROWS is caught at the boundary (never escapes the loop)", async () => {
    const throwing: ImageGenPort = {
      async generate(): Promise<ImageGenOutcome> {
        throw new Error("boom")
      },
    }
    const res = await run(
      { port: throwing, writePort: new MemWritePort() },
      { prompt: "a", outputPath: "x.png" },
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("boom")
  })
})

/* ------------------------------------------------------------------ */
/* G. size cap                                                        */
/* ------------------------------------------------------------------ */

describe("image_gen — size cap", () => {
  test("an oversize decoded image is rejected, nothing written", async () => {
    const big = Buffer.alloc(IMAGE_GEN_MAX_BYTES + 1, 1).toString("base64")
    const writePort = new MemWritePort()
    const res = await run(
      { port: fakePort({ kind: "ok", images: [{ b64: big, mediaType: "image/png" }] }), writePort },
      { prompt: "a", outputPath: "x.png" },
    )
    expect(res.ok).toBe(false)
    expect((res.failure as { modelVisibleError?: string }).modelVisibleError).toBe("image_over_cap")
    expect(writePort.files.size).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* H. edit mode                                                       */
/* ------------------------------------------------------------------ */

describe("image_gen — edit mode", () => {
  test("edit without referenceImagePath → typed rejected", async () => {
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort: new MemWritePort() },
      { prompt: "a", outputPath: "x.png", mode: "edit" },
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("rejected")
  })

  test("edit reads the reference through the jail and passes it to the port", async () => {
    // write a real reference PNG inside the jail
    writeFileSync(join(jail, "ref.png"), Buffer.from(PNG_1x1))
    const port = fakePort({ kind: "ok", images: [pngImage] })
    const res = await run(
      { port, writePort: new MemWritePort() },
      {
        prompt: "make it blue",
        outputPath: "edited.png",
        mode: "edit",
        referenceImagePath: "ref.png",
      },
    )
    expect(res.ok).toBe(true)
    expect(port.last?.mode).toBe("edit")
    expect(port.last?.referenceImages.length).toBe(1)
    expect(port.last?.referenceImages[0]?.b64).toBe(PNG_B64)
  })

  test("edit with a missing reference → typed not_found", async () => {
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort: new MemWritePort() },
      { prompt: "a", outputPath: "x.png", mode: "edit", referenceImagePath: "nope.png" },
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("not_found")
  })

  test("edit reference outside the jail → permission_denied", async () => {
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort: new MemWritePort() },
      { prompt: "a", outputPath: "x.png", mode: "edit", referenceImagePath: "../secret.png" },
    )
    expect(res.ok).toBe(false)
    expect(res.failure?.mode).toBe("permission_denied")
  })
})

/* ------------------------------------------------------------------ */
/* I. n>1 + inline preview                                            */
/* ------------------------------------------------------------------ */

describe("image_gen — multi-image + inline preview", () => {
  test("n>1 writes indexed siblings", async () => {
    const writePort = new MemWritePort()
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage, pngImage, pngImage] }), writePort },
      { prompt: "a", outputPath: "v.png", n: 3 },
    )
    expect(res.ok).toBe(true)
    const keys = [...writePort.files.keys()]
    // n>1 ⇒ every image is index-suffixed (v-1, v-2, v-3) — unambiguous.
    expect(keys.some((p) => p.endsWith("v-1.png"))).toBe(true)
    expect(keys.some((p) => p.endsWith("v-2.png"))).toBe(true)
    expect(keys.some((p) => p.endsWith("v-3.png"))).toBe(true)
    expect(writePort.files.size).toBe(3)
  })

  test("inlinePreview attaches the first image via ToolResult.images", async () => {
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort: new MemWritePort() },
      { prompt: "a", outputPath: "x.png", inlinePreview: true },
    )
    expect(res.ok).toBe(true)
    expect(res.images?.length).toBe(1)
    expect(res.images?.[0]?.type).toBe("image")
    expect(res.images?.[0]?.data).toBe(PNG_B64)
  })

  test("without inlinePreview there is NO images channel (byte-identical)", async () => {
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort: new MemWritePort() },
      { prompt: "a", outputPath: "x.png" },
    )
    expect(res.ok).toBe(true)
    expect(res.images).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* schema rejects                                                     */
/* ------------------------------------------------------------------ */

describe("image_gen — schema", () => {
  test("empty prompt → invalid input", async () => {
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort: new MemWritePort() },
      { prompt: "", outputPath: "x.png" },
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("invalid input")
  })

  test("malformed size literal → invalid input", async () => {
    const res = await run(
      { port: fakePort({ kind: "ok", images: [pngImage] }), writePort: new MemWritePort() },
      { prompt: "a", outputPath: "x.png", size: "huge" },
    )
    expect(res.ok).toBe(false)
    expect(res.output).toContain("invalid input")
  })

  afterAll(() => {
    try {
      rmSync(jail, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })
})
