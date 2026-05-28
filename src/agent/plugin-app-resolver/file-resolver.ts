/**
 * ADR-0413 — File resolver impl (the `resolveFile` method of an
 * ADR-0325 `MentionResolverPort`).
 *
 * Reads a workspace file SYNCHRONOUSLY (`fs.readFileSync`) and renders
 * its body as the mention bodyText. This is the kind that makes `@file`
 * safe to add to the frozen-sync resolver port: file IO is sync, so no
 * `resolve*` signature flips to `Promise` (unlike a future `@symbol`,
 * which needs an async symbol index — see ADR-0413 §"deliberate_hold").
 *
 * Security — fs-jail (SYNC):
 *   The resolver captures a workspace `root` and rejects any `target`
 *   that resolves outside it. Symlinks are followed (`realpathSync`) so
 *   an in-jail symlink pointing OUT is rejected. Containment uses the
 *   same `is-path-inside` library as the async `fsJailLib`, called
 *   synchronously here. fs-jail escape ⇒ `null` (skip), never a throw.
 *
 * Graceful degradation (all ⇒ `null`):
 *   - missing file / directory target / unreadable (EACCES, etc.)
 *   - file outside the jail
 *   - binary file (NUL byte in the first {@link SNIFF_BYTES})
 *   - empty / non-string target
 *
 * Over-cap files are TRUNCATED (not nulled): the user explicitly asked
 * for the file, so a too-large file yields its first {@link MAX_BYTES}
 * with a trailing truncation notice. This mirrors the read-tool's
 * offset/limit ergonomic (a giant file is clamped, not refused).
 *
 * NO-THROW: every branch degrades to `null` / truncated text. The
 * ADR-0325 `safeCall` wrapper is the belt-and-suspenders second line.
 */

import { readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"
import type { MentionResolverPort } from "@/agent/mention-injection"
import isPathInside from "is-path-inside"

/** Options for {@link createFileResolver}. */
export interface FileResolverOptions {
  /** Workspace root. A `@file` mention may only read files at or below
   *  this directory. Required; an absent / non-string root ⇒ every
   *  mention resolves to `null`. */
  readonly root: string
  /** Max bytes spliced into the bodyText before truncation. Default
   *  256 KiB. */
  readonly maxBytes?: number
}

/** Default body-size cap (256 KiB). Over-cap ⇒ truncated, not nulled. */
const MAX_BYTES = 256 * 1024

/** Binary-sniff window: a NUL byte within the first 8 KiB ⇒ binary. */
const SNIFF_BYTES = 8 * 1024

/** Canonicalise a path: resolve symlinks where the path (or its nearest
 *  existing ancestor) exists. Returns the lexically-resolved absolute
 *  path if nothing resolves. Sync. NO-THROW. */
const canonicalize = (abs: string): string => {
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

/** Sync fs-jail containment check. `true` ⇒ `target` is at or below
 *  `root` (after symlink resolution). NO-THROW. */
const isInsideRoot = (root: string, target: string): boolean => {
  try {
    const canonRoot = canonicalize(resolvePath(root))
    const canonTarget = canonicalize(target)
    // `isPathInside` is strict on equality (a path is not "inside"
    // itself); allow target === root only when root is the file (rare,
    // but a single-file root should still resolve). We additionally OR
    // the equality so reading the canonical root path itself is allowed.
    return canonTarget === canonRoot || isPathInside(canonTarget, canonRoot)
  } catch {
    return false
  }
}

/** Decide whether the raw bytes look binary (NUL in the sniff window). */
const looksBinary = (buf: Buffer): boolean => {
  const end = Math.min(buf.length, SNIFF_BYTES)
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Render the bodyText from raw bytes, truncating over-cap content. */
const renderBody = (buf: Buffer, maxBytes: number): string => {
  if (buf.length <= maxBytes) return buf.toString("utf8")
  const head = buf.subarray(0, maxBytes).toString("utf8")
  return `${head}\n… (truncated — file is ${buf.length} bytes, cap ${maxBytes})`
}

/** Resolve + jail-check + read a single file. Returns the raw Buffer or
 *  `null` for any miss / dir / outside-jail / unreadable. Sync, NO-THROW. */
const readJailed = (root: string, target: string): Buffer | null => {
  // Resolve the target relative to the root (so a bare `src/x.ts` reads
  // `<root>/src/x.ts`); an absolute target is taken verbatim and then
  // jail-checked.
  const abs = isAbsolute(target) ? resolvePath(target) : resolvePath(root, target)
  if (!isInsideRoot(root, abs)) return null
  try {
    const st = statSync(abs)
    if (!st.isFile()) return null
    return readFileSync(abs)
  } catch {
    return null
  }
}

/**
 * Build the `resolveFile` method of a {@link MentionResolverPort}.
 *
 * @param opts — workspace root + optional size cap. An absent / invalid
 *               root ⇒ every file mention resolves to `null` (skipped).
 * @returns    — a SYNC function suitable for direct assignment to
 *               `MentionResolverPort.resolveFile`.
 */
export const createFileResolver = (
  opts: FileResolverOptions,
): NonNullable<MentionResolverPort["resolveFile"]> => {
  const root = opts?.root
  const maxBytes = typeof opts?.maxBytes === "number" && opts.maxBytes > 0 ? opts.maxBytes : MAX_BYTES
  return (target: string) => {
    if (typeof root !== "string" || root.length === 0) return null
    if (typeof target !== "string" || target.length === 0) return null
    const buf = readJailed(root, target)
    if (buf === null) return null
    if (looksBinary(buf)) return null
    return { bodyText: renderBody(buf, maxBytes) }
  }
}
