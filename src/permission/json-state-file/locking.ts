/**
 * Cross-process advisory lock + the shared persistence types for
 * {@link createJsonStateFile} (extracted from `json-state-file.ts`).
 *
 * Behavior is byte-identical to the prior in-file definitions; this split only
 * keeps the factory body under the god-function ceiling.
 */

import { open, readFile, stat, unlink } from "node:fs/promises"

/** Distinguished outcomes of a state `parse`. The engine takes the right
 *  action per outcome — schema mismatch quarantines to a versioned sidecar so
 *  a future migration can recover, while malformed-shape just starts empty. */
export type ParseOutcome<T> =
  | { kind: "ok"; state: T }
  | { kind: "version-mismatch"; foundVersion: number | string | null }
  | { kind: "shape-invalid"; reason: string }

/**
 * Typed persistence outcome (T08 — May-31 bugbash, audit L8 M5/M6).
 *
 * The store's in-memory state is ALWAYS authoritative — a failed flush never
 * loses the live grant/denial. But the prior `flush(): Promise<void>` made the
 * durable-write failure INVISIBLE to the caller: a `grant()` that landed in
 * memory but never reached disk (EACCES on `~/.quanta`, a full disk, a
 * read-only mount) resolved `await flush()` exactly like a successful write.
 * A caller that needs the grant to survive a process restart (a CI bot pinning
 * a host to read-only; a security denial that MUST persist) had no way to know
 * it didn't.
 *
 * `flush()` now returns this discriminated outcome so callers can DISTINGUISH
 * "applied in memory" (`durable: false` + opaque `reason`) from "durably
 * persisted" (`durable: true`). It is part of the store contract, not a log
 * line. Callers that don't care keep ignoring the return (it widens
 * `Promise<void>` → `Promise<PersistOutcome>`, source-compatible).
 */
export type PersistOutcome =
  | { readonly durable: true }
  | { readonly durable: false; readonly reason: string }

/**
 * Cross-process advisory lock around the read-merge-rename critical section.
 *
 * WHY: `mergeWithDisk` re-reads the on-disk file then renames our merged
 * payload over it. Without a lock, two SEPARATE OS PROCESSES can both re-read
 * the SAME (e.g. empty) state, both serialize their own records, and the second
 * `rename` clobbers the first — a silent last-write-WINS lost-update (TOCTOU)
 * that the in-process `pendingFlush` queue cannot prevent (it only serializes
 * writes WITHIN one process). The per-instance tmp suffix prevents TORN JSON
 * but not the lost grant. A security grant/denial that races a peer must NOT be
 * dropped, so we serialize the critical section across processes too.
 *
 * MECHANISM: `open(path, "wx")` (O_CREAT|O_EXCL) is an atomic "create-if-absent"
 * on POSIX — exactly one racer wins the create; losers retry. The lock file
 * holds the holder's `{pid, ts}` so a peer can break a STALE lock (holder died
 * mid-section, e.g. SIGKILL) after `staleMs`, avoiding a permanent deadlock.
 * The retry spin yields to the event loop (`await` of a resolved microtask) so
 * it is cooperative, not a busy-CPU spin, and is bounded by `timeoutMs` so a
 * truly stuck peer degrades to "write anyway" rather than hanging the caller.
 *
 * CLOCK: lock expiry compares a peer's written `ts` against now. In production
 * each process uses the real global clock (the default `now` param). Injecting
 * the clock makes stale-lock STEALING deterministically testable — the whole
 * point of the injected-clock rule (`opts?.now ?? Date.now`).
 */
export const LOCK_STALE_MS = 5_000
export const LOCK_TIMEOUT_MS = 10_000

/** Best-effort: read the lock holder's birth timestamp; null when unreadable. */
const readLockBirth = async (lockPath: string): Promise<number | null> => {
  try {
    const raw = await readFile(lockPath, "utf8")
    const parsed = JSON.parse(raw) as { ts?: unknown }
    return typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : null
  } catch {
    return null
  }
}

/** Acquire the lock or return false if we timed out (caller then proceeds
 *  best-effort — non-durability never blocks the in-memory authority).
 *  `now` is injected so stale-lock STEALING is deterministically testable; the
 *  literal `Date.now` is only the default-factory fallback (no call form). */
export const acquireLock = async (
  lockPath: string,
  tmpSuffix: string,
  now: () => number = Date.now,
): Promise<boolean> => {
  const deadline = now() + LOCK_TIMEOUT_MS
  const body = JSON.stringify({ pid: process.pid, ts: now() })
  for (;;) {
    try {
      const handle = await open(lockPath, "wx")
      await handle.writeFile(body, "utf8")
      await handle.close()
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false
    }
    // Lock held by a peer. Break it if it is stale (holder likely died).
    const birth = await readLockBirth(lockPath)
    const ageKnown = birth !== null
    let stale = false
    if (ageKnown) {
      stale = now() - birth > LOCK_STALE_MS
    } else {
      // Unreadable lock body — fall back to mtime so a partially-written or
      // legacy lock can still be reclaimed once it ages out.
      try {
        const st = await stat(lockPath)
        stale = now() - st.mtimeMs > LOCK_STALE_MS
      } catch {
        // Lock vanished between EEXIST and stat — retry the create immediately.
        continue
      }
    }
    if (stale) {
      // Steal: unlink the stale lock (atomic enough — a double-unlink is a
      // harmless ENOENT) and retry the create. Use the tmpSuffix only to keep
      // the linter happy that each instance is distinguishable in traces.
      void tmpSuffix
      try {
        await unlink(lockPath)
      } catch {
        // Someone else already broke it — fine, just retry.
      }
      continue
    }
    if (now() > deadline) return false
    // Cooperative yield before retrying — not a CPU spin.
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}

export const releaseLock = async (lockPath: string): Promise<void> => {
  try {
    await unlink(lockPath)
  } catch {
    // Already released / stolen — nothing to do.
  }
}
