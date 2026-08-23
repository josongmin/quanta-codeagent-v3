/**
 * RFC-06 F1 (R1) — cross-process exclusive lock for the durable
 * user-disabled-set file.
 *
 * # Why this exists
 *
 * The disabled-set store's read→modify→write (authority `setEnabled`) is NOT
 * safe across processes: a CLI and a web-daemon that share
 * `<userDir>/.disabled.json` both read revision N, both compute N+1, both
 * atomic-rename → last-writer-wins, one session's disable silently lost. A
 * rev-compare-then-rename does NOT fix it — the read and the rename are
 * separate syscalls, so both writers pass the compare and both rename
 * (classic TOCTOU). Only a real mutual-exclusion primitive closes it.
 *
 * # Mechanism (generalized from the agent registry's file-lock)
 *
 * This is a path-keyed clone of
 * `src/agent/session-resource-registry/disk-adapter/file-lock.ts`
 * (ADR-0356 / ADR-0364 telemetry / ADR-0365 Windows). It is re-implemented
 * here rather than imported because the `@/skill` slice may NOT import
 * `@/agent` (nor `@/observability`, which that module pulls in for metrics) —
 * see `tests/unit/_arch/slice-boundary-configs.ts`. The lock contract is the
 * atomic exclusive-create of `<file>.lock`:
 *
 *   `fs.open(path, "wx")` ≡ POSIX `O_CREAT | O_EXCL | O_WRONLY`. On Windows
 *   this maps to `CreateFileW(CREATE_NEW)`, atomic on every supported volume
 *   (NTFS / ReFS / modern SMB2/3) — ADR-0365 keeps `wx` as the portable
 *   primitive; no `LockFileEx` binding required.
 *
 * # Differences from the agent file-lock (deliberate)
 *
 *   1. NO process-local refcount holder map. The agent lock shares one handle
 *      between two same-PID registry instances so they don't deadlock against
 *      themselves. Here the ONLY concurrent-mutation path (the authority) is
 *      already in-process serialized, so a single store instance never
 *      re-enters `withLock`; and TWO store instances on the same file
 *      represent TWO processes and MUST genuinely contend on the on-disk
 *      `.lock` (that is exactly the cross-process invariant, and the shape the
 *      hellgate exercises). A holder map would mask it.
 *   2. Acquire failure THROWS (fail-closed) rather than degrading. The agent
 *      registry degrades a lost lock to memory-only; here a lost lock must
 *      REFUSE the mutation (the authority converts the throw to a
 *      `persist_failed` rejection) so we never clobber a concurrent writer.
 *
 * # Liveness
 *
 *   - Bounded retry: `timeoutMs` caps total wait; each contended iteration
 *     sleeps `retryIntervalMs`. No unbounded spin (livelock-safe).
 *   - Stale reclaim: a crashed holder leaves its `.lock` behind. When the
 *     lockfile's mtime is older than `staleThresholdMs` it is treated as a
 *     crashed leftover, unlinked, and the exclusive-create retried — so a dead
 *     holder never deadlocks a live one.
 *
 * # Slice fence
 *
 * Reaches `node:fs/promises` + `node:path` through dynamic import (mirroring
 * `nodeDisabledStoreFs`). NO cross-slice imports. exactOptionalPropertyTypes.
 */

import { abortableSleep } from "@/shared"

/** The lock surface consumed by {@link createJsonDisabledStore}: run a critical
 *  section under a cross-process exclusive lock. `withLock` acquires (bounded
 *  retry + stale reclaim), runs `fn`, and ALWAYS releases in a `finally` —
 *  including when `fn` throws (a persist failure must not leak the lock). An
 *  acquire that cannot succeed within the budget THROWS (fail-closed). */
export interface DisabledStoreLock {
  withLock<T>(fn: () => Promise<T>): Promise<T>
}

/** Tunables for {@link createFileLock}. All optional; defaults match the
 *  agent file-lock (5s timeout / 100ms retry / 30s stale). */
export interface DisabledStoreLockOpts {
  /** Hard upper bound on acquisition wall time (ms). Default 5000. */
  readonly timeoutMs?: number
  /** Sleep between retries while contended (ms). Default 100. */
  readonly retryIntervalMs?: number
  /** Age (ms) at which an existing lockfile is treated as a crashed-holder
   *  leftover and reclaimed. Default 30000. */
  readonly staleThresholdMs?: number
  /** Clock seam — tests pass a deterministic source. Default `Date.now`. */
  readonly now?: () => number
}

/** Default acquisition timeout — 5s (orders of magnitude above the expected
 *  sub-ms hold of a single JSON read+rename). */
export const DEFAULT_DISABLED_LOCK_TIMEOUT_MS = 5_000
/** Default per-retry sleep — 100ms. */
export const DEFAULT_DISABLED_LOCK_RETRY_INTERVAL_MS = 100
/** Default stale threshold — 30s (well above a healthy hold, well below a
 *  process-restart latency, so a live holder never trips it and a crashed one
 *  is reclaimed within a retry or two). */
export const DEFAULT_DISABLED_LOCK_STALE_THRESHOLD_MS = 30_000

/** Derive the sibling lockfile path for a disabled-set file. Kept adjacent so
 *  the atomic `<file>.<pid>.<ts>.tmp` write path never collides with it. */
export const disabledSetLockPath = (path: string): string => `${path}.lock`

// Retry wait via the shared timer-clearing sleep (never a raw
// `new Promise(setTimeout)` — no leaked timer; abort-aware if a signal is later
// threaded). Bounded by the caller's `timeoutMs` budget in `acquire`.
const sleep = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : abortableSleep(ms))

/** Read the lockfile's mtime (ms). `null` when missing/unreadable ⇒ treat as
 *  "not stale, keep retrying". */
const readMtimeMs = async (path: string): Promise<number | null> => {
  const { stat } = await import("node:fs/promises")
  try {
    return (await stat(path)).mtimeMs
  } catch (_e) {
    return null
  }
}

/** Best-effort unlink (NO-THROW). Used by stale-reap + release. */
const unlinkSafe = async (path: string): Promise<void> => {
  const { unlink } = await import("node:fs/promises")
  try {
    await unlink(path)
  } catch (_e) {
    // ENOENT / EPERM — already gone or not ours to remove.
  }
}

type ExclusiveCreate = "acquired" | "exists" | "failed"

/** One `open(lockPath,"wx")` attempt. `"acquired"` ⇒ we own the lockfile (a
 *  best-effort diagnostic body is written); `"exists"` ⇒ EEXIST (contended);
 *  `"failed"` ⇒ any other fs error (perm/ENOSPC — give up). */
const tryCreate = async (lockPath: string, pid: number, at: number): Promise<ExclusiveCreate> => {
  const { open } = await import("node:fs/promises")
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(lockPath, "wx", 0o600)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EEXIST" ? "exists" : "failed"
  }
  try {
    await handle.writeFile(JSON.stringify({ pid, acquiredAt: at }), { encoding: "utf8" })
  } catch (_e) {
    // Body is diagnostic only — we already hold the lock (the file's existence
    // IS the contract).
  }
  try {
    await handle.close()
  } catch (_e) {
    // Close failure: still acquired; the kernel reclaims the fd on exit.
  }
  return "acquired"
}

/** Acquire the exclusive lockfile, blocking (bounded) on contention and
 *  reclaiming a stale (crashed-holder) lock. THROWS on timeout or fs failure —
 *  the caller must NOT proceed to write without the lock. */
const acquire = async (lockPath: string, o: Required<DisabledStoreLockOpts>): Promise<void> => {
  const { mkdir } = await import("node:fs/promises")
  const { dirname } = await import("node:path")
  await mkdir(dirname(lockPath), { recursive: true })
  const pid = typeof process?.pid === "number" ? process.pid : 0
  const start = o.now()
  while (true) {
    const result = await tryCreate(lockPath, pid, o.now())
    if (result === "acquired") return
    if (result === "failed")
      throw new Error(`disabled-set lock: unusable filesystem at ${lockPath}`)
    // EEXIST — reclaim if the holder looks crashed, else respect the budget.
    const mtimeMs = await readMtimeMs(lockPath)
    if (mtimeMs !== null && o.now() - mtimeMs >= o.staleThresholdMs) {
      await unlinkSafe(lockPath)
      continue
    }
    if (o.now() - start >= o.timeoutMs) {
      throw new Error(`disabled-set lock: acquire timed out after ${o.timeoutMs}ms at ${lockPath}`)
    }
    await sleep(o.retryIntervalMs)
  }
}

/**
 * Build a cross-process {@link DisabledStoreLock} guarding `lockPath` via an
 * O_EXCL (`wx`) lockfile. The default guard for {@link createJsonDisabledStore}.
 */
export const createFileLock = (
  lockPath: string,
  opts: DisabledStoreLockOpts = {},
): DisabledStoreLock => {
  const resolved: Required<DisabledStoreLockOpts> = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_DISABLED_LOCK_TIMEOUT_MS,
    retryIntervalMs: opts.retryIntervalMs ?? DEFAULT_DISABLED_LOCK_RETRY_INTERVAL_MS,
    staleThresholdMs: opts.staleThresholdMs ?? DEFAULT_DISABLED_LOCK_STALE_THRESHOLD_MS,
    now: opts.now ?? Date.now,
  }
  return {
    withLock: async (fn) => {
      await acquire(lockPath, resolved)
      try {
        return await fn()
      } finally {
        await unlinkSafe(lockPath)
      }
    },
  }
}
