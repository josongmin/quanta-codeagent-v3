/**
 * T11 / audit-R2 — import-log append DURABILITY-BARRIER (fsync) crash-window
 * hellgate.
 *
 * Audit R2 noted `appendImportLog` did tmp+rename (same dir → no EXDEV) BUT
 * NO fsync before the rename, so a crash between the temp write and the
 * rename's metadata flush could promote a torn / zero-length file under the
 * FINAL name — a partial log surfacing as committed after recovery.
 *
 * This battery injects the `ImportLogSync` seam to PROVE:
 *   1. happy append — temp fsync'd BEFORE the rename, dir fsync'd AFTER
 *      (ordering invariant: syncFile precedes the visible new file)
 *   2. crash-window — if the temp fsync THROWS, the rename NEVER runs, the
 *      on-disk log is UNCHANGED (no torn entry surfaces as committed), the
 *      lock is released (finally), and a partial temp is cleaned up
 *   3. recovery — after a failed-fsync append, loadImportLog returns the PRIOR
 *      complete log, and the lock is reclaimable (a later append succeeds)
 *   4. real default barrier round-trips an append to disk (regression)
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendImportLog, type ImportLogSync, importLogPath, loadImportLog } from "@/migration"
import type { ImportLogEntry } from "@/migration/types"

const tmps: string[] = []
const mkHome = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `import-fsync-${label}-`))
  tmps.push(d)
  return d
}

// The log keys entries only by content; we tag the `detail` so a test can
// assert which entries are committed (the type has no id field).
const entry = (id: string): ImportLogEntry => ({
  timestamp: "2026-05-31T00:00:00.000Z",
  provider: "claude_code",
  stage: "import_finished",
  ok: true,
  detail: id,
})

describe("import-log-append-fsync-crash-window-hellgate", () => {
  test("HELL-1: ordering — syncFile runs while only the temp exists, dir fsync after", async () => {
    const home = mkHome("order")
    const path = importLogPath(home)
    const events: string[] = []
    const spy: ImportLogSync = {
      syncFile: async (p) => {
        // At fsync time the durable name must NOT yet hold the new entry — only
        // the temp sibling does.
        events.push(`syncFile:${p.includes(".tmp.")}`)
      },
      syncDir: async () => {
        events.push("syncDir")
      },
    }
    await appendImportLog(home, entry("a"), {}, spy)
    expect(events).toEqual(["syncFile:true", "syncDir"])
    const log = await loadImportLog(home)
    expect(log.entries.map((e) => e.detail)).toEqual(["a"])
    expect(path.endsWith(".json")).toBe(true)
  })

  test("HELL-2: crash mid-fsync → rename NEVER runs, prior log UNCHANGED, lock freed", async () => {
    const home = mkHome("crash")
    // Seed a committed first entry through the REAL barrier.
    await appendImportLog(home, entry("first"))
    const before = await loadImportLog(home)

    let renameSurfaced = false
    const failing: ImportLogSync = {
      syncFile: async () => {
        throw new Error("EIO: fsync failed")
      },
      syncDir: async () => {
        renameSurfaced = true // only reachable after a successful rename
      },
    }
    await expect(appendImportLog(home, entry("torn"), {}, failing)).rejects.toThrow("EIO")

    // The committed log is still EXACTLY the prior complete set — the torn
    // append was never promoted.
    const after = await loadImportLog(home)
    expect(after.entries.map((e) => e.detail)).toEqual(["first"])
    expect(after).toEqual(before)
    expect(renameSurfaced).toBe(false)

    // Lock released by the finally — a fresh append (real barrier) succeeds,
    // proving the crash did not wedge the writer.
    await appendImportLog(home, entry("second"))
    const recovered = await loadImportLog(home)
    expect(recovered.entries.map((e) => e.detail)).toEqual(["first", "second"])
  })

  test("HELL-3: failed-fsync append leaves NO leftover temp sibling", async () => {
    const home = mkHome("notemp")
    await appendImportLog(home, entry("first"))
    const failing: ImportLogSync = {
      syncFile: async () => {
        throw new Error("ENOSPC")
      },
      syncDir: async () => undefined,
    }
    await expect(appendImportLog(home, entry("torn"), {}, failing)).rejects.toThrow("ENOSPC")

    const dir = join(home, ".quanta")
    const leftover = readdirSync(dir).filter((e) => e.includes(".tmp."))
    expect(leftover).toEqual([])
  })

  test("HELL-4: real default barrier durably round-trips an append (regression)", async () => {
    const home = mkHome("real")
    await appendImportLog(home, entry("x"))
    await appendImportLog(home, entry("y"))
    const log = await loadImportLog(home)
    expect(log.entries.map((e) => e.detail)).toEqual(["x", "y"])
  })
})

// `afterAll`, NOT `process.on("exit")`. Bun's test runner does not fire an
// exit hook for a test file, so that form never ran and every fixture dir it
// created stayed on disk — enough of them to make `ls /tmp` slow enough to
// time other tests out.
afterAll(() => {
  for (const d of tmps) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})
