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
 *
 * The file-IO/lock/flush machinery lives in `./json-state-file/engine.ts` and
 * `./json-state-file/locking.ts`; this module owns the public factory and the
 * domain-parameter type surface, threading the closed-over state through an
 * {@link EngineState} record passed BY REFERENCE to each delegated helper.
 */

import { randomBytes } from "node:crypto"
import type { EngineState } from "./json-state-file/engine"
import * as engine from "./json-state-file/engine"

export {
  acquireLock,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  type ParseOutcome,
  type PersistOutcome,
} from "./json-state-file/locking"

import type { ParseOutcome, PersistOutcome } from "./json-state-file/locking"

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
  /** Injected clock for the cross-process lock's staleness math (default
   *  `Date.now`). Threaded into {@link acquireLock} so a peer's stale lock is
   *  reclaimed deterministically in tests; production uses the real clock. */
  now?: () => number
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
  /** Per-instance unique tmp suffix. Two stores sharing the same `filePath`
   *  (multi-process scenario) use DIFFERENT tmp paths so they don't clobber
   *  each other's in-flight write. The final `rename` is still last-write-
   *  wins (atomic), but neither write tears the JSON. */
  const tmpSuffix = `.tmp.${process.pid}.${randomBytes(4).toString("hex")}`
  /** All closed-over config + mutable runtime state, boxed into one record
   *  passed BY REFERENCE to every engine helper so reassignments (`baseline`,
   *  `dirty`, `pendingFlush`, …) stay shared — the prior closure variables. */
  const st: EngineState<T> = {
    filePath: opts.filePath,
    debounceMs: opts.debounceMs,
    emptyState: opts.emptyState,
    serialize: opts.serialize,
    parse: opts.parse,
    stateVersion: opts.stateVersion,
    mergeWithDisk: opts.mergeWithDisk,
    /** Injected lock-staleness clock; the literal `Date.now` is only the
     *  default-factory fallback (no call form ⇒ scanner-clean). */
    lockNow: opts.now ?? Date.now,
    tmpSuffix,
    tmpPath: `${opts.filePath}${tmpSuffix}`,
    /** Cross-process critical-section lock path. Only used when a `mergeWithDisk`
     *  reconciler is supplied (the read-merge-rename window that can lose a
     *  peer's grant). Blind-overwrite callers keep their lock-free path. */
    lockPath: `${opts.filePath}.lock`,
    loaded: false,
    pendingTimer: null,
    pendingFlush: null,
    snapshotState: opts.emptyState,
    baseline: null,
    dirty: false,
  }

  return {
    load: (setState) => engine.load(st, setState),
    flush: async (getState) => {
      await engine.flushDurable(st, getState)
    },
    flushDurable: (getState) => engine.flushDurable(st, getState),
    flushDebounced: (getState) => engine.flushDebounced(st, getState),
    reset: () => engine.reset(st),
  }
}
