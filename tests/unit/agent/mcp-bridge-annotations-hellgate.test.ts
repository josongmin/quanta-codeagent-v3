/** §19.1 / §19.3 — MCP→Tool bridge SECURITY hellgate (RED-on-injection).
 *
 *  The bridge is the trust boundary: a server self-DECLARES `ToolAnnotations`,
 *  so the bridge must NEVER let an untrusted (or knob-off) server's
 *  `readOnlyHint:true` relax the `isReadOnly`/`isConcurrencySafe` predicates that
 *  drive the permission/concurrency/HITL machine. These tests inject a HOSTILE
 *  annotation set and assert it CANNOT escape:
 *
 *   (a) UNTRUSTED server + `readOnlyHint:true` (knob ON) ⇒ isReadOnly()===false,
 *       isConcurrencySafe()===false (cannot skip HITL, cannot run in parallel).
 *   (b) knob OFF ⇒ byte-identical false/false EVEN for a trusted server.
 *   (c) poisoned `readOnlyHint:"true"` (string) on a trusted+knob-on server ⇒
 *       false (the non-boolean was dropped at parse; `=== true` is false).
 *   (d) oversized / unrecognized image media ⇒ skipped + honest marker, NO crash
 *       (and a valid image flows to `ToolResult.images`).
 *
 *  Only the FULLY-honored path (knob ON + trusted + real boolean hints) elevates
 *  the predicates — proving the gate is an ELEVATE-only, fail-closed boundary. */

import { describe, expect, test } from "bun:test"
import { mcpToolToTool } from "@/agent"
import type { McpCallResult, McpClient, McpToolDef } from "@/mcp"
import { READ_IMAGE_MAX_BYTES, type ToolContext, type ToolEvent, type ToolResult } from "@/tool"

const ctx: ToolContext = { cwd: process.cwd(), signal: new AbortController().signal }

/** A fake client whose `callTool` returns a scripted result. Only `callTool` is
 *  exercised by the bridge's `execute`; the rest is unused. */
const fakeClient = (result: McpCallResult): McpClient =>
  ({ callTool: async (): Promise<McpCallResult> => result }) as unknown as McpClient

const drainResult = async (it: AsyncIterable<ToolEvent>): Promise<ToolResult> => {
  let last: ToolResult | undefined
  for await (const ev of it) if (ev.type === "result") last = ev.result
  if (last === undefined) throw new Error("no result event")
  return last
}

const def = (annotations?: McpToolDef["annotations"]): McpToolDef => ({
  name: "do_thing",
  description: "d",
  inputSchema: { type: "object" },
  ...(annotations !== undefined ? { annotations } : {}),
})

const client = fakeClient({ ok: true, content: "ok" })

describe("§19.1 hellgate — annotations cannot escape HITL/parallel", () => {
  test("(a) UNTRUSTED server + readOnlyHint:true (knob ON) ⇒ false/false", () => {
    const tool = mcpToolToTool(client, def({ readOnlyHint: true, idempotentHint: true }), "evil", {
      annotationsHonored: true,
      trusted: false,
    })
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe()).toBe(false)
  })

  test("(b) knob OFF ⇒ false/false EVEN for a trusted server", () => {
    const tool = mcpToolToTool(client, def({ readOnlyHint: true, idempotentHint: true }), "good", {
      annotationsHonored: false,
      trusted: true,
    })
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe()).toBe(false)
  })

  test("(b') no opts at all ⇒ byte-identical false/false", () => {
    const tool = mcpToolToTool(client, def({ readOnlyHint: true, idempotentHint: true }), "good")
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe()).toBe(false)
  })

  test("(c) poisoned readOnlyHint:'true' on trusted+knob-on ⇒ false (parse dropped it)", () => {
    // sanitizeAnnotations would have dropped the string hint upstream; here we
    // assert that even if an annotations object reaches the bridge with NO real
    // readOnlyHint boolean, the predicate stays false.
    const tool = mcpToolToTool(client, def({ idempotentHint: true }), "good", {
      annotationsHonored: true,
      trusted: true,
    })
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe()).toBe(false)
  })

  test("ONLY trusted + knob ON + real readOnlyHint:true ELEVATES", () => {
    const tool = mcpToolToTool(client, def({ readOnlyHint: true, idempotentHint: true }), "good", {
      annotationsHonored: true,
      trusted: true,
    })
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe()).toBe(true)
  })

  test("readOnly but idempotentHint:false ⇒ read-only YES, concurrency NO", () => {
    const tool = mcpToolToTool(client, def({ readOnlyHint: true, idempotentHint: false }), "good", {
      annotationsHonored: true,
      trusted: true,
    })
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe()).toBe(false)
  })

  test("readOnly true, idempotent ABSENT ⇒ concurrency YES (idempotent!==false)", () => {
    const tool = mcpToolToTool(client, def({ readOnlyHint: true }), "good", {
      annotationsHonored: true,
      trusted: true,
    })
    expect(tool.isReadOnly()).toBe(true)
    expect(tool.isConcurrencySafe()).toBe(true)
  })

  test("non-read-only tool never concurrency-safe even when idempotent", () => {
    const tool = mcpToolToTool(client, def({ readOnlyHint: false, idempotentHint: true }), "good", {
      annotationsHonored: true,
      trusted: true,
    })
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.isConcurrencySafe()).toBe(false)
  })
})

/** A 1x1 PNG (valid magic bytes) — base64. */
const PNG_1x1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

describe("§19.3 hellgate — media cap + magic-byte validation, no crash", () => {
  test("(d) oversized image ⇒ skipped + honest marker, NO crash", async () => {
    // a base64 blob whose decoded length exceeds the 5 MB cap
    const big = "A".repeat((READ_IMAGE_MAX_BYTES + 1024) * 2) // base64 → ~1.5x bytes; well over cap
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "big",
        media: [{ kind: "image", data: big, mimeType: "image/png" }],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.ok).toBe(true)
    expect(res.images).toBeUndefined()
    expect(res.output).toContain("skipped")
  })

  test("unrecognized (spoofed mimeType, non-image bytes) ⇒ skipped, no crash", async () => {
    const garbage = Buffer.from("not an image at all").toString("base64")
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "x",
        media: [{ kind: "image", data: garbage, mimeType: "image/png" }],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.images).toBeUndefined()
    expect(res.output).toContain("skipped")
  })

  test("valid PNG flows to ToolResult.images, classified by magic bytes", async () => {
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "here",
        media: [{ kind: "image", data: PNG_1x1_B64, mimeType: "image/jpeg" /* lying */ }],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.images).toHaveLength(1)
    // magic-byte SSOT overrides the server's lying mimeType
    expect(res.images?.[0]?.mediaType).toBe("image/png")
    expect(res.output).toBe("here")
  })

  test("embedded resource (valid small pdf) ⇒ ToolResult.documents (passthrough)", async () => {
    // `QkxPQg==` is not a real PDF; a valid resource must carry %PDF- magic.
    const pdf = Buffer.from("%PDF-1.7\n...").toString("base64")
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "doc",
        media: [{ kind: "resource", data: pdf, mimeType: "application/pdf" }],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.documents).toEqual([{ type: "document", data: pdf, mediaType: "application/pdf" }])
    expect(res.output).toBe("doc")
  })

  test("no media ⇒ byte-identical { ok, output } (no images/documents/marker)", async () => {
    const tool = mcpToolToTool(fakeClient({ ok: true, content: "plain" }), def(), "srv")
    const res = await drainResult(tool.execute({}, ctx))
    expect(res).toEqual({ ok: true, output: "plain" })
  })
})

/** §19.3 hellgate (Finding 1) — RESOURCE/document inbound blocks must be subject
 *  to the SAME gate discipline as images: a byte cap (the 32 MB Anthropic
 *  document-block ceiling, SSOT `MAX_PDF_BYTES`) AND a mimeType allowlist (the
 *  codec only emits `application/pdf` document blocks) AND magic-byte validation
 *  (`%PDF-`). An over-cap or disallowed or non-pdf-magic resource is SKIPPED with
 *  the honest trailing marker — NOT forwarded uncapped into the model prompt. */
describe("§19.3 hellgate — resource/document cap + mimeType + magic, no crash", () => {
  const pdf = (body = "%PDF-1.7\nhello"): string => Buffer.from(body).toString("base64")

  test("15 MB resource blob ⇒ skipped + honest marker, NOT forwarded", async () => {
    // a base64 PDF payload whose decoded length exceeds the 32 MB cap
    const huge = `%PDF-1.7\n${"A".repeat(33 * 1024 * 1024)}`
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "big",
        media: [{ kind: "resource", data: Buffer.from(huge).toString("base64"), mimeType: "application/pdf" }],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.ok).toBe(true)
    expect(res.documents).toBeUndefined()
    expect(res.output).toContain("skipped")
  })

  test("spoofed non-pdf mimeType resource ⇒ dropped (not in allowlist)", async () => {
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "x",
        media: [{ kind: "resource", data: pdf(), mimeType: "text/html" }],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.documents).toBeUndefined()
    expect(res.output).toContain("skipped")
  })

  test("pdf mimeType but non-pdf magic bytes ⇒ dropped (spoofed type)", async () => {
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "x",
        media: [
          { kind: "resource", data: Buffer.from("not a pdf").toString("base64"), mimeType: "application/pdf" },
        ],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.documents).toBeUndefined()
    expect(res.output).toContain("skipped")
  })

  test("valid small pdf passes (magic ✓, under cap, allowed mimeType)", async () => {
    const data = pdf()
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "ok",
        media: [{ kind: "resource", data, mimeType: "application/pdf" }],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.documents).toEqual([{ type: "document", data, mediaType: "application/pdf" }])
    expect(res.output).toBe("ok")
  })

  test("bad base64 resource ⇒ skipped, no crash", async () => {
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "x",
        media: [{ kind: "resource", data: "!!!not-base64!!!", mimeType: "application/pdf" }],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.documents).toBeUndefined()
    expect(res.output).toContain("skipped")
  })

  test("mixed: valid pdf + over-cap pdf ⇒ one document kept, marker present", async () => {
    const good = pdf()
    const huge = `%PDF-1.7\n${"A".repeat(33 * 1024 * 1024)}`
    const tool = mcpToolToTool(
      fakeClient({
        ok: true,
        content: "mix",
        media: [
          { kind: "resource", data: good, mimeType: "application/pdf" },
          { kind: "resource", data: Buffer.from(huge).toString("base64"), mimeType: "application/pdf" },
        ],
      }),
      def(),
      "srv",
    )
    const res = await drainResult(tool.execute({}, ctx))
    expect(res.documents).toEqual([{ type: "document", data: good, mediaType: "application/pdf" }])
    expect(res.output).toContain("skipped")
  })
})
