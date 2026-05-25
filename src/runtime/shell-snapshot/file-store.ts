/**
 * ADR-0204 — filesystem layer for shell-snapshot.
 *
 * Lives under `~/.quanta/shell_snapshots/` (directory created on first
 * write, mode 0700). Each snapshot is a single `.sh` file written with
 * mode 0600 so other users on a multi-tenant host cannot read environment
 * values that may include secrets — defense-in-depth on top of ADR-0006's
 * env scrubbing, since the captured file legitimately contains values
 * (e.g. `TZ`, `LANG`) that the *parent* shell had access to.
 *
 * `safeId` rejects path-injection: `;`, `\n`, `..`, `/`, leading `-` /
 * `.` are stripped or collapsed. The resulting id is length-capped at 48
 * chars and never empty. A nonce suffix is appended in `mkId` so two
 * concurrent captures cannot collide on the same path.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SnapErr } from "./types"

/** Resolve the on-disk directory. Exported so tests can override `HOME`
 *  and verify the path discipline. */
export const snapshotDir = (home: string = homedir()): string =>
  join(home, ".quanta", "shell_snapshots")

const ID_PATTERN = /[^A-Za-z0-9._-]/g

/** Sanitise a caller-supplied id. Returns `null` if nothing survives —
 *  caller turns that into `SnapErr{ kind: "invalid-id" }`. */
export const safeId = (raw: string): string | null => {
  let cleaned = raw.replace(ID_PATTERN, "-").slice(0, 48)
  cleaned = cleaned.replace(/^[-.]+/, "")
  if (cleaned.length === 0) return null
  return cleaned
}

/** Build a unique id. When the caller supplies `seed`, the nonce is
 *  appended to it; otherwise a random base id is used. The nonce is 8
 *  hex chars derived from `crypto.randomUUID()` so two concurrent
 *  captures with the SAME seed still resolve to different filenames
 *  (HELL-SS-09). */
export const mkId = (seed?: string): string | null => {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 8)
  if (seed === undefined) return `snap-${nonce}`
  const safe = safeId(seed)
  if (safe === null) return null
  return `${safe}-${nonce}`
}

const ensureDir = (dir: string): void => {
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** Write the snapshot file. Mode 0600. Returns the absolute path on
 *  success, or a `SnapErr` describing the failure mode. */
export const writeSnapshot = async (
  id: string,
  body: string,
  shell: "zsh" | "bash",
  home: string = homedir(),
): Promise<{ ok: true; path: string } | { ok: false; err: SnapErr }> => {
  const dir = snapshotDir(home)
  try {
    ensureDir(dir)
  } catch (e) {
    return {
      ok: false,
      err: { kind: "write-failed", shell, detail: String((e as Error).message) },
    }
  }
  const path = join(dir, `${id}.sh`)
  try {
    await writeFile(path, body, { mode: 0o600 })
  } catch (e) {
    return {
      ok: false,
      err: { kind: "write-failed", shell, detail: String((e as Error).message) },
    }
  }
  return { ok: true, path }
}

/** Drop snapshot files whose mtime is older than the cutoff. Returns
 *  count removed. Missing directory is treated as zero removals. */
export const prune = async (olderThanMs: number, home: string = homedir()): Promise<number> => {
  const dir = snapshotDir(home)
  if (!existsSync(dir)) return 0
  const cutoff = Date.now() - olderThanMs
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sh")) continue
    const path = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.mtimeMs < cutoff) {
      try {
        unlinkSync(path)
        removed++
      } catch {
        // best-effort prune — skip files that vanished concurrently
      }
    }
  }
  return removed
}
