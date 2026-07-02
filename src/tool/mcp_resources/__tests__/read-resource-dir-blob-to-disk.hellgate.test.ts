/** B4 HELLGATE — MCP resource read-dir + blob-to-disk.
 *
 *  Three RED-first properties this feature MUST satisfy:
 *
 *   (a) FRESH-READBACK blob-to-disk: a `.blob` ResourceBlock is base64-decoded to
 *       ACTUAL bytes and written through the injected `ImageWritePort` under a
 *       jailed path; the tool output reports `blobSavedTo:<path>` and NEVER inlines
 *       the base64 (red-on-injection: the old placeholder string is gone, the bytes
 *       on disk match, and the base64 literal is absent from the output).
 *
 *   (b) READ-DIR aggregation: `readResourceDir(uri)` returns only the DIRECT
 *       children of the dir URI (not grandchildren, not the dir itself) and the
 *       render surfaces the Claude `inode/directory` mimeType for subdirs.
 *
 *   (c) JAIL: a blob whose uri encodes a `../` escape is REJECTED — bytes never
 *       land outside `ctx.cwd`, and the write port is never called with an escaped
 *       path.
 *
 *  THE risk (hellaudit): blob-to-disk turns a read-only network tool into a disk
 *  writer. So the tool must NOT claim `isReadOnly() === true` (that would be a lie
 *  that misroutes the HITL gate), the jail is mandatory, and it stays default-OFF
 *  under the existing gate. Those invariants are pinned below.
 */

import { describe, expect, it } from "bun:test"
import { aggregateResourcesHandle, type McpResourcesClient } from "@/agent/mcp-bridge"
import type { ImageWritePort } from "@/tool/image-gen/store"
import {
  type HandleResult,
  mcpReadResourceDirTool,
  mcpReadResourceTool,
  type ResourceBlock,
  type ResourceEntry,
  renderResourceDirList,
  type ResourcesHandle,
} from "../index"
import type { Tool, ToolContext, ToolEvent } from "../../types"

const ctx = (cwd: string): ToolContext => ({ cwd, signal: new AbortController().signal })

const run = async (
  tool: Tool<{ uri: string }>,
  input: { uri: string },
  cwd: string,
): Promise<{ ok: boolean; output: string; failure?: unknown }> => {
  let last: { ok: boolean; output: string; failure?: unknown } = { ok: false, output: "" }
  for await (const ev of tool.execute(input, ctx(cwd)) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = ev.result as typeof last
  }
  return last
}

/** In-memory ImageWritePort double — records the last write so a test can assert
 *  ACTUAL bytes landed (fresh-readback), not just that a call happened. */
const makeMemWrite = (): ImageWritePort & { writes: Map<string, Uint8Array> } => {
  const writes = new Map<string, Uint8Array>()
  return {
    writes,
    async exists(path: string) {
      return writes.has(path)
    },
    async writeBytes(path: string, bytes: Uint8Array) {
      writes.set(path, bytes)
    },
  }
}

/** A single-server handle that returns fixed blocks for readResource + a fixed
 *  entry list for readResourceDir. */
const handleWith = (opts: {
  blocks?: ResourceBlock[]
  entries?: ResourceEntry[]
}): ResourcesHandle => ({
  listResources: async () => ({ ok: true, value: opts.entries ?? [] }),
  listResourceTemplates: async () => ({ ok: true, value: [] }),
  readResource: async () => ({ ok: true, value: opts.blocks ?? [] }),
  readResourceDir: async (uri) => {
    // The real aggregate composes listResources + filter; a hand-rolled handle
    // just echoes what the caller pre-filtered, but tests below use the REAL
    // aggregate to prove the filter. This branch is only for the blob test.
    const all = opts.entries ?? []
    return { ok: true, value: all.filter((e) => e.uri.startsWith(uri)) }
  },
  listPrompts: async () => ({ ok: true, value: [] }),
  getPrompt: async () => ({ ok: true, value: { messages: [] } }),
})

describe("B4 (a) blob-to-disk fresh-readback", () => {
  it("writes ACTUAL decoded bytes to a jailed path and reports blobSavedTo — base64 NOT inlined", async () => {
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const b64 = Buffer.from(raw).toString("base64")
    const mem = makeMemWrite()
    const port = handleWith({
      blocks: [{ uri: "file:///data/logo.png", mimeType: "image/png", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })

    const res = await run(tool, { uri: "file:///data/logo.png" }, "/tmp/jail-b4")

    expect(res.ok).toBe(true)
    // red-on-injection: the pre-feature placeholder must be GONE.
    expect(res.output).not.toContain("not inlined")
    expect(res.output).not.toContain("base64 chars")
    // the base64 literal must NEVER appear inline in the transcript.
    expect(res.output).not.toContain(b64)
    // output reports where the bytes landed.
    expect(res.output).toContain("blobSavedTo:")
    // exactly one file written, with the EXACT decoded bytes (fresh-readback).
    expect(mem.writes.size).toBe(1)
    const entries = [...mem.writes.entries()]
    const first = entries[0]
    if (first === undefined) throw new Error("expected one write")
    const [savedPath, savedBytes] = first
    expect(savedPath).toContain("/tmp/jail-b4")
    expect([...savedBytes]).toEqual([...raw])
    // the reported path is the one actually written.
    expect(res.output).toContain(savedPath)
  })

  it("text blocks are unaffected (still rendered inline, no disk write)", async () => {
    const mem = makeMemWrite()
    const port = handleWith({
      blocks: [{ uri: "file:///notes.txt", mimeType: "text/plain", text: "hello world" }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "file:///notes.txt" }, "/tmp/jail-b4")
    expect(res.ok).toBe(true)
    expect(res.output).toContain("hello world")
    expect(mem.writes.size).toBe(0)
  })
})

describe("B4 (b) read-dir aggregation over a multi-client handle", () => {
  const entry = (uri: string, mimeType?: string): ResourceEntry =>
    mimeType === undefined ? { uri } : { uri, mimeType }

  // Two fake clients — the aggregate concats their listResources; readResourceDir
  // must keep only DIRECT children of the dir uri.
  const clientA: McpResourcesClient = {
    listResources: async (): Promise<HandleResult<ResourceEntry[]>> => ({
      ok: true,
      value: [
        entry("file:///proj/"), // the dir itself — excluded
        entry("file:///proj/readme.md", "text/markdown"), // direct child
        entry("file:///proj/src", "inode/directory"), // direct child subdir
        entry("file:///proj/src/main.ts", "text/x-typescript"), // grandchild — excluded
      ],
    }),
    listResourceTemplates: async () => ({ ok: true, value: [] }),
    readResource: async () => ({ ok: true, value: [] }),
    readResourceDir: async (uri) => {
      // real client composes listResources + filter; delegate to the same filter
      // the aggregate uses by re-listing here.
      const all = await clientA.listResources()
      if (!all.ok) return all
      return {
        ok: true,
        value: all.value.filter((e) => {
          if (!e.uri.startsWith(uri) || e.uri === uri) return false
          const rest = e.uri.slice(uri.length).replace(/\/$/, "")
          return rest.length > 0 && !rest.includes("/")
        }),
      }
    },
    listPrompts: async () => ({ ok: true, value: [] }),
    getPrompt: async () => ({ ok: true, value: { messages: [] } }),
  }

  it("returns only direct children and renders inode/directory subdir", async () => {
    const handle = aggregateResourcesHandle([clientA])
    const r = await handle.readResourceDir("file:///proj/")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("expected ok")
    const uris = r.value.map((e) => e.uri).sort()
    expect(uris).toEqual(["file:///proj/readme.md", "file:///proj/src"])
    const rendered = renderResourceDirList("file:///proj/", r.value)
    expect(rendered).toContain("file:///proj/") // parent tagged
    expect(rendered).toContain("inode/directory") // subdir mimeType surfaced
    expect(rendered).toContain("readme.md")
    expect(rendered).not.toContain("main.ts") // grandchild not present
  })
})

describe("B4 (c) jail — '../' blob uri escape is rejected", () => {
  it("refuses a blob whose derived path escapes ctx.cwd and never writes", async () => {
    const raw = new Uint8Array([1, 2, 3, 4])
    const b64 = Buffer.from(raw).toString("base64")
    const mem = makeMemWrite()
    const port = handleWith({
      // an attacker-chosen uri that decodes to a traversal filename.
      blocks: [{ uri: "file:///../../../../etc/evil.bin", mimeType: "application/octet-stream", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "file:///../../../../etc/evil.bin" }, "/tmp/jail-b4")
    // no throw (no-throw contract); the write is refused.
    expect(mem.writes.size).toBe(0)
    // the model sees a typed refusal, not a silent success.
    expect(res.output.toLowerCase()).toMatch(/jail|denied|escape|refused/)
  })
})

describe("B4 hellaudit R1 — '..' traversal that stays INSIDE the jail is still refused", () => {
  it("a uri deriving to mcp-blobs/../<file> does NOT clobber a workspace file", async () => {
    const raw = new Uint8Array([9, 9, 9])
    const b64 = Buffer.from(raw).toString("base64")
    const mem = makeMemWrite()
    // mcp-blobs/../package.json resolves UNDER cwd (jail-legal) but ESCAPES the
    // mcp-blobs/ prefix — the pre-jail traversal guard must refuse it.
    const port = handleWith({
      blocks: [{ uri: "mcp://srv/../package.json", mimeType: "application/json", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "mcp://srv/../package.json" }, "/tmp/jail-b4")
    expect(mem.writes.size).toBe(0)
    expect(res.output.toLowerCase()).toMatch(/traversal|refused|not allowed/)
    // the escaped-but-jailed path must NOT have been written.
    expect([...mem.writes.keys()].some((p) => p.endsWith("/package.json"))).toBe(false)
  })
})

describe("B4 hellaudit R2 — attacker bytes never OVERWRITE an existing file", () => {
  it("refuses to write when the jailed target already exists", async () => {
    const b64 = Buffer.from(new Uint8Array([1, 1, 1])).toString("base64")
    const mem = makeMemWrite()
    // seed an existing file at the exact jailed target the blob would resolve to.
    const existing = "/tmp/jail-b4/mcp-blobs/data/report.bin"
    mem.writes.set(existing, new Uint8Array([0xff]))
    const port = handleWith({
      blocks: [{ uri: "file:///data/report.bin", mimeType: "application/octet-stream", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "file:///data/report.bin" }, "/tmp/jail-b4")
    // the pre-existing byte is untouched (no overwrite).
    expect([...(mem.writes.get(existing) ?? [])]).toEqual([0xff])
    expect(res.output.toLowerCase()).toMatch(/already exists|overwrite/)
  })
})

describe("B4 hellaudit invariants (load-bearing mitigations)", () => {
  it("the read tool is NOT read-only (it can write blobs to disk)", () => {
    const tool = mcpReadResourceTool(handleWith({}), { writePort: makeMemWrite() })
    expect(tool.isReadOnly()).toBe(false)
  })

  it("the read-dir tool IS read-only (pure list+filter, no disk write)", () => {
    const tool = mcpReadResourceDirTool(handleWith({}))
    expect(tool.isReadOnly()).toBe(true)
  })
})
