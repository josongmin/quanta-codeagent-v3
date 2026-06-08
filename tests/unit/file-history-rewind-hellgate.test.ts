/**
 * Hellgate — file_history_rewind (per-file session snapshot list/restore).
 *
 * STORE (pure bounded ring):
 *   - record ⇒ a version recorded with a per-path monotonic ordinal.
 *   - list ⇒ oldest-first versions for the path; get ⇒ exact ordinal.
 *   - BOUND: >maxVersionsPerPath records ⇒ oldest evicted, ring stays bounded;
 *     >maxBytesPerPath ⇒ oldest evicted (but never the only copy).
 *
 * CAPTURE SINK:
 *   - write/edit-style record through the sink keys by the JAILED absolute path
 *     (relative vs absolute spelling collapse to one key).
 *   - an escaping path is silently dropped (NO-THROW, mutation already done).
 *
 * TOOL:
 *   - list ⇒ versions for the path; restore ⇒ prior bytes written back (jailed).
 *   - jail: a `../escape` path ⇒ rejected, NO write, typed bad_path.
 *   - restore of an unknown version / no history ⇒ typed not_found / no_history.
 *
 * DEFAULT-OFF:
 *   - no fileHistory port ⇒ file_history_rewind absent (byte-identical menu).
 *   - capture helper with absent ctx.fileHistory ⇒ no-op.
 */

import { describe, expect, test } from "bun:test"
import { type FileInfo, type FileSystemPort, FsJailError } from "@/storage"
import type { ActiveWorktree, Tool, ToolContext, ToolEvent } from "@/tool"
import { buildDefaultTools } from "@/tool"
import { makeEditTool } from "@/tool/edit"
import { captureFileHistory } from "@/tool/file-history/capture"
import { createFileHistorySink } from "@/tool/file-history/sink"
import { createFileHistoryStore } from "@/tool/file-history/store"
import { makeFileHistoryRewindTool } from "@/tool/file-history/tool"

const CWD = "/repo"

const ctx = (over?: Partial<ToolContext>): ToolContext => ({
  cwd: CWD,
  signal: new AbortController().signal,
  ...over,
})

const run = async (
  tool: Tool,
  input: unknown,
  c?: ToolContext,
): Promise<{ ok: boolean; output: string }> => {
  let last = { ok: false, output: "no result" }
  for await (const ev of tool.execute(input as never, c ?? ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last
}

/** Recording in-memory FS port — `writes` captures every committed (path,
 *  content) so a restore can be asserted without touching disk. */
const recordingFs = (): { port: FileSystemPort; writes: { path: string; content: string }[] } => {
  const writes: { path: string; content: string }[] = []
  const port: FileSystemPort = {
    async readFile(path) {
      const w = writes.findLast((x) => x.path === path)
      if (w === undefined) throw new Error(`File not found: ${path}`)
      return w.content
    },
    async writeFile(path, content) {
      writes.push({ path, content })
    },
    async statFile(path): Promise<FileInfo> {
      return {
        path,
        size: 0,
        isDirectory: false,
        mtimeMs: 0,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path) {
      return writes.some((x) => x.path === path)
    },
  }
  return { port, writes }
}

let clock = 0
const now = () => {
  clock += 1
  return clock
}

describe("file-history store — record / list / get", () => {
  test("record mints a 1-indexed monotonic version; list is oldest-first; get is exact", () => {
    const store = createFileHistoryStore({ now })
    const v1 = store.record("/repo/a.ts", "one")
    const v2 = store.record("/repo/a.ts", "two")
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    const list = store.list("/repo/a.ts")
    expect(list.map((v) => v.version)).toEqual([1, 2])
    expect(store.get("/repo/a.ts", 1)?.content).toBe("one")
    expect(store.get("/repo/a.ts", 2)?.content).toBe("two")
    expect(store.get("/repo/a.ts", 3)).toBeUndefined()
    // distinct paths are isolated
    expect(store.list("/repo/b.ts")).toEqual([])
  })

  test("BOUND: >maxVersionsPerPath records ⇒ oldest evicted; ordinals never reused", () => {
    const store = createFileHistoryStore({
      now,
      bounds: { maxVersionsPerPath: 3, maxBytesPerPath: 1_000_000 },
    })
    for (let i = 1; i <= 5; i++) store.record("/repo/a.ts", `v${i}`)
    const list = store.list("/repo/a.ts")
    // ring bounded to 3; oldest (v1,v2) evicted; ordinals 3,4,5 survive.
    expect(list.length).toBe(3)
    expect(list.map((v) => v.version)).toEqual([3, 4, 5])
    // evicted ordinals are NOT recoverable as a different file's bytes
    expect(store.get("/repo/a.ts", 1)).toBeUndefined()
    expect(store.get("/repo/a.ts", 5)?.content).toBe("v5")
  })

  test("BOUND: byte cap evicts oldest but NEVER the only copy", () => {
    const store = createFileHistoryStore({
      now,
      bounds: { maxVersionsPerPath: 100, maxBytesPerPath: 10 },
    })
    store.record("/repo/a.ts", "12345") // 5 bytes
    store.record("/repo/a.ts", "67890") // +5 = 10, at cap
    store.record("/repo/a.ts", "abcde") // +5 = 15 > 10 ⇒ evict oldest
    const list = store.list("/repo/a.ts")
    const total = list.reduce((s, v) => s + v.byteLength, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(list.map((v) => v.version)).toEqual([2, 3])
    // a single over-cap version is still kept (never drop the only copy)
    const store2 = createFileHistoryStore({
      now,
      bounds: { maxVersionsPerPath: 100, maxBytesPerPath: 2 },
    })
    store2.record("/repo/big.ts", "way-over-two-bytes")
    expect(store2.list("/repo/big.ts").length).toBe(1)
  })

  test("a fat-fingered 0/negative cap clamps to 1 (no always-empty / infinite loop)", () => {
    const store = createFileHistoryStore({
      now,
      bounds: { maxVersionsPerPath: 0, maxBytesPerPath: 0 },
    })
    store.record("/repo/a.ts", "x")
    store.record("/repo/a.ts", "y")
    expect(store.list("/repo/a.ts").map((v) => v.content)).toEqual(["y"])
  })

  // ── ROUND-2 (UNBOUNDED-GROWTH lens) — the path MAP itself must be bounded ──
  test("BOUND across paths: 10k DISTINCT paths ⇒ map stays ≤ maxPaths (no leak)", () => {
    const store = createFileHistoryStore({
      now,
      bounds: { maxVersionsPerPath: 20, maxBytesPerPath: 4 * 1024 * 1024, maxPaths: 8 },
    })
    for (let i = 0; i < 10_000; i++) store.record(`/repo/f${i}.ts`, "x")
    // The per-path ring would NOT save us here — each path has ONE version. The
    // across-path bound is the only thing keeping the map finite.
    expect(store.keys().length).toBe(8)
    // The SURVIVORS are the 8 most-recently-recorded paths (LRU eviction).
    expect(store.keys()).toEqual([
      "/repo/f9992.ts",
      "/repo/f9993.ts",
      "/repo/f9994.ts",
      "/repo/f9995.ts",
      "/repo/f9996.ts",
      "/repo/f9997.ts",
      "/repo/f9998.ts",
      "/repo/f9999.ts",
    ])
    // An evicted path returns empty (not a different file's bytes).
    expect(store.list("/repo/f0.ts")).toEqual([])
  })

  test("LRU touch: re-recording a path keeps it alive past the cap", () => {
    const store = createFileHistoryStore({
      now,
      bounds: { maxVersionsPerPath: 20, maxBytesPerPath: 1_000_000, maxPaths: 2 },
    })
    store.record("/repo/keep.ts", "k1")
    store.record("/repo/b.ts", "b")
    // Touch keep.ts so it becomes MRU; the NEXT distinct path must evict b.ts.
    store.record("/repo/keep.ts", "k2")
    store.record("/repo/c.ts", "c")
    expect(store.keys()).toEqual(["/repo/keep.ts", "/repo/c.ts"])
    // keep.ts survived AND kept its full timeline (both versions).
    expect(store.list("/repo/keep.ts").map((v) => v.content)).toEqual(["k1", "k2"])
    expect(store.list("/repo/b.ts")).toEqual([])
  })

  test("a fat-fingered 0/negative/absent maxPaths clamps to a finite cap", () => {
    // 0 ⇒ clamp to 1 (never unbounded, never always-empty).
    const zero = createFileHistoryStore({
      now,
      bounds: { maxVersionsPerPath: 5, maxBytesPerPath: 1000, maxPaths: 0 },
    })
    zero.record("/repo/a.ts", "a")
    zero.record("/repo/b.ts", "b")
    expect(zero.keys()).toEqual(["/repo/b.ts"])
    // absent maxPaths (legacy bounds literal) ⇒ falls back to the default cap,
    // NOT unbounded — proven by the map staying finite over many distinct paths.
    const legacy = createFileHistoryStore({
      now,
      bounds: { maxVersionsPerPath: 5, maxBytesPerPath: 1000 },
    })
    for (let i = 0; i < 2_000; i++) legacy.record(`/repo/g${i}.ts`, "x")
    expect(legacy.keys().length).toBeLessThanOrEqual(512)
  })
})

describe("file-history sink — jailed keying + escape drop", () => {
  test("relative and absolute spelling of the SAME file collapse to one key", () => {
    const store = createFileHistoryStore({ now })
    const sink = createFileHistorySink(store)
    sink.record({ path: "src/a.ts", cwd: CWD, content: "rel" })
    sink.record({ path: "/repo/src/a.ts", cwd: CWD, content: "abs" })
    // both keyed under the resolved absolute path ⇒ one timeline, two versions
    expect(store.keys()).toEqual(["/repo/src/a.ts"])
    expect(store.list("/repo/src/a.ts").map((v) => v.content)).toEqual(["rel", "abs"])
  })

  test("an escaping path is silently dropped (NO-THROW; nothing recorded)", () => {
    const store = createFileHistoryStore({ now })
    const sink = createFileHistorySink(store)
    expect(() => sink.record({ path: "../../etc/passwd", cwd: CWD, content: "x" })).not.toThrow()
    expect(store.keys()).toEqual([])
  })
})

describe("file_history_rewind tool — list / restore round-trip", () => {
  test("capture (write) then list shows the version, restore writes prior bytes back (jailed)", async () => {
    const store = createFileHistoryStore({ now })
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(store, port)
    // simulate two write/edit captures via the sink (the real hook path)
    const sink = createFileHistorySink(store)
    sink.record({ path: "src/a.ts", cwd: CWD, content: "version-one" })
    sink.record({ path: "src/a.ts", cwd: CWD, content: "version-two" })

    const listed = await run(tool, { op: "list", path: "src/a.ts" })
    expect(listed.ok).toBe(true)
    expect(listed.output).toContain("v1")
    expect(listed.output).toContain("v2")
    expect(listed.output).toContain("2 version(s)")

    const restored = await run(tool, { op: "restore", path: "src/a.ts", version: 1 })
    expect(restored.ok).toBe(true)
    expect(restored.output).toContain("Restored")
    expect(restored.output).toContain("v1")
    // prior bytes written back through the FS port, keyed by the jailed abs path
    expect(writes).toEqual([{ path: "/repo/src/a.ts", content: "version-one" }])
  })

  test("list of a path with NO history ⇒ ok:true no_history (not an error)", async () => {
    const tool = makeFileHistoryRewindTool(createFileHistoryStore({ now }), recordingFs().port)
    const r = await run(tool, { op: "list", path: "src/never.ts" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("no_history")
  })

  test("restore of an unknown version ⇒ typed not_found, NO write", async () => {
    const store = createFileHistoryStore({ now })
    createFileHistorySink(store).record({ path: "src/a.ts", cwd: CWD, content: "v1" })
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(store, port)
    const r = await run(tool, { op: "restore", path: "src/a.ts", version: 99 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("not_found")
    expect(writes).toEqual([])
  })

  test("restore with no recorded history ⇒ typed no_history, NO write", async () => {
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(createFileHistoryStore({ now }), port)
    const r = await run(tool, { op: "restore", path: "src/a.ts", version: 1 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("no_history")
    expect(writes).toEqual([])
  })

  test("restore without a version ⇒ rejected (version required)", async () => {
    const store = createFileHistoryStore({ now })
    createFileHistorySink(store).record({ path: "src/a.ts", cwd: CWD, content: "v1" })
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(store, port)
    const r = await run(tool, { op: "restore", path: "src/a.ts" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("requires a 'version'")
    expect(writes).toEqual([])
  })

  // ── ROUND-2 (Tool-contract conformance lens) ──────────────────────────────
  test("CONTRACT: a pre-aborted ctx ⇒ exactly ONE typed result, NO write, no hang", async () => {
    const store = createFileHistoryStore({ now })
    createFileHistorySink(store).record({ path: "src/a.ts", cwd: CWD, content: "v1" })
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(store, port)
    const aborted = new AbortController()
    aborted.abort()
    const events: Array<{ ok: boolean; output: string }> = []
    for await (const ev of tool.execute(
      { op: "restore", path: "src/a.ts", version: 1 } as never,
      ctx({ signal: aborted.signal }),
    ) as AsyncIterable<ToolEvent>) {
      if (ev.type === "result") events.push({ ok: ev.result.ok, output: ev.result.output })
    }
    expect(events).toHaveLength(1) // exactly one terminal result
    expect(events[0]?.ok).toBe(false)
    expect(events[0]?.output).toContain("aborted")
    expect(writes).toEqual([]) // aborted before any FS write
  })

  test("CONTRACT: an FsJailError from writeFile ⇒ typed bad_path (no iterator reject)", async () => {
    const store = createFileHistoryStore({ now })
    createFileHistorySink(store).record({ path: "src/a.ts", cwd: CWD, content: "v1" })
    // An FS port whose writeFile throws the jail error (defense-in-depth path).
    const jailingPort: FileSystemPort = {
      ...recordingFs().port,
      async writeFile() {
        throw new FsJailError("path escapes the workspace jail")
      },
    }
    const tool = makeFileHistoryRewindTool(store, jailingPort)
    const results: Array<{ ok: boolean; output: string; mode?: string | undefined }> = []
    for await (const ev of tool.execute(
      { op: "restore", path: "src/a.ts", version: 1 } as never,
      ctx(),
    ) as AsyncIterable<ToolEvent>) {
      if (ev.type === "result") {
        const f = (ev.result as { failure?: { mode?: string } }).failure
        results.push({ ok: ev.result.ok, output: ev.result.output, mode: f?.mode })
      }
    }
    expect(results).toHaveLength(1)
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.output).toContain("bad_path")
    expect(results[0]?.mode).toBe("permission_denied")
  })

  test("JAIL: a ../escape path ⇒ rejected bad_path, NO store lookup, NO write", async () => {
    const store = createFileHistoryStore({ now })
    // even if (impossibly) something were recorded outside, the tool jails first
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(store, port)
    const r = await run(tool, { op: "restore", path: "../../etc/passwd", version: 1 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("bad_path")
    expect(writes).toEqual([])
    // and list of an escaping path is equally rejected
    const rl = await run(tool, { op: "list", path: "../../etc/passwd" })
    expect(rl.ok).toBe(false)
    expect(rl.output).toContain("bad_path")
  })
})

describe("file_history_rewind — spelling-collapse + cross-path confusion (round-1 jun-6 audit)", () => {
  test("./a, a, x/../a, absolute all collapse to ONE key (no cross-read via spelling)", () => {
    const store = createFileHistoryStore({ now })
    const sink = createFileHistorySink(store)
    sink.record({ path: "a.ts", cwd: CWD, content: "plain" })
    sink.record({ path: "./a.ts", cwd: CWD, content: "dotslash" })
    sink.record({ path: "x/../a.ts", cwd: CWD, content: "dotdot" })
    sink.record({ path: "/repo/a.ts", cwd: CWD, content: "absolute" })
    expect(store.keys()).toEqual(["/repo/a.ts"])
    expect(store.list("/repo/a.ts").map((v) => v.content)).toEqual([
      "plain",
      "dotslash",
      "dotdot",
      "absolute",
    ])
  })

  test("restore keys off the SAME jailed path as capture — no cross-path write", async () => {
    const store = createFileHistoryStore({ now })
    createFileHistorySink(store).record({ path: "secret/victim.ts", cwd: CWD, content: "VICTIM" })
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(store, port)
    // Naming a DIFFERENT path has no victim history ⇒ no_history, no write.
    const other = await run(tool, { op: "restore", path: "other.ts", version: 1 })
    expect(other.ok).toBe(false)
    expect(other.output).toContain("no_history")
    expect(writes).toEqual([])
    // A spelling variant of the victim writes back ONLY to the victim's own
    // jailed path — never to an attacker-chosen destination.
    const r = await run(tool, { op: "restore", path: "./secret/victim.ts", version: 1 })
    expect(r.ok).toBe(true)
    expect(writes).toEqual([{ path: "/repo/secret/victim.ts", content: "VICTIM" }])
  })

  test("absolute /etc/passwd restore is jailed (bad_path, no write)", async () => {
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(createFileHistoryStore({ now }), port)
    const r = await run(tool, { op: "restore", path: "/etc/passwd", version: 1 })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("bad_path")
    expect(writes).toEqual([])
  })

  test("a NUL byte in the restore path does not escape and writes nothing", async () => {
    const store = createFileHistoryStore({ now })
    createFileHistorySink(store).record({ path: "a.ts", cwd: CWD, content: "x" })
    const { port, writes } = recordingFs()
    const tool = makeFileHistoryRewindTool(store, port)
    const nulPath = `a.ts${String.fromCharCode(0)}/../../etc/passwd`
    const r = await run(tool, { op: "restore", path: nulPath, version: 1 })
    expect(r.ok).toBe(false)
    expect(writes).toEqual([])
  })
})

describe("file_history_rewind — default-OFF byte-identity", () => {
  test("no fileHistory port ⇒ file_history_rewind is NOT registered (byte-identical menu)", () => {
    const off = buildDefaultTools().map((t) => t.name)
    expect(off).not.toContain("file_history_rewind")
  })

  test("fileHistory port set ⇒ file_history_rewind IS registered", () => {
    const on = buildDefaultTools({ fileHistory: createFileHistoryStore({ now }) }).map(
      (t) => t.name,
    )
    expect(on).toContain("file_history_rewind")
  })

  test("captureFileHistory with absent ctx.fileHistory ⇒ no-op (no throw, nothing observable)", () => {
    // The capture helper is the write/edit hook. With the gate OFF (no sink on
    // ctx) it must be a pure no-op — this is the byte-identical legacy path.
    expect(() => captureFileHistory(ctx(), "src/a.ts", "content")).not.toThrow()
  })

  test("captureFileHistory routes to a wired sink (the gate-ON path)", () => {
    const store = createFileHistoryStore({ now })
    const sink = createFileHistorySink(store)
    captureFileHistory(ctx({ fileHistory: sink }), "src/a.ts", "captured")
    expect(store.list("/repo/src/a.ts").map((v) => v.content)).toEqual(["captured"])
  })

  test("a throwing sink can NEVER break the mutation (capture swallows)", () => {
    const hostileSink = {
      record: () => {
        throw new Error("boom")
      },
    }
    expect(() =>
      captureFileHistory(ctx({ fileHistory: hostileSink }), "src/a.ts", "x"),
    ).not.toThrow()
  })
})

// ── ticket-11 R4-5 finding #2: capture under an active worktree ──────────────
// The edit LANDS at `resolveEditBase(...).path` (the WORKTREE-resolved path for a
// relative edit), but capture passed the RAW `input.path`, which the sink then
// jails under `ctx.cwd` (the SESSION root) — so a later restore writes the WRONG
// file (the session-root sibling, not the worktree file that was edited). The
// capture key MUST equal the worktree-resolved path the write used.
describe("file_history_rewind — capture key under an active worktree (finding #2)", () => {
  const SESSION = "/repo"
  const WT = "/repo/.quanta/worktrees/wt" // a subdir of the session jail
  const active: ActiveWorktree = {
    worktreePath: WT,
    branch: "fork-wt",
    isPersistent: false,
    repoRoot: SESSION,
    branchFrom: "head",
  }

  test("a RELATIVE edit under an active worktree records under the WORKTREE path, not the session path", async () => {
    const { port } = recordingFs()
    // Seed the file at the WORKTREE-resolved path (where a relative edit lands).
    await port.writeFile(`${WT}/rel.txt`, "before\n", SESSION)
    const store = createFileHistoryStore({ now })
    const sink = createFileHistorySink(store)
    const c: ToolContext = {
      cwd: SESSION,
      signal: new AbortController().signal,
      fileHistory: sink,
      activeWorktree: active,
    }
    const tool = makeEditTool(port)
    const r = await run(tool, { path: "rel.txt", old_string: "before", new_string: "after" }, c)
    expect(r.ok).toBe(true)
    // The capture must key under the WORKTREE-resolved absolute path — the SAME
    // file the write touched. Today it keys under the SESSION-root sibling (RED).
    expect(store.list(`${WT}/rel.txt`).map((v) => v.content)).toEqual(["after\n"])
    // And it must NOT have recorded under the session-root sibling (the bug).
    expect(store.list(`${SESSION}/rel.txt`)).toEqual([])
  })

  test("default-OFF: NO active worktree ⇒ capture keys under the session path (unchanged)", async () => {
    const { port } = recordingFs()
    // No worktree ⇒ the edit reads/writes the RAW relative path key (target.path
    // is the unmodified `input.path`); the sink then jails it under the session.
    await port.writeFile("rel.txt", "before\n", SESSION)
    const store = createFileHistoryStore({ now })
    const sink = createFileHistorySink(store)
    const c: ToolContext = {
      cwd: SESSION,
      signal: new AbortController().signal,
      fileHistory: sink,
      // no activeWorktree
    }
    const r = await run(
      makeEditTool(port),
      { path: "rel.txt", old_string: "before", new_string: "after" },
      c,
    )
    expect(r.ok).toBe(true)
    expect(store.list(`${SESSION}/rel.txt`).map((v) => v.content)).toEqual(["after\n"])
  })
})
