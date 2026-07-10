import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig } from "@/shared"
import type { FileInfo, FileSystemPort } from "@/storage"
import { makeReadTool } from "@/tool/read"
import { ReadFileState } from "@/tool/stale-read-guard"
import type { ToolContext, ToolResult } from "@/tool/types"

// H9 read `file_unchanged` dedup hellgate. Adversarial: a re-read of the SAME
// (path, offset, limit) with UNCHANGED content must return the compact
// `file_unchanged` sentinel — NOT the full content; a re-read at a DIFFERENT
// range, or after the content changed, or the first read ever, must return FULL
// content; the knob OFF must be byte-identical (full content always, no sentinel
// ever); interleaved reads of different files must not cross-contaminate.
// Content-truth (UUX-6-07): the dedup verdict compares a CONTENT HASH of the
// just-read text — the mtime is NOT the signal (see
// read-dedup-content-truth-hellgate.test.ts for the mtime-preserving mutation
// battery); in this fixture every content change also moves the fake mtime,
// matching real external writes.
//
// Deterministic substrate: an in-memory FileSystemPort with HAND-FED mtimes so
// the test controls "the file changed" precisely (real mtimes have ms-floor
// flakiness). The dedup state is the SAME ReadFileState already threaded through
// ctx.readFileState — we assert H9 reuses that thread (no new ctx field).

interface FakeEntry {
  content: string
  mtimeMs: number
}

/** Minimal in-memory port. `readFileBytes` is INTENTIONALLY omitted so the B5
 *  binary sniff is skipped (legacy in-memory-fake path) — H9 is orthogonal to
 *  the binary guard and we keep this fixture pure-text. */
const makePort = (files: Map<string, FakeEntry>): FileSystemPort =>
  ({
    async readFile(path: string): Promise<string> {
      const e = files.get(path)
      if (e === undefined) throw Object.assign(new Error("File not found"), { code: "ENOENT" })
      return e.content
    },
    async writeFile(): Promise<void> {
      throw new Error("not used")
    },
    async statFile(path: string): Promise<FileInfo> {
      const e = files.get(path)
      if (e === undefined) throw Object.assign(new Error("File not found"), { code: "ENOENT" })
      return {
        path,
        size: e.content.length,
        isDirectory: false,
        mtimeMs: e.mtimeMs,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
  }) as unknown as FileSystemPort

const SENTINEL_MARK = "file_unchanged:"

const setKnob = (on: boolean): void => {
  if (on) process.env.QUANTA_READ_DEDUP = "1"
  else delete process.env.QUANTA_READ_DEDUP
  __resetRuntimeConfig()
}

beforeEach(() => __resetRuntimeConfig())
afterEach(() => {
  delete process.env.QUANTA_READ_DEDUP
  __resetRuntimeConfig()
})

const ctxWith = (state?: ReadFileState): ToolContext => ({
  cwd: "/",
  signal: new AbortController().signal,
  ...(state !== undefined ? { readFileState: state } : {}),
})

const run = async (
  tool: ReturnType<typeof makeReadTool>,
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

describe("read file_unchanged dedup (H9) — knob ON", () => {
  test("identical-range re-read with UNCHANGED mtime → file_unchanged sentinel, NOT full content", async () => {
    setKnob(true)
    const files = new Map<string, FakeEntry>([
      ["/a.txt", { content: "alpha\nbeta", mtimeMs: 1000 }],
    ])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)

    const first = await run(tool, { path: "/a.txt" }, ctx)
    expect(first.ok).toBe(true)
    expect(first.output).toBe("1\talpha\n2\tbeta")
    expect(first.output).not.toContain(SENTINEL_MARK)

    const second = await run(tool, { path: "/a.txt" }, ctx)
    expect(second.ok).toBe(true)
    expect(second.output).toContain(SENTINEL_MARK)
    expect(second.output).toContain("/a.txt")
    // The sentinel must NOT carry the file content — that is the whole point.
    expect(second.output).not.toContain("alpha")
    expect(second.output).not.toContain("beta")
  })

  test("sentinel is unambiguous + actionable: names path, exact range, and re-use instruction", async () => {
    setKnob(true)
    const files = new Map<string, FakeEntry>([["/x.ts", { content: "x\ny\nz", mtimeMs: 42 }]])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    await run(tool, { path: "/x.ts", offset: 2, limit: 5 }, ctx)
    const r = await run(tool, { path: "/x.ts", offset: 2, limit: 5 }, ctx)
    expect(r.output).toContain("/x.ts")
    expect(r.output).toContain("offset 2")
    expect(r.output).toContain("limit 5")
    expect(r.output.toLowerCase()).toContain("re-using")
  })

  test("SAME path DIFFERENT offset → full content, NOT deduped", async () => {
    setKnob(true)
    const files = new Map<string, FakeEntry>([
      ["/b.txt", { content: "l1\nl2\nl3\nl4", mtimeMs: 7 }],
    ])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    await run(tool, { path: "/b.txt" }, ctx) // offset default 1
    const diff = await run(tool, { path: "/b.txt", offset: 3 }, ctx)
    expect(diff.output).not.toContain(SENTINEL_MARK)
    expect(diff.output).toBe("3\tl3\n4\tl4")
  })

  test("SAME path DIFFERENT limit → full content, NOT deduped", async () => {
    setKnob(true)
    const files = new Map<string, FakeEntry>([["/c.txt", { content: "a\nb\nc\nd", mtimeMs: 9 }]])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    await run(tool, { path: "/c.txt", limit: 2 }, ctx)
    const diff = await run(tool, { path: "/c.txt", limit: 3 }, ctx)
    expect(diff.output).not.toContain(SENTINEL_MARK)
    expect(diff.output).toContain("1\ta")
  })

  test("mtime ADVANCED between reads (file modified) → full content + re-record (next identical re-read dedups again)", async () => {
    setKnob(true)
    const entry: FakeEntry = { content: "v1", mtimeMs: 100 }
    const files = new Map<string, FakeEntry>([["/d.txt", entry]])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)

    await run(tool, { path: "/d.txt" }, ctx)
    // External write: content + mtime advance.
    entry.content = "v2-changed"
    entry.mtimeMs = 200
    const afterChange = await run(tool, { path: "/d.txt" }, ctx)
    expect(afterChange.output).not.toContain(SENTINEL_MARK)
    expect(afterChange.output).toBe("1\tv2-changed")
    // Re-record happened — an immediate identical re-read (mtime still 200) dedups.
    const again = await run(tool, { path: "/d.txt" }, ctx)
    expect(again.output).toContain(SENTINEL_MARK)
  })

  test("mtime REGRESSED (restore / clock skew) → full content, NOT a stale short-circuit", async () => {
    setKnob(true)
    const entry: FakeEntry = { content: "newer", mtimeMs: 500 }
    const files = new Map<string, FakeEntry>([["/e.txt", entry]])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    await run(tool, { path: "/e.txt" }, ctx)
    entry.content = "older-restored"
    entry.mtimeMs = 300 // backward
    const r = await run(tool, { path: "/e.txt" }, ctx)
    expect(r.output).not.toContain(SENTINEL_MARK)
    expect(r.output).toBe("1\tolder-restored")
  })

  test("first read ever (no baseline) → full content", async () => {
    setKnob(true)
    const files = new Map<string, FakeEntry>([["/f.txt", { content: "first", mtimeMs: 1 }]])
    const tool = makeReadTool(makePort(files))
    const r = await run(tool, { path: "/f.txt" }, ctxWith(new ReadFileState()))
    expect(r.output).toBe("1\tfirst")
    expect(r.output).not.toContain(SENTINEL_MARK)
  })

  test("interleaved reads of DIFFERENT files do not cross-contaminate", async () => {
    setKnob(true)
    const files = new Map<string, FakeEntry>([
      ["/g.txt", { content: "gee", mtimeMs: 10 }],
      ["/h.txt", { content: "aitch", mtimeMs: 10 }],
    ])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    // Read g, then h, then g again, then h again — each second read dedups
    // independently; neither file's sentinel ever shows the other's content.
    await run(tool, { path: "/g.txt" }, ctx)
    await run(tool, { path: "/h.txt" }, ctx)
    const g2 = await run(tool, { path: "/g.txt" }, ctx)
    const h2 = await run(tool, { path: "/h.txt" }, ctx)
    expect(g2.output).toContain(SENTINEL_MARK)
    expect(g2.output).toContain("/g.txt")
    expect(g2.output).not.toContain("/h.txt")
    expect(h2.output).toContain(SENTINEL_MARK)
    expect(h2.output).toContain("/h.txt")
    expect(h2.output).not.toContain("/g.txt")
  })

  test("a dedup HIT still refreshes the W1 freshness baseline (does NOT blind the stale-guard)", async () => {
    // Correctness-critical interaction: the read tool records the freshness
    // baseline (path→mtime, ADR-0474) BEFORE the H9 short-circuit, so even when a
    // re-read returns `file_unchanged` the write/edit stale-guard still has a
    // current baseline to compare against. Prove the dedup path never leaves the
    // freshness map stale: read twice (2nd is a dedup hit) → freshness baseline
    // equals the current on-disk mtime.
    setKnob(true)
    const files = new Map<string, FakeEntry>([["/fresh.txt", { content: "v", mtimeMs: 333 }]])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    await run(tool, { path: "/fresh.txt" }, ctx)
    const hit = await run(tool, { path: "/fresh.txt" }, ctx)
    expect(hit.output).toContain(SENTINEL_MARK) // confirm it WAS a dedup hit
    // The freshness baseline is present and current — a later edit can be gated.
    expect(state.recordedMtime("/fresh.txt")).toBe(333)
    expect(state.checkFresh("/fresh.txt", 333)).toEqual({ kind: "fresh" })
    // And an external advance past it is correctly seen as stale.
    expect(state.checkFresh("/fresh.txt", 999).kind).toBe("stale")
  })

  test("no readFileState wired → full content (dedup needs the state thread)", async () => {
    setKnob(true)
    const files = new Map<string, FakeEntry>([["/i.txt", { content: "no-state", mtimeMs: 5 }]])
    const tool = makeReadTool(makePort(files))
    const ctx = ctxWith(undefined)
    await run(tool, { path: "/i.txt" }, ctx)
    const r = await run(tool, { path: "/i.txt" }, ctx)
    expect(r.output).toBe("1\tno-state")
    expect(r.output).not.toContain(SENTINEL_MARK)
  })
})

describe("read file_unchanged dedup (H9) — knob OFF (byte-identical)", () => {
  test("knob OFF → identical re-read returns FULL content, never a sentinel", async () => {
    setKnob(false)
    const files = new Map<string, FakeEntry>([["/j.txt", { content: "off\nmode", mtimeMs: 1 }]])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    const first = await run(tool, { path: "/j.txt" }, ctx)
    const second = await run(tool, { path: "/j.txt" }, ctx)
    expect(first.output).toBe("1\toff\n2\tmode")
    expect(second.output).toBe("1\toff\n2\tmode")
    expect(second.output).not.toContain(SENTINEL_MARK)
  })

  test("knob OFF → the dedup map is never allocated (no recordReadRange side effect)", async () => {
    setKnob(false)
    const files = new Map<string, FakeEntry>([["/k.txt", { content: "k", mtimeMs: 1 }]])
    const tool = makeReadTool(makePort(files))
    const state = new ReadFileState()
    const ctx = ctxWith(state)
    await run(tool, { path: "/k.txt" }, ctx)
    // No range was recorded ⇒ even probing the dedup state directly misses.
    expect(state.recordedRangeHash("/k.txt", 1, 2000)).toBeUndefined()
    // But the freshness baseline (ADR-0474) is STILL recorded — H9 OFF must not
    // regress the stale-read-guard's read-time mtime record.
    expect(state.recordedMtime("/k.txt")).toBe(1)
  })
})

describe("ReadFileState range-dedup unit (additive, orthogonal to freshness)", () => {
  test("recordReadRange / recordedRangeHash round-trip per exact range", () => {
    const s = new ReadFileState()
    s.recordReadRange("/p", 1, 2000, "hash-50")
    expect(s.recordedRangeHash("/p", 1, 2000)).toBe("hash-50")
    // Different range on the same path is a distinct key.
    expect(s.recordedRangeHash("/p", 3, 2000)).toBeUndefined()
    expect(s.recordedRangeHash("/p", 1, 100)).toBeUndefined()
  })

  test("range-dedup does NOT leak into the freshness map (and vice-versa)", () => {
    const s = new ReadFileState()
    s.recordReadRange("/q", 1, 2000, "hash-77")
    // recordReadRange must NOT seed the freshness baseline used by guardWrite.
    expect(s.recordedMtime("/q")).toBeUndefined()
    expect(s.has("/q")).toBe(false)
    expect(s.checkFresh("/q", 999)).toEqual({ kind: "unread" })
    // Conversely, record (freshness) must NOT seed the range-dedup map.
    s.record("/r", 88)
    expect(s.recordedRangeHash("/r", 1, 2000)).toBeUndefined()
  })
})
