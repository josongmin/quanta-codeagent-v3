/**
 * jun-10 silent-failure audit #21 — output-spill must be ASYNC on the
 * universal tool-result path.
 *
 * `capToolOutput` runs on EVERY tool result (`ToolRegistry.run`). The old
 * implementation persisted the full over-cap output with `writeFileSync` and
 * ran a synchronous GC prune — stalling the shared web-daemon event loop for
 * all sessions on every large spill.
 *
 * These tests pin the async contract via CALL SHAPE (injected seams whose
 * completion the function must await), NOT source grep:
 *  - an injected `write` returning a Promise must be AWAITED before
 *    `capToolOutput` settles (fresh-readback proves it);
 *  - injected GC fs ops returning Promises must be consumed (the prune still
 *    bounds the dir to the exact keep count);
 *  - the default (un-injected) path round-trips through the real filesystem
 *    and the real prune still bounds the dir — behavior preserved.
 *
 * Every over-cap arm spills into `<dir>/.quanta/tool-output`: the spill dir is
 * opened for real by the NW-2 containment guard before any write or prune.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capToolOutput, type SpillFsOpsAsync } from "../../src/tool/output-spill"

let dir: string
let spillDir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "output-spill-async-"))
  spillDir = join(dir, ".quanta", "tool-output")
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("capToolOutput — async write seam is awaited (call shape)", () => {
  test("settles only after an injected ASYNC write completes (fresh-readback)", async () => {
    const big = "W".repeat(500)
    let writeSettled = false
    const r = await capToolOutput(big, {
      maxChars: 10,
      spillDir,
      // Async writer: the real write lands strictly later than the call. A
      // sync implementation that fires-and-forgets the returned promise
      // resolves before the file exists — fresh readback then fails.
      write: async (path, data) => {
        await tick()
        await writeFile(path, data)
        writeSettled = true
      },
    })
    // The function must have AWAITED the injected writer.
    expect(writeSettled).toBe(true)
    expect(r.spillPath).toBeDefined()
    // Fresh readback from disk: full original persisted, byte-identical.
    const onDisk = await readFile(r.spillPath as string, "utf8")
    expect(onDisk).toBe(big)
  })

  test("default (un-injected) write path: spill is readable back from real disk", async () => {
    const big = `${"A".repeat(20_000)}MIDDLE${"Z".repeat(20_000)}`
    // Neither component exists yet: exercises the lazy per-component mkdir.
    const r = await capToolOutput(big, { maxChars: 100, spillDir })
    expect(r.spillPath).toBeDefined()
    const onDisk = await readFile(r.spillPath as string, "utf8")
    expect(onDisk).toBe(big)
    // Marker contract preserved.
    expect(r.output.startsWith("<persisted-output>\n")).toBe(true)
    expect(r.output).toContain(r.spillPath as string)
  })
})

describe("capToolOutput — async GC prune (call shape via injected fs seam)", () => {
  test("prune consumes PROMISE-returning fs ops and bounds the dir to the exact keep count", async () => {
    const files: Record<string, number> = {
      "old1.txt": 100,
      "old2.txt": 200,
      "old3.txt": 300,
    }
    const removed: string[] = []
    const spillFs: SpillFsOpsAsync = {
      // Every op is genuinely async — a sync prune cannot consume these.
      readdir: async () => {
        await tick()
        return Object.keys(files)
      },
      mtimeMs: async (path) => {
        await tick()
        const name = path.slice(path.lastIndexOf("/") + 1)
        return files[name] ?? Number.NEGATIVE_INFINITY
      },
      remove: async (path) => {
        await tick()
        const name = path.slice(path.lastIndexOf("/") + 1)
        delete files[name]
        removed.push(name)
      },
    }
    const r = await capToolOutput("Z".repeat(1000), {
      maxChars: 10,
      spillDir,
      write: () => {},
      spillKeep: 1,
      spillFs,
    })
    expect(r.spillPath).toBeDefined()
    // EXACT bound: keep=1 over {100,200,300} → the two oldest removed, by the
    // time capToolOutput settles (the prune must be awaited, not floated).
    expect(removed.sort()).toEqual(["old1.txt", "old2.txt"])
    expect(Object.keys(files)).toEqual(["old3.txt"])
  })

  test("rejecting async GC ops are swallowed — tool result still produced", async () => {
    const spillFs: SpillFsOpsAsync = {
      readdir: async () => {
        await tick()
        throw new Error("disk on fire (async)")
      },
      mtimeMs: async () => 0,
      remove: async () => {},
    }
    const r = await capToolOutput("Q".repeat(500), {
      maxChars: 10,
      spillDir,
      write: () => {},
      spillKeep: 1,
      spillFs,
    })
    expect(r.output.startsWith("<persisted-output>\n")).toBe(true)
    expect(r.spillPath).toBeDefined()
  })

  test("default (un-injected) prune still bounds the REAL dir — exact count, newest survive", async () => {
    await mkdir(spillDir, { recursive: true })
    // Three pre-existing spills with explicitly OLD mtimes (no same-ms ties
    // with the fresh spill written below).
    const base = Math.floor(Date.now() / 1000) - 3600
    for (const [i, name] of ["a.txt", "b.txt", "c.txt"].entries()) {
      const p = join(spillDir, name)
      await writeFile(p, `old-${name}`)
      await utimes(p, base + i, base + i)
    }
    const r = await capToolOutput("Y".repeat(1000), {
      maxChars: 10,
      spillDir,
      spillKeep: 2,
    })
    expect(r.spillPath).toBeDefined()
    const left = (await readdir(spillDir)).filter((n) => n.endsWith(".txt")).sort()
    // 3 old + 1 new = 4, keep 2 newest → exactly [new spill, c.txt] survive.
    expect(left).toHaveLength(2)
    const spillName = (r.spillPath as string).slice((r.spillPath as string).lastIndexOf("/") + 1)
    expect(left).toContain(spillName)
    expect(left).toContain("c.txt")
  })
})
