import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNodeLockFileStore, lockFilePathFor } from "@/auth/node-lock-file-store"

describe("node lock-file store CAS", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("two stale replacements admit exactly one winner and leave no CAS claim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "node-lock-cas-"))
    dirs.push(dir)
    const store = createNodeLockFileStore(dir)
    const stale = JSON.stringify({ holderId: "dead", expiresAt: 0, pid: 9 })
    expect(await store.writeExclusive("k", stale)).toBe("ok")

    const results = await Promise.all([
      store.compareAndSwap("k", stale, "winner-a"),
      store.compareAndSwap("k", stale, "winner-b"),
    ])

    expect(results.filter((result) => result === "ok")).toHaveLength(1)
    expect(results.filter((result) => result === "changed")).toHaveLength(1)
    expect(["winner-a", "winner-b"]).toContain(await readFile(lockFilePathFor(dir, "k"), "utf8"))
    expect((await stat(lockFilePathFor(dir, "k"))).mode & 0o077).toBe(0)
    expect((await readdir(dir)).some((name) => name.endsWith(".cas"))).toBe(false)
  })

  test("delete loses safely when expected content is stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "node-lock-cas-"))
    dirs.push(dir)
    const store = createNodeLockFileStore(dir)
    expect(await store.writeExclusive("k", "new-holder")).toBe("ok")
    expect(await store.compareAndSwap("k", "old-holder", null)).toBe("changed")
    expect(await readFile(lockFilePathFor(dir, "k"), "utf8")).toBe("new-holder")
  })
})
