/**
 * ADR-0413 / ADR-0418 — Workspace `@file` mention resolver (async).
 *
 * Reads a workspace-relative file and emits its (possibly head+tail
 * truncated) contents as a fragment body. The port shape is **async**
 * (ADR-0418) so the fs read no longer blocks the event loop.
 *
 * Security: the candidate is `realpath`-canonicalized and rejected unless
 * it stays inside the (also `realpath`-canonicalized) workspace root.
 * Absolute paths are rejected up-front. A `@../../etc/passwd` style
 * traversal collapses outside the root and is rejected; a symlink that
 * escapes the root is caught by the post-realpath containment check.
 *
 * Configurable knobs (factory args; production wires `QUANTA_MENTION_FILE_*`):
 *   - `maxBytes`  — size cap before truncation (default 100_000).
 *   - `tailRatio` — fraction of `maxBytes` reserved for the file tail when
 *                   truncating; head gets `1 - tailRatio` (default 0.5).
 *                   `0` ⇒ head-only. `1` ⇒ tail-only.
 *
 * NO-THROW: any failure (traversal, EACCES, ENOENT, directory, binary,
 * decode) returns `null` (skip).
 */

import { promises as fs } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import type { MentionResolverPort } from "@/agent/mention-injection"

export interface FileResolverOptions {
  readonly workspaceRoot: string
  readonly maxBytes?: number
  /** Fraction of `maxBytes` reserved for the tail. 0 ≤ ratio ≤ 1. */
  readonly tailRatio?: number
}

export const DEFAULT_FILE_RESOLVER_MAX_BYTES = 100_000
export const DEFAULT_FILE_RESOLVER_TAIL_RATIO = 0.5

const resolveCap = (maxBytes: number | undefined): number => {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return DEFAULT_FILE_RESOLVER_MAX_BYTES
  }
  return Math.trunc(maxBytes)
}

const resolveTailRatio = (tailRatio: number | undefined): number => {
  if (typeof tailRatio !== "number" || !Number.isFinite(tailRatio)) {
    return DEFAULT_FILE_RESOLVER_TAIL_RATIO
  }
  if (tailRatio < 0) return 0
  if (tailRatio > 1) return 1
  return tailRatio
}

const safeRealpath = async (path: string): Promise<string | null> => {
  try {
    return await fs.realpath(path)
  } catch {
    return null
  }
}

const insideWorkspace = (workspaceRoot: string, candidate: string): boolean => {
  const rel = relative(workspaceRoot, candidate)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

const isBinary = (bytes: Uint8Array): boolean => {
  const cap = Math.min(bytes.length, 4096)
  for (let i = 0; i < cap; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

/** Head+tail truncation. `maxBytes <= 0` ⇒ "". Within cap ⇒ verbatim. */
const renderBodyText = (text: string, cap: number, tailRatio: number): string => {
  if (cap <= 0) return ""
  if (text.length <= cap) return text
  const tailLen = Math.floor(cap * tailRatio)
  const headLen = cap - tailLen
  if (tailLen <= 0) return text.slice(0, headLen) // head-only (ratio 0)
  if (headLen <= 0) return text.slice(text.length - tailLen) // tail-only (ratio 1)
  const omitted = text.length - headLen - tailLen
  const head = text.slice(0, headLen)
  const tail = text.slice(text.length - tailLen)
  return `${head}\n…[truncated ${omitted} bytes]…\n${tail}`
}

/** Resolve + jail-check a target path against the workspace root. Returns
 *  the canonical (realpath'd) candidate inside the root, or `null` if the
 *  target is absolute / escapes / does not exist. NO-THROW. */
const resolveInsideWorkspace = async (
  rootInput: string,
  target: string,
): Promise<string | null> => {
  if (typeof target !== "string" || target.length === 0) return null
  if (isAbsolute(target)) return null
  const workspaceRootReal = await safeRealpath(rootInput)
  if (workspaceRootReal === null) return null
  const candidateReal = await safeRealpath(resolve(workspaceRootReal, target))
  if (candidateReal === null) return null
  if (!insideWorkspace(workspaceRootReal, candidateReal)) return null
  return candidateReal
}

export const createFileResolver = (
  opts: FileResolverOptions,
): MentionResolverPort["resolveFile"] => {
  const rootInput =
    typeof opts.workspaceRoot === "string" && opts.workspaceRoot.length > 0
      ? opts.workspaceRoot
      : null
  const cap = resolveCap(opts.maxBytes)
  const tailRatio = resolveTailRatio(opts.tailRatio)

  return async (target: string) => {
    if (rootInput === null) return null
    const candidateReal = await resolveInsideWorkspace(rootInput, target)
    if (candidateReal === null) return null

    try {
      const info = await fs.stat(candidateReal)
      if (!info.isFile()) return null
      const bytes = await fs.readFile(candidateReal)
      if (isBinary(bytes)) return null
      return { bodyText: renderBodyText(bytes.toString("utf8"), cap, tailRatio) }
    } catch {
      return null
    }
  }
}
