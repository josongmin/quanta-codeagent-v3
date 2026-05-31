import { errMessage, writeStderr } from "@/shared"
/**
 * Generic JSON-state-file persistence engine (ADR-0046, extracted from
 * permission-store.ts #3).
 *
 * Owns the file-side machinery that is independent of WHAT is stored:
 *   - atomic write (per-instance `.tmp.<pid>.<rand>` + `rename`)
 *   - debounced flush (one `rename` per debounce window)
 *   - write serialization (`enqueueWrite` — burst-collapse, no torn rename)
 *   - quarantine sidecars (`.corrupt`, `.unsupported-vN`)
 *   - load → parse → validate, soft-failing to an empty state
 *   - test seam: `reset()` (drain in-flight write, drop file)
 *
 * The state DOMAIN (per-thread perms / per-host modes / denial ledger) lives
 * in the caller. This helper is parameterised by:
 *   - `emptyState()`        — the cold-start value.
 *   - `serialize(state)`    — the bytes to write (caller owns canonical order).
 *   - `parse(raw)`          — a `ParseOutcome<T>` so the right sidecar is chosen.
 *
 * Slice rules unchanged: pure `node:`-stdlib only. NO `@/storage`, NO
 * `@/memory` — `@/permission` keeps its dependency surface minimal.
 *
 * Failure model (preserved verbatim from the prior god-store):
 *   - Missing file at load    → start empty, no warning (cold-start).
 *   - Corrupt JSON            → start empty + `.corrupt` sidecar; never crash.
 *   - Schema-version mismatch → start empty + `.unsupported-vN` sidecar.
 *   - Write failure           → swallowed + warned (in-memory is authoritative).
 *   - Orphan `.tmp`           → unlinked on the unhappy write path.
 *
 * Concurrency:
 *   - Single in-process: writes serialize through `pendingFlush` so a burst of
 *     mutations produces at most ONE rename per debounce window.
 *   - Multi-process: per-instance tmp suffix avoids tmp clobber. The final
 *     rename is atomic (never torn). When a `mergeWithDisk` reconciler is
 *     supplied, every flush RE-READS the on-disk file and merges it with the
 *     in-memory state before serializing → last-write-MERGE, not -WINS, so a
 *     peer's grants/denials written between our load and our flush survive.
 *     (Still not a substitute for an OS lock under pathological interleaving —
 *     a true lockfile remains the v4 follow-up — but it removes the silent
 *     clobber of grants/denials, which is the security-critical loss.)
 */

import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

const stderrWarn = (msg: string): void => {
  writeStderr(`[quanta] permission-store: ${msg}\n`)
}

/** Route a fire-and-forget write's rejection to the same stderr-warn surface
 *  the synchronous write path uses, so a rejected `enqueueWrite()` (e.g. with
 *  `debounceMs:0` in tests) can never surface as an unhandled rejection.
 *  `writeToDisk` already swallows its own IO errors, so this is a defensive
 *  backstop for the promise-chain itself — the happy path is unaffected. */
const swallowWriteRejection =
  (filePath: string) =>
  (e: unknown): void => {
    const message = errMessage(e)
    stderrWarn(`flush failed (${filePath}): ${message}`)
  }

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

const PERSISTED: PersistOutcome = Object.freeze({ durable: true })

export interface JsonStateFileOptions<T> {
  /** Absolute path of the JSON state file. */
  filePath: string
  /** Debounce window in ms. 0 ⇒ every mutation flushes immediately. */
  debounceMs: number
  /** Cold-start value (missing file / corrupt / unsupported version). */
  emptyState: () => T
  /** Serialize the live state to the bytes written to disk. The caller owns
   *  canonical key ordering so structurally-equal payloads are byte-identical. */
  serialize: (state: T) => string
  /** Validate parsed JSON, returning a distinguished outcome. */
  parse: (raw: unknown) => ParseOutcome<T>
  /** Expected schema version — only used in the version-mismatch warning. */
  stateVersion: number
  /** Read-reconcile-MERGE hook (ADR-0046 follow-up: multi-process clobber fix).
   *
   *  When supplied, EVERY flush re-reads the current on-disk state and merges
   *  it with the live in-memory state BEFORE serializing — turning concurrent
   *  flushes from last-write-WINS into last-write-MERGE so a peer process's
   *  grants/denials written between our `load()` and our flush are never
   *  blindly clobbered.
   *
   *  Args:
   *    - `onDisk`   — the freshly re-read + parsed on-disk state, or `null`
   *                   when the file is absent (first write) OR unreadable /
   *                   corrupt (we refuse to let a corrupt peer file wipe us).
   *    - `inMemory` — this instance's live state (the authoritative base).
   *    - `baseline` — the state this instance last persisted/loaded, so the
   *                   merge can do a 3-way diff (peer-added vs locally-deleted)
   *                   instead of a lossy union. `null` until the first
   *                   successful load/write.
   *
   *  MUST be a pure function and MUST satisfy the single-process IDENTITY law:
   *  when `onDisk` deep-equals `baseline` (i.e. WE are the only writer), the
   *  result MUST equal `inMemory` byte-for-byte so the single-process path is
   *  unchanged. When absent, the engine falls back to writing `inMemory`. */
  mergeWithDisk?: (args: { onDisk: T | null; inMemory: T; baseline: T | null }) => T
}

/**
 * File-backed JSON state with debounced atomic flush. The caller supplies the
 * live state via {@link JsonStateFile.markDirty} (which schedules a debounced
 * flush) and reads it back through whatever domain accessors it composes; this
 * helper only owns persistence.
 */
export interface JsonStateFile<T> {
  /** Initialize from disk into `setState`. Safe to call multiple times — the
   *  second call is a no-op once the first `load()` has resolved. */
  load(setState: (state: T) => void): Promise<void>
  /** Flush the current state (via `getState`) to disk now. A true "bytes are
   *  durable" barrier — also drains any in-flight/queued write. Returns void
   *  for source-compatibility with existing callers; use {@link flushDurable}
   *  when you need to know whether the bytes actually reached disk. */
  flush(getState: () => T): Promise<void>
  /** Like {@link flush}, but resolves with a typed {@link PersistOutcome}:
   *  `{durable:true}` when the bytes reached disk, or `{durable:false, reason}`
   *  when the write failed (the in-memory state is still authoritative; the
   *  caller decides whether non-durability matters). Part of the store
   *  contract — persistence failure is observable, not just logged (audit
   *  L8 M5/M6). */
  flushDurable(getState: () => T): Promise<PersistOutcome>
  /** Schedule a debounced flush (the mutation just happened). */
  flushDebounced(getState: () => T): void
  /** Drain any in-flight write, then remove the file. Resets `loaded` so a
   *  subsequent `load()` re-reads from disk. */
  reset(): Promise<void>
}

export const createJsonStateFile = <T>(opts: JsonStateFileOptions<T>): JsonStateFile<T> => {
  const { filePath, debounceMs, emptyState, serialize, parse, stateVersion, mergeWithDisk } = opts
  let loaded = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let pendingFlush: Promise<PersistOutcome> | null = null
  /** Snapshot getter captured at the time a flush is scheduled, so a debounced
   *  or queued write serializes the LATEST state at write time. */
  let snapshotState: () => T = emptyState
  /** The state this instance last loaded-from / persisted-to disk. Drives the
   *  3-way merge (peer-added vs locally-deleted). `null` until first load/write
   *  resolves; the merge treats `null` baseline as "adopt all on-disk records"
   *  (we have no proof we ever deleted anything). */
  let baseline: T | null = null

  /** Per-instance unique tmp suffix. Two stores sharing the same `filePath`
   *  (multi-process scenario) use DIFFERENT tmp paths so they don't clobber
   *  each other's in-flight write. The final `rename` is still last-write-
   *  wins (atomic), but neither write tears the JSON. */
  const tmpSuffix = `.tmp.${process.pid}.${randomBytes(4).toString("hex")}`
  const tmpPath = `${filePath}${tmpSuffix}`

  /**
   * Atomic write: write to per-instance `.tmp.<pid>.<rand>`, then `rename`
   * over the final path. Avoids torn-write on crash AND prevents two
   * processes from clobbering each other's tmp file. On the unhappy path
   * the `.tmp` is unlinked so a crashed previous attempt can never linger.
   *
   * Concurrency:
   *   - Intra-process: serialized externally via {@link enqueueWrite} so two
   *     back-to-back mutations never `rename` over each other.
   *   - Multi-process: per-instance tmp suffix avoids tmp clobber; the final
   *     rename is still last-write-wins (see module comment).
   */
  /** Silent re-read used by the merge path (NOT load). Returns the parsed
   *  on-disk state, or `null` when the file is absent OR unreadable OR corrupt
   *  OR a version/shape mismatch. Crucially this NEVER quarantines and NEVER
   *  throws: a peer process mid-rename, a corrupt peer file, or a future-schema
   *  peer must NOT wipe our in-memory state nor crash our flush — we simply
   *  fall back to writing our own state (`null` ⇒ merge sees no disk records).
   *  The real `load()` path keeps its quarantine/sidecar behavior intact. */
  const rereadForMerge = async (): Promise<T | null> => {
    if (mergeWithDisk === undefined) return null
    let raw: string
    try {
      raw = await readFile(filePath, "utf8")
    } catch {
      return null // absent (first write) or unreadable — fall back to our state.
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null // corrupt peer file — do NOT let it wipe us, do NOT crash.
    }
    const outcome = parse(parsed)
    return outcome.kind === "ok" ? outcome.state : null
  }

  const writeToDisk = async (): Promise<PersistOutcome> => {
    try {
      await mkdir(dirname(filePath), { recursive: true })
      const inMemory = snapshotState()
      // Read-reconcile-MERGE: fold any peer-written records on disk into our
      // payload so a concurrent flush is last-write-MERGE, not -WINS. Absent
      // mergeWithDisk ⇒ legacy blind-overwrite (identical bytes). Single
      // process ⇒ onDisk deep-equals baseline ⇒ merge is identity (see law).
      const merged =
        mergeWithDisk === undefined
          ? inMemory
          : mergeWithDisk({ onDisk: await rereadForMerge(), inMemory, baseline })
      const payload = serialize(merged)
      await writeFile(tmpPath, payload, "utf8")
      await rename(tmpPath, filePath)
      // The merged state is now what's on disk → it becomes our new baseline so
      // the next 3-way merge diffs against what we actually persisted.
      baseline = merged
      return PERSISTED
    } catch (e) {
      const message = errMessage(e)
      stderrWarn(`flush failed (${filePath}): ${message}`)
      // Best-effort cleanup: remove a partial `.tmp` so the next write
      // starts from a clean slate (no orphan-tmp accumulation).
      try {
        await unlink(tmpPath)
      } catch {
        // tmp may not exist — that's fine.
      }
      // In-memory state stays authoritative; the caller learns the bytes did
      // NOT reach disk via the typed outcome (audit L8 M5/M6).
      return { durable: false, reason: message }
    }
  }

  /** True ⇨ a mutation since the last successful write is awaiting flush.
   *  Set by every mutating API (via markDirty/flushDebounced), cleared right
   *  before `writeToDisk` is called. Used to skip "write nothing" rewrites in
   *  `flush()` so idempotent set*() cannot bump the file's mtime. */
  let dirty = false

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
  const enqueueWrite = (): Promise<PersistOutcome> => {
    if (!dirty) return pendingFlush ?? Promise.resolve(PERSISTED)
    const prior = pendingFlush ?? Promise.resolve(PERSISTED)
    // Capture the dirty bit at queue time so a NEW mutation arriving while
    // we're awaiting `prior` still gets its own write (it re-sets dirty).
    dirty = false
    const next = prior.then(writeToDisk)
    pendingFlush = next.finally(() => {
      // Clear the slot ONLY if we were the most recent enqueue. A later
      // enqueue would have overwritten `pendingFlush` already.
      if (pendingFlush === next) pendingFlush = null
    })
    return next
  }

  const flushDurable = async (getState: () => T): Promise<PersistOutcome> => {
    snapshotState = getState
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    // First-persist barrier: if nothing has ever reached disk (baseline null),
    // an explicit flushDurable must ATTEMPT the write — otherwise enqueueWrite's
    // `!dirty` short-circuit returns {durable:true} without touching disk, so a
    // read-only/unwritable target would falsely report success (audit L8 M5/M6).
    // Once a baseline exists, normal dirty-tracking holds (idempotent flushes
    // stay no-ops so repeated/clean flushes don't bump mtime).
    if (baseline === null) dirty = true
    // If a debounced write was queued but not yet started, run it now
    // (combined with any new mutations since). Also waits on any in-flight
    // write so `await flush()` is a true "bytes are durable" barrier — and
    // returns whether those bytes actually reached disk (audit L8 M5/M6).
    return enqueueWrite()
  }

  /** Void-returning flush — source-compatible with the pre-T08 callers. */
  const flush = async (getState: () => T): Promise<void> => {
    await flushDurable(getState)
  }

  const flushDebounced = (getState: () => T): void => {
    snapshotState = getState
    dirty = true
    if (debounceMs <= 0) {
      // Tests with debounceMs:0 still serialize through the queue — fixes
      // the prior "fire-and-forget hits a deleted tmpdir during teardown"
      // noise by ensuring `await flush()` drains all queued writes.
      enqueueWrite().catch(swallowWriteRejection(filePath))
      return
    }
    if (pendingTimer !== null) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      enqueueWrite().catch(swallowWriteRejection(filePath))
    }, debounceMs)
    // Don't keep the event loop alive solely for the flush.
    if (typeof (pendingTimer as { unref?: () => void }).unref === "function") {
      ;(pendingTimer as { unref?: () => void }).unref?.()
    }
  }

  /** Quarantine bytes to a versioned sidecar (`.corrupt`, `.unsupported-vN`).
   *  Best-effort — if the sidecar write fails we keep going with an empty
   *  state in memory. */
  const quarantine = async (suffix: string, raw: string): Promise<void> => {
    try {
      await writeFile(`${filePath}.${suffix}`, raw, "utf8")
    } catch {
      // best-effort — the in-memory state is still safe.
    }
  }

  /** Read bytes from disk OR signal "not present yet" via `null`. Surfaces
   *  unexpected IO errors (permission denied, EISDIR, …) to the caller as a
   *  warning rather than crashing the process. */
  const readRawState = async (): Promise<string | null> => {
    try {
      return await readFile(filePath, "utf8")
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === "ENOENT") return null
      const message = errMessage(e)
      stderrWarn(`load failed (${filePath}): ${message} — starting empty`)
      return null
    }
  }

  /** Parse bytes already known to exist. Splits the three terminal cases so
   *  `load()` stays well under the complexity ceiling. */
  const parseRawState = async (raw: string): Promise<T | null> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      const message = errMessage(e)
      stderrWarn(`state file corrupt JSON (${filePath}): ${message} — starting empty`)
      await quarantine("corrupt", raw)
      return null
    }
    const outcome = parse(parsed)
    if (outcome.kind === "ok") return outcome.state
    if (outcome.kind === "version-mismatch") {
      stderrWarn(
        `state file schema mismatch (${filePath}) — found version=${String(outcome.foundVersion)}, expected ${stateVersion} — starting empty (quarantined)`,
      )
      await quarantine(`unsupported-v${String(outcome.foundVersion)}`, raw)
      return null
    }
    stderrWarn(`state file shape invalid (${filePath}): ${outcome.reason} — starting empty`)
    return null
  }

  const load = async (setState: (state: T) => void): Promise<void> => {
    if (loaded) return
    loaded = true
    const raw = await readRawState()
    if (raw === null) {
      const cold = emptyState()
      // Establish a baseline even on cold start: we KNOW we loaded an empty
      // file, so any record that later appears on disk is peer-added (adopt),
      // and any record we never set was never ours to delete.
      baseline = cold
      setState(cold)
      return
    }
    const validated = await parseRawState(raw)
    const initial = validated ?? emptyState()
    baseline = initial
    setState(initial)
  }

  const reset = async (): Promise<void> => {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    // Wait on any in-flight write so we don't unlink mid-rename — without
    // this, a flush queued by a recent set*() could resurrect the file we
    // just deleted (Heisenbug seen in stress tests).
    if (pendingFlush !== null) {
      try {
        await pendingFlush
      } catch {
        // Surfaced via stderrWarn already.
      }
    }
    loaded = false
    baseline = null
    try {
      await unlink(filePath)
    } catch {
      // best-effort — file may not exist yet.
    }
  }

  return { load, flush, flushDurable, flushDebounced, reset }
}
