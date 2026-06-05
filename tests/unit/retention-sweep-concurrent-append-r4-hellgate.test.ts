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
