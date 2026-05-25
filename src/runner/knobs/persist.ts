/**
 * User-default persistence — `~/.quanta/knobs.json`.
 *
 * Tiny v1 schema; bad / missing / malformed file returns `null` so callers
 * can fall back to "no user defaults". Writes go through `mkdir -p` first
 * and land with mode 0o600 (treat the file as containing potentially
 * sensitive feature-flag state).
 *
 * `path` is an injectable parameter so tests can write to a tmpdir without
 * touching the real `$HOME`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

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
): Promise<void> => {
  const data: KnobConfigFile = {
    version: 1,
    user_defaults: { ...defaults },
    last_saved: new Date().toISOString(),
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 })
}
