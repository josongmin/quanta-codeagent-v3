/**
 * T11 — Migration import-log STALE-LOCK RECOVERY hellgate.
 *
 * Audit L9 M13: "Migration import-log stale lock recovery."
 *
 * The import log uses a sidecar `*.lock` file (created with `wx`) so two
 * concurrent imports cannot race. The defect: if a writer CRASHES while
 * holding the lock, the lock file is orphaned and EVERY future import is
 * permanently blocked with {@link ImportLogBusyError} — there is no
 * reclaim path.
 *
 * Owning-seam invariant (T11): cross-process serialization is preserved,
 * AND a stale lock is reclaimable under bounded, explicit conditions
 * (age past an injected `staleAfterMs` threshold AND a dead owner). A
 * FRESH lock (live concurrent writer) is still honored — reclaim must
 * not become a race-defeating footgun.
 *
 * 7 adversarial cases (injected clock + pid-liveness probe — no sleeps):
 *   1. fresh lock + live owner → BUSY (regression anchor; no reclaim)
 *   2. fresh lock + dead owner → BUSY (age guard dominates — not yet stale)
 *   3. stale lock + dead owner → RECLAIMED, append succeeds
 *   4. stale lock + live owner → BUSY (owner still alive — never steal)
 *   5. reclaim preserves prior entries (read-modify-write after steal)
 *   6. after reclaim the lock is released (next append is not BUSY)
 *   7. malformed lock body (no pid) + stale age → treated as dead → reclaimed
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendImportLog,
  ImportLogBusyError,
  importLogPath,
  loadImportLog,
} from "@/migration/persistence"
import type { ImportLogEntry } from "@/migration/types"

const entry = (detail: string): ImportLogEntry => ({
  timestamp: "2026-01-01T00:00:00.000Z",
  provider: "claude_code",
  stage: "import_finished",
  ok: true,
  detail,
})

let home: string
const fresh = async (): Promise<string> => {
  home = await mkdtemp(join(tmpdir(), "t11-stale-lock-"))
  return home
}

const lockPath = (h: string): string => `${importLogPath(h)}.lock`

/** Plant a lock file with a given body + back-date its mtime by `ageMs`. */
const plantLock = async (h: string, body: string, ageMs: number): Promise<void> => {
  await mkdir(join(h, ".quanta"), { recursive: true })
  const p = lockPath(h)
  await writeFile(p, body, { encoding: "utf8" })
  const when = (Date.now() - ageMs) / 1000
  const { utimes } = await import("node:fs/promises")
  await utimes(p, when, when)
}

const STALE_MS = 60_000

describe("import-log-stale-lock-hellgate", () => {
  test("HELL-1: fresh lock + live owner → BUSY (no reclaim)", async () => {
    const h = await fresh()
    await plantLock(h, "424242", 0)
    await expect(
      appendImportLog(h, entry("x"), {
        staleAfterMs: STALE_MS,
        now: () => Date.now(),
        isOwnerAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(ImportLogBusyError)
    await rm(h, { recursive: true, force: true })
  })

  test("HELL-2: fresh lock + dead owner → BUSY (age guard dominates)", async () => {
    const h = await fresh()
    await plantLock(h, "424242", 0)
    await expect(
      appendImportLog(h, entry("x"), {
        staleAfterMs: STALE_MS,
        now: () => Date.now(),
        isOwnerAlive: () => false,
      }),
    ).rejects.toBeInstanceOf(ImportLogBusyError)
    await rm(h, { recursive: true, force: true })
  })

  test("HELL-3: stale lock + dead owner → reclaimed, append succeeds", async () => {
    const h = await fresh()
    await plantLock(h, "424242", STALE_MS * 2)
    await appendImportLog(h, entry("after-reclaim"), {
      staleAfterMs: STALE_MS,
      now: () => Date.now(),
      isOwnerAlive: () => false,
    })
    const log = await loadImportLog(h)
    expect(log.entries.map((e) => e.detail)).toEqual(["after-reclaim"])
    await rm(h, { recursive: true, force: true })
  })

  test("HELL-4: stale lock + LIVE owner → BUSY (never steal a live lock)", async () => {
    const h = await fresh()
    await plantLock(h, "424242", STALE_MS * 2)
    await expect(
      appendImportLog(h, entry("x"), {
        staleAfterMs: STALE_MS,
        now: () => Date.now(),
        isOwnerAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(ImportLogBusyError)
    await rm(h, { recursive: true, force: true })
  })

  test("HELL-5: reclaim preserves prior log entries", async () => {
    const h = await fresh()
    // Pre-existing committed log.
    await mkdir(join(h, ".quanta"), { recursive: true })
    await writeFile(
      importLogPath(h),
      `${JSON.stringify({ version: 1, entries: [entry("old")] }, null, 2)}\n`,
      "utf8",
    )
    await plantLock(h, "424242", STALE_MS * 2)
    await appendImportLog(h, entry("new"), {
      staleAfterMs: STALE_MS,
      now: () => Date.now(),
      isOwnerAlive: () => false,
    })
    const log = await loadImportLog(h)
    expect(log.entries.map((e) => e.detail)).toEqual(["old", "new"])
    await rm(h, { recursive: true, force: true })
  })

  test("HELL-6: after reclaim the lock is released", async () => {
    const h = await fresh()
    await plantLock(h, "424242", STALE_MS * 2)
    await appendImportLog(h, entry("first"), {
      staleAfterMs: STALE_MS,
      now: () => Date.now(),
      isOwnerAlive: () => false,
    })
    // Lock file must be gone → a follow-up append (no stale lock) succeeds.
    let lockExists = true
    try {
      await stat(lockPath(h))
    } catch {
      lockExists = false
    }
    expect(lockExists).toBe(false)
    await appendImportLog(h, entry("second"))
    const log = await loadImportLog(h)
    expect(log.entries.map((e) => e.detail)).toEqual(["first", "second"])
    await rm(h, { recursive: true, force: true })
  })

  test("HELL-7: malformed lock body (no pid) + stale → treated as dead → reclaimed", async () => {
    const h = await fresh()
    await plantLock(h, "not-a-pid", STALE_MS * 2)
    await appendImportLog(h, entry("ok"), {
      staleAfterMs: STALE_MS,
      now: () => Date.now(),
      // isOwnerAlive omitted — default probe must treat an unparseable pid
      // as not-alive so a garbage stale lock is still reclaimable.
    })
    const log = await loadImportLog(h)
    expect(log.entries.map((e) => e.detail)).toEqual(["ok"])
    expect(await readFile(importLogPath(h), "utf8")).toContain("ok")
    await rm(h, { recursive: true, force: true })
  })
})
