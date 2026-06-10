/**
 * User-default persistence — `~/.quanta/knobs.json`.
 *
 * Tiny v1 schema; bad / missing / malformed file returns `null` so callers
 * can fall back to "no user defaults". Writes go through `mkdir -p` first
 * and land with mode 0o600 (treat the file as containing potentially
 * sensitive feature-flag state).
 *
 * Writes are ATOMIC (jun-10 silent-failure audit #19): the commit routes
 * through `@/storage` writeFileAtomic (ADR-0398 temp+rename+fsync), so a
 * crash mid-write can never leave a torn knobs.json that the read side
 * (in-contract) collapses to `null` — i.e. a silent reset to "never saved
 * defaults". The durability barrier is an injectable seam (`sync`) so the
 * crash window is provable in tests.
 *
 * `path` is an injectable parameter so tests can write to a tmpdir without
 * touching the real `$HOME`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { type AtomicWriteSync, defaultAtomicWriteSync, writeFileAtomic } from "@/storage"

const DEFAULT_DIR = join(homedir(), ".quanta")
const DEFAULT_FILE = join(DEFAULT_DIR, "knobs.json")

export interface KnobConfigFile {
  readonly version: 1
  readonly user_defaults: Readonly<Record<string, string>>
  readonly last_saved: string
}

export const readKnobConfig = async (
  path: string = DEFAULT_FILE,
): Promise<KnobConfigFile | null> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) return null

  const defaults: Record<string, string> = {}
  const src = obj.user_defaults
  if (typeof src === "object" && src !== null) {
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (typeof v === "string") defaults[k] = v
    }
  }
  const lastSaved = typeof obj.last_saved === "string" ? obj.last_saved : ""
  return { version: 1, user_defaults: defaults, last_saved: lastSaved }
}

export const writeKnobConfig = async (
  defaults: Readonly<Record<string, string>>,
  path: string = DEFAULT_FILE,
  sync: AtomicWriteSync = defaultAtomicWriteSync,
): Promise<void> => {
  const data: KnobConfigFile = {
    version: 1,
    user_defaults: { ...defaults },
    last_saved: new Date().toISOString(),
  }
  await mkdir(dirname(path), { recursive: true })
  // Pre-create an EMPTY 0o600 file when absent (`wx` = create-only, race-free)
  // so the atomic temp+rename below — which preserves an EXISTING file's mode —
  // lands even the FIRST write at 0o600, with no transient default-perms
  // window. An empty file reads back as `null`, identical to "absent" under
  // this module's contract, so a crash right here loses nothing.
  try {
    await writeFile(path, "", { mode: 0o600, flag: "wx" })
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e
  }
  // jun-10 silent-failure audit #19: a plain truncating writeFile here meant a
  // crash mid-write tore the file and the (in-contract) read side silently
  // reset the user to "never saved defaults". temp+rename keeps the OLD
  // complete file visible until the new bytes are durable.
  await writeFileAtomic(path, JSON.stringify(data, null, 2), sync)
}

/** Merge-on-save (jun-10 silent-failure audit #18): fresh-read the persisted
 *  `user_defaults`, overlay `overrides` on top (the saving process wins on
 *  conflict), and commit the MERGED map atomically via
 *  {@link writeKnobConfig}. The pre-fix wholesale `writeKnobConfig(bag)` from
 *  a per-process bag silently wiped every OTHER session's saved knobs while
 *  the surface still printed "saved N override(s)". A missing/corrupt existing
 *  file reads as `null` (unchanged contract) and degrades to overrides-only. */
export const saveKnobConfigMerged = async (
  overrides: Readonly<Record<string, string>>,
  path: string = DEFAULT_FILE,
  sync: AtomicWriteSync = defaultAtomicWriteSync,
): Promise<void> => {
  const existing = await readKnobConfig(path)
  await writeKnobConfig({ ...existing?.user_defaults, ...overrides }, path, sync)
}
