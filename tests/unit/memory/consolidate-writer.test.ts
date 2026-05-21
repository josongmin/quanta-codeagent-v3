/**
 * ADR-0068 Wave B — unit tests for MemoryWriter + Git ports.
 *
 * Uses an in-memory Map<path, string> FS fake so no disk is touched and
 * runs are deterministic.  GitPort is a recording mock that captures
 * every call.  The real ChildProcessGitPort is exercised in the
 * integration test (consolidate-phase2-end-to-end.test.ts).
 */
import { beforeEach, describe, expect, test } from "bun:test"
import {
  MEMORY_DIR_MODE,
  MEMORY_MAX_BYTES,
  MEMORY_SUMMARY_MAX_BYTES,
} from "@/memory/consolidate/constants"
import { type GitPort, NullGitPort } from "@/memory/consolidate/git"
import { type MemoryDirPaths, MemoryWriteError } from "@/memory/consolidate/types"
import { MemoryWriter, type NodeFsLike } from "@/memory/consolidate/writer"

// ─── In-memory FS fake ─────────────────────────────────────────────────────

interface FsState {
  files: Map<string, string>
  dirs: Set<string>
  chmods: Map<string, number>
}

const makeFs = (
  failures?: Partial<{
    writeOn: string
    renameOn: string
    readOn: string
    chmodOn: string
    mkdirOn: string
    unlinkOn: string
  }>,
): { state: FsState; fs: NodeFsLike } => {
  const state: FsState = {
    files: new Map<string, string>(),
    dirs: new Set<string>(),
    chmods: new Map<string, number>(),
  }
  const enoent = (path: string): Error => {
    const e = new Error(`ENOENT: no such file or directory, ${path}`) as Error & {
      code?: string
    }
    e.code = "ENOENT"
    return e
  }
  const fs: NodeFsLike = {
    async mkdir(p, opts) {
      if (failures?.mkdirOn === p) throw new Error("mkdir-fail")
      state.dirs.add(p)
      if (opts.mode !== undefined) state.chmods.set(p, opts.mode)
      return p
    },
    async chmod(p, mode) {
      if (failures?.chmodOn === p) throw new Error("chmod-fail")
      state.chmods.set(p, mode)
    },
    async readFile(p, _enc) {
      if (failures?.readOn === p) throw new Error("read-fail")
      const v = state.files.get(p)
      if (v === undefined) throw enoent(p)
      return v
    },
    async writeFile(p, content, _enc) {
      if (failures?.writeOn === p) throw new Error("write-fail")
      state.files.set(p, content)
    },
    async rename(from, to) {
      if (failures?.renameOn === from) throw new Error("rename-fail")
      const v = state.files.get(from)
      if (v === undefined) throw enoent(from)
      state.files.delete(from)
      state.files.set(to, v)
    },
    async unlink(p) {
      if (failures?.unlinkOn === p) throw new Error("unlink-fail")
      if (!state.files.has(p)) throw enoent(p)
      state.files.delete(p)
    },
    async access(p) {
      if (!state.files.has(p) && !state.dirs.has(p)) throw enoent(p)
    },
  }
  return { state, fs }
}

// ─── Recording GitPort ─────────────────────────────────────────────────────

interface GitCall {
  method: "init" | "isRepo" | "addCommit"
  dir: string
  message?: string
}

const makeRecordingGit = (
  opts: {
    repoExists?: boolean
    initThrows?: Error
    commitThrows?: Error
    commitSha?: string | null
  } = {},
): { port: GitPort; calls: GitCall[] } => {
  const calls: GitCall[] = []
  const port: GitPort = {
    async init(dir) {
      calls.push({ method: "init", dir })
      if (opts.initThrows) throw opts.initThrows
    },
    async isRepo(dir) {
      calls.push({ method: "isRepo", dir })
      return opts.repoExists ?? false
    },
    async addCommit(dir, message) {
      calls.push({ method: "addCommit", dir, message })
      if (opts.commitThrows) throw opts.commitThrows
      return opts.commitSha === undefined
        ? "abcdef1234567890abcdef1234567890abcdef12"
        : opts.commitSha
    },
  }
  return { port, calls }
}

// ─── Shared test fixtures ──────────────────────────────────────────────────

const paths: MemoryDirPaths = {
  root: "/mem",
  memoryMd: "/mem/MEMORY.md",
  rawMemoriesMd: "/mem/raw_memories.md",
  memorySummaryMd: "/mem/memory_summary.md",
}

const goodContent = {
  memoryMd: "# Memory\nHello world.\n",
  rawMemoriesMd: "raw entry 1\nraw entry 2\n",
  memorySummaryMd: "Top index.\n",
}

const makeWriter = (
  fs: NodeFsLike,
  git: GitPort,
  opts: { gitEnabled?: boolean; now?: () => number } = {},
): MemoryWriter =>
  new MemoryWriter(paths, fs, git, {
    gitEnabled: opts.gitEnabled ?? true,
    now: opts.now ?? (() => 1_700_000_000_000),
  })

// ─── ensureDir ─────────────────────────────────────────────────────────────

describe("MemoryWriter.ensureDir", () => {
  let state: FsState
  let fs: NodeFsLike
  beforeEach(() => {
    const made = makeFs()
    state = made.state
    fs = made.fs
  })

  test("creates root dir with recursive and mode 0700", async () => {
    const { port } = makeRecordingGit({ repoExists: false })
    await makeWriter(fs, port).ensureDir()
    expect(state.dirs.has("/mem")).toBe(true)
    // chmod is re-applied unconditionally; final chmod must be 0700.
    expect(state.chmods.get("/mem")).toBe(MEMORY_DIR_MODE)
  })

  test("re-applies chmod even when dir already exists", async () => {
    state.chmods.set("/mem", 0o755) // simulate permissive prior mode
    const { port } = makeRecordingGit({ repoExists: true })
    await makeWriter(fs, port).ensureDir()
    expect(state.chmods.get("/mem")).toBe(MEMORY_DIR_MODE)
  })

  test("calls git.init when gitEnabled and isRepo is false", async () => {
    const { port, calls } = makeRecordingGit({ repoExists: false })
    await makeWriter(fs, port).ensureDir()
    expect(calls.find((c) => c.method === "isRepo")?.dir).toBe("/mem")
    expect(calls.find((c) => c.method === "init")?.dir).toBe("/mem")
  })

  test("skips git.init when isRepo is true", async () => {
    const { port, calls } = makeRecordingGit({ repoExists: true })
    await makeWriter(fs, port).ensureDir()
    expect(calls.some((c) => c.method === "init")).toBe(false)
  })

  test("skips all git work when gitEnabled is false", async () => {
    const { port, calls } = makeRecordingGit({ repoExists: false })
    await makeWriter(fs, port, { gitEnabled: false }).ensureDir()
    expect(calls.length).toBe(0)
  })

  test("mkdir failure throws MemoryWriteError carrying root path", async () => {
    const failing = makeFs({ mkdirOn: "/mem" })
    const { port } = makeRecordingGit()
    await expect(makeWriter(failing.fs, port).ensureDir()).rejects.toBeInstanceOf(MemoryWriteError)
  })

  test("chmod failure throws MemoryWriteError", async () => {
    const failing = makeFs({ chmodOn: "/mem" })
    const { port } = makeRecordingGit()
    const err: unknown = await makeWriter(failing.fs, port)
      .ensureDir()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MemoryWriteError)
    expect((err as MemoryWriteError).path).toBe("/mem")
  })

  test("git.init failure propagates verbatim (not wrapped)", async () => {
    const initErr = new MemoryWriteError("custom init failure", "/mem")
    const { port } = makeRecordingGit({ repoExists: false, initThrows: initErr })
    await expect(makeWriter(fs, port).ensureDir()).rejects.toBe(initErr)
  })
})

// ─── readExisting ──────────────────────────────────────────────────────────

describe("MemoryWriter.readExisting", () => {
  test("returns null for every absent file", async () => {
    const { fs } = makeFs()
    const { port } = makeRecordingGit()
    const out = await makeWriter(fs, port).readExisting()
    expect(out).toEqual({
      memoryMd: null,
      rawMemoriesMd: null,
      memorySummaryMd: null,
    })
  })

  test("returns content for each present file", async () => {
    const { state, fs } = makeFs()
    state.files.set("/mem/MEMORY.md", "MEM")
    state.files.set("/mem/raw_memories.md", "RAW")
    state.files.set("/mem/memory_summary.md", "SUM")
    const { port } = makeRecordingGit()
    const out = await makeWriter(fs, port).readExisting()
    expect(out.memoryMd).toBe("MEM")
    expect(out.rawMemoriesMd).toBe("RAW")
    expect(out.memorySummaryMd).toBe("SUM")
  })

  test("mixed presence: only some files present", async () => {
    const { state, fs } = makeFs()
    state.files.set("/mem/MEMORY.md", "MEM-only")
    const { port } = makeRecordingGit()
    const out = await makeWriter(fs, port).readExisting()
    expect(out.memoryMd).toBe("MEM-only")
    expect(out.rawMemoriesMd).toBeNull()
    expect(out.memorySummaryMd).toBeNull()
  })

  test("non-ENOENT read failure throws MemoryWriteError", async () => {
    const { fs } = makeFs({ readOn: "/mem/MEMORY.md" })
    const { port } = makeRecordingGit()
    await expect(makeWriter(fs, port).readExisting()).rejects.toBeInstanceOf(MemoryWriteError)
  })
})

// ─── writeAtomic — happy paths ─────────────────────────────────────────────

describe("MemoryWriter.writeAtomic happy paths", () => {
  test("writes all 3 files and returns commit sha", async () => {
    const { state, fs } = makeFs()
    const { port, calls } = makeRecordingGit({
      commitSha: "deadbeefcafebabe1234567890abcdef12345678",
    })
    const writer = makeWriter(fs, port)
    const res = await writer.writeAtomic(goodContent)
    expect(state.files.get("/mem/MEMORY.md")).toBe(goodContent.memoryMd)
    expect(state.files.get("/mem/raw_memories.md")).toBe(goodContent.rawMemoriesMd)
    expect(state.files.get("/mem/memory_summary.md")).toBe(goodContent.memorySummaryMd)
    expect(res.gitCommitSha).toBe("deadbeefcafebabe1234567890abcdef12345678")
    expect(calls.find((c) => c.method === "addCommit")?.message).toContain("consolidate")
  })

  test("no temp files remain after success", async () => {
    const { state, fs } = makeFs()
    const { port } = makeRecordingGit()
    await makeWriter(fs, port).writeAtomic(goodContent)
    const tempKeys = [...state.files.keys()].filter((k) => k.includes(".tmp."))
    expect(tempKeys.length).toBe(0)
  })

  test("gitEnabled=false yields gitCommitSha=null and no git calls", async () => {
    const { fs } = makeFs()
    const { port, calls } = makeRecordingGit()
    const writer = makeWriter(fs, port, { gitEnabled: false })
    const res = await writer.writeAtomic(goodContent)
    expect(res.gitCommitSha).toBeNull()
    expect(calls.length).toBe(0)
  })

  test("NullGitPort yields gitCommitSha=null", async () => {
    const { fs } = makeFs()
    const writer = new MemoryWriter(paths, fs, new NullGitPort(), {
      gitEnabled: true,
      now: () => 1_700_000_000_000,
    })
    const res = await writer.writeAtomic(goodContent)
    expect(res.gitCommitSha).toBeNull()
  })

  test("addCommit returning null (clean tree) yields gitCommitSha=null", async () => {
    const { fs } = makeFs()
    const { port } = makeRecordingGit({ commitSha: null })
    const res = await makeWriter(fs, port).writeAtomic(goodContent)
    expect(res.gitCommitSha).toBeNull()
  })

  test("temp file paths include pid and now() timestamp", async () => {
    const { state, fs } = makeFs()
    let observedKey: string | null = null
    const origWrite = fs.writeFile.bind(fs)
    fs.writeFile = async (p, c, e) => {
      if (observedKey === null && p.includes(".tmp.")) observedKey = p
      return origWrite(p, c, e)
    }
    const { port } = makeRecordingGit()
    await makeWriter(fs, port, { now: () => 9999 }).writeAtomic(goodContent)
    expect(observedKey).not.toBeNull()
    expect(observedKey as string | null).toContain(`.tmp.${process.pid}.9999`)
    // After success, nothing remains under .tmp.
    expect([...state.files.keys()].some((k) => k.includes(".tmp."))).toBe(false)
  })

  test("commit message contains an ISO timestamp", async () => {
    const { fs } = makeFs()
    const { port, calls } = makeRecordingGit()
    const ts = Date.UTC(2026, 4, 21, 12, 34, 56)
    await makeWriter(fs, port, { now: () => ts }).writeAtomic(goodContent)
    const msg = calls.find((c) => c.method === "addCommit")?.message ?? ""
    expect(msg).toContain("2026-05-21T12:34:56")
  })
})

// ─── writeAtomic — cap enforcement ─────────────────────────────────────────

describe("MemoryWriter.writeAtomic cap enforcement", () => {
  test("MEMORY.md > MEMORY_MAX_BYTES throws and writes nothing", async () => {
    const { state, fs } = makeFs()
    const { port, calls } = makeRecordingGit()
    const writer = makeWriter(fs, port)
    const oversize = "x".repeat(MEMORY_MAX_BYTES + 1)
    await expect(writer.writeAtomic({ ...goodContent, memoryMd: oversize })).rejects.toBeInstanceOf(
      MemoryWriteError,
    )
    expect(state.files.size).toBe(0)
    expect(calls.length).toBe(0)
  })

  test("memory_summary.md > MEMORY_SUMMARY_MAX_BYTES throws", async () => {
    const { state, fs } = makeFs()
    const { port } = makeRecordingGit()
    const writer = makeWriter(fs, port)
    const oversize = "y".repeat(MEMORY_SUMMARY_MAX_BYTES + 1)
    await expect(
      writer.writeAtomic({ ...goodContent, memorySummaryMd: oversize }),
    ).rejects.toBeInstanceOf(MemoryWriteError)
    expect(state.files.size).toBe(0)
  })

  test("raw_memories.md has NO cap (huge value succeeds)", async () => {
    const { fs } = makeFs()
    const { port } = makeRecordingGit()
    const huge = "z".repeat(MEMORY_MAX_BYTES * 2)
    const writer = makeWriter(fs, port)
    const res = await writer.writeAtomic({ ...goodContent, rawMemoriesMd: huge })
    expect(res.gitCommitSha).not.toBeNull()
  })

  test("cap error path mentions the offending path", async () => {
    const { fs } = makeFs()
    const { port } = makeRecordingGit()
    const oversize = "x".repeat(MEMORY_MAX_BYTES + 1)
    const err = (await makeWriter(fs, port)
      .writeAtomic({ ...goodContent, memoryMd: oversize })
      .catch((e: unknown) => e)) as MemoryWriteError
    expect(err.path).toBe("/mem/MEMORY.md")
  })
})

// ─── writeAtomic — failure mid-flight ──────────────────────────────────────

describe("MemoryWriter.writeAtomic failure recovery", () => {
  test("temp write failure on file #2 cleans up file #1's temp", async () => {
    const fsHarness = makeFs()
    // First temp path is MEMORY.md's; we'll fail on raw_memories.md's temp.
    const tempRaw = `/mem/raw_memories.md.tmp.${process.pid}.111`
    fsHarness.fs.writeFile = (() => {
      const orig = fsHarness.fs.writeFile.bind(fsHarness.fs)
      return async (p: string, c: string, e: "utf8") => {
        if (p === tempRaw) throw new Error("write-fail")
        return orig(p, c, e)
      }
    })()
    const { port } = makeRecordingGit()
    const writer = makeWriter(fsHarness.fs, port, { now: () => 111 })
    await expect(writer.writeAtomic(goodContent)).rejects.toBeInstanceOf(MemoryWriteError)
    // Only the first temp file was written successfully; it must have been
    // unlinked.  Final-path files must not exist.
    expect(fsHarness.state.files.size).toBe(0)
  })

  test("rename failure on file #2 cleans up surviving temps", async () => {
    const fsHarness = makeFs()
    const tempRaw = `/mem/raw_memories.md.tmp.${process.pid}.222`
    fsHarness.fs.rename = (() => {
      const map = fsHarness.state.files
      return async (from: string, to: string) => {
        if (from === tempRaw) throw new Error("rename-fail")
        const v = map.get(from)
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
        map.delete(from)
        map.set(to, v)
      }
    })()
    const { port, calls } = makeRecordingGit()
    const writer = makeWriter(fsHarness.fs, port, { now: () => 222 })
    await expect(writer.writeAtomic(goodContent)).rejects.toBeInstanceOf(MemoryWriteError)
    // MEMORY.md DID get renamed (first), raw_memories.md temp survived
    // until cleanup, summary temp also survived until cleanup.  All temps
    // must be gone now.
    const remainingTemps = [...fsHarness.state.files.keys()].filter((k) => k.includes(".tmp."))
    expect(remainingTemps).toEqual([])
    // git was never called (Phase C is gated on Phase B success).
    expect(calls.find((c) => c.method === "addCommit")).toBeUndefined()
  })

  test("git commit failure AFTER renames surfaces as MemoryWriteError", async () => {
    const fsHarness = makeFs()
    const { port } = makeRecordingGit({
      commitThrows: new MemoryWriteError("hook rejected", "/mem"),
    })
    const writer = makeWriter(fsHarness.fs, port)
    const err = (await writer.writeAtomic(goodContent).catch((e: unknown) => e)) as MemoryWriteError
    expect(err).toBeInstanceOf(MemoryWriteError)
    expect(err.message).toContain("rename succeeded")
    expect(err.message).toContain("hook rejected")
    // Final files DO exist (renames landed) — the operator now has to
    // resolve the hook failure but no data was lost.
    expect(fsHarness.state.files.has("/mem/MEMORY.md")).toBe(true)
    expect(fsHarness.state.files.has("/mem/raw_memories.md")).toBe(true)
    expect(fsHarness.state.files.has("/mem/memory_summary.md")).toBe(true)
  })

  test("cleanup swallows ENOENT during temp removal", async () => {
    // Simulate: temp write succeeds, write of next temp throws, the
    // cleanup tries to unlink the FIRST temp — but a concurrent process
    // already removed it (ENOENT).  The writer must still surface the
    // ORIGINAL throw, not the cleanup ENOENT.
    const fsHarness = makeFs()
    let writes = 0
    fsHarness.fs.writeFile = (() => {
      const map = fsHarness.state.files
      return async (p: string, c: string, _e: "utf8") => {
        writes++
        if (writes === 2) throw new Error("original-write-fail")
        map.set(p, c)
      }
    })()
    fsHarness.fs.unlink = async (_p) => {
      const e = new Error("ENOENT: already gone") as Error & { code?: string }
      e.code = "ENOENT"
      throw e
    }
    const { port } = makeRecordingGit()
    const err = (await makeWriter(fsHarness.fs, port)
      .writeAtomic(goodContent)
      .catch((e: unknown) => e)) as MemoryWriteError
    expect(err.message).toContain("original-write-fail")
  })
})

// ─── NullGitPort + ChildProcessGitPort surface ─────────────────────────────

describe("NullGitPort", () => {
  test("init is a no-op", async () => {
    await new NullGitPort().init("/anywhere")
  })

  test("isRepo always reports false", async () => {
    expect(await new NullGitPort().isRepo("/x")).toBe(false)
  })

  test("addCommit always returns null", async () => {
    expect(await new NullGitPort().addCommit("/x", "msg")).toBeNull()
  })
})
