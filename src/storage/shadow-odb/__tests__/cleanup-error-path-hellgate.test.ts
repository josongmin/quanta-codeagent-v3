/**
 * T11 — Shadow ODB size-cap cleanup ERROR-PATH hellgate.
 *
 * Audit L9 H9: "Shadow ODB storage correctness."
 *
 * Owning-seam invariant (T11): the size-cap cleanup STILL enforces its
 * limit on error paths. A single un-removable workspace dir must not
 * strand the rest of the eviction, and a malformed cap (NaN / Infinity)
 * must NOT be interpreted as "evict everything" — it is a no-op guard,
 * never a footgun that wipes every snapshot.
 *
 * 6 adversarial cases:
 *   1. over-cap → oldest evicted until under cap (regression anchor)
 *   2. NaN maxBytes → no-op (refuses to treat NaN as "evict all")
 *   3. Infinity maxBytes → no-op (everything is under an infinite cap)
 *   4. negative maxBytes → no-op (existing guard)
 *   5. error path: an un-removable oldest dir does not strand newer evictions
 *      (the function still drives the total toward the cap using removable dirs)
 *   6. zero-size (un-statable) dirs do not cause an infinite/over-eviction loop
 */

import { describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evictLru } from "@/storage/shadow-odb/cleanup"

const mkBase = (): string => mkdtempSync(join(tmpdir(), "t11-shadow-cleanup-"))

const mkSized = async (
  snapshotsRoot: string,
  name: string,
  bytes: number,
  mtimeOffsetMs: number,
): Promise<string> => {
  const d = join(snapshotsRoot, name)
  await fs.mkdir(d, { recursive: true })
  await fs.writeFile(join(d, "blob"), Buffer.alloc(bytes), { mode: 0o600 })
  const t = (Date.now() - mtimeOffsetMs) / 1000
  await fs.utimes(d, t, t)
  return d
}

describe("shadow-cleanup-error-path-hellgate", () => {
  test("HELL-1: over-cap evicts oldest until under cap", async () => {
    const base = mkBase()
    const root = join(base, "snapshots")
    await fs.mkdir(root, { recursive: true })
    await mkSized(root, "aaaaaaaaaaaaaaaa", 4096, 60_000)
    await mkSized(root, "bbbbbbbbbbbbbbbb", 4096, 30_000)
    await mkSized(root, "cccccccccccccccc", 4096, 1_000)
    const evicted = await evictLru(base, 5000)
    expect(evicted).toBeGreaterThanOrEqual(2)
    const remaining = await fs.readdir(root)
    expect(remaining).toContain("cccccccccccccccc")
    expect(remaining).not.toContain("aaaaaaaaaaaaaaaa")
  })

  test("HELL-2: NaN maxBytes is a no-op (must NOT evict everything)", async () => {
    const base = mkBase()
    const root = join(base, "snapshots")
    await fs.mkdir(root, { recursive: true })
    await mkSized(root, "aaaaaaaaaaaaaaaa", 4096, 10_000)
    await mkSized(root, "bbbbbbbbbbbbbbbb", 4096, 5_000)
    const evicted = await evictLru(base, Number.NaN)
    expect(evicted).toBe(0)
    expect((await fs.readdir(root)).sort()).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"])
  })

  test("HELL-3: Infinity maxBytes is a no-op (everything is under cap)", async () => {
    const base = mkBase()
    const root = join(base, "snapshots")
    await fs.mkdir(root, { recursive: true })
    await mkSized(root, "aaaaaaaaaaaaaaaa", 4096, 10_000)
    const evicted = await evictLru(base, Number.POSITIVE_INFINITY)
    expect(evicted).toBe(0)
    expect(await fs.readdir(root)).toContain("aaaaaaaaaaaaaaaa")
  })

  test("HELL-4: negative maxBytes is a no-op", async () => {
    const base = mkBase()
    const root = join(base, "snapshots")
    await fs.mkdir(root, { recursive: true })
    await mkSized(root, "aaaaaaaaaaaaaaaa", 4096, 10_000)
    const evicted = await evictLru(base, -1)
    expect(evicted).toBe(0)
    expect(await fs.readdir(root)).toContain("aaaaaaaaaaaaaaaa")
  })

  test("HELL-5: an un-removable oldest dir does not strand newer evictions", async () => {
    const base = mkBase()
    const root = join(base, "snapshots")
    await fs.mkdir(root, { recursive: true })
    // Oldest dir made un-removable by sealing it read-only-execute so its
    // contents cannot be unlinked (rm of a child fails). The eviction must
    // still bring the total toward the cap using the removable newer dirs.
    const oldest = await mkSized(root, "aaaaaaaaaaaaaaaa", 4096, 60_000)
    await mkSized(root, "bbbbbbbbbbbbbbbb", 4096, 30_000)
    await mkSized(root, "cccccccccccccccc", 4096, 1_000)
    await fs.chmod(oldest, 0o500)
    try {
      const evicted = await evictLru(base, 4096)
      // At least the two removable dirs are gone (it did not give up after
      // the un-removable oldest one).
      expect(evicted).toBeGreaterThanOrEqual(2)
    } finally {
      await fs.chmod(oldest, 0o700)
    }
  })

  test("HELL-6: zero-byte dirs do not cause over-eviction below the cap", async () => {
    const base = mkBase()
    const root = join(base, "snapshots")
    await fs.mkdir(root, { recursive: true })
    // Two empty dirs (0 bytes each) under a positive cap → nothing to evict.
    await fs.mkdir(join(root, "aaaaaaaaaaaaaaaa"), { recursive: true })
    await fs.mkdir(join(root, "bbbbbbbbbbbbbbbb"), { recursive: true })
    const evicted = await evictLru(base, 1024)
    expect(evicted).toBe(0)
    expect((await fs.readdir(root)).sort()).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"])
  })
})
