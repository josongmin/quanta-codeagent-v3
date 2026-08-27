/**
 * Hellgate — an unreadable DIRECTORY must not delete the files inside it.
 *
 * `visitDirectory` swallowed every `readdir` failure with a bare `return`. The
 * files under that directory therefore never entered the scan snapshot, and
 * `DeltaTracker.diff` — which defines "deleted" as "tracked but not observed" —
 * classified all of them as DELETED. The driver then called `upsert.delete()`
 * for each, so a transient permission change or an `EMFILE` under a large
 * concurrent scan silently purged live files from the corpus AND the vector
 * store, reporting `filesSkipped: 0` with an empty `skipped` map.
 *
 * The module header's "Hard guarantees" block promises `permission_denied` for
 * EACCES on READ. There was no equivalent for the directory case, so the
 * destructive path had no guarantee at all.
 *
 * Invariants:
 *   U-1  A directory that cannot be read is REPORTED (`permission_denied`),
 *        never silently absent.
 *   U-2  Files under an unreadable directory are NOT deleted from the corpus or
 *        the vector store — unobserved is not the same as gone.
 *   U-3  PAIRED CONTROL — a genuinely removed file IS still deleted, so the
 *        guard cannot be satisfied by disabling deletion.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDefaultIndexer } from "@/retrieval/indexer"

let root = ""
const deleted: string[] = []

const upsert = {
  upsert: async (): Promise<void> => undefined,
  delete: async (path: string): Promise<void> => {
    deleted.push(path)
  },
}

const indexerFor = (r: string) =>
  createDefaultIndexer({ scanner: { root: r, glob: "**/*.ts" }, upsert })

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "quanta-idx-unreadable-"))
  mkdirSync(join(root, "pkg"), { recursive: true })
  writeFileSync(join(root, "top.ts"), "export const a = 1\n")
  for (const n of [0, 1, 2, 3]) {
    writeFileSync(join(root, "pkg", `f${n}.ts`), `export const f${n} = ${n}\n`)
  }
})

afterAll(() => {
  try {
    chmodSync(join(root, "pkg"), 0o755)
  } catch {
    // best effort — the temp tree is removed below regardless
  }
  rmSync(root, { recursive: true, force: true })
})

describe("U — an unreadable directory is reported, not treated as a deletion", () => {
  test("U-1/U-2 a mid-scan chmod 000 neither deletes nor hides", async () => {
    const idx = indexerFor(root)
    const first = await idx.scanInitial()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.filesScanned).toBe(5)

    deleted.length = 0
    chmodSync(join(root, "pkg"), 0o000)
    const second = await idx.scanDelta()
    chmodSync(join(root, "pkg"), 0o755)

    expect(second.ok).toBe(true)
    if (!second.ok) return
    // U-2 — the four files still exist on disk; nothing may be deleted.
    expect({ deleted: [...deleted].sort(), reported: second.value.deleted }).toEqual({
      deleted: [],
      reported: 0,
    })
    // U-1 — and the scan must SAY it could not look, rather than reporting a
    // clean pass over a tree it never read.
    expect(second.value.filesSkipped).toBeGreaterThan(0)
  })

  test("U-3 PAIRED CONTROL — a genuinely removed file is still deleted", async () => {
    const r = mkdtempSync(join(tmpdir(), "quanta-idx-control-"))
    try {
      writeFileSync(join(r, "keep.ts"), "export const k = 1\n")
      writeFileSync(join(r, "gone.ts"), "export const g = 1\n")
      const idx = indexerFor(r)
      expect((await idx.scanInitial()).ok).toBe(true)
      deleted.length = 0
      rmSync(join(r, "gone.ts"))
      const after = await idx.scanDelta()
      expect(after.ok).toBe(true)
      if (!after.ok) return
      expect({ deleted: [...deleted], reported: after.value.deleted }).toEqual({
        deleted: ["gone.ts"],
        reported: 1,
      })
    } finally {
      rmSync(r, { recursive: true, force: true })
    }
  })
})
