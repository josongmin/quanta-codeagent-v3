/** LRU eviction for the shadow ODB base directory.
 *
 *  We sum the on-disk size of each per-workspace shadow dir under
 *  `<base>/snapshots/*` and, while the total exceeds `maxBytes`, remove
 *  the oldest one (by mtime) until we're back under cap.
 *
 *  Safety invariants:
 *  - We only ever read/remove inside `<base>/snapshots/*`. Anything
 *    above that root is untouched (the user's `.quanta/auth/`, etc.).
 *  - We refuse to evict if `snapshots` does not exist (no-op).
 *  - Eviction failures are swallowed *per directory* so a single
 *    permission error doesn't strand later eviction work. The function
 *    is best-effort by design (see ADR-0108 "한계"). */

import { promises as fs } from "node:fs"
import { join } from "node:path"

/** Compute on-disk byte size of `dir` recursively. Best-effort: any
 *  per-entry failure is treated as 0 so a transient permission glitch
 *  doesn't disable cleanup. */
const dirSize = async (dir: string): Promise<number> => {
  let total = 0
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      total += await dirSize(p)
    } else if (e.isFile()) {
      try {
        const st = await fs.stat(p)
        total += st.size
      } catch {
        // entry vanished or unreadable — skip
      }
    }
    // Symlinks (which shouldn't appear inside our own snapshots) are skipped.
  }
  return total
}

interface ShadowEntry {
  path: string
  bytes: number
  mtimeMs: number
}

/** Inventory the per-workspace shadow stores. Returns one entry per
 *  immediate subdirectory of `<base>/snapshots/`. */
const inventory = async (snapshotsRoot: string): Promise<ShadowEntry[]> => {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(snapshotsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const out: ShadowEntry[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(snapshotsRoot, e.name)
    const [bytes, st] = await Promise.all([dirSize(p), fs.stat(p).catch(() => null)])
    if (st === null) continue
    out.push({ path: p, bytes, mtimeMs: st.mtimeMs })
  }
  return out
}

/** Evict oldest workspace shadow dirs under `<base>/snapshots/` until
 *  the total cumulative size is at or below `maxBytes`. Returns the
 *  number of workspace stores removed. */
export const evictLru = async (baseDir: string, maxBytes: number): Promise<number> => {
  if (maxBytes < 0) return 0
  const snapshotsRoot = join(baseDir, "snapshots")
  const entries = await inventory(snapshotsRoot)
  let total = entries.reduce((s, e) => s + e.bytes, 0)
  if (total <= maxBytes) return 0
  // Oldest first (smallest mtimeMs).
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  let evicted = 0
  for (const e of entries) {
    if (total <= maxBytes) break
    try {
      await fs.rm(e.path, { recursive: true, force: true })
      total -= e.bytes
      evicted += 1
    } catch {
      // best-effort — skip and continue
    }
  }
  return evicted
}
