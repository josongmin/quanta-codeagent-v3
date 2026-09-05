import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type PrivateFileIoPort, writePrivateFileAtomic } from "@/auth/private-file-atomic"

const posixMode = process.platform !== "win32"

const recordingIo = (temps: Set<string>): PrivateFileIoPort => ({
  mkdirParent: async (d) => {
    await mkdir(d, { recursive: true, mode: 0o700 })
  },
  statKind: async (path) => {
    try {
      const s = await stat(path)
      return s.isDirectory() ? "dir" : "file"
    } catch {
      return "absent"
    }
  },
  openExclusive: async (path) => {
    temps.add(path)
    const { defaultPrivateFileIo } = await import("@/auth/private-file-atomic")
    return defaultPrivateFileIo.openExclusive(path)
  },
  rename: async (from, to) => {
    const { defaultPrivateFileIo } = await import("@/auth/private-file-atomic")
    return defaultPrivateFileIo.rename(from, to)
  },
  unlink: async (path) => {
    const { defaultPrivateFileIo } = await import("@/auth/private-file-atomic")
    return defaultPrivateFileIo.unlink(path)
  },
  syncDir: async (d) => {
    const { defaultPrivateFileIo } = await import("@/auth/private-file-atomic")
    return defaultPrivateFileIo.syncDir(d)
  },
})

describe("private-file-atomic", () => {
  test("32 concurrent writers never share a temp path; final is complete JSON + 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-atomic-"))
    const finalPath = join(dir, "token.json")
    await writeFile(finalPath, JSON.stringify({ generation: "old" }), { mode: 0o600 })
    const temps = new Set<string>()
    const barrier = Promise.withResolvers<void>()
    const writers = Array.from({ length: 32 }, (_, i) =>
      (async () => {
        await barrier.promise
        await writePrivateFileAtomic(finalPath, `${JSON.stringify({ generation: i })}\n`, {
          io: recordingIo(temps),
        })
      })(),
    )
    barrier.resolve()
    await Promise.all(writers)
    expect(temps.size).toBe(32)
    const raw = await readFile(finalPath, "utf8")
    const parsed: unknown = JSON.parse(raw)
    expect(parsed).toEqual(expect.objectContaining({ generation: expect.any(Number) }))
    if (posixMode) {
      const mode = (await stat(finalPath)).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  test("file-sync failure performs zero renames and leaves final intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-atomic-fault-"))
    const finalPath = join(dir, "token.json")
    await writeFile(finalPath, "OLD\n", { mode: 0o600 })
    let renameCalls = 0
    const io: PrivateFileIoPort = {
      mkdirParent: async () => undefined,
      statKind: async () => "file",
      openExclusive: async () => ({
        write: async () => undefined,
        sync: async () => {
          throw new Error("sync-fail")
        },
        close: async () => undefined,
      }),
      rename: async () => {
        renameCalls++
      },
      unlink: async () => undefined,
      syncDir: async () => undefined,
    }
    await expect(writePrivateFileAtomic(finalPath, "NEW\n", { io })).rejects.toThrow("sync-fail")
    expect(renameCalls).toBe(0)
    expect(await readFile(finalPath, "utf8")).toBe("OLD\n")
  })

  test("write failure performs zero renames and leaves final intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-atomic-write-"))
    const finalPath = join(dir, "token.json")
    await writeFile(finalPath, "OLD\n", { mode: 0o600 })
    let renameCalls = 0
    const io: PrivateFileIoPort = {
      mkdirParent: async () => undefined,
      statKind: async () => "file",
      openExclusive: async () => ({
        write: async () => {
          throw new Error("write-fail")
        },
        sync: async () => undefined,
        close: async () => undefined,
      }),
      rename: async () => {
        renameCalls++
      },
      unlink: async () => undefined,
      syncDir: async () => undefined,
    }
    await expect(writePrivateFileAtomic(finalPath, "NEW\n", { io })).rejects.toThrow("write-fail")
    expect(renameCalls).toBe(0)
    expect(await readFile(finalPath, "utf8")).toBe("OLD\n")
  })

  test("rename failure leaves final intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-atomic-rename-"))
    const finalPath = join(dir, "token.json")
    await writeFile(finalPath, "OLD\n", { mode: 0o600 })
    const io: PrivateFileIoPort = {
      mkdirParent: async () => undefined,
      statKind: async () => "file",
      openExclusive: async () => ({
        write: async () => undefined,
        sync: async () => undefined,
        close: async () => undefined,
      }),
      rename: async () => {
        throw new Error("rename-fail")
      },
      unlink: async () => undefined,
      syncDir: async () => undefined,
    }
    await expect(writePrivateFileAtomic(finalPath, "NEW\n", { io })).rejects.toThrow("rename-fail")
    expect(await readFile(finalPath, "utf8")).toBe("OLD\n")
  })

  test("directory target is rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-atomic-dir-"))
    await expect(writePrivateFileAtomic(`${dir}/`, "x")).rejects.toThrow(/file path/)
  })

  test("mutation: restored fixed temp name collides under concurrent exclusive create", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quanta-atomic-fixed-"))
    const finalPath = join(dir, "token.json")
    const temps: string[] = []
    let exclusiveHits = 0
    const io: PrivateFileIoPort = {
      mkdirParent: async () => undefined,
      statKind: async () => "absent",
      openExclusive: async (path) => {
        temps.push(path)
        exclusiveHits++
        if (exclusiveHits > 1 && temps[0] === path) {
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" })
        }
        return {
          write: async () => undefined,
          sync: async () => undefined,
          close: async () => undefined,
        }
      },
      rename: async () => undefined,
      unlink: async () => undefined,
      syncDir: async () => undefined,
    }
    const fixed = (): Uint8Array => new Uint8Array(8)
    const barrier = Promise.withResolvers<void>()
    const first = (async () => {
      await barrier.promise
      await writePrivateFileAtomic(finalPath, "a\n", { io, randomBytes: fixed })
    })()
    const second = (async () => {
      await barrier.promise
      await writePrivateFileAtomic(finalPath, "b\n", { io, randomBytes: fixed })
    })()
    barrier.resolve()
    const results = await Promise.allSettled([first, second])
    expect(temps[0]).toBe(temps[1])
    expect(results.filter((r) => r.status === "rejected").length).toBe(1)
  })
})
