import { describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reapStaleMirrorTemps } from "@/runner/batch/corpus/dataset"

/**
 * Age-gated reaper for orphaned `*.git.tmp-<uuid>` bare-mirror dirs (left by a clone
 * SIGTERM'd before its atomic rename). The gate is load-bearing: it must NOT race a
 * concurrent same-repo instance's still-live temp (recent mtime), only sweep stale ones.
 */
describe("reapStaleMirrorTemps", () => {
  it("removes STALE temps, keeps FRESH temps and real mirrors and non-temp siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "repocache-"))
    try {
      const stale = join(root, "org__repo.git.tmp-aaaa")
      const fresh = join(root, "org__repo.git.tmp-bbbb")
      const realMirror = join(root, "org__repo.git")
      const unrelated = join(root, "other__thing.git")
      for (const d of [stale, fresh, realMirror, unrelated]) await mkdir(d, { recursive: true })

      // Age the stale temp well past the 6h gate; leave the rest fresh.
      const sevenHoursAgoSec = Date.now() / 1000 - 7 * 3600
      await utimes(stale, sevenHoursAgoSec, sevenHoursAgoSec)

      await reapStaleMirrorTemps(root)

      const left = await readdir(root)
      expect(left).not.toContain("org__repo.git.tmp-aaaa") // stale → reaped
      expect(left).toContain("org__repo.git.tmp-bbbb") // fresh temp (live clone) → spared
      expect(left).toContain("org__repo.git") // real mirror → never matched (no .tmp-)
      expect(left).toContain("other__thing.git") // unrelated dir → untouched
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("is best-effort: a missing cache root does not throw", async () => {
    await expect(
      reapStaleMirrorTemps(join(tmpdir(), "does-not-exist-xyz-123")),
    ).resolves.toBeUndefined()
  })
})
