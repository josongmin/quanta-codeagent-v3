/**
 * Hellgate e2e — read_image ↔ downsample codec wiring (GAP 1).
 *
 * The pure plan/geometry are fuzz-proven in image-downsample-plan-hellgate; this
 * proves the LIVE wiring through the actual tool:
 *   - port absent  ⇒ an oversized image is REJECTED (image_over_cap) exactly as
 *     before this slice (byte-identical default-OFF).
 *   - port present ⇒ an oversized image is DOWNSAMPLED via the codec and returned.
 *   - port present + under-cap ⇒ the codec is NOT invoked (happy path unchanged).
 *   - port returns "unable" ⇒ falls back to the over-cap rejection (no throw).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type ImageDownsamplePort, MAX_IMAGE_BYTES, makeReadImageTool } from "@/tool/image"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const makePng = (len: number): Uint8Array => {
  const b = new Uint8Array(len)
  b.set(PNG_MAGIC, 0)
  return b
}

let dir: string
let bigPath: string
let smallPath: string
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "quanta-ds-"))
  bigPath = path.join(dir, "big.png")
  smallPath = path.join(dir, "small.png")
  writeFileSync(bigPath, makePng(MAX_IMAGE_BYTES + 1024)) // over cap
  writeFileSync(smallPath, makePng(64)) // under cap
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ctx = (): ToolContext => ({ cwd: dir, signal: new AbortController().signal }) as ToolContext

const runResult = async (
  tool: ReturnType<typeof makeReadImageTool>,
  file: string,
): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of tool.execute({ path: file }, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result
  }
  if (last === undefined) throw new Error("no result")
  return last
}

const overCap = (r: ToolResult): boolean =>
  r.failure !== undefined &&
  "modelVisibleError" in r.failure &&
  r.failure.modelVisibleError === "image_over_cap"

const okPort = (calls: { n: number }): ImageDownsamplePort => ({
  downsample: async (_b, mediaType) => {
    calls.n++
    return { kind: "ok", bytes: makePng(128), mediaType }
  },
})
const unablePort: ImageDownsamplePort = {
  downsample: async () => ({ kind: "unable", reason: "codec missing" }),
}
// A codec that "succeeds" (longest-edge capped) but whose OUTPUT is STILL over
// the byte cap — e.g. a 2048² noise image whose edges fit but bytes don't.
const okButOverCapPort: ImageDownsamplePort = {
  downsample: async (_b, mediaType) => ({
    kind: "ok",
    bytes: makePng(MAX_IMAGE_BYTES + 512),
    mediaType,
  }),
}

describe("read_image downsample wiring", () => {
  test("port ABSENT ⇒ oversized image rejected (byte-identical default-OFF)", async () => {
    const r = await runResult(makeReadImageTool(), "big.png")
    expect(r.ok).toBe(false)
    expect(overCap(r)).toBe(true)
  })

  test("port PRESENT ⇒ oversized image downsampled + returned", async () => {
    const calls = { n: 0 }
    const r = await runResult(makeReadImageTool(okPort(calls)), "big.png")
    expect(r.ok).toBe(true)
    expect(calls.n).toBe(1) // codec invoked exactly once
    expect(r.images?.[0]?.mediaType).toBe("image/png")
  })

  test("port PRESENT + under-cap ⇒ codec NOT invoked (happy path unchanged)", async () => {
    const calls = { n: 0 }
    const r = await runResult(makeReadImageTool(okPort(calls)), "small.png")
    expect(r.ok).toBe(true)
    expect(calls.n).toBe(0)
  })

  test("port returns 'unable' ⇒ falls back to over-cap rejection (no throw)", async () => {
    const r = await runResult(makeReadImageTool(unablePort), "big.png")
    expect(r.ok).toBe(false)
    expect(overCap(r)).toBe(true)
  })

  test("port returns ok but output STILL over cap ⇒ rejected (byte cap re-enforced)", async () => {
    const r = await runResult(makeReadImageTool(okButOverCapPort), "big.png")
    expect(r.ok).toBe(false)
    expect(overCap(r)).toBe(true)
  })
})
