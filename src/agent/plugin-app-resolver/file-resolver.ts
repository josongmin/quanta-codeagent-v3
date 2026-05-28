/**
 * ADR-0413 / ADR-0418 — File resolver impl (the `resolveFile` method of an
 * ADR-0325 / ADR-0418 `MentionResolverPort`).
 *
 * Reads a workspace file ASYNCHRONOUSLY (`fs.promises.readFile`) and
 * renders its body as the mention bodyText. ADR-0418 flips the resolver
 * port to `Promise`-shaped (so the sibling `@symbol` resolver can do LSP /
 * semantic I/O); this file moves with it — fs reads no longer block the
 * event loop.
 *
 * Security — fs-jail (async):
 *   The resolver captures a workspace `root` and rejects any `target`
 *   that resolves outside it. Symlinks are followed (`fs.realpath`) so an
 *   in-jail symlink pointing OUT is rejected. Containment uses the same
 *   `is-path-inside` library as the async `fsJailLib`. fs-jail escape ⇒
 *   `null` (skip), never a throw.
 *
 * Graceful degradation (all ⇒ `null`):
 *   - missing file / directory target / unreadable (EACCES, etc.)
 *   - file outside the jail
 *   - binary file (NUL byte in the first {@link SNIFF_BYTES})
 *   - empty / non-string target
 *
 * Over-cap files are TRUNCATED (not nulled): the user explicitly asked
 * for the file, so a too-large file yields a head+tail window with a
 * trailing truncation notice. The split is governed by `tailRatio`
 * (ADR-0418 knob; default 0 ⇒ head-only, preserving the legacy marker).
 *
 * NO-THROW: every branch degrades to `null` / truncated text. The
 * ADR-0325 `safeCall` wrapper is the belt-and-suspenders second line.
 */

import { promises as fs } from "node:fs"
import { isAbsolute, resolve as resolvePath } from "node:path"
import isPathInside from "is-path-inside"
import type { MentionResolverPort } from "@/agent/mention-injection"

/** Options for {@link createFileResolver}. */
export interface FileResolverOptions {
  /** Workspace root. A `@file` mention may only read files at or below
   *  this directory. Required; an absent / non-string root ⇒ every
   *  mention resolves to `null`. */
  readonly root: string
  /** Max bytes spliced into the bodyText before truncation. Default
   *  256 KiB. `QUANTA_MENTION_FILE_MAX_BYTES` overrides at the wire. */
  readonly maxBytes?: number
  /** Fraction of `maxBytes` reserved for the file TAIL when truncating;
   *  the head gets `1 - tailRatio`. 0 ≤ ratio ≤ 1. Default 0 (head-only,
   *  legacy marker). `QUANTA_MENTION_FILE_TAIL_RATIO` overrides. */
  readonly tailRatio?: number
}

/** Default body-size cap (256 KiB). Over-cap ⇒ truncated, not nulled. */
export const DEFAULT_FILE_RESOLVER_MAX_BYTES = 256 * 1024

/** Binary-sniff window: a NUL byte within the first 8 KiB ⇒ binary. */
const SNIFF_BYTES = 8 * 1024

/** Default tail fraction. 0 ⇒ head-only (legacy ADR-0413 behaviour). */
const DEFAULT_TAIL_RATIO = 0

const resolveMaxBytes = (raw: number | undefined): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : DEFAULT_FILE_RESOLVER_MAX_BYTES

const resolveTailRatio = (raw: number | undefined): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_TAIL_RATIO
  if (raw < 0) return 0
  if (raw > 1) return 1
  return raw
}

/** Canonicalise a path: resolve symlinks where the path (or its nearest
 *  existing ancestor) exists. Returns the lexically-resolved absolute
 *  path if nothing resolves. Async. NO-THROW. */
const canonicalize = async (abs: string): Promise<string> => {
  try {
    return await fs.realpath(abs)
  } catch {
    return abs
  }
}

/** Async fs-jail containment check. `true` ⇒ `target` is at or below
 *  `root` (after symlink resolution). NO-THROW. */
const isInsideRoot = async (root: string, target: string): Promise<boolean> => {
  try {
    const canonRoot = await canonicalize(resolvePath(root))
    const canonTarget = await canonicalize(target)
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

/** Render the bodyText from raw bytes, truncating over-cap content. With
 *  `tailRatio === 0` this is the legacy head-only marker; a positive ratio
 *  keeps a head + tail window with the omitted-byte count in the middle. */
const renderBody = (buf: Buffer, maxBytes: number, tailRatio: number): string => {
  if (buf.length <= maxBytes) return buf.toString("utf8")
  const tailLen = Math.floor(maxBytes * tailRatio)
  const headLen = maxBytes - tailLen
  if (tailLen <= 0) {
    const head = buf.subarray(0, maxBytes).toString("utf8")
    return `${head}\n… (truncated — file is ${buf.length} bytes, cap ${maxBytes})`
  }
  if (headLen <= 0) {
    return buf.subarray(buf.length - tailLen).toString("utf8")
  }
  const omitted = buf.length - headLen - tailLen
  const head = buf.subarray(0, headLen).toString("utf8")
  const tail = buf.subarray(buf.length - tailLen).toString("utf8")
  return `${head}\n…[truncated ${omitted} bytes]…\n${tail}`
}

/** Resolve + jail-check + read a single file. Returns the raw Buffer or
 *  `null` for any miss / dir / outside-jail / unreadable. Async, NO-THROW. */
const readJailed = async (root: string, target: string): Promise<Buffer | null> => {
  // Resolve the target relative to the root (so a bare `src/x.ts` reads
  // `<root>/src/x.ts`); an absolute target is taken verbatim and then
  // jail-checked.
  const abs = isAbsolute(target) ? resolvePath(target) : resolvePath(root, target)
  if (!(await isInsideRoot(root, abs))) return null
  try {
    const st = await fs.stat(abs)
    if (!st.isFile()) return null
    return await fs.readFile(abs)
  } catch {
    return null
  }
}

/**
 * Build the `resolveFile` method of a {@link MentionResolverPort}.
 *
 * @param opts — workspace root + optional size cap / tail ratio. An absent
 *               / invalid root ⇒ every file mention resolves to `null`.
 * @returns    — an ASYNC function suitable for direct assignment to
 *               `MentionResolverPort.resolveFile`.
 */
export const createFileResolver = (
  opts: FileResolverOptions,
): NonNullable<MentionResolverPort["resolveFile"]> => {
  const root = opts?.root
  const maxBytes = resolveMaxBytes(opts?.maxBytes)
  const tailRatio = resolveTailRatio(opts?.tailRatio)
  return async (target: string) => {
    if (typeof root !== "string" || root.length === 0) return null
    if (typeof target !== "string" || target.length === 0) return null
    const buf = await readJailed(root, target)
    if (buf === null) return null
    if (looksBinary(buf)) return null
    return { bodyText: renderBody(buf, maxBytes, tailRatio) }
  }
}
