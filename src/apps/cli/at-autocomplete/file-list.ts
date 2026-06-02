/**
 * RFC-12 / ADR-0436 §4.2 — File-path candidate lister.
 *
 * Enumerates workspace files for `@path` completion. This is the LISTING
 * counterpart to `createFileResolver` (`@/agent/plugin-app-resolver`), which
 * only RESOLVES a known path. Containment uses the SAME `is-path-inside`
 * library + symlink canonicalisation idiom as `file-resolver.ts` /
 * `fs-jail-lib.ts` — a candidate that escapes `root` is never listed.
 *
 * Walk strategy (RFC §6 "huge directory" edge): we walk ONLY the directory
 * the query's path-prefix points at (NOT a full recursive workspace scan),
 * cap the result count, and honour an `AbortSignal`. A query of `src/ut`
 * lists `<root>/src/*` filtered to names containing `ut`; a query with no
 * slash lists `<root>/*`.
 *
 * NO-THROW: every fs failure (missing dir, EACCES, abort) degrades to the
 * candidates gathered so far (or `[]`).
 */

import { type Dirent, promises as fs } from "node:fs"
import { isAbsolute, join, resolve as resolvePath } from "node:path"
import isPathInside from "is-path-inside"
import type { AtCandidate } from "./port"

/** Options for {@link createFileLister}. */
export interface FileListerOptions {
  /** Workspace root. MUST equal the `createFileResolver` root so listed
   *  candidates are exactly the ones the resolver can later read. */
  readonly fileRoot: string
  /** Max candidates returned. Default 8 (= `MAX_VISIBLE_CANDIDATES`). */
  readonly maxResults?: number
}

const DEFAULT_MAX = 8

/** Split a raw `@`-query into the directory portion (relative to root) and
 *  the leaf filter. `"src/ut"` ⇒ `{ dir: "src", leaf: "ut" }`;
 *  `"ut"` ⇒ `{ dir: "", leaf: "ut" }`; `"src/"` ⇒ `{ dir: "src", leaf: "" }`. */
const splitQuery = (query: string): { dir: string; leaf: string } => {
  const slash = query.lastIndexOf("/")
  if (slash < 0) return { dir: "", leaf: query }
  return { dir: query.slice(0, slash), leaf: query.slice(slash + 1) }
}

/** Canonicalise (follow symlinks where resolvable). NO-THROW. */
const canonicalize = async (abs: string): Promise<string> => {
  try {
    return await fs.realpath(abs)
  } catch {
    return abs
  }
}

/** Async containment: `true` iff `abs` is at/below `root` after symlink
 *  resolution. Mirrors `file-resolver.ts::isInsideRoot`. NO-THROW. */
const isInsideRoot = async (root: string, abs: string): Promise<boolean> => {
  try {
    const canonRoot = await canonicalize(resolvePath(root))
    const canonTarget = await canonicalize(abs)
    return canonTarget === canonRoot || isPathInside(canonTarget, canonRoot)
  } catch {
    return false
  }
}

/** Project one dir entry into an {@link AtCandidate}. Directories get a
 *  trailing `/` so a follow-up keystroke descends; files are leaf paths. */
const toCandidate = (relDir: string, name: string, isDir: boolean): AtCandidate => {
  const rel = relDir === "" ? name : `${relDir}/${name}`
  const display = isDir ? `${rel}/` : rel
  return {
    kind: "file",
    insertText: `@${display}`,
    label: display,
    detail: isDir ? "dir" : "file",
  }
}

/** `true` iff `entry` should be skipped: hidden, leaf-mismatch, or a symlink
 *  escaping the jail. Extracted so the lister closure stays under the
 *  cognitive-complexity cap. NO-THROW. */
const skipEntry = async (
  entry: Dirent,
  scanAbs: string,
  root: string,
  leafLower: string,
): Promise<boolean> => {
  const name = entry.name
  if (name.startsWith(".")) return true // hidden files are not surfaced by default
  if (leafLower !== "" && !name.toLowerCase().includes(leafLower)) return true
  // Symlink-escape guard: a symlinked entry pointing OUT of root is dropped.
  if (entry.isSymbolicLink() && !(await isInsideRoot(root, join(scanAbs, name)))) return true
  return false
}

/** Read a directory + project the matching, in-jail entries into candidates.
 *  Extracted from the lister closure to keep its complexity low. NO-THROW. */
const scanDir = async (
  scanAbs: string,
  dir: string,
  leafLower: string,
  root: string,
  max: number,
  signal: AbortSignal | undefined,
): Promise<readonly AtCandidate[]> => {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(scanAbs, { withFileTypes: true })
  } catch {
    return []
  }
  if (signal?.aborted) return []
  const out: AtCandidate[] = []
  for (const entry of entries) {
    if (out.length >= max) break
    if (await skipEntry(entry, scanAbs, root, leafLower)) continue
    out.push(toCandidate(dir, entry.name, entry.isDirectory()))
  }
  return out
}

/**
 * Build a file-path lister. Returns a function `(query, signal) ⇒ candidates`.
 * An absent / non-string `fileRoot` ⇒ every call returns `[]` (graceful).
 */
export const createFileLister = (
  opts: FileListerOptions,
): ((query: string, signal?: AbortSignal) => Promise<readonly AtCandidate[]>) => {
  const root = opts?.fileRoot
  const max =
    typeof opts?.maxResults === "number" && Number.isFinite(opts.maxResults) && opts.maxResults > 0
      ? Math.trunc(opts.maxResults)
      : DEFAULT_MAX
  return async (query: string, signal?: AbortSignal): Promise<readonly AtCandidate[]> => {
    if (typeof root !== "string" || root.length === 0) return []
    if (typeof query !== "string") return []
    if (isAbsolute(query)) return [] // absolute queries never escape the jail via the dropdown
    if (signal?.aborted) return []
    const { dir, leaf } = splitQuery(query)
    const scanAbs = dir === "" ? resolvePath(root) : resolvePath(root, dir)
    if (!(await isInsideRoot(root, scanAbs))) return []
    return scanDir(scanAbs, dir, leaf.toLowerCase(), root, max, signal)
  }
}
