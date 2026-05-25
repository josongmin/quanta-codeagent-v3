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

import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import writeFileAtomic from "write-file-atomic"
import { QuantaError } from "@/shared"
import type { AgentMode } from "../prompt"
import type { StickyModelLoadResult, StickyModelSetResult, StickyModelStore } from "./port"

/** Default path: `~/.quanta/sticky-model.json`. Pure function of homedir;
 *  exposed so tests can override via the `path` option without re-deriving. */
export const defaultStickyModelPath = (): string => join(homedir(), ".quanta", "sticky-model.json")

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

/** Construct an fs-backed {@link StickyModelStore}. The store re-reads the
 *  file on every `get`/`load` so that out-of-band edits (a second process,
 *  or the user hand-editing the file) are visible immediately — there is no
 *  in-process cache layer. The atomic-write seam (`write-file-atomic`)
 *  ensures readers never observe a torn write. */
export const fsBackedStickyModelStore = (opts?: FsBackedStickyModelStoreOpts): StickyModelStore => {
  const path = opts?.path ?? defaultStickyModelPath()

  return {
    async get(input: { mode: AgentMode }): Promise<string | undefined> {
      const result = await readSnapshot(path)
      return result.snapshot[input.mode]
    },

    async set(input: { mode: AgentMode; modelId: string }): Promise<StickyModelSetResult> {
      // Read-modify-write: load current snapshot, splice the new entry,
      // atomically replace. A torn write is impossible because the lib
      // writes to a sibling tmp file and rename(2)-promotes.
      //
      // We tolerate `ok:false` on read (corruption / IO error) — the next
      // write will overwrite the corrupt file with a fresh snapshot
      // containing JUST the new entry, plus any entries the failed read
      // could not surface. That is by-design: the store's contract is
      // "best effort persistence" and the resolver falls back to the
      // global default on any read failure.
      const current = await readSnapshot(path)
      const next: Record<string, string> = { ...current.snapshot, [input.mode]: input.modelId }
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFileAtomic(path, JSON.stringify(next, null, 2))
        return { ok: true }
      } catch (cause: unknown) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        return {
          ok: false,
          error: new StickyModelWriteError(path, reason, { cause }),
        }
      }
    },

    async load(): Promise<StickyModelLoadResult> {
      return readSnapshot(path)
    },
  }
}
