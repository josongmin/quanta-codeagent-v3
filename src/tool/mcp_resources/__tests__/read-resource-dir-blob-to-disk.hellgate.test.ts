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
import { directResourceChildren } from "@/mcp/resources"
import type { ImageWritePort } from "@/tool/image-gen/store"
import type { Tool, ToolContext, ToolEvent } from "../../types"
import {
  BLOB_MAX_BYTES,
  filterDirectChildren,
  type HandleResult,
  mcpReadResourceDirTool,
  mcpReadResourceTool,
  type ResourceBlock,
  type ResourceEntry,
  type ResourcesHandle,
  renderResourceDirList,
} from "../index"

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
      blocks: [
        {
          uri: "file:///../../../../etc/evil.bin",
          mimeType: "application/octet-stream",
          blob: b64,
        },
      ],
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

// ===========================================================================
// AUDIT closeouts (independent adversarial pass over commit 321329668).
// Each block below was RED before the fix it guards; a mutation that breaks the
// guarded behavior turns it red again (mutation-witnessed in the audit report).
// ===========================================================================

describe("AUDIT B4-h1 — @/tool filterDirectChildren is load-bearing (was UNTESTED)", () => {
  // The commit dedups the direct-children filter as `filterDirectChildren`
  // (@/tool) + `directResourceChildren` (@/mcp) and claims the host-wire
  // hellgate pins them identical. It pins only the @/mcp copy over a LIVE
  // client; the @/tool copy (a public @/tool export, re-imported by mcp-bridge)
  // had NO test asserting its semantics — a drift to "include grandchildren" or
  // "include the dir itself" passed the whole B4 suite. These pin it directly.
  const E = (uri: string, mimeType?: string): ResourceEntry =>
    mimeType === undefined ? { uri } : { uri, mimeType }

  const corpus: ResourceEntry[] = [
    E("file:///a/"), // the dir itself — excluded
    E("file:///a"), // the dir itself (no slash) — excluded
    E("file:///a/child.txt", "text/plain"), // direct child
    E("file:///a/sub", "inode/directory"), // direct child subdir
    E("file:///a/sub/deep.txt"), // grandchild — MUST be excluded
    E("file:///a/x/y/z"), // deep grandchild — MUST be excluded
    E("file:///ab/sibling.txt"), // sibling-prefix trap — MUST be excluded
  ]

  it("keeps ONLY direct children (no dir-self, no grandchildren, no prefix-sibling)", () => {
    const got = filterDirectChildren(corpus, "file:///a")
      .map((e) => e.uri)
      .sort()
    expect(got).toEqual(["file:///a/child.txt", "file:///a/sub"])
    // explicit red-on-injection: the grandchild must NOT be present (this line
    // goes red the instant the `!rest.includes("/")` guard is dropped).
    expect(got).not.toContain("file:///a/sub/deep.txt")
    // the dir itself must NOT be present.
    expect(got).not.toContain("file:///a/")
    expect(got).not.toContain("file:///a")
    // the sibling-prefix (`file:///ab/...`) must NOT be captured by `file:///a`.
    expect(got).not.toContain("file:///ab/sibling.txt")
  })

  it("trailing-slash on the dir uri is normalized (file:///a === file:///a/)", () => {
    const a = filterDirectChildren(corpus, "file:///a")
      .map((e) => e.uri)
      .sort()
    const aSlash = filterDirectChildren(corpus, "file:///a/")
      .map((e) => e.uri)
      .sort()
    expect(a).toEqual(aSlash)
  })

  it("stays behaviorally identical to the @/mcp directResourceChildren twin (dedup parity)", () => {
    // The two copies straddle the @/tool ↔ @/mcp slice fence; the commit relies
    // on them agreeing. Pin the invariant DIRECTLY (not only via a live client).
    for (const dir of ["file:///a", "file:///a/", "file:///ab", "file:///none"]) {
      const tool = filterDirectChildren(corpus, dir)
        .map((e) => e.uri)
        .sort()
      const mcp = directResourceChildren(corpus, dir)
        .map((e) => e.uri)
        .sort()
      expect(tool).toEqual(mcp)
    }
  })
})

describe("AUDIT B4-h2 — 8MB blob byte cap is load-bearing (was UNTESTED)", () => {
  // The commit adds BLOB_MAX_BYTES (8MB) so a hostile server cannot drop an
  // unbounded artifact into the workspace via one resources/read. No test
  // exercised it — removing the cap check passed the whole suite. Pin it.
  it("refuses a decoded blob larger than BLOB_MAX_BYTES and NEVER writes it", async () => {
    // one byte over the cap — base64-encode a buffer of exactly cap+1 bytes.
    const oversize = Buffer.alloc(BLOB_MAX_BYTES + 1, 0x41)
    const b64 = oversize.toString("base64")
    const mem = makeMemWrite()
    const port = handleWith({
      blocks: [{ uri: "file:///huge.bin", mimeType: "application/octet-stream", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "file:///huge.bin" }, "/tmp/jail-b4")
    // no throw, nothing written, and the model is told why.
    expect(mem.writes.size).toBe(0)
    expect(res.output.toLowerCase()).toMatch(/exceeds|cap|not written/)
    // the raw base64 must never be inlined even on refusal.
    expect(res.output).not.toContain(b64)
  })

  it("a blob EXACTLY at the cap is still written (boundary is inclusive, off-by-one guard)", async () => {
    const atCap = Buffer.alloc(BLOB_MAX_BYTES, 0x42)
    const b64 = atCap.toString("base64")
    const mem = makeMemWrite()
    const port = handleWith({
      blocks: [{ uri: "file:///atcap.bin", mimeType: "application/octet-stream", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "file:///atcap.bin" }, "/tmp/jail-b4")
    expect(mem.writes.size).toBe(1)
    expect(res.output).toContain("blobSavedTo:")
  })
})

describe("AUDIT B4-h3 — NUL byte in a blob uri path is refused (was UNTESTED)", () => {
  // The commit screens a NUL byte in the derived path (a NUL would otherwise
  // make the write syscall throw / could truncate a C-string path). No test
  // covered it. Pin the typed refusal + no-write.
  it("refuses a uri whose path segment contains a NUL and NEVER writes", async () => {
    const raw = new Uint8Array([7, 7, 7])
    const b64 = Buffer.from(raw).toString("base64")
    const mem = makeMemWrite()
    // explicit NUL via escape (not an invisible literal byte in the source).
    const nulUri = `file:///ev${"\u0000"}il.bin`
    const port = handleWith({
      blocks: [{ uri: nulUri, mimeType: "application/octet-stream", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: nulUri }, "/tmp/jail-b4")
    expect(mem.writes.size).toBe(0)
    expect(res.output.toLowerCase()).toMatch(/nul|refused|not allowed|jail/)
  })
})

// ===========================================================================
// QUALITY closeouts (deep detail/polish pass). The blob-save + read-dir
// GRACEFUL-DEGRADATION branches (decode-fail, write-port throw, existence-probe
// throw, empty-after-decode, empty content, empty dir) were UNPINNED: a mutation
// turning any into an iterator THROW (no-throw contract break) or dropping the
// content-free reason would pass the whole suite. Each pin below asserts the
// tool degrades to a clear, base64-free reason line and NEVER throws / writes.
// ===========================================================================

describe("QUALITY B4-q1 — undecodable / empty-after-decode blob degrades gracefully (no write, no throw)", () => {
  it("a blob that base64-decodes to ZERO bytes is NOT written and the model is told why", async () => {
    const mem = makeMemWrite()
    // "" decodes to an empty buffer — a legitimately empty blob the tool must
    // refuse to write (an empty file is not a useful artifact) without throwing.
    const port = handleWith({
      blocks: [{ uri: "file:///empty.bin", mimeType: "application/octet-stream", blob: "" }],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "file:///empty.bin" }, "/tmp/jail-b4")
    expect(res.ok).toBe(true) // no-throw: a degraded block is still an ok read
    expect(mem.writes.size).toBe(0)
    expect(res.output.toLowerCase()).toMatch(/empty after base64|not written/)
  })

  it("a mixed resource still renders its TEXT block even when a sibling blob is refused", async () => {
    // completeness: one bad block must not swallow a good one (per-block degrade).
    const mem = makeMemWrite()
    const port = handleWith({
      blocks: [
        { uri: "file:///readme.txt", mimeType: "text/plain", text: "keep me" },
        { uri: "file:///empty.bin", mimeType: "application/octet-stream", blob: "" },
      ],
    })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "file:///readme.txt" }, "/tmp/jail-b4")
    expect(res.ok).toBe(true)
    expect(res.output).toContain("keep me") // good block survived
    expect(res.output.toLowerCase()).toMatch(/not written|empty after base64/) // bad block surfaced
    expect(mem.writes.size).toBe(0)
  })
})

describe("QUALITY B4-q2 — a THROWING write port degrades to a typed reason (no-throw contract)", () => {
  // The port is documented no-throw, but a real Bun.write can throw (ENOSPC /
  // EACCES / disk-full). renderResourceContentSavingBlobs wraps writeBytes AND
  // exists in try/catch → a reason line, never an iterator rejection. Pin both.
  const raw = new Uint8Array([1, 2, 3, 4])
  const b64 = Buffer.from(raw).toString("base64")

  it("writeBytes throwing (e.g. disk-full) surfaces 'write failed' and never rejects the iterator", async () => {
    const throwingWrite: ImageWritePort = {
      async exists() {
        return false
      },
      async writeBytes() {
        throw new Error("ENOSPC: no space left on device")
      },
    }
    const port = handleWith({
      blocks: [{ uri: "file:///data/report.bin", mimeType: "application/octet-stream", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: throwingWrite })
    // MUST NOT throw out of the async iterator.
    const res = await run(tool, { uri: "file:///data/report.bin" }, "/tmp/jail-b4")
    expect(res.ok).toBe(true)
    expect(res.output.toLowerCase()).toContain("write failed")
    // the disk-full detail is surfaced but the base64 is still never inlined.
    expect(res.output).not.toContain(b64)
  })

  it("exists() throwing surfaces 'existence probe failed' and never writes / rejects", async () => {
    const writes = new Map<string, Uint8Array>()
    const throwingExists: ImageWritePort = {
      async exists() {
        throw new Error("EACCES: permission denied on stat")
      },
      async writeBytes(path, bytes) {
        writes.set(path, bytes)
      },
    }
    const port = handleWith({
      blocks: [{ uri: "file:///data/report.bin", mimeType: "application/octet-stream", blob: b64 }],
    })
    const tool = mcpReadResourceTool(port, { writePort: throwingExists })
    const res = await run(tool, { uri: "file:///data/report.bin" }, "/tmp/jail-b4")
    expect(res.ok).toBe(true)
    // a failed probe must FAIL-CLOSED — never fall through to a write.
    expect(writes.size).toBe(0)
    expect(res.output.toLowerCase()).toContain("existence probe failed")
  })
})

describe("QUALITY B4-q3 — empty renders are clear, content-free lines (read + read-dir)", () => {
  it("a read of a resource with NO content blocks renders an explicit empty note (no throw)", async () => {
    const mem = makeMemWrite()
    const port = handleWith({ blocks: [] })
    const tool = mcpReadResourceTool(port, { writePort: mem })
    const res = await run(tool, { uri: "file:///nothing" }, "/tmp/jail-b4")
    expect(res.ok).toBe(true)
    expect(res.output).toContain("file:///nothing")
    expect(res.output.toLowerCase()).toContain("empty resource")
    expect(mem.writes.size).toBe(0)
  })

  it("an empty directory listing renders '(no direct children)' tagged with the parent uri", () => {
    // read-dir over a dir with zero children (empty dir, or a dir whose only
    // entries are grandchildren the filter drops) must not render a bare/blank line.
    const rendered = renderResourceDirList("file:///emptydir/", [])
    expect(rendered).toContain("file:///emptydir/")
    expect(rendered).toContain("(no direct children)")
  })

  it("a directory with ONLY subdirectories still lists them (subdir-only is not empty)", () => {
    const onlySubdirs: ResourceEntry[] = [
      { uri: "file:///d/sub1", mimeType: "inode/directory" },
      { uri: "file:///d/sub2", mimeType: "inode/directory" },
    ]
    const kept = filterDirectChildren(onlySubdirs, "file:///d").map((e) => e.uri)
    expect(kept).toEqual(["file:///d/sub1", "file:///d/sub2"])
    const rendered = renderResourceDirList(
      "file:///d",
      filterDirectChildren(onlySubdirs, "file:///d"),
    )
    expect(rendered).toContain("inode/directory")
    expect(rendered).not.toContain("(no direct children)")
  })
})
