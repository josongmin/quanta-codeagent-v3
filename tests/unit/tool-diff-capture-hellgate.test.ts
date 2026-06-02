/** ADR-0440 wire-finish hellgate — tool.diff agent-seam capture.
 *
 *  The file-mutating tools (`write`/`edit`) hand the OPTIONAL tool-diff sink
 *  on `ToolContext` the full pre/post file text after a SUCCESSFUL mutation,
 *  the daemon's canvas tool-diff source fans the capture out to every
 *  connection, and each connection's emitter renders it as a single
 *  `tool.diff` frame (the diff math runs ONCE inside `feedToolDiff`).
 *
 *  Adversarial invariants pinned here:
 *
 *    1. Gate ON + an edit ⇒ the sink receives { toolCallId, before, after,
 *       path } — `before` is the verbatim pre-edit source, `after` the new
 *       bytes, NO recompute (raw strings, no diff math tool-side).
 *    2. Gate ON + a write to an EXISTING file ⇒ `before` is the prior bytes,
 *       `after` is the new content. Gate ON + a write to a NEW file ⇒ `before`
 *       is the empty string.
 *    3. Gate OFF (no `toolDiff` OR no `toolCallId`) ⇒ NO capture, and the
 *       `write` tool performs NO extra pre-read (byte-identical legacy path).
 *    4. A throwing sink can NEVER break a successful mutation (the file is
 *       already written; the helper swallows).
 *    5. Daemon source: `capture(...)` fans out to every `subscribe`r; a
 *       throwing subscriber does not block siblings; unsubscribe stops it.
 *       There is NO snapshot-on-connect (subscribe-only).
 *    6. `feedToolDiff` runs the line diff once and honors the binary + byte/
 *       line caps (no recompute upstream — caps live in the emitter).
 *    7. Slice fence: `@/tool` never imports `@/apps/web-daemon`; the daemon
 *       tool-diff source imports neither `@/agent` nor `@/apps/cli`. */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createCanvasEmitter } from "@/../src/apps/web-daemon/canvas-emitter"
import {
  type CapturedToolDiff,
  createCanvasToolDiffSource,
} from "@/../src/apps/web-daemon/canvas-tool-diff-source"
import { decodeCanvasFrame } from "@/protocol/canvas"
import type { FileInfo, FileSystemPort } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { makeWriteTool } from "@/tool/write"

/** Recording in-memory FS port; counts reads so we can prove the gate-OFF
 *  `write` path performs NO extra pre-read. */
const makePort = (seed: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed))
  const reads: string[] = []
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      reads.push(path)
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return { path, size: files.get(path)?.length ?? 0, isDirectory: false }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
  }
  return { port, files, reads }
}

/** A recording tool-diff sink (structural mirror of `ToolDiffSink`). */
const makeSink = (onThrow = false) => {
  const captured: CapturedToolDiff[] = []
  const sink = {
    capture(input: CapturedToolDiff): void {
      captured.push(input)
      if (onThrow) throw new Error("hostile sink")
    },
  }
  return { sink, captured }
}

const baseCtx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

const run = async (
  tool: {
    execute: (i: never, c: ToolContext) => AsyncIterable<{ type: string; result?: ToolResult }>
  },
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("ADR-0440 wire-finish — tool.diff agent-seam capture", () => {
  test("INV-1 gate ON + edit ⇒ sink receives verbatim before/after/path/toolCallId (no recompute)", async () => {
    const { port } = makePort({ "a.ts": "const x = 1\nconst y = 2\n" })
    const { sink, captured } = makeSink()
    const tool = makeEditTool(port)
    const ctx: ToolContext = { ...baseCtx("/"), toolDiff: sink, toolCallId: "call-123" }
    const res = await run(
      tool,
      { path: "a.ts", old_string: "const x = 1", new_string: "const x = 42" },
      ctx,
    )
    expect(res.ok).toBe(true)
    expect(captured).toHaveLength(1)
    const c = captured[0]!
    expect(c.toolCallId).toBe("call-123")
    expect(c.path).toBe("a.ts")
    // Raw strings — the tool did NO diff math; before is the pre-edit source.
    expect(c.before).toBe("const x = 1\nconst y = 2\n")
    expect(c.after).toBe("const x = 42\nconst y = 2\n")
  })

  test("INV-2 gate ON + write to EXISTING file ⇒ before=prior bytes; NEW file ⇒ before=empty", async () => {
    const { port } = makePort({ "exists.txt": "old content\n" })
    const tool = makeWriteTool(port)

    const s1 = makeSink()
    await run(
      tool,
      { path: "exists.txt", content: "new content\n" },
      { ...baseCtx("/"), toolDiff: s1.sink, toolCallId: "c1" },
    )
    expect(s1.captured).toHaveLength(1)
    expect(s1.captured[0]!.before).toBe("old content\n")
    expect(s1.captured[0]!.after).toBe("new content\n")

    const s2 = makeSink()
    await run(
      tool,
      { path: "fresh.txt", content: "hello\n" },
      { ...baseCtx("/"), toolDiff: s2.sink, toolCallId: "c2" },
    )
    expect(s2.captured).toHaveLength(1)
    expect(s2.captured[0]!.before).toBe("") // new file
    expect(s2.captured[0]!.after).toBe("hello\n")
  })

  test("INV-3 gate OFF ⇒ no capture AND no extra pre-read (byte-identical)", async () => {
    // (a) no sink at all
    const a = makePort({ "f.txt": "v0\n" })
    await run(makeWriteTool(a.port), { path: "f.txt", content: "v1\n" }, baseCtx("/"))
    expect(a.reads).toHaveLength(0) // write never read the old bytes
    expect(a.files.get("f.txt")).toBe("v1\n")

    // (b) sink present but no toolCallId ⇒ still gate OFF, still no pre-read
    const b = makePort({ "f.txt": "v0\n" })
    const { sink, captured } = makeSink()
    await run(
      makeWriteTool(b.port),
      { path: "f.txt", content: "v1\n" },
      { ...baseCtx("/"), toolDiff: sink },
    )
    expect(captured).toHaveLength(0)
    expect(b.reads).toHaveLength(0)
  })

  test("INV-4 a throwing sink never breaks a successful mutation", async () => {
    const { port, files } = makePort({ "x.txt": "a\n" })
    const { sink } = makeSink(/* onThrow */ true)
    const res = await run(
      makeWriteTool(port),
      { path: "x.txt", content: "b\n" },
      { ...baseCtx("/"), toolDiff: sink, toolCallId: "c" },
    )
    expect(res.ok).toBe(true) // mutation succeeded despite hostile sink
    expect(files.get("x.txt")).toBe("b\n")
  })

  test("INV-5 daemon source fans out to all subscribers; throwing one isolated; unsubscribe stops", () => {
    const source = createCanvasToolDiffSource()
    const a: CapturedToolDiff[] = []
    const b: CapturedToolDiff[] = []
    source.subscribe(() => {
      throw new Error("bad subscriber")
    })
    const unsubA = source.subscribe((d) => a.push(d))
    source.subscribe((d) => b.push(d))

    source.sink.capture({ toolCallId: "t1", before: "x", after: "y", path: "p" })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1) // throwing sibling did not block fan-out

    unsubA()
    source.sink.capture({ toolCallId: "t2", before: "y", after: "z" })
    expect(a).toHaveLength(1) // unsubscribed
    expect(b).toHaveLength(2)
  })

  test("INV-6 feedToolDiff runs the diff once + honors binary + caps (no upstream recompute)", () => {
    const frames: string[] = []
    const emitter = createCanvasEmitter({
      send: () => {},
      ws: { send: (f: string) => frames.push(f) },
      maxBytes: 16,
      maxLines: 2,
      now: () => 0,
    })

    // small change ⇒ a real line diff
    emitter.feedToolDiff({ toolCallId: "t1", before: "a\nb\n", after: "a\nc\n", path: "f" })
    // over the byte cap ⇒ binary placeholder
    emitter.feedToolDiff({ toolCallId: "t2", before: "x".repeat(100), after: "y".repeat(100) })

    const msgs = frames.map((f) => decodeCanvasFrame(f))
    expect(msgs[0]?.kind).toBe("tool.diff")
    const first = msgs[0] as unknown as { binary?: boolean; lines: unknown[]; additions: number }
    expect(first.binary).toBeUndefined()
    expect(first.lines.length).toBeGreaterThan(0)
    const second = msgs[1] as unknown as { binary?: boolean }
    expect(second.binary).toBe(true) // byte cap tripped the binary short-circuit
  })

  test("INV-7 slice fence — @/tool never imports @/apps; daemon source imports no @/agent or @/apps/cli", () => {
    const root = join(import.meta.dir, "..", "..")
    const toolDiffCapture = readFileSync(join(root, "src/tool/tool-diff-capture.ts"), "utf8")
    const toolTypes = readFileSync(join(root, "src/tool/types.ts"), "utf8")
    const daemonSource = readFileSync(
      join(root, "src/apps/web-daemon/canvas-tool-diff-source.ts"),
      "utf8",
    )

    const importLines = (s: string) =>
      s.split("\n").filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l))

    for (const src of [toolDiffCapture, toolTypes]) {
      for (const line of importLines(src)) {
        expect(line.includes("@/apps")).toBe(false)
      }
    }
    for (const line of importLines(daemonSource)) {
      expect(line.includes("@/agent")).toBe(false)
      expect(line.includes("@/apps/cli")).toBe(false)
    }
  })
})
