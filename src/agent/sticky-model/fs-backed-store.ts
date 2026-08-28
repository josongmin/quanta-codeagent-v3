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

  return {
    async get(input: StickyModelKey): Promise<string | undefined> {
      const result = await readSnapshot(path)
      return readStickyModelFrom((k) => result.snapshot[k], input)
    },

    async set(input: StickyModelKey & { modelId: string }): Promise<StickyModelSetResult> {
      // Read-modify-write: load current snapshot, splice the new entry,
      // atomically replace. A torn write is impossible because the lib
      // writes to a sibling tmp file and rename(2)-promotes.
      //
      // We tolerate `ok:false` on read (corruption / IO error): the write
      // proceeds with a fresh snapshot containing JUST the new entry (the
      // unreadable bytes yield no recoverable entries). To honor the file
      // header's "never silently destroy user data" promise, FIRST copy the
      // corrupt bytes to a `.corrupt.bak` sidecar so a hand-recoverable file
      // is preserved for inspection before we overwrite it. Best-effort — a
      // backup failure (the file may be genuinely gone on an ENOENT-shaped IO
      // error) must NOT block making progress on a broken store.
      const current = await readSnapshot(path)
      if (!current.ok) {
        try {
          await copyFile(path, `${path}.corrupt.bak`)
        } catch {
          // best-effort: nothing to preserve / unreadable — proceed with write
        }
      }
      const next: Record<string, string> = {
        ...current.snapshot,
        // Through the SAME composer `get` reads with — a write that keys
        // differently than the read is a silent "no preference".
        [stickyModelKeyOf(input)]: input.modelId,
      }
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFileAtomic(path, JSON.stringify(next, null, 2))
        return { ok: true }
      } catch (cause: unknown) {
        const reason = errMessage(cause)
        return {
          ok: false,
          error: new StickyModelWriteError(path, reason, { cause }),
        }
      }
    },

    async unset(input: StickyModelKey): Promise<StickyModelSetResult> {
      // Read-modify-write, same shape as `set`: load, drop the key, atomically
      // replace. Two deliberate details:
      //
      //  1. NOTHING IS WRITTEN when the file reads cleanly and the key is already
      //     absent. A removal is idempotent by contract, and a blind write here
      //     would CREATE `~/.quanta/sticky-model.json` on a machine that has never
      //     had a preference — a `/model --clear` on a first run should leave the
      //     disk exactly as it found it.
      //  2. A CORRUPT file is backed up and then TRUNCATED to `{}`. We cannot tell
      //     whether the requested key was in the unreadable bytes, and the user
      //     asked for "no preference here", so leaving the corrupt bytes in place
      //     would let an unknown pick reappear the moment the file parses again.
      //     The bytes are preserved to `.corrupt.bak` first (the same courtesy
      //     `set` pays — never silently destroy user data).
      const current = await readSnapshot(path)
      const key = stickyModelKeyOf(input)
      if (current.ok && current.snapshot[key] === undefined) return { ok: true }
      if (!current.ok) {
        try {
          await copyFile(path, `${path}.corrupt.bak`)
        } catch {
          // best-effort: nothing to preserve / unreadable — proceed with write
        }
      }
      const next: Record<string, string> = { ...current.snapshot }
      // Removing the LAST key leaves a valid empty OBJECT, not a deleted file:
      // every reader here treats a missing file and `{}` identically ("no
      // preference"), but unlinking would also take out a concurrent writer's
      // freshly-promoted file, and an operator inspecting the path deserves to see
      // the store exists and is empty.
      delete next[key]
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFileAtomic(path, JSON.stringify(next, null, 2))
        return { ok: true }
      } catch (cause: unknown) {
        return {
          ok: false,
          error: new StickyModelWriteError(path, errMessage(cause), { cause }),
        }
      }
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
