/**
 * External-agent import log persistence (ADR-0038, Cluster D Feature 4).
 *
 * Mirrors Codex's `external_agent_session_imports.json`. Writes use a
 * sidecar lock file so concurrent imports cannot race; collision raises
 * {@link ImportLogBusyError} rather than silently merging.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { QuantaError } from "@/shared"
import type { ImportLog, ImportLogEntry } from "./types"

/** Default log file location under `~/.quanta`. Caller-supplied `homeDir`
 *  lets tests redirect to a tmpdir. */
export const importLogPath = (homeDir: string): string =>
  join(homeDir, ".quanta", "external_agent_session_imports.json")

const lockPath = (homeDir: string): string => `${importLogPath(homeDir)}.lock`

/** Thrown when a writer cannot acquire the log file lock — surfaces the
 *  conflict to the caller instead of overwriting. */
export class ImportLogBusyError extends QuantaError {
  readonly lockFile: string
  constructor(lockFile: string) {
    super("import_log_busy", `Import log lock held: ${lockFile}.`)
    this.lockFile = lockFile
  }
}

/**
 * Default staleness window (T11 / L9 M13). A lock older than this AND whose
 * recorded owner pid is no longer alive is considered orphaned by a crashed
 * writer and is reclaimable. Chosen well ABOVE the read-modify-write window
 * of a healthy append (a few fs ops, sub-millisecond) so a live writer is
 * never mistaken for a crashed one. Callers can override via
 * {@link ReclaimOptions.staleAfterMs}.
 */
export const DEFAULT_LOCK_STALE_MS = 5 * 60_000

/**
 * Knobs for stale-lock reclaim. All injected so the recovery state machine is
 * testable without sleeping and the staleness threshold is EXPLICIT (never a
 * hidden magic number). A lock is reclaimed iff BOTH:
 *   - its file mtime is older than `staleAfterMs` (bounded age), AND
 *   - `isOwnerAlive(pid)` is false (the recorded owner process is gone).
 * A lock that is fresh OR whose owner is still alive is HONORED (BUSY) —
 * reclaim never defeats a live concurrent writer.
 */
export interface ReclaimOptions {
  /** Wall-clock source (ms since epoch). Defaults to `Date.now`. */
  readonly now?: () => number
  /** Age past which a dead-owner lock is reclaimable. Defaults to
   *  {@link DEFAULT_LOCK_STALE_MS}. */
  readonly staleAfterMs?: number
  /** Liveness probe for the lock's recorded owner pid. Defaults to a real
   *  `process.kill(pid, 0)` check (signal 0 = existence test). An
   *  unparseable / absent pid is treated as NOT alive. */
  readonly isOwnerAlive?: (pid: number) => boolean
}

/** Real owner-liveness probe — `process.kill(pid, 0)` throws ESRCH for a dead
 *  pid, EPERM for one we may not signal (alive but foreign). */
const defaultIsOwnerAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM ⇒ the process exists but is owned by another user → still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Parse the pid recorded in a lock body. Returns `undefined` for an
 *  unparseable body (legacy / corrupt lock) so the caller treats the owner
 *  as not-alive. */
const parseLockPid = (body: string): number | undefined => {
  const n = Number.parseInt(body.trim(), 10)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * If `lock` is an orphaned lock from a crashed writer, remove it so a fresh
 * `wx` acquire can succeed. Returns true iff the lock was reclaimed. A lock is
 * reclaimable ONLY when it is BOTH older than `staleAfterMs` AND its recorded
 * owner pid is not alive — preserving cross-process serialization for any
 * live writer.
 */
const tryReclaimStaleLock = async (lock: string, opts: ReclaimOptions): Promise<boolean> => {
  const now = opts.now ?? Date.now
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_LOCK_STALE_MS
  const isOwnerAlive = opts.isOwnerAlive ?? defaultIsOwnerAlive

  let mtimeMs: number
  let body: string
  try {
    const [st, raw] = await Promise.all([stat(lock), readFile(lock, "utf8")])
    mtimeMs = st.mtimeMs
    body = raw
  } catch {
    // Lock vanished between the failed acquire and here → race won by the
    // other side; let the caller retry the acquire.
    return true
  }
  const ageMs = now() - mtimeMs
  if (ageMs < staleAfterMs) return false // fresh → honor (possibly live writer)
  const pid = parseLockPid(body)
  // Unparseable pid ⇒ treat as dead; otherwise probe liveness.
  if (pid !== undefined && isOwnerAlive(pid)) return false // owner alive → honor
  // Stale + dead owner → orphaned. Remove it (force: tolerate a concurrent
  // reclaim having already deleted it).
  await rm(lock, { force: true })
  return true
}

/** Read the log. Missing file ⇒ empty log (version 1). */
export const loadImportLog = async (homeDir: string): Promise<ImportLog> => {
  const path = importLogPath(homeDir)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { version: 1, entries: [] }
    throw err
  }
  const parsed = JSON.parse(raw) as unknown
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error(`Malformed import log at ${path}`)
  }
  return parsed as ImportLog
}

/** Append one entry to the log, atomically (write-temp + rename). Holds an
 *  exclusive lock for the read-modify-write window; concurrent writers get
 *  {@link ImportLogBusyError}.
 *
 *  T11 / L9 M13: if the existing lock is ORPHANED by a crashed writer (older
 *  than `reclaim.staleAfterMs` AND its owner pid is dead), it is reclaimed
 *  once and the acquire retried — so a single crash can no longer wedge every
 *  future import. A fresh OR live-owner lock is still honored (BUSY). */
export const appendImportLog = async (
  homeDir: string,
  entry: ImportLogEntry,
  reclaim: ReclaimOptions = {},
): Promise<void> => {
  const path = importLogPath(homeDir)
  await mkdir(dirname(path), { recursive: true })

  const lock = lockPath(homeDir)
  // Acquire — wx flag fails if lock exists. On collision, attempt a bounded
  // stale-lock reclaim ONCE and retry; if the lock is still held (fresh or
  // live owner), surface BUSY.
  const acquire = async (): Promise<boolean> => {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
      throw err
    }
  }
  if (!(await acquire())) {
    const reclaimed = await tryReclaimStaleLock(lock, reclaim)
    if (!reclaimed || !(await acquire())) {
      throw new ImportLogBusyError(lock)
    }
  }

  try {
    const current = await loadImportLog(homeDir)
    const next: ImportLog = {
      version: 1,
      entries: [...current.entries, entry],
    }
    const tmp = `${path}.tmp.${process.pid}.${crypto.randomUUID().slice(0, 8)}`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    await rename(tmp, path)
  } finally {
    await rm(lock, { force: true })
  }
}
