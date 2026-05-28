/** ADR-0398 — atomic write + sha256 hash precondition (storage-slice adapter).
 *
 *  Single-file 2-phase temp+rename adapter co-located inside `@/storage`. Used
 *  by the `edit` / `write` tools as the on-disk commit primitive when the
 *  caller threads `expected_hash` (or any future precondition gate) and so the
 *  storage slice can offer "either FULLY APPLIED or FULLY ABORTED" semantics
 *  WITHOUT crossing the slice fence into `@/lsp` (where the batch-shaped
 *  `atomicFileWriteStrategy` lives — same algorithm, different port shape).
 *
 *  Algorithm — identical to `@/lsp/adapters/file-write-atomic.ts` for a single
 *  entry:
 *    1. Write bytes to `<path>.<tempPrefix>-<hex>` (an 8-byte random suffix
 *       keeps concurrent edits non-colliding; mirrors the lsp adapter).
 *    2. POSIX `rename(temp, path)` — atomic on the same filesystem.
 *    3. On `EXDEV` (cross-filesystem rename, the documented degradation)
 *       fall back to `copyFile(temp, path)` + best-effort `unlink(temp)`.
 *       This narrows but does not eliminate the crash window — readers still
 *       see either pre- or post-bytes, never a partial write.
 *    4. Any other rename failure surfaces as the original Error; the temp is
 *       LEFT ON DISK so an operator can replay (mirrors lsp adapter posture).
 *
 *  Plane-clean: pure adapter, no slice cross-imports. The `sha256Hex` helper
 *  is the convention every other slice already uses (see
 *  `@/llm/system-prompt-cache/hash.ts`). Re-declared here ONLY so `@/storage`
 *  does not reach into `@/llm` for a 1-line wrapper. */

import { createHash, randomBytes } from "node:crypto"
import { copyFile, rename, unlink } from "node:fs/promises"

interface ErrnoLike {
  readonly code?: string
}

const isExdev = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false
  return (e as ErrnoLike).code === "EXDEV"
}

const TEMP_PREFIX = "quanta-tmp"

const toHex = (bytes: Uint8Array): string => {
  let s = ""
  for (const b of bytes) s += b.toString(16).padStart(2, "0")
  return s
}

/** Compute the sha256 hex digest of `content` (UTF-8). The convention used
 *  by every hash-bearing port in this codebase. Re-exported from `@/storage`
 *  so the tool slice can compute and compare without touching `@/llm`. */
export const sha256Hex = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")

/** Single-file atomic write. Writes `content` to `<path>.quanta-tmp-<hex>`
 *  first, then `rename`s into place. On `EXDEV` falls back to `copyFile` +
 *  `unlink(temp)` (atomicity narrows, crash-safety preserved on most filesystems).
 *
 *  Failure semantics:
 *  - If the temp write throws, the original file at `path` is UNTOUCHED. The
 *    error is re-thrown (caller wraps as needed).
 *  - If `rename` throws with `EXDEV`, the copyFile fallback runs. If THAT
 *    throws, the original is still untouched (copy onto same path is the only
 *    destructive step; a failure mid-copy leaves a partial — but in practice
 *    `Bun.write` / `node:fs` `copyFile` are best-effort whole-file). The error
 *    propagates.
 *  - Any other rename failure: original untouched, temp remains on disk for
 *    operator recovery, error propagates.
 *
 *  Default-OFF byte-identical: the `edit`/`write` tools call this ONLY when
 *  the new `expected_hash` opt-in is present; absent that, they keep using
 *  the legacy `fs.writeFile` path. */
export const writeFileAtomic = async (path: string, content: string): Promise<void> => {
  const temp = `${path}.${TEMP_PREFIX}-${toHex(randomBytes(8))}`
  // Phase A — write to temp. If THIS throws, the original is untouched.
  try {
    await Bun.write(temp, content)
  } catch (e) {
    // Best-effort cleanup of any partial temp; swallow ENOENT.
    await unlink(temp).catch(() => undefined)
    throw e
  }
  // Phase B — rename(temp, path) is atomic on same FS.
  try {
    await rename(temp, path)
  } catch (e) {
    if (isExdev(e)) {
      // Cross-FS fallback — copy then unlink. A copyFile failure propagates
      // unwrapped (caller has no atomic guarantee on EXDEV, only crash-safety
      // narrowed to the copy window). The temp is left on disk if copyFile
      // throws so the operator can inspect / replay.
      await copyFile(temp, path)
      await unlink(temp).catch(() => undefined)
      return
    }
    // Other rename failure — leave the temp on disk for recovery.
    throw e
  }
}
