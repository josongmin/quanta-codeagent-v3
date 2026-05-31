/**
 * T11 / audit-R2 — atomic-write DURABILITY-BARRIER (fsync) crash-window hellgate.
 *
 * Audit R2 noted: `writeFileAtomic` did tmp+rename (no EXDEV — same dir, good)
 * BUT issued NO fsync before the rename. So a crash in the window between the
 * temp write and the rename's own metadata flush could leave a torn /
 * zero-length file surviving under the FINAL name — a partial write that
 * surfaces as a "committed" record after recovery.
 *
 * This battery injects the durability seam (`AtomicWriteSync`) to PROVE:
 *   1. happy path — the temp is fsync'd BEFORE the rename, dir fsync'd AFTER
 *      (ordering invariant: syncFile precedes rename precedes syncDir)
 *   2. crash-window — if the temp fsync THROWS, the rename NEVER runs, the
 *      original on-disk file is UNCHANGED, and no torn file surfaces as
 *      committed (the partial is cleaned up)
 *   3. recovery — a fresh write whose fsync fails leaves the PRIOR complete
 *      file readable; the half-written content is never observable
 *   4. no leftover temp sibling after a failed fsync
 *   5. real default barrier round-trips bytes through to disk (regression)
 *
 * All sites that route through `@/storage` `writeFileAtomic`
 * (shadow-odb init marker T11/H9, github delivery-persist T12/H9) inherit
 * this barrier, so the proof covers them by construction.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AtomicWriteSync, writeFileAtomic } from "@/storage"

const tmps: string[] = []
const mk = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `atomic-fsync-${label}-`))
  tmps.push(d)
  return d
}

describe("atomic-write-fsync-crash-window-hellgate", () => {
  test("HELL-1: ordering — syncFile runs BEFORE rename, syncDir AFTER", async () => {
    const dir = mk("order")
    const target = join(dir, "doc.json")
    const events: string[] = []
    const spy: AtomicWriteSync = {
      syncFile: async (p) => {
        // The temp must already exist with the new bytes at fsync time.
        events.push(`syncFile:${readFileSync(p, "utf8")}`)
      },
      syncDir: async () => {
        // By the time syncDir runs the final file must be in place.
        events.push(`syncDir:${readFileSync(target, "utf8")}`)
      },
    }
    await writeFileAtomic(target, "new", spy)
    expect(events).toEqual(["syncFile:new", "syncDir:new"])
    expect(readFileSync(target, "utf8")).toBe("new")
  })

  test("HELL-2: crash mid-fsync → rename NEVER runs, original UNCHANGED", async () => {
    const dir = mk("crash")
    const target = join(dir, "doc.json")
    writeFileSync(target, "OLD-COMPLETE")

    let renameWouldHaveRun = false
    const failing: AtomicWriteSync = {
      syncFile: async () => {
        // Simulate a crash / IO error at the durability barrier.
        throw new Error("EIO: fsync failed")
      },
      syncDir: async () => {
        // syncDir only runs after a successful rename — if this ever fires the
        // ordering invariant is broken.
        renameWouldHaveRun = true
      },
    }

    await expect(writeFileAtomic(target, "NEW-TORN", failing)).rejects.toThrow("EIO")
    // The committed file must still be the complete prior content — the torn
    // write was never promoted.
    expect(readFileSync(target, "utf8")).toBe("OLD-COMPLETE")
    expect(renameWouldHaveRun).toBe(false)
  })

  test("HELL-3: partial write is NOT observable as a complete record after recovery", async () => {
    const dir = mk("recover")
    const target = join(dir, "doc.json")
    writeFileSync(target, JSON.stringify({ committed: true, n: 1 }))

    const failing: AtomicWriteSync = {
      syncFile: async () => {
        throw new Error("ENOSPC: no space, fsync")
      },
      syncDir: async () => undefined,
    }
    await expect(
      writeFileAtomic(target, JSON.stringify({ committed: true, n: 2 }), failing),
    ).rejects.toThrow("ENOSPC")

    // Recovery read: the record parses back to the PRIOR committed value, never
    // the half-written n:2 record.
    const recovered = JSON.parse(readFileSync(target, "utf8")) as { n: number }
    expect(recovered.n).toBe(1)
  })

  test("HELL-4: failed fsync leaves NO leftover temp sibling masquerading as data", async () => {
    const dir = mk("notemp")
    const target = join(dir, "doc.json")
    writeFileSync(target, "OLD")

    const failing: AtomicWriteSync = {
      syncFile: async () => {
        throw new Error("EIO")
      },
      syncDir: async () => undefined,
    }
    await expect(writeFileAtomic(target, "NEW", failing)).rejects.toThrow("EIO")

    const entries = readdirSync(dir)
    // Only the original file remains — the quanta-tmp sibling was cleaned up.
    expect(entries).toEqual(["doc.json"])
    expect(entries.some((e) => e.includes("quanta-tmp"))).toBe(false)
  })

  test("HELL-5: default real barrier durably round-trips bytes (regression)", async () => {
    const dir = mk("real")
    const target = join(dir, "doc.json")
    // No injected sync → uses the real fsync path. Must succeed end-to-end.
    await writeFileAtomic(target, "real-bytes")
    expect(readFileSync(target, "utf8")).toBe("real-bytes")
    // Overwrite (target already exists → r+ open must work, not just create).
    await writeFileAtomic(target, "real-bytes-2")
    expect(readFileSync(target, "utf8")).toBe("real-bytes-2")
    // No leftover temp.
    expect(readdirSync(dir).some((e) => e.includes("quanta-tmp"))).toBe(false)
  })
})

process.on("exit", () => {
  for (const d of tmps) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
