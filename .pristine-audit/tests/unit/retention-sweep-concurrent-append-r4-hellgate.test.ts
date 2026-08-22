/**
 * ROUND-4 concurrency hellgate — retention sweep vs a concurrent transcript
 * append (LOST-UPDATE).
 *
 * `applyRetention` is a read-modify-rewrite:
 *     1. readFile(path)            ← snapshot of rows
 *     2. splitByCap(...)           ← decide kept (newest) rows
 *     3. write tmp + fsync
 *     4. rename(tmp, path)         ← replaces the file with `kept`
 *
 * A live session appends new rows to the SAME path with O_APPEND. An append
 * that lands AFTER step 1 but BEFORE step 4 is in the original file but NOT in
 * the snapshot the sweep read — the rename at step 4 OVERWRITES it. The newly
 * appended (newest!) row is LOST even though retention is supposed to keep the
 * newest rows.
 *
 * We drive the interleaving with the `_afterReadForTest` hook: it fires right
 * after step 1, where we append a fresh row to the real file. After the rewrite
 * completes we assert the appended row SURVIVES (is still present on disk).
 *
 * jun-10 silent-failure audit #20 — the RESIDUAL window: the catch-up tail
 * re-read closes the snapshot→tail-read window, but an append landing AFTER
 * that re-read and BEFORE the rename (i.e. inside step 3→4, the
 * write+fsync+rename window) still targets the ORIGINAL inode, which the
 * rename orphans. The `_beforeRenameForTest` hook fires after the tmp is
 * written+fsynced and right before the rename — injecting there proves the
 * post-rename late-tail salvage.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyRetention } from "@/stream"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "retention-race-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const appendRow = async (path: string, row: string): Promise<void> => {
  const fh = await open(path, "a")
  try {
    await fh.write(`${row}\n`)
  } finally {
    await fh.close()
  }
}

describe("ROUND-4 retention sweep — concurrent append must not be lost", () => {
  test("a row appended between snapshot-read and rename SURVIVES", async () => {
    const path = join(dir, "session-a.jsonl")
    // Seed rows that already exceed the cap so retention will trim + rewrite.
    const seed = Array.from({ length: 20 }, (_, i) => `{"i":${i},"pad":"xxxxxxxxxx"}`)
    await writeFile(path, `${seed.join("\n")}\n`, "utf8")

    const appended = '{"i":999,"live":true}'

    // Cap that forces a trim of the oldest rows (keep only the newest handful).
    const res = await applyRetention(path, {
      maxCumulativeBytes: 120,
      // Test seam: fires right after the snapshot read, BEFORE write+rename.
      // Simulates a live session appending a fresh transcript row concurrently.
      _afterReadForTest: async () => {
        await appendRow(path, appended)
      },
    })

    expect(res.droppedRows).toBeGreaterThan(0)

    const after = await readFile(path, "utf8")
    // The concurrently-appended NEWEST row must not be lost by the rewrite.
    expect(after.includes(appended)).toBe(true)
  })

  test("a row appended inside the write→rename window SURVIVES (jun-10 #20 residual race)", async () => {
    const path = join(dir, "session-c.jsonl")
    const seed = Array.from({ length: 20 }, (_, i) => `{"i":${i},"pad":"xxxxxxxxxx"}`)
    await writeFile(path, `${seed.join("\n")}\n`, "utf8")

    const lateAppended = '{"i":1000,"late":true}'

    const res = await applyRetention(path, {
      maxCumulativeBytes: 120,
      // Test seam: fires AFTER the tmp file is written+fsynced and BEFORE the
      // rename — the residual window the pre-rename tail re-read cannot see.
      _beforeRenameForTest: async () => {
        await appendRow(path, lateAppended)
      },
    })

    expect(res.droppedRows).toBeGreaterThan(0)

    const after = await readFile(path, "utf8")
    // ZERO row loss: the row appended inside the write→rename window must be
    // salvaged onto the NEW file post-rename, exactly once.
    const rows = after.split("\n").filter((l) => l.length > 0)
    expect(rows.filter((r) => r === lateAppended)).toHaveLength(1)
    // Newest retained seed row is still there (rewrite itself is intact).
    expect(rows.includes('{"i":19,"pad":"xxxxxxxxxx"}')).toBe(true)
    // Every surviving line is a WHOLE row (no torn splice from the salvage).
    for (const row of rows) expect(() => JSON.parse(row)).not.toThrow()
  })

  test("appends in BOTH windows (post-read AND write→rename) each survive exactly once", async () => {
    const path = join(dir, "session-d.jsonl")
    const seed = Array.from({ length: 20 }, (_, i) => `{"i":${i},"pad":"xxxxxxxxxx"}`)
    await writeFile(path, `${seed.join("\n")}\n`, "utf8")

    const earlyAppended = '{"i":999,"live":true}'
    const lateAppended = '{"i":1000,"late":true}'

    const res = await applyRetention(path, {
      maxCumulativeBytes: 120,
      _afterReadForTest: async () => {
        await appendRow(path, earlyAppended)
      },
      _beforeRenameForTest: async () => {
        await appendRow(path, lateAppended)
      },
    })

    expect(res.droppedRows).toBeGreaterThan(0)

    const after = await readFile(path, "utf8")
    const rows = after.split("\n").filter((l) => l.length > 0)
    expect(rows.filter((r) => r === earlyAppended)).toHaveLength(1)
    expect(rows.filter((r) => r === lateAppended)).toHaveLength(1)
  })

  test("no concurrent append → behaves exactly as before (regression guard)", async () => {
    const path = join(dir, "session-b.jsonl")
    const seed = Array.from({ length: 20 }, (_, i) => `{"i":${i},"pad":"xxxxxxxxxx"}`)
    await writeFile(path, `${seed.join("\n")}\n`, "utf8")

    const res = await applyRetention(path, { maxCumulativeBytes: 120 })
    expect(res.droppedRows).toBeGreaterThan(0)
    const after = await readFile(path, "utf8")
    // Newest seed row is always retained.
    expect(after.includes('{"i":19,"pad":"xxxxxxxxxx"}')).toBe(true)
  })
})
