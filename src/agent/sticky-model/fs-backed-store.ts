/**
 * Fs-backed sticky-model store (ADR-0212).
 *
 * Persists `{ mode → modelId }` to a single JSON file (default
 * `~/.quanta/sticky-model.json`) using `write-file-atomic` so a crashed
 * partial write cannot corrupt the file (the lib writes to a sibling
 * `.tmp.<rand>` and rename(2)-promotes — atomic on the same filesystem).
 *
 * No-throw public surface: ALL IO errors are caught at the seam and
 * surfaced via the typed {@link StickyModelSetResult} / {@link
 * StickyModelLoadResult} unions. The resolver (`resolver.ts`) treats an
 * `ok:false` load result as "no preference" and falls through to the
 * global default deterministically.
 *
 * Corruption posture: a load that yields invalid JSON or a non-object
 * top-level value resolves to `ok:false` (`StickyModelLoadCorruptionError`).
 * The store does NOT auto-truncate — a subsequent `set()` will overwrite
 * the corrupt file atomically, but until then the corrupt bytes stay on
 * disk for forensic inspection (matches the Codex `logs_2.sqlite`
 * retention discipline: never silently destroy user data).
 */

import { readFileSync } from "node:fs"
import { copyFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import writeFileAtomic from "write-file-atomic"
import { acquireLock, LOCK_STALE_MS, releaseLock } from "@/permission/json-state-file/locking"
import { errMessage, QuantaError, quantaHomeDir, quantaHomeDirFrom } from "@/shared"
import {
  readStickyModelFrom,
  type StickyModelKey,
  type StickyModelLoadResult,
  type StickyModelSetResult,
  type StickyModelStore,
  stickyModelKeyOf,
} from "./port"

/** The store's filename under the Quanta home. Exported so a composition root
 *  that resolves the home from an INJECTED env (`quantaHomeDirFrom`) can build
 *  the same path without re-spelling the literal. */
export const STICKY_MODEL_FILENAME = "sticky-model.json"

/** Default path: `~/.quanta/sticky-model.json`. Pure function of homedir;
 *  exposed so tests can override via the `path` option without re-deriving. */
export const defaultStickyModelPath = (): string => join(quantaHomeDir(), STICKY_MODEL_FILENAME)

/**
 * The store path derived from an INJECTED env bag (aug-27).
 *
 * Every composition root that HOLDS an `env` should use this instead of the
 * default: `quantaHomeDir()` reads the FROZEN global runtime config, so a surface
 * (or a test) that sets `QUANTA_CONFIG_DIR` after that config was first resolved
 * would keep writing to the OLD path while reading the new one — the two halves
 * must never disagree. Same precedence as the singleton
 * (`QUANTA_CONFIG_DIR ?? QUANTA_HOME ?? ~/.quanta`), just from the caller's bag.
 */
export const stickyModelPathFrom = (env: Record<string, string | undefined>): string =>
  join(quantaHomeDirFrom(env), STICKY_MODEL_FILENAME)

/** Surfaced via {@link StickyModelLoadResult.error} when the on-disk file
 *  exists but cannot be parsed as a top-level JSON object of `{ string:
 *  string }`. The store stays callable; a subsequent `set()` will overwrite. */
export class StickyModelLoadCorruptionError extends QuantaError {
  readonly path: string
  constructor(path: string, reason: string, options?: { cause?: unknown }) {
    super(
      "sticky_model_load_corrupt",
      `Sticky model store at ${JSON.stringify(path)} is corrupt: ${reason}. ` +
        `The next set() will overwrite the file atomically.`,
      options,
    )
    this.path = path
  }
}

/** Surfaced via {@link StickyModelSetResult.error} when the atomic write
 *  could not complete (permission denied, disk full, parent dir
 *  un-creatable). The store stays callable for subsequent attempts. */
export class StickyModelWriteError extends QuantaError {
  readonly path: string
  constructor(path: string, reason: string, options?: { cause?: unknown }) {
    super(
      "sticky_model_write_failed",
      `Sticky model store at ${JSON.stringify(path)} could not be written: ${reason}.`,
      options,
    )
    this.path = path
  }
}

/** Options for {@link fsBackedStickyModelStore}. */
export interface FsBackedStickyModelStoreOpts {
  /** Override the on-disk path. Defaults to
   *  {@link defaultStickyModelPath}() — `~/.quanta/sticky-model.json`. */
  readonly path?: string
  /**
   * Clock seam for the cross-process WRITE LOCK (MR-08) — its acquisition
   * deadline and its stale-holder rule both read this, nothing else does.
   *
   * Injected rather than closed over `Date.now` for the same reason the lock
   * helper itself takes the seam: the two branches that MUST be proven are "a
   * peer is alive and we time out" and "a peer died and we break its lock", and
   * both are defined purely in terms of elapsed time. Racing the real clock to
   * reach them means a 10-second test for the first and an un-reachable one for
   * the second. Production passes nothing and gets `Date.now`.
   */
  readonly now?: () => number
}

/** Suffix of the sibling lockfile guarding a read-modify-write of the store.
 *  Exported so a test (or an operator's cleanup script) names the same file the
 *  store does rather than re-spelling the literal. */
export const STICKY_MODEL_LOCK_SUFFIX = ".lock"

/** The lockfile path for a given store path: `<store>.lock`, a SIBLING of the
 *  store rather than a file inside it, so the lock exists before the store does
 *  (first-run `set`) and an operator listing `~/.quanta` sees the pair. */
export const stickyModelLockPathOf = (storePath: string): string =>
  `${storePath}${STICKY_MODEL_LOCK_SUFFIX}`

/**
 * What a locked mutation decided to do with the snapshot it was handed.
 *
 * `no-op` is a first-class outcome, not "wrote the same bytes back": `unset` on a
 * key that holds no pick must leave a machine that never had a preference with no
 * `~/.quanta/sticky-model.json` at all.
 */
type StickyMutation = (current: StickyModelLoadResult) => Readonly<Record<string, string>> | "no-op"

/**
 * Read-modify-write the store under a CROSS-PROCESS lock (MR-08).
 *
 * MEASURED DEFECT this closes. `set`/`unset` were an unlocked read-modify-write:
 * read the whole map, splice one key, atomically replace the whole file. The
 * atomic rename prevents a TORN write — it does nothing about a LOST UPDATE. Two
 * `fsBackedStickyModelStore` instances writing DIFFERENT keys concurrently (in
 * production: the CLI and the web daemon, which is exactly the "one user, one
 * preference across surfaces" arrangement this store exists to serve) both read
 * the same snapshot, both spliced their own key into it, and the second rename
 * erased the first key. Measured 30/30 rounds losing one key before this change.
 *
 * MECHANISM — {@link acquireLock}/{@link releaseLock} from
 * `@/permission/json-state-file/locking`, REUSED rather than re-implemented. That
 * helper exists for the identical problem one slice over (two processes
 * read-merge-renaming a JSON state file) and is a true leaf — it imports
 * `node:fs/promises` and nothing else. Its mechanism is the one this store wants:
 * `open(path, "wx")` (`O_CREAT|O_EXCL`) is an atomic create-if-absent, so exactly
 * one racer wins and the losers retry on a cooperative `setTimeout(1)` yield
 * rather than a CPU spin.
 *
 * The two OTHER in-repo lock helpers were considered and rejected:
 *   - `@/agent/session-resource-registry/disk-adapter/file-lock` refcounts
 *     same-process holders and hands a SECOND caller in the same PID a sibling
 *     handle instead of making it wait. The CLI and the daemon are different
 *     processes, so that would be safe in production and silently wrong in the
 *     test that proves this fix — two store instances in one test process would
 *     both "acquire" and the lost update would survive.
 *   - `@/auth/lock-file-based` carries an OAuth-token payload + TTL contract this
 *     store has no use for.
 *
 * STALE-LOCK RULE (documented, because a lock with no reclamation is a deadlock
 * waiting for a `SIGKILL`): the lockfile body is `{pid, ts}`. A holder is
 * declared dead once `now() - ts > LOCK_STALE_MS` (5s) and its lockfile is
 * unlinked so the create can be retried; when the body is unreadable — a
 * half-written or legacy lock — the file's mtime substitutes for `ts` under the
 * same threshold. 5s is orders of magnitude above the real hold here (one small
 * read + one rename, sub-millisecond), so a healthy holder never trips its own
 * check, and it bounds the wedge a `kill -9` mid-write can cause to one 5s
 * window rather than forever.
 *
 * NO-THROW, per the port contract: a lock we could not take within the helper's
 * budget, an un-creatable parent directory, and a failed write all resolve to a
 * typed {@link StickyModelWriteError}. Degrading a contended write to `ok:false`
 * (rather than the "write anyway" the permission store chooses) is the honest
 * option HERE because the session-scoped decorator above only reflects a pick the
 * durable write ACCEPTED — so a refused write leaves every display naming the
 * model the turn will actually run.
 */
const mutateUnderLock = async (
  path: string,
  now: () => number,
  mutate: StickyMutation,
): Promise<StickyModelSetResult> => {
  try {
    await mkdir(dirname(path), { recursive: true })
  } catch (cause: unknown) {
    return { ok: false, error: new StickyModelWriteError(path, errMessage(cause), { cause }) }
  }
  const lockPath = stickyModelLockPathOf(path)
  if (!(await acquireLock(lockPath, `${process.pid}`, now))) {
    return {
      ok: false,
      error: new StickyModelWriteError(
        path,
        `another process holds ${JSON.stringify(lockPath)} (stale after ${LOCK_STALE_MS}ms)`,
      ),
    }
  }
  try {
    // The AUTHORITATIVE read — inside the lock, so nothing can land between it
    // and the rename below. A pre-lock read (there is one in `unset`, to keep a
    // true no-op from creating the file) is only ever a fast path; this one
    // decides.
    const current = await readSnapshot(path)
    if (!current.ok) {
      // The `.corrupt.bak` courtesy, unchanged and now serialized: never silently
      // destroy user data. Best-effort — a backup failure (the file may be
      // genuinely gone on an ENOENT-shaped IO error) must NOT block making
      // progress on a broken store.
      try {
        await copyFile(path, `${path}.corrupt.bak`)
      } catch {
        // best-effort: nothing to preserve / unreadable — proceed with write
      }
    }
    const next = mutate(current)
    if (next === "no-op") return { ok: true }
    await writeFileAtomic(path, JSON.stringify(next, null, 2))
    return { ok: true }
  } catch (cause: unknown) {
    return { ok: false, error: new StickyModelWriteError(path, errMessage(cause), { cause }) }
  } finally {
    // Released on EVERY exit, including the throwing one — an un-released lock
    // would wedge every writer on this machine for `LOCK_STALE_MS` per attempt.
    await releaseLock(lockPath)
  }
}

/** Parse `raw` as a `{ string: string }` map. Returns `undefined` on any
 *  shape mismatch — callers convert that to a typed corruption error. Pure. */
const parseStickyJson = (raw: string): Record<string, string> | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0) return undefined
    if (typeof v !== "string" || v.length === 0) return undefined
    out[k] = v
  }
  return out
}

/** Read the file once and return a parsed snapshot OR a typed error.
 *  ENOENT is treated as an empty snapshot (the canonical first-run state),
 *  NOT a corruption error. */
const readSnapshot = async (path: string): Promise<StickyModelLoadResult> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (cause: unknown) {
    const code = (cause as { code?: unknown })?.code
    if (code === "ENOENT") {
      return { ok: true, snapshot: Object.freeze({}) }
    }
    return {
      ok: false,
      snapshot: Object.freeze({}),
      error: new StickyModelLoadCorruptionError(path, "read failed", { cause }),
    }
  }
  const parsed = parseStickyJson(raw)
  if (parsed === undefined) {
    return {
      ok: false,
      snapshot: Object.freeze({}),
      error: new StickyModelLoadCorruptionError(path, "invalid JSON shape"),
    }
  }
  return { ok: true, snapshot: Object.freeze(parsed) }
}

/**
 * SYNCHRONOUS one-shot snapshot read (aug-27) — the boot-time companion to the
 * async port.
 *
 * WHY a sync reader exists at all: the whole port is async by contract, but a
 * surface that must DISPLAY the effective model before its first turn has only
 * synchronous seams to do it in (the CLI's `/model` `current()`, its status-line
 * source, and the welcome banner are all sync). Without this, a persisted pick
 * was invisible at boot: the picker/banner claimed the boot model while the loop
 * ran the persisted one — a split-brain, which is why the interactive surface
 * previously used an in-memory (session-only) store instead. One `readFileSync`
 * of a small JSON file at startup is cheaper than the config reads already on
 * that path, and the ASYNC port stays the authority for every later read/write.
 *
 * NO-THROW, like every other method here: a missing file (first run), an
 * unreadable one, or corrupt bytes all resolve to an EMPTY snapshot, so a caller
 * degrades to its own default rather than failing to boot.
 */
export const readStickyModelSnapshotSync = (
  opts?: FsBackedStickyModelStoreOpts,
): Readonly<Record<string, string>> => {
  const path = opts?.path ?? defaultStickyModelPath()
  try {
    return Object.freeze(parseStickyJson(readFileSync(path, "utf8")) ?? {})
  } catch {
    // ENOENT (first run) and every IO/permission fault take the same branch:
    // "no preference yet". Corruption is handled by `parseStickyJson` above.
    return Object.freeze({})
  }
}

/** Construct an fs-backed {@link StickyModelStore}. The store re-reads the
 *  file on every `get`/`load` so that out-of-band edits (a second process,
 *  or the user hand-editing the file) are visible immediately — there is no
 *  in-process cache layer. The atomic-write seam (`write-file-atomic`)
 *  ensures readers never observe a torn write. */
export const fsBackedStickyModelStore = (opts?: FsBackedStickyModelStoreOpts): StickyModelStore => {
  const path = opts?.path ?? defaultStickyModelPath()
  const now = opts?.now ?? Date.now

  return {
    async get(input: StickyModelKey): Promise<string | undefined> {
      const result = await readSnapshot(path)
      return readStickyModelFrom((k) => result.snapshot[k], input)
    },

    async set(input: StickyModelKey & { modelId: string }): Promise<StickyModelSetResult> {
      // Read-modify-write UNDER THE CROSS-PROCESS LOCK (see `mutateUnderLock`).
      // The atomic rename was always enough to keep a reader from seeing a torn
      // file; it was never enough to keep a CONCURRENT WRITER's key from being
      // erased by our own full-map replace. The snapshot the mutation is handed is
      // read inside the lock, so the key we splice in lands on top of whatever the
      // peer just committed instead of on top of a stale copy.
      //
      // A corrupt read is tolerated exactly as before: the write proceeds with the
      // (empty) recovered snapshot, after the bytes are preserved to
      // `.corrupt.bak`.
      return mutateUnderLock(path, now, (current) => ({
        ...current.snapshot,
        // Through the SAME composer `get` reads with — a write that keys
        // differently than the read is a silent "no preference".
        [stickyModelKeyOf(input)]: input.modelId,
      }))
    },

    async unset(input: StickyModelKey): Promise<StickyModelSetResult> {
      // Read-modify-write, same shape as `set`. Three deliberate details:
      //
      //  1. NOTHING IS WRITTEN when the file reads cleanly and the key is already
      //     absent. A removal is idempotent by contract, and a blind write here
      //     would CREATE `~/.quanta/sticky-model.json` on a machine that has never
      //     had a preference — a `/model --clear` on a first run should leave the
      //     disk exactly as it found it. The check is made TWICE: once before the
      //     lock (so the true no-op never even creates the parent dir or the
      //     lockfile) and once inside it (so the decision that reaches the write is
      //     made against the authoritative snapshot).
      //  2. A CORRUPT file is backed up and then TRUNCATED to `{}`. We cannot tell
      //     whether the requested key was in the unreadable bytes, and the user
      //     asked for "no preference here", so leaving the corrupt bytes in place
      //     would let an unknown pick reappear the moment the file parses again.
      //     The bytes are preserved to `.corrupt.bak` first (the same courtesy
      //     `set` pays — never silently destroy user data).
      //  3. Removing the LAST key leaves a valid empty OBJECT, not a deleted file:
      //     every reader here treats a missing file and `{}` identically ("no
      //     preference"), but unlinking would also take out a concurrent writer's
      //     freshly-promoted file, and an operator inspecting the path deserves to
      //     see the store exists and is empty.
      const key = stickyModelKeyOf(input)
      const preRead = await readSnapshot(path)
      if (preRead.ok && preRead.snapshot[key] === undefined) return { ok: true }
      return mutateUnderLock(path, now, (current) => {
        if (current.ok && current.snapshot[key] === undefined) return "no-op"
        const next: Record<string, string> = { ...current.snapshot }
        delete next[key]
        return next
      })
    },

    // The SYNC read (aug-28). Re-reads the file, matching this impl's documented
    // no-cache contract; a corrupt/absent file reads as "no preference" because
    // the sync reader is no-throw. In production the session-scoped decorator
    // wraps this store and answers `peek` from its own cell, so no display path
    // pays a per-paint file read — this branch serves hosts that wire the fs store
    // raw (and keeps the two impls answering the same question).
    peek(input: StickyModelKey): string | undefined {
      const snapshot = readStickyModelSnapshotSync({ path })
      return readStickyModelFrom((k) => snapshot[k], input)
    },

    async load(): Promise<StickyModelLoadResult> {
      return readSnapshot(path)
    },
  }
}
