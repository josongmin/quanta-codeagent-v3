/** ADR-0155 — `sequentialFileWriteStrategy`: per-file write loop (fallback).
 *
 *  Mirrors ADR-0143 Phase-1 posture: for each entry, write content directly to
 *  the target path. If file K throws, files 1..K-1 are already on disk (best
 *  effort) and files K+1..N are still attempted — each gets its own outcome.
 *  This strategy is the fallback for filesystems where the atomic strategy
 *  cannot guarantee atomicity (today: not used by default; reserved for
 *  callers who explicitly opt out of the 2-phase commit cost). */

import {
  copyFile as fsCopyFile,
  rename as fsRename,
  unlink as fsUnlink,
  readdir,
} from "node:fs/promises"
import { errMessage } from "@/shared"
import type {
  FileWriteBatch,
  FileWriteFs,
  FileWriteOutcome,
  FileWriteStrategy,
} from "./file-write-strategy"

/** Default FS binding: `Bun.write` for writes (matches `LspClient`'s prior
 *  `writeFileText` seam), `node:fs/promises` for the rest. `unlink` swallows
 *  ENOENT so cleanup is idempotent. The sequential strategy doesn't actually
 *  CALL `copyFile` (no temp/rename → no EXDEV path) but the `FileWriteFs`
 *  contract requires it, so we bind it for completeness. */
const defaultFs = (): FileWriteFs => ({
  write: (path, content) => Bun.write(path, content),
  rename: (from, to) => fsRename(from, to),
  copyFile: (from, to) => fsCopyFile(from, to),
  unlink: (path) =>
    fsUnlink(path).catch((e: NodeJS.ErrnoException) => {
      if (e?.code === "ENOENT") return
      throw e
    }),
  listDir: (dir) => readdir(dir).catch(() => []),
})

export interface SequentialFileWriteStrategyOpts {
  /** FS shim — primarily for tests / for `LspClient` to route writes through
   *  its protected seams. Defaults to real-FS via `Bun.write` + `node:fs`. */
  readonly fs?: FileWriteFs
}

/** Build a `FileWriteStrategy` that writes each entry sequentially.
 *
 *  Failure semantics:
 *  - Per-entry — if `fs.write` throws, that entry emits `outcome.kind: "failed"`
 *    with the error message; the loop CONTINUES to the next entry. This is
 *    best-effort by design: the LSP `applyWorkspaceEdit` v1 (ADR-0143) shipped
 *    with this exact posture, and we preserve it as the fallback contract.
 *  - Abort signal — checked before each write. Once aborted, the remaining
 *    entries get `failed` with reason `"aborted"` and NO further writes happen.
 *  - Empty batch — returns `[]` synchronously (no FS calls). */
export const sequentialFileWriteStrategy = (
  opts: SequentialFileWriteStrategyOpts = {},
): FileWriteStrategy => {
  const fs = opts.fs ?? defaultFs()

  return {
    name: "sequential",
    async applyBatch(
      batch: ReadonlyArray<FileWriteBatch>,
      signal?: AbortSignal,
    ): Promise<ReadonlyArray<FileWriteOutcome>> {
      if (batch.length === 0) return []
      const out: FileWriteOutcome[] = []
      for (const entry of batch) {
        if (signal?.aborted) {
          out.push({ kind: "failed", path: entry.path, reason: "aborted" })
          continue
        }
        try {
          await fs.write(entry.path, entry.content)
          out.push({ kind: "ok", path: entry.path })
        } catch (e) {
          out.push({
            kind: "failed",
            path: entry.path,
            reason: errMessage(e),
          })
        }
      }
      return out
    },
  }
}
