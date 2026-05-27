/**
 * ADR-0356 — Per-session lockfile for the disk-backed
 * `SessionResourceRegistry` (ADR-0348).
 *
 * ADR-0348 is single-writer by design (see `disk-store.ts` §Concurrency).
 * When two quanta processes target the same `storageDir` for the same
 * `sessionId` the JSONL appends interleave and the meta.json
 * temp+rename races between writers — a `meta.json.tmp-<hex>` from
 * writer-A can be renamed by writer-B after A renamed it. The disk
 * state stays valid (every individual append is atomic-by-line at
 * POSIX-write granularity) but the meta.json + cache-rewrite paths
 * are NOT safe.
 *
 * This module ships the lockfile primitive for ADR-0348 to gate every
 * disk-mirror write on a per-session lock. Single-machine, multi-process
 * safety; cross-machine NFS lease semantics remain out of scope per
 * ADR-0355 (negative).
 *
 * # API
 *
 *   acquireSessionLock(storageDir, sessionId, opts?) → Promise<SessionLock | null>
 *     Acquire the lock for `<storageDir>/<sanitizedId>/.lock`. Returns:
 *       - `SessionLock` when the lockfile was created exclusively;
 *       - `null` when contention persists past `timeoutMs` OR the
 *         filesystem cannot host the lock (missing storageDir, perms).
 *
 *   SessionLock.release(): Promise<void>
 *     Best-effort unlink. Idempotent — second call is a no-op.
 *     NO-THROW.
 *
 * # Algorithm
 *
 *   1. Sanitize `sessionId` (same `[A-Za-z0-9_-]` allowlist as
 *      `disk-store.safeId`) to derive `lockPath`.
 *   2. `mkdir -p` the session dir (best-effort, NO-THROW).
 *   3. Attempt `fs.open(lockPath, "wx")` — Node `wx` ≡ POSIX
 *      `O_CREAT | O_EXCL | O_WRONLY`. The atomic exclusive-create is
 *      the same primitive that `src/stream/adapters/jsonl-retention.ts`
 *      uses for its tmpfile.
 *   4. On `EEXIST`:
 *        a. `stat` the existing lockfile. If `mtime + staleThresholdMs
 *           < now`, treat as a crashed-process leftover: `unlink` it
 *           and retry the exclusive create from step 3.
 *        b. Otherwise sleep `retryIntervalMs` and retry. Give up once
 *           the elapsed time since the first attempt ≥ `timeoutMs`.
 *   5. On any OTHER error (perm denied, ENOSPC, etc.): return `null`.
 *
 * # Stale-detection threshold
 *
 * Default `staleThresholdMs = 30_000` (30s). Rationale: the disk-store
 * NEVER holds the lock across a network call — the lock is held only
 * for the synchronous duration of a getOrCreate + a small async mirror
 * flush window. 30s is two orders of magnitude above the expected hold
 * (sub-second) so a healthy holder never trips its own stale check;
 * 30s is also well under typical process restart latency (kernel
 * cleanup + supervisor restart on macOS launchd / systemd) so a real
 * crashed lock is reclaimed within one or two `getOrCreate` calls.
 *
 * # NO-THROW invariant
 *
 * Every codepath returns rather than throws. `acquire` returns `null`
 * on any unrecoverable filesystem failure; `release` swallows every
 * error (the caller has nothing actionable to do — the disk-mirror
 * already degraded best-effort).
 *
 * # Prior art
 *
 *   - `src/auth/lock-file-based.ts` — same O_EXCL pattern, but for
 *     OAuth refresh tokens with a JSON-payload + TTL. Used as the
 *     in-house reference for the exclusive-create + stale-reap loop.
 *   - `src/stream/adapters/jsonl-retention.ts:174` — atomic rewrite
 *     using `fs.open(tmpPath, "wx")` with the same EEXIST semantics
 *     we rely on here.
 *   - `src/lsp/adapters/file-write-atomic.ts` — temp+rename pattern
 *     ADR-0348 mirrors for `meta.json` writes; this ADR extends the
 *     same family.
 *
 * # Slice fence
 *
 * Imports `node:fs/promises` + `node:path` only. NO cross-slice
 * imports. Used internally by `./disk-store.ts`.
 */

import { mkdir, open, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

/** Default acquisition timeout — 5s. Above the expected hold by orders
 *  of magnitude (the disk-store holds the lock for one synchronous
 *  getOrCreate + a small async mirror burst). */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000

/** Default per-retry sleep — 100ms. 50 retries fit inside the default
 *  5s timeout, balancing CPU vs latency. */
export const DEFAULT_LOCK_RETRY_INTERVAL_MS = 100

/** Default stale threshold — 30s. See file-header §Stale-detection. */
export const DEFAULT_LOCK_STALE_THRESHOLD_MS = 30_000

/** Lockfile basename. Kept dot-prefixed so a `readdir` of the session
 *  directory doesn't surface it as a content file. */
export const LOCK_FILENAME = ".lock"

/**
 * Process-local holder map keyed by absolute lockfile path. Same-process
 * re-entrancy: when two adapters in this process target the same
 * `<storageDir>/<sessionId>/.lock`, the second `acquireSessionLock`
 * call shares the first one's handle via refcount rather than spinning
 * on EEXIST against a file we ourselves planted.
 *
 * Multi-process safety is unaffected — the on-disk `.lock` file is the
 * truth-of-record. This map is purely a same-process optimization +
 * correctness fix for the "two registries instances in one PID"
 * scenario which would otherwise deadlock against itself.
 */
interface Holder {
  refCount: number
  released: boolean
}
const processHolders = new Map<string, Holder>()

/** Acquired session lock — the only public surface returned by
 *  {@link acquireSessionLock}. Holds the path + an `released` flag for
 *  idempotent release. */
export interface SessionLock {
  /** Best-effort unlink. Idempotent — second call is a no-op.
   *  NO-THROW. */
  release(): Promise<void>
}

/** Options for {@link acquireSessionLock}. All optional — sensible
 *  defaults match the disk-store's expected workload. */
export interface AcquireSessionLockOpts {
  /** Hard upper bound on acquisition wall time, in ms. Default
   *  {@link DEFAULT_LOCK_TIMEOUT_MS}. `0` means "try once + fail
   *  immediately if contended" (useful for tests + best-effort
   *  background sweeps). */
  readonly timeoutMs?: number
  /** Sleep between retries while waiting for a contended lock, in ms.
   *  Default {@link DEFAULT_LOCK_RETRY_INTERVAL_MS}. */
  readonly retryIntervalMs?: number
  /** Age threshold (ms) at which an existing lockfile is treated as
   *  stale (crashed process) and reclaimed. Default
   *  {@link DEFAULT_LOCK_STALE_THRESHOLD_MS}. */
  readonly staleThresholdMs?: number
  /** Clock seam — tests pass a deterministic source. Default
   *  `Date.now`. */
  readonly now?: () => number
}

/** Same `[A-Za-z0-9_-]` allowlist the disk-store uses for `safeId`.
 *  Kept here as a private duplicate so file-lock has no cross-file
 *  coupling — the disk-store imports `acquireSessionLock` but the
 *  lock module imports nothing from the disk-store. */
const safeId = (sessionId: string): string => {
  let out = ""
  for (const ch of sessionId) {
    const safe = /^[A-Za-z0-9_-]$/.test(ch)
    out += safe ? ch : "_"
  }
  return out.length === 0 ? "_" : out
}

/** Best-effort `mkdir -p`. NO-THROW. Returns `true` iff the directory
 *  exists (or was created) at the end. */
const ensureDir = async (path: string): Promise<boolean> => {
  try {
    await mkdir(path, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** Best-effort unlink. NO-THROW. Used both by the stale-reap path and
 *  by {@link SessionLock.release}. */
const unlinkSafe = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch {
    // ENOENT / EBUSY / EPERM — nothing actionable; the lock is either
    // already gone or held by someone we can't displace.
  }
}

/** Read the lockfile's mtime in ms. Returns `null` when the file is
 *  missing or unreadable (treated as "not stale, retry"). */
const readMtimeMs = async (path: string): Promise<number | null> => {
  try {
    const st = await stat(path)
    return st.mtimeMs
  } catch {
    return null
  }
}

/** Sleep helper using `setTimeout`. The lock module deliberately does
 *  NOT depend on a clock-port for the SLEEP (tests that need
 *  deterministic retry must use `retryIntervalMs: 0` + a small
 *  `timeoutMs`). The `now` clock-seam is independent and gates the
 *  outer wall-clock budget. */
const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms))

/** Try one exclusive-create. Returns:
 *    - `"acquired"` on success (the caller owns the lockfile);
 *    - `"exists"` on EEXIST (contention — retry path);
 *    - `"failed"` on any other filesystem error (give up). */
type ExclusiveCreateResult = "acquired" | "exists" | "failed"

const tryExclusiveCreate = async (
  lockPath: string,
  pid: number,
  acquiredAt: number,
): Promise<ExclusiveCreateResult> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    // `wx` ≡ O_CREAT | O_EXCL | O_WRONLY. On EEXIST the open call
    // throws with `code === "EEXIST"`. mode 0o600 keeps the body
    // readable only by the owning user (the body is diagnostic; the
    // exclusive-create itself carries the mutual-exclusion contract).
    handle = await open(lockPath, "wx", 0o600)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EEXIST") return "exists"
    return "failed"
  }
  // Best-effort body write — diagnostic only. Failure does NOT
  // invalidate the lock (we already own it).
  try {
    const body = JSON.stringify({ pid, acquiredAt })
    await handle.writeFile(body, { encoding: "utf8" })
  } catch {
    // Body write failure: still acquired.
  }
  try {
    await handle.close()
  } catch {
    // Close failure: still acquired; the kernel will reclaim the fd
    // on process exit. Lock contract is the file's existence, not
    // the fd.
  }
  return "acquired"
}

/** One iteration of the acquire-or-wait loop. Returns:
 *    - `"acquired"`     → caller owns the lock + holder map registered.
 *    - `"failed"`       → unrecoverable fs error.
 *    - `"retry"`        → loop again (after sleeping).
 *    - `"timeout"`      → caller budget exhausted.
 *
 *  Extracted from {@link acquireSessionLock} to keep the public fn
 *  under the biome cognitive-complexity ceiling. The state machine
 *  lives ONLY here. */
type LoopStep = "acquired" | "failed" | "retry" | "timeout"

interface LoopCtx {
  lockPath: string
  pid: number
  start: number
  timeoutMs: number
  staleThresholdMs: number
  now: () => number
}

const loopOnce = async (ctx: LoopCtx): Promise<LoopStep> => {
  const result = await tryExclusiveCreate(ctx.lockPath, ctx.pid, ctx.now())
  if (result === "acquired") {
    processHolders.set(ctx.lockPath, { refCount: 1, released: false })
    return "acquired"
  }
  if (result === "failed") return "failed"
  // EEXIST — consider stale-reap, then check budget.
  const mtimeMs = await readMtimeMs(ctx.lockPath)
  if (mtimeMs !== null && ctx.now() - mtimeMs >= ctx.staleThresholdMs) {
    await unlinkSafe(ctx.lockPath)
    return "retry"
  }
  return ctx.now() - ctx.start >= ctx.timeoutMs ? "timeout" : "retry"
}

/**
 * Acquire a per-session lockfile under
 * `<storageDir>/<sanitized-sessionId>/.lock`.
 *
 * Returns the {@link SessionLock} on success, or `null` when the lock
 * could not be acquired within `timeoutMs` (contention) or when the
 * filesystem is unusable (missing dir, perm denied, ENOSPC, etc).
 *
 * NO-THROW.
 */
export const acquireSessionLock = async (
  storageDir: string,
  sessionId: string,
  opts: AcquireSessionLockOpts = {},
): Promise<SessionLock | null> => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS
  const staleThresholdMs = opts.staleThresholdMs ?? DEFAULT_LOCK_STALE_THRESHOLD_MS
  const now = opts.now ?? Date.now

  const sessionDir = join(storageDir, safeId(sessionId))
  const lockPath = join(sessionDir, LOCK_FILENAME)

  if (!(await ensureDir(sessionDir))) {
    // Filesystem unusable — the disk-store's higher layer falls back
    // to memory-only.
    return null
  }

  // Same-process re-entrancy: if THIS pid already holds the lock for
  // this exact path, bump the refcount + hand out a sibling handle.
  const sameProcess = processHolders.get(lockPath)
  if (sameProcess !== undefined) {
    sameProcess.refCount += 1
    return makeLock(lockPath)
  }

  const pid = typeof process !== "undefined" && typeof process.pid === "number" ? process.pid : 0
  const ctx: LoopCtx = {
    lockPath,
    pid,
    start: now(),
    timeoutMs,
    staleThresholdMs,
    now,
  }

  while (true) {
    const step = await loopOnce(ctx)
    if (step === "acquired") return makeLock(lockPath)
    if (step === "failed" || step === "timeout") return null
    // step === "retry": sleep then loop. With `retryIntervalMs === 0`
    // this is a pure microtask yield.
    await sleep(retryIntervalMs)
  }
}

/** Construct the {@link SessionLock} returned from a successful
 *  acquire (or a same-process re-entry). Holds a single bool guard so
 *  two `release()` calls on the SAME handle are idempotent. The
 *  refcounted process-level holder governs the actual unlink: only
 *  the last release physically removes the lockfile. */
const makeLock = (lockPath: string): SessionLock => {
  let released = false
  return {
    async release(): Promise<void> {
      if (released) return
      released = true
      const holder = processHolders.get(lockPath)
      if (holder === undefined) {
        // Holder map already cleared by an external hand (clearProcessHolders
        // in test reset, or a race with another release). Treat as
        // already-released — physical unlink may have happened already.
        return
      }
      holder.refCount -= 1
      if (holder.refCount > 0) {
        // Sibling handles still active — defer the physical unlink to
        // the last one out.
        return
      }
      if (holder.released) return
      holder.released = true
      processHolders.delete(lockPath)
      await unlinkSafe(lockPath)
    },
  }
}

/** Test-only escape hatch: reset the process-local holder map. Used
 *  by suites that simulate "fresh process restart" without spawning a
 *  real child. NOT exported from the slice barrel. */
export const __resetProcessHolders = (): void => {
  processHolders.clear()
}
