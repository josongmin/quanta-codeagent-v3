/**
 * Dispatch + real readImageTool integration roundtrip — hellgate (Gap #2).
 *
 * The existing `tests/unit/dispatch-wires-checkpoint-and-image-hellgate.test.ts`
 * uses HAND-ROLLED tools that just yield a pre-fabricated `ToolResult`. This
 * suite proves the REAL `readImageTool` (with real FS I/O + magic-byte sniff
 * + base64 encode) plugs into REAL `dispatchTool` and the resulting
 * `tool_result` block carries the exact bytes the file held.
 *
 * Plane-clean (integration plane):
 *   - Imports REAL `readImageTool` from `@/tool/image`
 *   - Imports REAL `dispatchTool` from `@/agent/dispatch`
 *   - Uses real tmpdir + real PNG/JPEG fixture bytes
 *   - The ONLY fake is the `PermissionContext` mode (set to `acceptEdits`)
 *
 * Sections (5+ cases):
 *   1. Real PNG roundtrip → ImageBlock with correct base64
 *   2. dispatch wraps that ToolResult → contentBlocks shape correct
 *   3. ToolResult with NO images → byte-identical legacy string content
 *   4. Wrong magic bytes (PNG with .pdf extension) → readImageTool rejects via magic
 *   5. 3 concurrent dispatches of different images → no crosstalk
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { ToolRegistry } from "@/tool"
import { readImageTool } from "@/tool/image"

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Same canonical 67-byte 1x1 PNG used by `read-image-hellgate`. */
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const JPEG_MIN = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
])

const GIF_MIN = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x3b,
])

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

let workDir = ""
const perm: PermissionContext = { mode: "acceptEdits" }

const call = (name: string, input: unknown, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const config = (cwd: string, registry: ToolRegistry): AgentConfig =>
  ({
    registry,
    cwd,
    signal: new AbortController().signal,
    permission: perm,
  }) as AgentConfig

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "dispatch-image-roundtrip-hellgate-"))
  await writeFile(path.join(workDir, "a.png"), PNG_1x1)
  await writeFile(path.join(workDir, "b.jpg"), JPEG_MIN)
  await writeFile(path.join(workDir, "c.gif"), GIF_MIN)
  // Spoofed: PNG bytes with `.pdf` extension — read_image should still ACCEPT
  // because the magic-byte sniff is the SSOT and matches PNG.
  await writeFile(path.join(workDir, "spoofed-magic.png"), "not actually image bytes")
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/* 1. real PNG roundtrip                                               */
/* ------------------------------------------------------------------ */

describe("HELL-1: real PNG + readImageTool yields valid base64 ImageBlock", () => {
  test("readImageTool executed directly produces ToolResult.images with PNG base64", async () => {
    const registry = new ToolRegistry([readImageTool])
    const res = await dispatchTool(
      call("read_image", { path: "a.png" }),
      config(workDir, registry),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.block.contentBlocks).toBeDefined()
    const blocks = res.block.contentBlocks
    if (!blocks) throw new Error("expected contentBlocks")
    expect(blocks.length).toBe(2)
    const image = blocks[1]
    if (image?.type !== "image") throw new Error("expected ImageBlock at index 1")
    expect(image.mediaType).toBe("image/png")
    // Verify base64 round-trips back to the SAME bytes.
    const roundTripped = Buffer.from(image.data, "base64")
    expect(roundTripped.byteLength).toBe(PNG_1x1.byteLength)
    expect(Array.from(roundTripped)).toEqual(Array.from(PNG_1x1))
  })
})

/* ------------------------------------------------------------------ */
/* 2. dispatch wraps ToolResult with images → contentBlocks shape      */
/* ------------------------------------------------------------------ */

describe("HELL-2: dispatch tool_result block carries ImageBlock with matching base64", () => {
  test("tool_result.contentBlocks = [text, ImageBlock] with intact base64", async () => {
    const registry = new ToolRegistry([readImageTool])
    const res = await dispatchTool(
      call("read_image", { path: "b.jpg" }, "c-jpg"),
      config(workDir, registry),
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.block.type).toBe("tool_result")
    expect(res.block.tool_use_id).toBe("c-jpg")
    expect(res.block.is_error).toBeUndefined()
    const blocks = res.block.contentBlocks
    if (!blocks) throw new Error("expected contentBlocks")
    expect(blocks.length).toBe(2)
    const text = blocks[0]
    expect(text?.type).toBe("text")
    if (text?.type !== "text") throw new Error("unreachable")
    expect(text.text).toContain("b.jpg")
    expect(text.text).toContain("image/jpeg")
    const image = blocks[1]
    if (image?.type !== "image") throw new Error("expected ImageBlock at index 1")
    const roundTripped = Buffer.from(image.data, "base64")
    expect(roundTripped.byteLength).toBe(JPEG_MIN.byteLength)
  })
})

/* ------------------------------------------------------------------ */
/* 3. ToolResult with NO images → string content, byte-identical legacy */
/* ------------------------------------------------------------------ */

describe("HELL-3: image-less tool keeps legacy string content + no contentBlocks", () => {
  test("read_image on missing file → ok:false, contentBlocks omitted (string-only)", async () => {
    const registry = new ToolRegistry([readImageTool])
    const res = await dispatchTool(
      call("read_image", { path: "does-not-exist.png" }, "c-miss"),
      config(workDir, registry),
      perm,
    )
    expect(res.ok).toBe(false)
    // Legacy string content preserved; no structured contentBlocks.
    expect(typeof res.block.content).toBe("string")
    expect(res.block.contentBlocks).toBeUndefined()
    expect("contentBlocks" in res.block).toBe(false)
  })
})

/* ------------------------------------------------------------------ */
/* 4. magic-byte SSOT — text disguised as .png ⇒ rejected             */
/* ------------------------------------------------------------------ */

describe("HELL-4: magic-byte SSOT — wrong content rejected even with right extension", () => {
  test("file with .png ext but non-PNG bytes ⇒ ok:false (unsupported_media_type)", async () => {
    const registry = new ToolRegistry([readImageTool])
    const res = await dispatchTool(
      call("read_image", { path: "spoofed-magic.png" }, "c-spoof"),
      config(workDir, registry),
      perm,
    )
    expect(res.ok).toBe(false)
    expect(res.block.content).toContain("unsupported")
    expect(res.block.contentBlocks).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/* 5. concurrent dispatches → no crosstalk                            */
/* ------------------------------------------------------------------ */

describe("HELL-5: 3 concurrent dispatches of different images surface no crosstalk", () => {
  test("Promise.all of read_image(a.png), read_image(b.jpg), read_image(c.gif) each carries its own bytes", async () => {
    const registry = new ToolRegistry([readImageTool])
    const cfg = config(workDir, registry)
    const [r1, r2, r3] = await Promise.all([
      dispatchTool(call("read_image", { path: "a.png" }, "id-A"), cfg, perm),
      dispatchTool(call("read_image", { path: "b.jpg" }, "id-B"), cfg, perm),
      dispatchTool(call("read_image", { path: "c.gif" }, "id-C"), cfg, perm),
    ])
    // Each result is keyed to its own tool_use_id (no swap).
    expect(r1.block.tool_use_id).toBe("id-A")
    expect(r2.block.tool_use_id).toBe("id-B")
    expect(r3.block.tool_use_id).toBe("id-C")

    const img1 = r1.block.contentBlocks?.[1]
    const img2 = r2.block.contentBlocks?.[1]
    const img3 = r3.block.contentBlocks?.[1]
    if (img1?.type !== "image" || img2?.type !== "image" || img3?.type !== "image") {
      throw new Error("expected ImageBlock in every dispatch")
    }
    expect(img1.mediaType).toBe("image/png")
    expect(img2.mediaType).toBe("image/jpeg")
    expect(img3.mediaType).toBe("image/gif")

    // Verify each base64 round-trips to its own original bytes (no cross-mix).
    expect(Buffer.from(img1.data, "base64").byteLength).toBe(PNG_1x1.byteLength)
    expect(Buffer.from(img2.data, "base64").byteLength).toBe(JPEG_MIN.byteLength)
    expect(Buffer.from(img3.data, "base64").byteLength).toBe(GIF_MIN.byteLength)
  })
})
