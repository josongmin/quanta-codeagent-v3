import { errMessage, writeStderr } from "@/shared"
/**
 * Engine internals for {@link createJsonStateFile} (extracted from
 * `json-state-file.ts` to keep the factory body under the god-function ceiling).
 *
 * Every helper here is behavior-identical to the prior in-factory closure body;
 * the closed-over mutable state and immutable config are threaded through a
 * single mutable {@link EngineState} record passed BY REFERENCE, so a reassign
 * (`st.baseline = …`, `st.dirty = …`) mutates the same object the factory and
 * the other helpers see — exactly as the shared closure variables did.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { acquireLock, type ParseOutcome, type PersistOutcome, releaseLock } from "./locking"

const stderrWarn = (msg: string): void => {
  writeStderr(`[quanta] permission-store: ${msg}\n`)
}

const PERSISTED: PersistOutcome = Object.freeze({ durable: true })

/** Mutable engine state + immutable config, threaded BY REFERENCE through every
 *  helper so reassignments (`baseline`, `dirty`, `pendingFlush`, …) are visible
 *  across the factory and all delegated methods — the closure variables, boxed. */
export interface EngineState<T> {
  // ── immutable config (captured once at construction) ──────────────────────
  readonly filePath: string
  readonly debounceMs: number
  readonly emptyState: () => T
  readonly serialize: (state: T) => string
  readonly parse: (raw: unknown) => ParseOutcome<T>
  readonly stateVersion: number
  readonly mergeWithDisk:
    | ((args: { onDisk: T | null; inMemory: T; baseline: T | null }) => T)
    | undefined
  readonly lockNow: () => number
  readonly lockTimeoutMs: number
  readonly tmpSuffix: string
  readonly tmpPath: string
  readonly lockPath: string
  // ── mutable runtime state (the boxed closure variables) ───────────────────
  loaded: boolean
  pendingTimer: ReturnType<typeof setTimeout> | null
  pendingFlush: Promise<PersistOutcome> | null
  /** Snapshot getter captured at the time a flush is scheduled, so a debounced
   *  or queued write serializes the LATEST state at write time. */
  snapshotState: () => T
  /** The state this instance last loaded-from / persisted-to disk. Drives the
   *  3-way merge (peer-added vs locally-deleted). `null` until first load/write
   *  resolves. */
  baseline: T | null
  /** True ⇨ a mutation since the last successful write is awaiting flush. */
  dirty: boolean
}

/** Route a fire-and-forget write's rejection to the same stderr-warn surface
 *  the synchronous write path uses, so a rejected `enqueueWrite()` (e.g. with
 *  `debounceMs:0` in tests) can never surface as an unhandled rejection.
 *  `writeToDisk` already swallows its own IO errors, so this is a defensive
 *  backstop for the promise-chain itself — the happy path is unaffected. */
export const swallowWriteRejection =
  (filePath: string) =>
  (e: unknown): void => {
    const message = errMessage(e)
    stderrWarn(`flush failed (${filePath}): ${message}`)
  }

/** Silent re-read used by the merge path (NOT load). Returns the parsed
 *  on-disk state, or `null` when the file is absent OR unreadable OR corrupt
 *  OR a version/shape mismatch. Crucially this NEVER quarantines and NEVER
 *  throws: a peer process mid-rename, a corrupt peer file, or a future-schema
 *  peer must NOT wipe our in-memory state nor crash our flush — we simply
 *  fall back to writing our own state (`null` ⇒ merge sees no disk records).
 *  The real `load()` path keeps its quarantine/sidecar behavior intact. */
export const rereadForMerge = async <T>(st: EngineState<T>): Promise<T | null> => {
  if (st.mergeWithDisk === undefined) return null
  let raw: string
  try {
    raw = await readFile(st.filePath, "utf8")
  } catch {
    return null // absent (first write) or unreadable — fall back to our state.
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null // corrupt peer file — do NOT let it wipe us, do NOT crash.
  }
  const outcome = st.parse(parsed)
  return outcome.kind === "ok" ? outcome.state : null
}

/**
 * Atomic write: write to per-instance `.tmp.<pid>.<rand>`, then `rename`
 * over the final path. Avoids torn-write on crash AND prevents two
 * processes from clobbering each other's tmp file. On the unhappy path
 * the `.tmp` is unlinked so a crashed previous attempt can never linger.
 *
 * Concurrency:
 *   - Intra-process: serialized externally via {@link enqueueWrite} so two
 *     back-to-back mutations never `rename` over each other.
 *   - Multi-process: merge-enabled stores hold the advisory lock across the
 *     read-merge-rename window. Failure to acquire it is a typed non-durable
 *     outcome; the engine never writes outside the protected section.
 */
export const writeToDisk = async <T>(st: EngineState<T>): Promise<PersistOutcome> => {
  // Cross-process lock ONLY guards the merge path's read-merge-rename window
  // (the lost-update TOCTOU). Blind-overwrite callers stay lock-free.
  const useLock = st.mergeWithDisk !== undefined
  let locked = false
  try {
    await mkdir(dirname(st.filePath), { recursive: true })
    if (useLock) {
      locked = await acquireLock(st.lockPath, st.tmpSuffix, st.lockNow, st.lockTimeoutMs)
      if (!locked) {
        const reason = "cross-process lock unavailable"
        stderrWarn(`flush blocked (${st.filePath}): ${reason}`)
        return { durable: false, reason }
      }
    }
    const inMemory = st.snapshotState()
    // Read-reconcile-MERGE: fold any peer-written records on disk into our
    // payload so a concurrent flush is last-write-MERGE, not -WINS. Absent
    // mergeWithDisk ⇒ legacy blind-overwrite (identical bytes). Single
    // process ⇒ onDisk deep-equals baseline ⇒ merge is identity (see law).
    // The reread + rename below run UNDER the lock so a peer cannot slip a
    // write between our read and our rename (the silent lost-grant).
    const merged =
      st.mergeWithDisk === undefined
        ? inMemory
        : st.mergeWithDisk({ onDisk: await rereadForMerge(st), inMemory, baseline: st.baseline })
    const payload = st.serialize(merged)
    await writeFile(st.tmpPath, payload, "utf8")
    await rename(st.tmpPath, st.filePath)
    // The merged state is now what's on disk → it becomes our new baseline so
    // the next 3-way merge diffs against what we actually persisted.
    st.baseline = merged
    if (locked) await releaseLock(st.lockPath)
    return PERSISTED
  } catch (e) {
    if (locked) await releaseLock(st.lockPath)
    const message = errMessage(e)
    stderrWarn(`flush failed (${st.filePath}): ${message}`)
    // Best-effort cleanup: remove a partial `.tmp` so the next write
    // starts from a clean slate (no orphan-tmp accumulation).
    try {
      await unlink(st.tmpPath)
    } catch {
      // tmp may not exist — that's fine.
    }
    // In-memory state stays authoritative; the caller learns the bytes did
    // NOT reach disk via the typed outcome (audit L8 M5/M6).
    return { durable: false, reason: message }
  }
}

/**
 * Serialize writes through `pendingFlush`. A second mutation that arrives
 * while the first is in flight does NOT race a second `rename` — it queues
 * to run after the in-flight one resolves. Returns the promise of the
 * write that captured this mutation, so callers awaiting `flush()` see
 * their bytes hit disk.
 *
 * Behavior:
 *   - dirty + idle ⇒ start a fresh write, clear dirty.
 *   - dirty + in-flight ⇒ chain a new write after the current one
 *     (captures the latest state on the chained `writeToDisk` callback).
 *   - clean + in-flight ⇒ just return the in-flight promise (no double-write).
 *   - clean + idle ⇒ no-op (returns resolved promise).
 */
export const enqueueWrite = <T>(st: EngineState<T>): Promise<PersistOutcome> => {
  if (!st.dirty) return st.pendingFlush ?? Promise.resolve(PERSISTED)
  const prior = st.pendingFlush ?? Promise.resolve(PERSISTED)
  // Capture the dirty bit at queue time so a NEW mutation arriving while
  // we're awaiting `prior` still gets its own write (it re-sets dirty).
  st.dirty = false
  const next = prior.then(() => writeToDisk(st))
  let tracked: Promise<PersistOutcome>
  tracked = next
    .then((outcome) => {
      // Preserve retryability for the newest failed generation. If a newer
      // write is already queued, that write owns the dirty state instead.
      if (!outcome.durable && st.pendingFlush === tracked) st.dirty = true
      return outcome
    })
    .finally(() => {
      // Clear the slot ONLY if we were the most recent enqueue. A later
      // enqueue would have overwritten `pendingFlush` already.
      if (st.pendingFlush === tracked) st.pendingFlush = null
    })
  st.pendingFlush = tracked
  return tracked
}

export const flushDurable = async <T>(
  st: EngineState<T>,
  getState: () => T,
): Promise<PersistOutcome> => {
  st.snapshotState = getState
  if (st.pendingTimer !== null) {
    clearTimeout(st.pendingTimer)
    st.pendingTimer = null
  }
  // First-persist barrier: if nothing has ever reached disk (baseline null),
  // an explicit flushDurable must ATTEMPT the write — otherwise enqueueWrite's
  // `!dirty` short-circuit returns {durable:true} without touching disk, so a
  // read-only/unwritable target would falsely report success (audit L8 M5/M6).
  // Once a baseline exists, normal dirty-tracking holds (idempotent flushes
  // stay no-ops so repeated/clean flushes don't bump mtime).
  if (st.baseline === null) st.dirty = true
  // If a debounced write was queued but not yet started, run it now
  // (combined with any new mutations since). Also waits on any in-flight
  // write so `await flush()` is a true "bytes are durable" barrier — and
  // returns whether those bytes actually reached disk (audit L8 M5/M6).
  return enqueueWrite(st)
}

export const flushDebounced = <T>(st: EngineState<T>, getState: () => T): void => {
  st.snapshotState = getState
  st.dirty = true
  if (st.debounceMs <= 0) {
    // Tests with debounceMs:0 still serialize through the queue — fixes
    // the prior "fire-and-forget hits a deleted tmpdir during teardown"
    // noise by ensuring `await flush()` drains all queued writes.
    enqueueWrite(st).catch(swallowWriteRejection(st.filePath))
    return
  }
  if (st.pendingTimer !== null) clearTimeout(st.pendingTimer)
  st.pendingTimer = setTimeout(() => {
    st.pendingTimer = null
    enqueueWrite(st).catch(swallowWriteRejection(st.filePath))
  }, st.debounceMs)
  // Don't keep the event loop alive solely for the flush.
  if (typeof (st.pendingTimer as { unref?: () => void }).unref === "function") {
    ;(st.pendingTimer as { unref?: () => void }).unref?.()
  }
}

/** Quarantine bytes to a versioned sidecar (`.corrupt`, `.unsupported-vN`).
 *  Best-effort — if the sidecar write fails we keep going with an empty
 *  state in memory. */
const quarantine = async <T>(st: EngineState<T>, suffix: string, raw: string): Promise<void> => {
  try {
    await writeFile(`${st.filePath}.${suffix}`, raw, "utf8")
  } catch {
    // best-effort — the in-memory state is still safe.
  }
}

/** Read bytes from disk OR signal "not present yet" via `null`. Surfaces
 *  unexpected IO errors (permission denied, EISDIR, …) to the caller as a
 *  warning rather than crashing the process. */
const readRawState = async <T>(st: EngineState<T>): Promise<string | null> => {
  try {
    return await readFile(st.filePath, "utf8")
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null
    const message = errMessage(e)
    stderrWarn(`load failed (${st.filePath}): ${message} — starting empty`)
    return null
  }
}

/** Parse bytes already known to exist. Splits the three terminal cases so
 *  `load()` stays well under the complexity ceiling. */
const parseRawState = async <T>(st: EngineState<T>, raw: string): Promise<T | null> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const message = errMessage(e)
    stderrWarn(`state file corrupt JSON (${st.filePath}): ${message} — starting empty`)
    await quarantine(st, "corrupt", raw)
    return null
  }
  const outcome = st.parse(parsed)
  if (outcome.kind === "ok") return outcome.state
  if (outcome.kind === "version-mismatch") {
    stderrWarn(
      `state file schema mismatch (${st.filePath}) — found version=${String(outcome.foundVersion)}, expected ${st.stateVersion} — starting empty (quarantined)`,
    )
    await quarantine(st, `unsupported-v${String(outcome.foundVersion)}`, raw)
    return null
  }
  stderrWarn(`state file shape invalid (${st.filePath}): ${outcome.reason} — starting empty`)
  return null
}

export const load = async <T>(st: EngineState<T>, setState: (state: T) => void): Promise<void> => {
  if (st.loaded) return
  st.loaded = true
  const raw = await readRawState(st)
  if (raw === null) {
    const cold = st.emptyState()
    // Establish a baseline even on cold start: we KNOW we loaded an empty
    // file, so any record that later appears on disk is peer-added (adopt),
    // and any record we never set was never ours to delete.
    st.baseline = cold
    setState(cold)
    return
  }
  const validated = await parseRawState(st, raw)
  const initial = validated ?? st.emptyState()
  st.baseline = initial
  setState(initial)
}

export const reset = async <T>(st: EngineState<T>): Promise<void> => {
  if (st.pendingTimer !== null) {
    clearTimeout(st.pendingTimer)
    st.pendingTimer = null
  }
  // Wait on any in-flight write so we don't unlink mid-rename — without
  // this, a flush queued by a recent set*() could resurrect the file we
  // just deleted (Heisenbug seen in stress tests).
  if (st.pendingFlush !== null) {
    try {
      await st.pendingFlush
    } catch {
      // Surfaced via stderrWarn already.
    }
  }
  st.loaded = false
  st.baseline = null
  try {
    await unlink(st.filePath)
  } catch {
    // best-effort — file may not exist yet.
  }
}
