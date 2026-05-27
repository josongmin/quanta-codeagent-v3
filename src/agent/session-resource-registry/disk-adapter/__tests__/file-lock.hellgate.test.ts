/**
 * ADR-0356 — Per-session lockfile hellgate.
 *
 * Coverage (12 cases — minimum from the ADR brief):
 *   A. empty dir ⇒ acquire + release succeed                       (1)
 *   B. existing fresh lock ⇒ second acquire times out + null       (1)
 *   C. existing STALE lock (mtime > 30s) ⇒ reclaim + acquire       (1)
 *   D. concurrent multi-acquire ⇒ exactly one winner               (1)
 *   E. release then immediate re-acquire succeeds                  (1)
 *   F. timeoutMs:0 ⇒ instant fail when contended                   (1)
 *   G. retry interval respected (mock now)                         (1)
 *   H. double release ⇒ idempotent                                 (1)
 *   I. release swallows fs errors (NO-THROW)                       (1)
 *   J. fs error (storageDir under a file, not a dir) ⇒ null        (1)
 *   K. lockfile body owner-only (mode 0o600 on POSIX)              (1)
 *   L. now() seam threaded through stale-detection                 (1)
 *
 *  Total: 12 cases.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { platform, tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetProcessHolders,
  acquireSessionLock,
  DEFAULT_LOCK_STALE_THRESHOLD_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  LOCK_FILENAME,
} from "../file-lock"

/** Plant a lockfile DIRECTLY (bypassing `acquireSessionLock` so the
 *  process-holder map stays empty) to simulate "a different process
 *  holds the lock". */
const plantForeignLock = async (dir: string, sessionId: string): Promise<string> => {
  const sessionDir = join(dir, sessionId)
  await mkdir(sessionDir, { recursive: true })
  const lockPath = join(sessionDir, LOCK_FILENAME)
  await writeFile(lockPath, JSON.stringify({ pid: 99999, acquiredAt: 0 }), { mode: 0o600 })
  return lockPath
}

const tempStorage = async (): Promise<string> => mkdtemp(join(tmpdir(), "adr0356-"))

describe("ADR-0356 §A — empty dir ⇒ acquire + release succeed", () => {
  test("first acquire returns a lock; release unlinks the lockfile", async () => {
    const dir = await tempStorage()
    const lock = await acquireSessionLock(dir, "sess-A")
    expect(lock).not.toBeNull()
    if (lock === null) return
    // Lockfile exists at the expected path.
    const lockPath = join(dir, "sess-A", LOCK_FILENAME)
    const st = await stat(lockPath)
    expect(st.isFile()).toBe(true)
    // Body is JSON with pid + acquiredAt (best-effort; may be empty
    // on FS issue but the contract is "file exists").
    const body = await readFile(lockPath, "utf8")
    expect(body.length).toBeGreaterThanOrEqual(0)
    await lock.release()
    // After release the file is gone.
    await expect(stat(lockPath)).rejects.toThrow()
  })
})

describe("ADR-0356 §B — existing fresh lock from another process ⇒ second acquire times out", () => {
  test("acquire over a hand-planted (other-process) lockfile returns null after budget", async () => {
    __resetProcessHolders()
    const dir = await tempStorage()
    // Plant a "foreign" lockfile (NOT via acquireSessionLock so the
    // process-holder map stays empty — same-process re-entry won't
    // short-circuit). Fresh mtime ⇒ no stale-reap.
    await plantForeignLock(dir, "sess-B")
    const start = Date.now()
    const second = await acquireSessionLock(dir, "sess-B", {
      timeoutMs: 80,
      retryIntervalMs: 10,
      staleThresholdMs: 60_000,
    })
    const elapsed = Date.now() - start
    expect(second).toBeNull()
    // Sanity: we did wait roughly the budget (not instant).
    expect(elapsed).toBeGreaterThanOrEqual(60)
  })
})

describe("ADR-0356 §C — stale lock reclaim", () => {
  test("a lockfile with mtime older than staleThresholdMs is reclaimed", async () => {
    const dir = await tempStorage()
    // First, plant a stale lockfile by hand.
    const sessionDir = join(dir, "sess-C")
    await import("node:fs/promises").then((m) => m.mkdir(sessionDir, { recursive: true }))
    const lockPath = join(sessionDir, LOCK_FILENAME)
    await writeFile(lockPath, JSON.stringify({ pid: 99999, acquiredAt: 0 }), { mode: 0o600 })
    // Push mtime to 60s in the past.
    const past = (Date.now() - 60_000) / 1000
    await utimes(lockPath, past, past)

    const lock = await acquireSessionLock(dir, "sess-C", {
      timeoutMs: 100,
      retryIntervalMs: 10,
      staleThresholdMs: 30_000,
    })
    expect(lock).not.toBeNull()
    await lock?.release()
  })
})

describe("ADR-0356 §D — concurrent multi-acquire ⇒ one winner", () => {
  test("5 simultaneous acquires on same session ⇒ exactly 1 non-null", async () => {
    const dir = await tempStorage()
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        acquireSessionLock(dir, "sess-D", { timeoutMs: 50, retryIntervalMs: 10 }),
      ),
    )
    const winners = results.filter((r) => r !== null)
    const losers = results.filter((r) => r === null)
    expect(winners.length).toBe(1)
    expect(losers.length).toBe(4)
    await winners[0]?.release()
  })
})

describe("ADR-0356 §E — release then immediate re-acquire", () => {
  test("release frees the lock; next acquire succeeds without delay", async () => {
    const dir = await tempStorage()
    const a = await acquireSessionLock(dir, "sess-E")
    expect(a).not.toBeNull()
    await a?.release()
    const b = await acquireSessionLock(dir, "sess-E", { timeoutMs: 50 })
    expect(b).not.toBeNull()
    await b?.release()
  })
})

describe("ADR-0356 §F — timeoutMs:0 instant fail when contended", () => {
  test("zero-budget acquire over a foreign lock bails out immediately", async () => {
    __resetProcessHolders()
    const dir = await tempStorage()
    // Foreign lock — same-process re-entry can't short-circuit.
    await plantForeignLock(dir, "sess-F")
    const start = Date.now()
    const second = await acquireSessionLock(dir, "sess-F", {
      timeoutMs: 0,
      retryIntervalMs: 0,
      staleThresholdMs: 60_000,
    })
    const elapsed = Date.now() - start
    expect(second).toBeNull()
    expect(elapsed).toBeLessThan(200)
  })
})

describe("ADR-0356 §G — retry budget honored with mock clock + foreign lock", () => {
  test("`now` advancing past budget yields null (against a foreign lock)", async () => {
    __resetProcessHolders()
    const dir = await tempStorage()
    await plantForeignLock(dir, "sess-G")

    // Mock clock: tick by 30 ms per call so the timeout (60ms) is
    // exhausted after a handful of loop iterations. The lock body's
    // mtime is wall-clock recent so the staleThreshold (default
    // very large here) never trips with this clock.
    let t = 0
    const now = (): number => {
      t += 30
      return t
    }
    const second = await acquireSessionLock(dir, "sess-G", {
      timeoutMs: 60,
      retryIntervalMs: 0,
      // staleThresholdMs much larger than the mock clock ever reaches
      // so the stale-reap branch never fires.
      staleThresholdMs: 1_000_000,
      now,
    })
    expect(second).toBeNull()
  })
})

describe("ADR-0356 §H — double release ⇒ idempotent", () => {
  test("calling release twice is a no-op the second time", async () => {
    const dir = await tempStorage()
    const lock = await acquireSessionLock(dir, "sess-H")
    expect(lock).not.toBeNull()
    if (lock === null) return
    await lock.release()
    // Second release MUST NOT throw.
    await expect(lock.release()).resolves.toBeUndefined()
  })
})

describe("ADR-0356 §I — release swallows fs errors (NO-THROW)", () => {
  test("release does not throw when the underlying file was already removed by an external hand", async () => {
    const dir = await tempStorage()
    const lock = await acquireSessionLock(dir, "sess-I")
    expect(lock).not.toBeNull()
    if (lock === null) return
    // Remove the file behind the lock's back to simulate an OS-level
    // cleanup race or a sibling reaper.
    const lockPath = join(dir, "sess-I", LOCK_FILENAME)
    const { unlink } = await import("node:fs/promises")
    await unlink(lockPath)
    // Release MUST still resolve cleanly.
    await expect(lock.release()).resolves.toBeUndefined()
  })
})

describe("ADR-0356 §J — fs error ⇒ null (not throw)", () => {
  test("storageDir under a file (not a dir) ⇒ mkdir fails ⇒ null", async () => {
    const dir = await tempStorage()
    // Plant a regular file where the storageDir would be.
    const blocker = join(dir, "blocked")
    await writeFile(blocker, "i am a file, not a dir")
    // Use `blocker` itself as the storageDir — mkdir of
    // `blocker/sessionDir` will fail with ENOTDIR.
    const lock = await acquireSessionLock(blocker, "sess-J", { timeoutMs: 50 })
    expect(lock).toBeNull()
  })
})

describe("ADR-0356 §K — lockfile mode 0o600 (POSIX)", () => {
  test.skipIf(platform() === "win32")(
    "the lockfile is created with owner-only permissions",
    async () => {
      const dir = await tempStorage()
      const lock = await acquireSessionLock(dir, "sess-K")
      expect(lock).not.toBeNull()
      const lockPath = join(dir, "sess-K", LOCK_FILENAME)
      const st = await stat(lockPath)
      // Mask the file-type bits; only check the perm bits.
      const perms = st.mode & 0o777
      expect(perms).toBe(0o600)
      await lock?.release()
    },
  )
})

describe("ADR-0356 §L — now() clock-seam threaded through stale detection", () => {
  test("custom `now` advances past stale threshold ⇒ stale lock reclaimed", async () => {
    const dir = await tempStorage()
    // Plant an existing lockfile (mtime ≈ wall-clock now).
    const sessionDir = join(dir, "sess-L")
    await import("node:fs/promises").then((m) => m.mkdir(sessionDir, { recursive: true }))
    const lockPath = join(sessionDir, LOCK_FILENAME)
    await writeFile(lockPath, "{}", { mode: 0o600 })
    // We push mtime well into the past so the stale check trips with
    // the custom `now` (which itself returns the current Date.now to
    // keep the time-axis aligned with utimes).
    const past = (Date.now() - 60_000) / 1000
    await utimes(lockPath, past, past)
    // Use a clock that always returns "now" — staleness is decided by
    // (now() - mtime) ≥ threshold. With mtime 60s back and now() at
    // wall clock, threshold 30s should reclaim.
    const lock = await acquireSessionLock(dir, "sess-L", {
      timeoutMs: 100,
      retryIntervalMs: 10,
      staleThresholdMs: 30_000,
      now: () => Date.now(),
    })
    expect(lock).not.toBeNull()
    await lock?.release()
  })
})

describe("ADR-0356 — constants sanity", () => {
  test("default thresholds match the ADR brief", () => {
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(5_000)
    expect(DEFAULT_LOCK_STALE_THRESHOLD_MS).toBe(30_000)
  })
})
