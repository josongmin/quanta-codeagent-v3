/**
 * HELL-GATE — cross-process lock STALENESS is deterministically testable via
 * the injected clock (`json-state-file.ts` :: `acquireLock` / `createJsonStateFile`).
 *
 * THREAT / WHY: `permission-state.json` is a file-backed read-merge-rename
 * shared across OS processes. The advisory O_EXCL lock that guards the
 * lost-update window MUST be reclaimable when a holder dies mid-section
 * (SIGKILL) — otherwise a dead peer's lock deadlocks every future writer. That
 * reclaim hinges on a STALENESS comparison: holder's written `ts` vs NOW. With
 * a wall-clock `Date.now()` this is untestable without real `setTimeout` sleeps
 * (flaky, slow). The structural fix injects `now()` so stale-lock STEALING is
 * deterministic. This suite proves the seam is real, with a PAIRED CONTROL.
 *
 * INVARIANTS:
 *   - stale-reclaimed   — a lock whose body `ts` is older than LOCK_STALE_MS,
 *     measured by the INJECTED clock, is stolen (acquire ⇒ true) and the lock
 *     body is rewritten with OUR pid.
 *   - fresh-NOT-reclaimed (paired control) — an equal lock whose `ts` is NOT
 *     stale under the same injected clock is NOT stolen; acquire times out
 *     (⇒ false) and the foreign body survives untouched.
 *   - fail-closed-on-timeout — when the lock can never be acquired,
 *     `flushDurable()` returns `durable:false`, leaves existing disk bytes
 *     untouched, and preserves the live in-memory state for a later retry.
 *   - mtime-fallback uses the injected clock too — an unreadable (non-JSON)
 *     lock body is reclaimed via mtime measured against `now()`.
 *
 * RED-ON-INJECTION (test-has-teeth): revert the structural fix — change
 * `acquireLock`'s `now()` calls back to `Date.now()` (ignoring the injected
 * clock). The stale-reclaimed + mtime-fallback cases then measure age against
 * the REAL wall clock, where a freshly-planted lock is ~0ms old ⇒ NOT stale ⇒
 * acquire times out ⇒ those cases go RED. The authors ran that loop.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireLock,
  createJsonStateFile,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
} from "@/permission/json-state-file"

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), "jsf-lock-clock-"))

/** A clock that advances a fixed `step` ms on every read, starting at `start`.
 *  Deterministic, no wall-clock dependency, and guarantees `acquireLock`'s
 *  spin deadline is eventually crossed so contended cases terminate. */
const steppingClock = (start: number, step: number): (() => number) => {
  let t = start
  return () => {
    const v = t
    t += step
    return v
  }
}

/** Plant a FOREIGN lock file (a different process holds it) with a chosen
 *  body `ts`. Returns the lock path. */
const plantForeignLock = async (lockPath: string, ts: number): Promise<void> => {
  await writeFile(lockPath, JSON.stringify({ pid: 999_999, ts }), { mode: 0o600 })
}

describe("json-state-file lock clock — stale reclaim is deterministic (injected clock)", () => {
  test("stale-reclaimed: body ts older than LOCK_STALE_MS under the injected clock ⇒ stolen", async () => {
    const dir = await tmp()
    const lockPath = join(dir, "state.json.lock")
    try {
      // Foreign lock whose `ts` is RECENT in real wall-clock terms (≈ now), so a
      // wall-clock-based staleness check would see age ≈ 0 ⇒ NOT stale. Only the
      // INJECTED clock — set past the staleness horizon — makes it stale. This is
      // what gives the test teeth: revert `now()`→`Date.now()` in acquireLock and
      // this case can no longer steal a freshly-planted lock ⇒ RED.
      const HOLDER_TS = Date.now()
      await plantForeignLock(lockPath, HOLDER_TS)

      // Injected clock starts WELL past the staleness horizon: now - ts > LOCK_STALE_MS.
      // (start advances per read; the very first read already exceeds the horizon.)
      const now = steppingClock(HOLDER_TS + LOCK_STALE_MS + 1, 1)

      const acquired = await acquireLock(lockPath, ".tmp.test", now)
      expect(acquired).toBe(true)

      // Fresh-readback: the stolen lock body now carries OUR pid (real proof the
      // create-after-steal landed, not just a boolean).
      const body = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }
      expect(body.pid).toBe(process.pid)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fresh-NOT-reclaimed (paired control): a non-stale lock that stays fresh is NOT stolen, only times out", async () => {
    const dir = await tmp()
    const lockPath = join(dir, "state.json.lock")
    try {
      // A LIVE peer keeps refreshing its lock body, so its `ts` tracks the
      // clock and the lock is NEVER stale. We model that by re-stamping the
      // foreign body's `ts` to the current injected time on each clock read,
      // while the clock advances fast enough to cross the TIMEOUT deadline.
      //
      // This is the genuine "held by an alive peer" case: the staleness steal is
      // (correctly) NEVER taken — only the bounded timeout ends the spin. It is
      // the paired control to the stale-reclaim case above: SAME engine, the one
      // observable difference (fresh vs stale) flips the outcome (false vs true).
      const start = 50_000
      const step = Math.max(1, Math.floor(LOCK_TIMEOUT_MS / 4))
      let t = start
      const now = (): number => {
        const v = t
        // Re-stamp the foreign lock so it stays fresh under the advancing clock
        // (age 0 every read ⇒ never crosses LOCK_STALE_MS).
        writeFileSync(lockPath, JSON.stringify({ pid: 999_999, ts: v }), { mode: 0o600 })
        t += step
        return v
      }
      await plantForeignLock(lockPath, start)

      const acquired = await acquireLock(lockPath, ".tmp.test", now)
      expect(acquired).toBe(false)

      // The foreign holder (pid) is UNTOUCHED — we never stole it.
      const body = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }
      expect(body.pid).toBe(999_999)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("mtime-fallback: an UNREADABLE lock body is reclaimed via mtime measured against the injected clock", async () => {
    const dir = await tmp()
    const lockPath = join(dir, "state.json.lock")
    try {
      // Non-JSON body ⇒ readLockBirth returns null ⇒ stat/mtime fallback path.
      await writeFile(lockPath, "not-json{{", { mode: 0o600 })
      // Leave the mtime at "just now" (the freshly-written file). A wall-clock
      // staleness check sees age ≈ 0 ⇒ NOT stale; only the INJECTED clock, set
      // past the horizon, makes it stale (teeth: revert ⇒ RED).
      const st = await stat(lockPath)

      // Clock starts past the staleness horizon relative to the file mtime.
      const now = steppingClock(st.mtimeMs + LOCK_STALE_MS + 1, 1)

      const acquired = await acquireLock(lockPath, ".tmp.test", now)
      expect(acquired).toBe(true)

      const body = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }
      expect(body.pid).toBe(process.pid)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("fail-closed-on-timeout: an unstealable fresh lock blocks disk write and remains retryable", async () => {
    const dir = await tmp()
    const filePath = join(dir, "state.json")
    const lockPath = `${filePath}.lock`
    try {
      type S = { records: string[] }
      // A foreign lock that is NEVER stale under our injected clock ⇒ acquireLock
      // inside writeToDisk times out. Existing durable bytes must not change.
      const start = 50_000
      await plantForeignLock(lockPath, start - 1)
      const original: S = { records: ["existing-durable-record"] }
      await writeFile(filePath, JSON.stringify(original), "utf8")
      const step = Math.max(1, Math.floor(LOCK_TIMEOUT_MS / 4))
      let clock = start
      let peerAlive = true
      const now = (): number => {
        const value = clock
        if (peerAlive) {
          writeFileSync(lockPath, JSON.stringify({ pid: 999_999, ts: value }), { mode: 0o600 })
        }
        clock += step
        return value
      }

      const store = createJsonStateFile<S>({
        filePath,
        debounceMs: 0,
        emptyState: () => ({ records: [] }),
        serialize: (s) => JSON.stringify(s),
        parse: (raw): { kind: "ok"; state: S } | { kind: "shape-invalid"; reason: string } =>
          raw !== null && typeof raw === "object" && Array.isArray((raw as S).records)
            ? { kind: "ok", state: raw as S }
            : { kind: "shape-invalid", reason: "not a records array" },
        stateVersion: 1,
        // Supplying mergeWithDisk ⇒ the lock path is exercised. Identity merge
        // when nothing peer-wrote: write our in-memory state.
        mergeWithDisk: ({ inMemory }) => inMemory,
        now,
      })

      const live: S = { records: ["denial-must-survive"] }
      const outcome = await store.flushDurable(() => live)

      expect(outcome).toEqual({
        durable: false,
        reason: "cross-process lock unavailable",
      })
      const onDisk = JSON.parse(await readFile(filePath, "utf8")) as S
      expect(onDisk).toEqual(original)

      // In-memory authority is unchanged regardless of the lock outcome.
      expect(live.records).toEqual(["denial-must-survive"])

      // Release the simulated peer and retry the SAME generation. A failed
      // flush must not clear dirty state or report a false durable no-op.
      peerAlive = false
      await rm(lockPath, { force: true })
      const retry = await store.flushDurable(() => live)
      expect(retry).toEqual({ durable: true })
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(live)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
