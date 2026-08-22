/**
 * @/storage internal — the ONE symlink-aware path canonicalization core.
 *
 * Extracted (jul-27 DRY/SSOT audit) from `service.ts` + `fs-jail-lib.ts`, which
 * each carried a BYTE-IDENTICAL copy of this ~60-line create-then-escape defense.
 * A duplicated security-critical algorithm means a new symlink-escape vector
 * patched in one file silently leaves the other exposed — so both jail entry
 * points (`resolveJailed`/`enforceJail` via service.ts, `canonicalizePath` +
 * `FsJailLib` via fs-jail-lib.ts) now share THIS single implementation.
 *
 * Internal to @/storage (no barrel re-export): the public surface stays
 * `resolveJailed` / `canonicalizePath` / `FsJailLib`.
 */
import { lstatSync, readlinkSync } from "node:fs"
import { isAbsolute } from "node:path"

/** Normalize an absolute path to its canonical segment list (collapsing `.`
 *  and resolving `..` lexically). Returns the cleaned absolute path. */
export const lexicalNormalize = (abs: string): string => {
  const out: string[] = []
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return `/${out.join("/")}`
}

/** Max symlink hops {@link realResolve} expands before giving up. Mirrors the
 *  kernel's typical `MAXSYMLINKS` (40) — far past any legitimate chain, but
 *  bounded so a symlink CYCLE among dangling links cannot spin forever. */
export const MAX_SYMLINK_HOPS = 40

/**
 * Canonicalize `abs` for the jail boundary check, resolving symlinks EVEN WHEN
 * THEIR TARGET DOES NOT YET EXIST.
 *
 * SECURITY-CRITICAL. A naive `realpathSync(ancestor)` + lexical-tail approach
 * silently treats a *dangling* symlink (e.g. `jail/esc -> /outside/absent`) as a
 * plain directory name, so a path UNDER it (`jail/esc/pwned.txt`) normalizes back
 * "inside" the jail — yet a later write, once the target appears, lands OUTSIDE.
 * A dangling symlink to an out-of-jail location is the classic create-then-escape
 * vector.
 *
 * This walks the path segment-by-segment from the root. For each existing
 * component we `lstat` it: a SYMLINK has its `readlink` target expanded (resolved
 * against the symlink's parent, absolute targets honoured) and re-walked —
 * whether or not that target currently exists. Non-symlink components (real
 * dirs/files, or not-yet-created leaves) are appended literally. The result is
 * the fully symlink-expanded path; the caller's containment check then sees the
 * REAL destination, dangling or not.
 *
 * Bounded by {@link MAX_SYMLINK_HOPS} so a symlink cycle cannot loop forever (on
 * the cap we fall back to the lexical normalize, which is conservative — an
 * unresolvable cycle is not a valid in-jail path anyway). */
export const realResolve = (abs: string): string => {
  let pending = abs.split("/").filter(Boolean)
  const resolved: string[] = []
  let hops = 0
  while (pending.length > 0) {
    const seg = pending.shift() as string
    if (seg === ".") continue
    if (seg === "..") {
      resolved.pop()
      continue
    }
    const current = `/${[...resolved, seg].join("/")}`
    let link: string | undefined
    try {
      if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current)
    } catch {
      // Component does not exist yet (a not-yet-created leaf/parent). It cannot
      // be a symlink, so append it literally and keep walking.
    }
    if (link === undefined) {
      resolved.push(seg)
      continue
    }
    if (++hops > MAX_SYMLINK_HOPS) return lexicalNormalize(abs)
    // Expand the symlink. An ABSOLUTE target replaces the whole walked prefix; a
    // RELATIVE target resolves against the symlink's PARENT (`resolved`, which
    // does NOT yet include `seg`). In both cases reset `resolved` and re-queue the
    // new prefix PLUS the remaining `pending` so `..`/`.` in the target and the
    // rest of the path are re-walked uniformly through the loop's own logic.
    const prefix = isAbsolute(link) ? link : `/${[...resolved, link].join("/")}`
    resolved.length = 0
    pending = [...prefix.split("/").filter(Boolean), ...pending]
  }
  return `/${resolved.join("/")}`
}
