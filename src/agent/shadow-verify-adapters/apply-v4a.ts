/**
 * ADR-0400 — Real `ShadowApplyPort` over `@/patch` (V4A applier).
 *
 * Adapts the V4A `applyPatch(parsePatch(text), fs)` pipeline into the
 * `ShadowApplyPort.apply(handle, patch)` shape. The scratch handle is an
 * absolute worktree path produced by `createScratchWorktreePort`; every file
 * read/write is rooted there via a path-resolution `PatchFileSystemPort`
 * adapter sealed inside this module.
 *
 * NO-THROW: every grammar / anchor / apply error (`PatchParseError`,
 * `PatchAnchorNotFoundError`, `PatchApplyError`) is caught and projected onto
 * the port's `{ ok: false, error }` shape. The wave-1 runner converts that
 * into an error-severity `ShadowDiagnostic` with `source = first requested
 * check` — so the model sees a typed error line, not a thrown exception.
 *
 * Slice fence (ADR-0400): allowed to import `@/patch` (composition-root
 * adapter slice, sibling of `@/tool/apply-patch`). The wave-1 slice
 * `@/agent/shadow-verify` is sealed and CANNOT reach `@/patch` itself.
 */

import * as nodeFs from "node:fs/promises"
import * as path from "node:path"
import { applyPatch, type PatchFileSystemPort, parsePatch } from "@/patch"
import { errMessage } from "@/shared"
import type { ShadowApplyPort } from "../shadow-verify"

/**
 * Build a `PatchFileSystemPort` rooted at `scratchRoot`. Relative paths in the
 * patch grammar are resolved against this root; absolute paths are accepted
 * verbatim and checked to live inside the root (a stray absolute path that
 * escapes is rejected by re-resolving through `path.resolve` + a prefix-with-
 * separator check, mirroring `@/storage`'s lexical containment).
 *
 * No symlink / `realpath` defence is performed here — the scratch tree was
 * minted by `git worktree add` and is private to this verify call. The wider
 * filesystem jail is not crossed because the V4A applier never sees a host
 * path (the patch text addresses worktree-relative files).
 */
const scratchFsPort = (scratchRoot: string): PatchFileSystemPort => {
  const root = path.resolve(scratchRoot)
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  const resolveInside = (p: string): string => {
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p)
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      throw new Error(`path '${p}' resolves outside scratch root '${root}'`)
    }
    return abs
  }
  return {
    async readFile(p: string): Promise<string> {
      return nodeFs.readFile(resolveInside(p), "utf8")
    },
    async writeFile(p: string, content: string): Promise<void> {
      const abs = resolveInside(p)
      await nodeFs.mkdir(path.dirname(abs), { recursive: true })
      await nodeFs.writeFile(abs, content, "utf8")
    },
    async deleteFile(p: string): Promise<void> {
      await nodeFs.unlink(resolveInside(p))
    },
    async renameFile(from: string, to: string): Promise<void> {
      const absTo = resolveInside(to)
      await nodeFs.mkdir(path.dirname(absTo), { recursive: true })
      await nodeFs.rename(resolveInside(from), absTo)
    },
    async exists(p: string): Promise<boolean> {
      try {
        await nodeFs.stat(resolveInside(p))
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * Build a `ShadowApplyPort` that parses + applies a V4A patch into the scratch
 * worktree handed in by `createScratchWorktreePort`. Parse / anchor / apply
 * failures collapse to `{ ok: false, error }` — the runner converts them into
 * an error-severity diagnostic for the caller.
 */
export const createV4AApplyPort = (): ShadowApplyPort => ({
  async apply(
    handle: string,
    patchText: string,
    _signal?: AbortSignal,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const patch = parsePatch(patchText)
      const fs = scratchFsPort(handle)
      await applyPatch(patch, fs)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: errMessage(e) }
    }
  },
})
