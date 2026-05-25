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

/** ADR-0237 — drop snapshot files until the aggregate byte size of the
 *  remaining `.sh` files is at or below `maxBytes`. Eviction order is
 *  OLDEST-first by mtime (so a freshly-captured per-turn snapshot survives
 *  even when the directory is over-cap on entry). Returns the count removed.
 *
 *  Defense-in-depth on top of the time-based `prune()`:
 *    - `prune(olderThanMs)` only removes by AGE (a single very long session
 *      can accumulate 100s of fresh-but-large snapshots and overflow disk).
 *    - `pruneToSizeBudget(maxBytes)` caps the total byte budget and is
 *      meant to be called AFTER `prune()` so the cheap age-based sweep
 *      runs first.
 *
 *  Semantics:
 *    - missing directory → 0 removals (idempotent, mirrors `prune()`).
 *    - `maxBytes <= 0` is treated as 0 (caller's intent: empty the dir).
 *      The function still skips non-`.sh` files (foreign files left alone).
 *    - `under-budget` (`sum <= maxBytes`) → 0 removals, no-op fast path.
 *    - on `over-budget`, files are sorted by mtime ASC and unlinked one by
 *      one until the running sum is at or below the budget. The MOST
 *      RECENT file is always kept even if it singly exceeds the budget —
 *      eviction stops once only one file remains (a single oversized
 *      capture is an operator-visible failure, not a data-loss source).
 *    - per-file unlink failures are tolerated (best-effort, like `prune()`)
 *      and the file's bytes remain counted against the running sum, so a
 *      protected file does not cause infinite eviction. */
export const pruneToSizeBudget = async (
  maxBytes: number,
  home: string = homedir(),
): Promise<number> => {
  const dir = snapshotDir(home)
  if (!existsSync(dir)) return 0
  const budget = maxBytes > 0 ? maxBytes : 0
  // Collect (name, mtimeMs, size) tuples for every .sh file. A vanished
  // file between readdir and stat is silently dropped (race-safe).
  const entries: Array<{ path: string; mtimeMs: number; size: number }> = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sh")) continue
    const path = join(dir, name)
    try {
      const st = statSync(path)
      entries.push({ path, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // file vanished concurrently — ignore
    }
  }
  let total = entries.reduce((acc, e) => acc + e.size, 0)
  if (total <= budget) return 0
  // Oldest first: a fresh per-turn capture (highest mtime) stays.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let removed = 0
  for (const entry of entries) {
    if (total <= budget) break
    // Never evict the last remaining file — see semantic note above.
    if (entries.length - removed <= 1) break
    try {
      unlinkSync(entry.path)
      removed++
      total -= entry.size
    } catch {
      // best-effort: a file we cannot unlink (perm change, vanished) is
      // still counted against `total` — we move on to the next-oldest so
      // the loop is bounded.
      total -= entry.size
    }
  }
  return removed
}
