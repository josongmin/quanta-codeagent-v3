/**
 * Cross-process advisory lock + the shared persistence types for
 * {@link createJsonStateFile} (extracted from `json-state-file.ts`).
 *
 * W0.3/F-09: the lock is a held `flock(2)` fd. Age/mtime steal and
 * unconditional unlink on release are removed. A live holder cannot be
 * displaced. Process death releases the fd. Leftover lock pathnames are
 * reopened, never age-unlinked. Nested reentrancy is refused. Concurrent
 * waiters serialize on flock. A second acquire in the same process waits
 * on flock until timeout rather than stealing.
 */

import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname } from "node:path"
import { LOCK_EX, LOCK_NB, LOCK_UN, OPEN_LOCK_FLAGS, posixFlock } from "./posix-flock"

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

/** Kept for source-compat. Steal-by-age is no longer implemented. */
export const LOCK_STALE_MS = 5_000
export const LOCK_TIMEOUT_MS = 10_000

type Held = { readonly fd: number }
const heldFds = new Map<string, Held>()

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })

/**
 * Acquire an exclusive flock on `lockPath`. Returns false on timeout, I/O
 * failure, or nested reentrancy. `now` is ignored — age steal is gone;
 * the parameter remains so existing call sites compile.
 */
export const acquireLock = async (
  lockPath: string,
  _tmpSuffix?: string,
  _now: () => number = Date.now,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<boolean> => {
  void _now
  try {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  } catch {
    return false
  }
  let fd: number
  try {
    fd = openSync(lockPath, OPEN_LOCK_FLAGS, 0o600)
  } catch {
    return false
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (posixFlock(fd, LOCK_EX | LOCK_NB) === 0) {
      const rec: Held = { fd }
      heldFds.set(lockPath, rec)
      return true
    }
    if (Date.now() > deadline) {
      closeSync(fd)
      return false
    }
    await sleep(10)
  }
}

/** Unlock + close. Does not unlink the lock pathname. Stale delayed
 *  release of a previous generation does not unlock a successor. */
export const releaseLock = async (lockPath: string): Promise<void> => {
  const rec = heldFds.get(lockPath)
  if (rec === undefined) return
  posixFlock(rec.fd, LOCK_UN)
  closeSync(rec.fd)
  if (heldFds.get(lockPath) === rec) heldFds.delete(lockPath)
}
