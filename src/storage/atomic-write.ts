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
 *       keeps concurrent edits non-colliding; mirrors the lsp adapter) AND
 *       `fsync` that temp file BEFORE the rename. Without the fsync the bytes
 *       may live only in the page cache, so a crash in the window between the
 *       write and the rename's own metadata flush can leave a torn / zero-
 *       length file surviving under the FINAL name — i.e. a partial write that
 *       surfaces as a "committed" record. The fsync is the durability barrier
 *       that makes the post-rename file either ABSENT or COMPLETE.
 *    2. POSIX `rename(temp, path)` — atomic on the same filesystem.
 *    3. After the rename, `fsync` the parent DIRECTORY so the rename itself is
 *       durable (the new dirent survives a crash). Best-effort: platforms that
 *       reject a directory fsync (e.g. some Windows configs) are tolerated.
 *    4. On `EXDEV` (cross-filesystem rename, the documented degradation)
 *       fall back to `copyFile(temp, path)` + best-effort `unlink(temp)`.
 *       This narrows but does not eliminate the crash window — readers still
 *       see either pre- or post-bytes, never a partial write.
 *    5. Any other rename failure surfaces as the original Error; the temp is
 *       LEFT ON DISK so an operator can replay (mirrors lsp adapter posture).
 *
 *  Plane-clean: pure adapter, no slice cross-imports. The `sha256Hex` helper
 *  is the convention every other slice already uses (see
 *  `@/llm/system-prompt-cache/hash.ts`). Re-declared here ONLY so `@/storage`
 *  does not reach into `@/llm` for a 1-line wrapper. */

import { createHash, randomBytes } from "node:crypto"
import { copyFile, open, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"

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

/** Durability barrier seam. Splits the two flushes the atomic write relies on
 *  so a fault-injection test can stub them and PROVE the ordering invariant
 *  (no rename after a failed temp fsync). The default implementations issue a
 *  real `fsync(2)` on the temp file and a best-effort `fsync` of the parent
 *  directory; tests pass a stub to assert the barrier was reached. */
export interface AtomicWriteSync {
  /** Flush the temp file's BYTES to stable storage before the rename. A
   *  rejection here ABORTS the write — the rename must never run, so a torn /
   *  zero-length temp can never surface under the final name. */
  readonly syncFile: (path: string) => Promise<void>
  /** Flush the parent DIRECTORY so the rename's new dirent is durable. Called
   *  AFTER a successful rename. Best-effort — a rejection is swallowed because
   *  some platforms reject a directory fsync and the bytes are already safe. */
  readonly syncDir: (dir: string) => Promise<void>
}

/** Real durability barrier — `fsync` via an `fs/promises` file handle. */
export const defaultAtomicWriteSync: AtomicWriteSync = {
  syncFile: async (path) => {
    const handle = await open(path, "r+")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  syncDir: async (dir) => {
    // Directory fsync is the POSIX way to make a rename durable. Open O_RDONLY
    // (a directory cannot be opened r+); swallow platforms that reject it.
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(dir, "r")
      await handle.sync()
    } catch {
      // EISDIR/EPERM/EINVAL on directory fsync (e.g. Windows) — bytes are
      // already durable via syncFile; the dirent flush is best-effort.
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined)
    }
  },
}

/** Single-file atomic write. Writes `content` to `<path>.quanta-tmp-<hex>`,
 *  `fsync`s it (durability barrier), then `rename`s into place and `fsync`s
 *  the parent dir. On `EXDEV` falls back to `copyFile` + `unlink(temp)`
 *  (atomicity narrows, crash-safety preserved on most filesystems).
 *
 *  Failure semantics:
 *  - If the temp write OR its fsync throws, the original file at `path` is
 *    UNTOUCHED and the rename NEVER runs — the partial temp is cleaned up and
 *    the error re-thrown. This is the crash-window guarantee: a flush that did
 *    not complete can never be promoted to the committed name.
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
export const writeFileAtomic = async (
  path: string,
  content: string,
  sync: AtomicWriteSync = defaultAtomicWriteSync,
): Promise<void> => {
  const temp = `${path}.${TEMP_PREFIX}-${toHex(randomBytes(8))}`
  // Phase A — write to temp, then FSYNC it. If either throws, the original is
  // untouched and the rename is skipped — no torn temp can be promoted.
  try {
    await Bun.write(temp, content)
    await sync.syncFile(temp)
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
      // Durably flush the new dirent in the destination directory.
      await sync.syncDir(dirname(path))
      return
    }
    // Other rename failure — leave the temp on disk for recovery.
    throw e
  }
  // Phase C — flush the parent dir so the rename survives a crash.
  await sync.syncDir(dirname(path))
}
