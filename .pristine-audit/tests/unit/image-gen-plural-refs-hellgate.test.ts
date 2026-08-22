/**
 * §5.2 (long-tail) — image_gen MULTIPLE reference images. The provider port
 * already accepts `referenceImages[]`; this surfaces it via the input schema
 * (`referenceImagePaths`) merged with the singular `referenceImagePath`
 * (de-duped). Default-OFF: absent ⇒ the singular path alone (byte-identical).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDefaultTools } from "@/tool"
import { IMAGE_GEN_MAX_REFS, imageGenInputSchema } from "@/tool/image-gen/tool"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

let jail: string
beforeEach(() => {
  jail = mkdtempSync(join(tmpdir(), "img-plural-"))
  mkdirSync(join(jail, "refs"), { recursive: true })
  writeFileSync(join(jail, "refs", "a.png"), PNG_1x1)
  writeFileSync(join(jail, "refs", "b.png"), PNG_1x1)
})
afterEach(() => rmSync(jail, { recursive: true, force: true }))

const ctx = (): ToolContext => ({ cwd: jail, signal: new AbortController().signal })

/** Fake port capturing how many reference images the tool passed through. */
const capturingPort = () => {
  let refs = -1
  return {
    refsSeen: () => refs,
    port: {
      async generate(req: { referenceImages: readonly unknown[] }) {
        refs = req.referenceImages.length
        return {
          kind: "ok" as const,
          images: [{ b64: Buffer.from(PNG_1x1).toString("base64"), mediaType: "image/png" }],
        }
      },
    },
  }
}

const runEdit = async (
  input: Record<string, unknown>,
): Promise<{ res: ToolResult | undefined; refs: number }> => {
  const cap = capturingPort()
  const tool = buildDefaultTools({ imageGen: cap.port as never }).find(
    (t) => t.name === "image_gen",
  )
  if (tool === undefined) throw new Error("image_gen not registered")
  let res: ToolResult | undefined
  for await (const ev of tool.execute(
    { prompt: "p", outputPath: "out.png", mode: "edit", ...input } as never,
    ctx(),
  ) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") res = ev.result
  }
  return { res, refs: cap.refsSeen() }
}

describe("§5.2 — image_gen referenceImagePaths schema", () => {
  test("accepts a plural referenceImagePaths array", () => {
    const p = imageGenInputSchema.safeParse({
      prompt: "x",
      outputPath: "o.png",
      mode: "edit",
      referenceImagePaths: ["a.png", "b.png"],
    })
    expect(p.success).toBe(true)
  })
  test(`rejects more than ${IMAGE_GEN_MAX_REFS} reference paths`, () => {
    const tooMany = Array.from({ length: IMAGE_GEN_MAX_REFS + 1 }, (_, i) => `r${i}.png`)
    const p = imageGenInputSchema.safeParse({
      prompt: "x",
      outputPath: "o.png",
      referenceImagePaths: tooMany,
    })
    expect(p.success).toBe(false)
  })
})

describe("§5.2 — plural reference merge + de-dup (e2e)", () => {
  test("two plural paths ⇒ the port receives TWO reference images", async () => {
    const { res, refs } = await runEdit({ referenceImagePaths: ["refs/a.png", "refs/b.png"] })
    expect(res?.ok).toBe(true)
    expect(refs).toBe(2)
  })

  test("singular + plural overlapping ⇒ DE-DUPED (a once)", async () => {
    const { refs } = await runEdit({
      referenceImagePath: "refs/a.png",
      referenceImagePaths: ["refs/a.png", "refs/b.png"],
    })
    expect(refs).toBe(2) // a (deduped) + b
  })

  test("singular only ⇒ ONE reference (byte-identical legacy)", async () => {
    const { refs } = await runEdit({ referenceImagePath: "refs/a.png" })
    expect(refs).toBe(1)
  })

  test("edit mode with NO references ⇒ typed rejection", async () => {
    const { res } = await runEdit({})
    expect(res?.ok).toBe(false)
  })
})
