import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ContainedSpillDir,
  capToolOutput,
  DEFAULT_SPILL_KEEP,
  DEFAULT_TOOL_OUTPUT_MAX,
  envMaxChars,
  envSpillKeep,
  HEAD_CHARS,
  openSpillDir,
  pruneSpillDir,
  pruneSpillDirAsync,
  resolveMaxChars,
  resolveSpillKeep,
  type SpillFsOps,
  TAIL_CHARS,
} from "../../src/tool/output-spill"

// Over-cap spills open `<root>/.quanta/tool-output` for real (NW-2 containment),
// so over-cap arms spill into a scratch root; the file write stays injected.
let scratch: string
let spillDir: string
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "output-spill-unit-"))
  spillDir = join(scratch, ".quanta", "tool-output")
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function collectingWrite() {
  const calls: Array<{ path: string; data: string }> = []
  return {
    calls,
    write: (path: string, data: string) => {
      calls.push({ path, data })
    },
  }
}

describe("resolveMaxChars / envMaxChars", () => {
  test("0, unset, negative, NaN fall back to default", () => {
    expect(resolveMaxChars(0)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(resolveMaxChars(undefined)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(resolveMaxChars(-5)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(resolveMaxChars(Number.NaN)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(resolveMaxChars(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TOOL_OUTPUT_MAX)
  })

  test("positive value is honored (floored)", () => {
    expect(resolveMaxChars(1234)).toBe(1234)
    expect(resolveMaxChars(50.9)).toBe(50)
  })

  test("env override: valid positive used, else default", () => {
    expect(envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "500" })).toBe(500)
    expect(envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "0" })).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "" })).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "abc" })).toBe(DEFAULT_TOOL_OUTPUT_MAX)
    expect(envMaxChars({})).toBe(DEFAULT_TOOL_OUTPUT_MAX)
  })
})

describe("capToolOutput — under cap", () => {
  test("output at/under cap is returned byte-identical, no write", async () => {
    const { write, calls } = collectingWrite()
    const small = "hello world"
    const r = await capToolOutput(small, { maxChars: 100, spillDir: "/tmp/x", write })
    expect(r.output).toBe(small)
    expect(r.spillPath).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  test("exactly at cap boundary is untouched", async () => {
    const { write, calls } = collectingWrite()
    const exact = "a".repeat(50)
    const r = await capToolOutput(exact, { maxChars: 50, spillDir: "/tmp/x", write })
    expect(r.output).toBe(exact)
    expect(calls).toHaveLength(0)
  })
})

describe("capToolOutput — over cap", () => {
  test("persists full content and returns excerpt + marker", async () => {
    const { write, calls } = collectingWrite()
    const big = `${"A".repeat(20_000)}MIDDLE${"Z".repeat(20_000)}`
    const r = await capToolOutput(big, { maxChars: 100, spillDir, write })

    // full content written exactly once, untruncated
    expect(calls).toHaveLength(1)
    expect(calls[0]?.data).toBe(big)
    expect(calls[0]?.path).toBe(r.spillPath)
    expect((r.spillPath as string).slice(0, spillDir.length + 1)).toBe(`${spillDir}/`)
    expect((r.spillPath as string).slice(spillDir.length + 1)).toMatch(/^[0-9a-f-]{36}\.txt$/)

    // marker faithfully echoes CC's <persisted-output> wrapper
    expect(r.output.startsWith("<persisted-output>\n")).toBe(true)
    expect(r.output.endsWith("</persisted-output>")).toBe(true)
    // includes spill path, original char count, and how-to-read
    expect(r.output).toContain(r.spillPath as string)
    expect(r.output).toContain(`${big.length} chars`)
    expect(r.output.toLowerCase()).toContain("read")

    // marker is far smaller than original
    expect(r.output.length).toBeLessThan(big.length)
  })

  test("head/tail boundaries: keeps first HEAD_CHARS and last TAIL_CHARS", async () => {
    const { write } = collectingWrite()
    const head = "H".repeat(HEAD_CHARS)
    const mid = "M".repeat(5_000)
    const tail = "T".repeat(TAIL_CHARS)
    const big = head + mid + tail
    const r = await capToolOutput(big, { maxChars: 10, spillDir, write })

    expect(r.output).toContain(head)
    expect(r.output).toContain(tail)
    // the omitted middle should not appear in full
    expect(r.output).not.toContain(mid)
    expect(r.output).toContain(`${mid.length} chars omitted`)
  })

  test("no head/tail overlap when over cap but shorter than HEAD+TAIL", async () => {
    const { write } = collectingWrite()
    // length 100, cap 10 → over cap, but < HEAD_CHARS+TAIL_CHARS
    const big = "x".repeat(60) + "y".repeat(40)
    const r = await capToolOutput(big, { maxChars: 10, spillDir, write })
    expect(r.spillPath).toBeDefined()
    // 0 chars omitted: head covers whole string, tail empty
    expect(r.output).toContain("0 chars omitted")
    expect(r.output).toContain(big)
  })

  test("env override drives the cap end-to-end", async () => {
    const { write, calls } = collectingWrite()
    const out = "q".repeat(1000)
    const max = envMaxChars({ QUANTA_TOOL_OUTPUT_MAX: "500" })
    const r = await capToolOutput(out, { maxChars: max, spillDir, write })
    expect(calls).toHaveLength(1)
    expect(r.output).toContain("500-char")
  })
})

describe("resolveSpillKeep / envSpillKeep", () => {
  test("0, unset, negative, NaN, Infinity fall back to default", () => {
    expect(resolveSpillKeep(0)).toBe(DEFAULT_SPILL_KEEP)
    expect(resolveSpillKeep(undefined)).toBe(DEFAULT_SPILL_KEEP)
    expect(resolveSpillKeep(-3)).toBe(DEFAULT_SPILL_KEEP)
    expect(resolveSpillKeep(Number.NaN)).toBe(DEFAULT_SPILL_KEEP)
    expect(resolveSpillKeep(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPILL_KEEP)
  })

  test("positive value honored (floored)", () => {
    expect(resolveSpillKeep(10)).toBe(10)
    expect(resolveSpillKeep(7.9)).toBe(7)
  })

  test("env override: valid positive used, else default", () => {
    expect(envSpillKeep({ QUANTA_TOOL_OUTPUT_SPILL_KEEP: "5" })).toBe(5)
    expect(envSpillKeep({ QUANTA_TOOL_OUTPUT_SPILL_KEEP: "0" })).toBe(DEFAULT_SPILL_KEEP)
    expect(envSpillKeep({ QUANTA_TOOL_OUTPUT_SPILL_KEEP: "" })).toBe(DEFAULT_SPILL_KEEP)
    expect(envSpillKeep({ QUANTA_TOOL_OUTPUT_SPILL_KEEP: "abc" })).toBe(DEFAULT_SPILL_KEEP)
    expect(envSpillKeep({})).toBe(DEFAULT_SPILL_KEEP)
  })
})

/** The scratch `<root>/.quanta/tool-output`, opened by the NW-2 guard — the only
 *  way to obtain a directory the prune accepts. */
function openedSpillDir(): ContainedSpillDir {
  const opened = openSpillDir(spillDir)
  if (!opened.ok) throw new Error(`scratch spill dir refused: ${opened.refusal.kind}`)
  return opened.dir
}

/** Build an in-memory SpillFsOps over a {name -> mtimeMs} map. */
function memSpillFs(files: Record<string, number>) {
  const removed: string[] = []
  const fs: SpillFsOps = {
    readdir: () => Object.keys(files),
    mtimeMs: (path) => {
      const name = path.slice(path.lastIndexOf("/") + 1)
      if (!(name in files)) throw new Error(`ENOENT ${path}`)
      return files[name] as number
    },
    remove: (path) => {
      const name = path.slice(path.lastIndexOf("/") + 1)
      delete files[name]
      removed.push(path)
    },
  }
  return { fs, removed }
}

describe("pruneSpillDir — bounded retention", () => {
  test("no-op when at/under the keep limit (no GC churn on normal use)", () => {
    const { fs, removed } = memSpillFs({ "a.txt": 1, "b.txt": 2, "c.txt": 3 })
    expect(pruneSpillDir(openedSpillDir(), 3, fs)).toEqual([])
    expect(pruneSpillDir(openedSpillDir(), 5, fs)).toEqual([])
    expect(removed).toHaveLength(0)
  })

  test("over the limit: prunes oldest, retains the newest `keep`", () => {
    const files: Record<string, number> = {
      "old1.txt": 100,
      "old2.txt": 200,
      "mid.txt": 300,
      "new1.txt": 400,
      "new2.txt": 500,
    }
    const { fs } = memSpillFs(files)
    const gone = pruneSpillDir(openedSpillDir(), 2, fs)
    // 5 files, keep 2 newest (new2=500, new1=400) → 3 oldest removed
    expect(gone.sort()).toEqual(
      [join(spillDir, "mid.txt"), join(spillDir, "old1.txt"), join(spillDir, "old2.txt")].sort(),
    )
    expect(Object.keys(files).sort()).toEqual(["new1.txt", "new2.txt"])
  })

  test("ignores non-.txt entries, counts only spill files", () => {
    const files: Record<string, number> = {
      "keep.lock": 999,
      "a.txt": 1,
      "b.txt": 2,
      "c.txt": 3,
    }
    const { fs } = memSpillFs(files)
    const gone = pruneSpillDir(openedSpillDir(), 2, fs)
    expect(gone).toEqual([join(spillDir, "a.txt")])
    expect(Object.keys(files).sort()).toEqual(["b.txt", "c.txt", "keep.lock"])
  })

  test("env override respected via envSpillKeep", () => {
    const files: Record<string, number> = {
      "f1.txt": 1,
      "f2.txt": 2,
      "f3.txt": 3,
      "f4.txt": 4,
    }
    const { fs } = memSpillFs(files)
    const keep = envSpillKeep({ QUANTA_TOOL_OUTPUT_SPILL_KEEP: "1" })
    pruneSpillDir(openedSpillDir(), keep, fs)
    expect(Object.keys(files)).toEqual(["f4.txt"])
  })

  test("readdir failure is swallowed (best-effort, returns [])", () => {
    const fs: SpillFsOps = {
      readdir: () => {
        throw new Error("ENOENT: spill dir missing")
      },
      mtimeMs: () => 0,
      remove: () => {
        throw new Error("should not be called")
      },
    }
    expect(() => pruneSpillDir(openedSpillDir(), 1, fs)).not.toThrow()
    expect(pruneSpillDir(openedSpillDir(), 1, fs)).toEqual([])
  })

  test("per-file remove failure is swallowed; pruning continues", () => {
    const files = { "a.txt": 1, "b.txt": 2, "c.txt": 3, "d.txt": 4 }
    let calls = 0
    const fs: SpillFsOps = {
      readdir: () => Object.keys(files),
      mtimeMs: (path) => {
        const name = path.slice(path.lastIndexOf("/") + 1)
        return (files as Record<string, number>)[name] as number
      },
      remove: (path) => {
        calls++
        // First removal candidate throws; the next must still be attempted.
        if (path.endsWith("a.txt")) throw new Error("EBUSY")
      },
    }
    // keep 1 (d=4 newest) → candidates a,b,c. a throws, b & c removed.
    const gone = pruneSpillDir(openedSpillDir(), 1, fs)
    expect(gone.sort()).toEqual([join(spillDir, "b.txt"), join(spillDir, "c.txt")].sort())
    expect(calls).toBe(3)
  })

  test("unstattable entry is treated as oldest (prune candidate, never a survivor)", () => {
    const fs: SpillFsOps = {
      readdir: () => ["good1.txt", "good2.txt", "racing.txt"],
      mtimeMs: (path) => {
        if (path.endsWith("racing.txt")) throw new Error("ENOENT (removed mid-scan)")
        return path.endsWith("good2.txt") ? 200 : 100
      },
      remove: () => {},
    }
    // keep 2: survivors are the two stattable (good2=200, good1=100);
    // racing.txt (unstattable → -Infinity) is the lone prune candidate.
    const gone = pruneSpillDir(openedSpillDir(), 2, fs)
    expect(gone).toEqual([join(spillDir, "racing.txt")])
  })
})

describe("pruneSpillDir / pruneSpillDirAsync take only a dir openSpillDir verified", () => {
  test("STATIC PIN (tsc): a plain string path does not typecheck as a prune target", async () => {
    // NW-2: prune deletes every `*.txt` past keep in the directory it is handed,
    // so the only directory it may be handed is one `openSpillDir` verified. The
    // parameter is the `ContainedSpillDir` brand; if it regressed to `string`,
    // the `@ts-expect-error` lines below would be unused and tsc would FAIL.
    // The closures are never invoked: this half is checked by tsc, not at runtime.
    const { fs } = memSpillFs({ "a.txt": 1, "b.txt": 2 })
    const rawPath: string = spillDir
    // @ts-expect-error a plain string is not a ContainedSpillDir
    const _rawSync = (): string[] => pruneSpillDir(rawPath, 1, fs)
    // @ts-expect-error a plain string is not a ContainedSpillDir
    const _rawAsync = (): Promise<string[]> => pruneSpillDirAsync(rawPath, 1, fs)

    // Runtime half: the dir the guard returns is accepted and pruned.
    const dir: ContainedSpillDir = openedSpillDir()
    expect(await pruneSpillDirAsync(dir, 1, fs)).toEqual([join(spillDir, "a.txt")])
    expect(pruneSpillDir(dir, 1, fs)).toEqual([])
  })
})

describe("capToolOutput — GC wiring", () => {
  test("prunes the spill dir after an over-cap write (injected fs)", async () => {
    const { write, calls } = collectingWrite()
    // Pre-existing dir already over the keep limit.
    const files: Record<string, number> = {
      "old1.txt": 1,
      "old2.txt": 2,
      "old3.txt": 3,
    }
    const spillFs: SpillFsOps = {
      readdir: () => Object.keys(files),
      mtimeMs: (path) => {
        const name = path.slice(path.lastIndexOf("/") + 1)
        return name in files ? (files[name] as number) : Number.NEGATIVE_INFINITY
      },
      remove: (path) => {
        const name = path.slice(path.lastIndexOf("/") + 1)
        delete files[name]
      },
    }
    const r = await capToolOutput("Z".repeat(1000), {
      maxChars: 10,
      spillDir,
      write,
      spillKeep: 1,
      spillFs,
    })
    expect(calls).toHaveLength(1)
    expect(r.spillPath).toBeDefined()
    // Pruned down to keep=1 (newest of the pre-existing set).
    expect(Object.keys(files)).toEqual(["old3.txt"])
  })

  test("under-cap path performs no write and no GC (behavior-preserving)", async () => {
    const { write, calls } = collectingWrite()
    let readdirCalled = false
    const spillFs: SpillFsOps = {
      readdir: () => {
        readdirCalled = true
        return []
      },
      mtimeMs: () => 0,
      remove: () => {},
    }
    const small = "tiny"
    const r = await capToolOutput(small, { maxChars: 100, spillDir: "/spill", write, spillFs })
    expect(r.output).toBe(small)
    expect(calls).toHaveLength(0)
    expect(readdirCalled).toBe(false)
  })

  test("GC failure does not break the tool result (marker still returned)", async () => {
    const { write } = collectingWrite()
    const spillFs: SpillFsOps = {
      readdir: () => {
        throw new Error("disk on fire")
      },
      mtimeMs: () => 0,
      remove: () => {},
    }
    const r = await capToolOutput("Q".repeat(500), {
      maxChars: 10,
      spillDir,
      write,
      spillKeep: 1,
      spillFs,
    })
    expect(r.output.startsWith("<persisted-output>\n")).toBe(true)
    expect(r.spillPath).toBeDefined()
  })
})
