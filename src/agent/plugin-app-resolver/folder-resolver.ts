/**
 * §10.3 — Folder resolver impl (the `resolveFolder` method of a
 * `MentionResolverPort`). Cursor `@Folders` parity.
 *
 * Lists a workspace directory ASYNCHRONOUSLY (`fs.promises.readdir`) and
 * renders a bounded, deterministic entry listing as the mention bodyText.
 * Entries are sorted (byte order) and capped at {@link FolderResolverOptions.maxEntries};
 * over-cap directories get a trailing `… (+N more)` marker. Directories are
 * suffixed with `/` so the model can distinguish them from files.
 *
 * Security — fs-jail (async): identical containment model to the §file
 * resolver. The resolver captures a workspace `root` and rejects any `target`
 * that resolves outside it (symlinks followed via `fs.realpath`). Escape ⇒
 * `null` (skip), never a throw.
 *
 * Graceful degradation (all ⇒ `null`):
 *   - missing dir / file target (not a directory) / unreadable (EACCES)
 *   - target outside the jail
 *   - empty / non-string target / absent root
 *
 * NO-THROW: every branch degrades to `null` / bounded text. The ADR-0325
 * `safeCall` wrapper is the belt-and-suspenders second line.
 */

import { promises as fs } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"
import isPathInside from "is-path-inside"
import type { MentionResolverPort } from "@/agent/mention-injection"

/** Options for {@link createFolderResolver}. */
export interface FolderResolverOptions {
  /** Workspace root. A `@folder` mention may only list dirs at or below this
   *  directory. Required; an absent / non-string root ⇒ every mention → null. */
  readonly root: string
  /** Max directory entries rendered before a `… (+N more)` marker. Default
   *  {@link DEFAULT_FOLDER_MAX_ENTRIES}. */
  readonly maxEntries?: number
}

/** Default entry cap. Over-cap ⇒ truncated listing + count marker. */
export const DEFAULT_FOLDER_MAX_ENTRIES = 200

const resolveMaxEntries = (raw: number | undefined): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : DEFAULT_FOLDER_MAX_ENTRIES

/** Canonicalise a path (resolve symlinks), best-effort. NO-THROW. */
const canonicalize = async (abs: string): Promise<string> => {
  try {
    return await fs.realpath(abs)
  } catch {
    return abs
  }
}

/** Async fs-jail containment check. NO-THROW. */
const isInsideRoot = async (root: string, target: string): Promise<boolean> => {
  try {
    const canonRoot = await canonicalize(resolvePath(root))
    const canonTarget = await canonicalize(target)
    return canonTarget === canonRoot || isPathInside(canonTarget, canonRoot)
  } catch {
    return false
  }
}

/** Render a bounded, deterministic listing from dirent entries. Pure. */
const renderListing = (
  names: readonly { name: string; isDir: boolean }[],
  maxEntries: number,
): string => {
  // Stable byte-order sort; dirs and files interleave alphabetically but each
  // dir is suffixed with `/` so the kind is unambiguous.
  const sorted = [...names].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const shown = sorted.slice(0, maxEntries)
  const lines = shown.map((e) => (e.isDir ? `${e.name}/` : e.name))
  if (sorted.length > maxEntries) {
    lines.push(`… (+${sorted.length - maxEntries} more)`)
  }
  return lines.join("\n")
}

/** Resolve + jail-check + read one directory. Returns the dirents or `null`
 *  for any miss / non-dir / outside-jail / unreadable. Async, NO-THROW. */
const readJailedDir = async (
  root: string,
  target: string,
): Promise<{ name: string; isDir: boolean }[] | null> => {
  const abs = isAbsolute(target) ? resolvePath(target) : resolvePath(root, target)
  if (!(await isInsideRoot(root, abs))) return null
  try {
    const st = await fs.stat(abs)
    if (!st.isDirectory()) return null
    const dirents = await fs.readdir(abs, { withFileTypes: true })
    return dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
  } catch {
    return null
  }
}

/**
 * Build the `resolveFolder` method of a {@link MentionResolverPort}.
 *
 * @param opts — workspace root + optional entry cap. An absent / invalid root
 *               ⇒ every folder mention resolves to `null`.
 */
export const createFolderResolver = (
  opts: FolderResolverOptions,
): NonNullable<MentionResolverPort["resolveFolder"]> => {
  const root = opts?.root
  const maxEntries = resolveMaxEntries(opts?.maxEntries)
  return async (target: string) => {
    if (typeof root !== "string" || root.length === 0) return null
    if (typeof target !== "string" || target.length === 0) return null
    const entries = await readJailedDir(root, target)
    if (entries === null) return null
    return { bodyText: renderListing(entries, maxEntries) }
  }
}
