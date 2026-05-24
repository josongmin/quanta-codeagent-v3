/** ADR-0155 — `atomicFileWriteStrategy`: 2-phase temp+rename commit (default).
 *
 *  Closes ADR-0143's deferred Phase-2 atomicity gap by hexagonalizing the
 *  ADR-0152 in-`LspClient` logic into a reusable strategy. An N-file edit is
 *  either FULLY APPLIED or FULLY ABORTED (Phase-A failure) — modulo the
 *  documented Phase-B partial-success window (POSIX rename is destructive on
 *  its target, so once K of N renames succeed, rolling back K requires
 *  preserved originals we don't keep). Phase-B failures are exceedingly rare
 *  on the same filesystem; the most common cause is cross-FS rename (`EXDEV`)
 *  which we handle via copy+delete fallback flagged as `warning`.
 *
 *  Phases:
 *    A. Prepare — for each entry, write content to `<path>.<tempPrefix>-<rand>`.
 *       If ANY temp write fails: unlink every already-written temp, then mark
 *       the failed entry + every later entry as `failed` (aborted). NO original
 *       file is touched.
 *    B. Commit — for each successful temp, `rename(temp, original)`. If rename
 *       fails with `EXDEV`, fall back to write-to-original + unlink-temp (this
 *       loses atomicity for that file → outcome carries `warning`). Any other
 *       rename failure marks that path failed + leaves the remaining temps on
 *       disk (caller can recover by scanning for the temp prefix). */

import { randomBytes } from "node:crypto"
import {
  copyFile as fsCopyFile,
  rename as fsRename,
  unlink as fsUnlink,
  readdir,
} from "node:fs/promises"
import type {
  FileWriteBatch,
  FileWriteFs,
  FileWriteOutcome,
  FileWriteStrategy,
} from "./file-write-strategy"

interface ErrnoLike {
  readonly code?: string
}

const isExdev = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false
  const code = (e as ErrnoLike).code
  return code === "EXDEV"
}

/** Default FS binding — real-FS via `Bun.write` + `node:fs/promises`. `unlink`
 *  swallows ENOENT so cleanup remains idempotent. */
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

const defaultRandomBytes = (): Uint8Array => randomBytes(8)

const toHex = (bytes: Uint8Array): string => {
  let s = ""
  for (const b of bytes) s += b.toString(16).padStart(2, "0")
  return s
}

export interface AtomicFileWriteStrategyOpts {
  /** FS shim — for tests / `LspClient` seam injection. Default = real FS. */
  readonly fs?: FileWriteFs
  /** Prefix between `path` and the random suffix. Default `"quanta-tmp"`.
   *  Final temp path = `<path>.<tempPrefix>-<hex>`. Custom prefixes are useful
   *  when the caller wants to namespace temps for later sweeps. */
  readonly tempPrefix?: string
  /** Random byte source (≥4 bytes recommended). Default `crypto.randomBytes(8)`.
   *  Tests pass a deterministic generator to assert on temp-path shape. */
  readonly randomBytes?: () => Uint8Array
}

/** Build the 2-phase commit strategy. See module docstring for semantics. */
export const atomicFileWriteStrategy = (
  opts: AtomicFileWriteStrategyOpts = {},
): FileWriteStrategy => {
  const fs = opts.fs ?? defaultFs()
  const tempPrefix = opts.tempPrefix ?? "quanta-tmp"
  const rand = opts.randomBytes ?? defaultRandomBytes

  const makeTempPath = (path: string): string => `${path}.${tempPrefix}-${toHex(rand())}`

  return {
    name: "atomic-temp-rename",
    async applyBatch(
      batch: ReadonlyArray<FileWriteBatch>,
      signal?: AbortSignal,
    ): Promise<ReadonlyArray<FileWriteOutcome>> {
      if (batch.length === 0) return []

      // Pre-flight abort: nothing has happened yet → ALL entries failed.
      if (signal?.aborted) {
        return batch.map(
          (b): FileWriteOutcome => ({ kind: "failed", path: b.path, reason: "aborted" }),
        )
      }

      // ── Phase A: prepare temps ──────────────────────────────────────────
      // Walk batch in order; on first failure (write throw OR signal abort)
      // stop, unlink every temp written so far, and mark THIS entry + every
      // later entry as failed. Originals are never touched in Phase A.
      const prepared: { tempPath: string; entry: FileWriteBatch }[] = []
      let phaseAFailIndex = -1
      let phaseAFailReason = ""
      for (let i = 0; i < batch.length; i++) {
        const entry = batch[i]
        if (!entry) continue
        if (signal?.aborted) {
          phaseAFailIndex = i
          phaseAFailReason = "aborted"
          break
        }
        const tempPath = makeTempPath(entry.path)
        try {
          await fs.write(tempPath, entry.content)
          prepared.push({ tempPath, entry })
        } catch (e) {
          phaseAFailIndex = i
          phaseAFailReason = e instanceof Error ? e.message : String(e)
          break
        }
      }

      if (phaseAFailIndex >= 0) {
        // Rollback every prepared temp; cleanup errors are swallowed
        // (best-effort — the rollback must not mask the original failure).
        for (const { tempPath } of prepared) {
          await fs.unlink(tempPath).catch(() => undefined)
        }
        // Mark every batch entry as failed: the ones we attempted (0..fail-1)
        // had their temps rolled back; the failing entry carries its reason;
        // the rest were never attempted (aborted by the upstream failure).
        return batch.map((b, i): FileWriteOutcome => {
          if (i < phaseAFailIndex) {
            return { kind: "failed", path: b.path, reason: "aborted: prior entry failed" }
          }
          if (i === phaseAFailIndex) {
            return { kind: "failed", path: b.path, reason: phaseAFailReason }
          }
          return { kind: "failed", path: b.path, reason: "aborted: prior entry failed" }
        })
      }

      // ── Phase B: commit ─────────────────────────────────────────────────
      // POSIX rename is atomic on the same filesystem. EXDEV (cross-FS) is
      // the documented degradation; copy+delete keeps the data flowing but
      // surfaces `warning: "non-atomic-fallback"` so the caller knows that
      // file is no longer crash-atomic. Other rename failures mark that
      // entry failed + leave remaining temps on disk for caller recovery.
      const outcomes: FileWriteOutcome[] = []
      let commitFailed = false
      for (let i = 0; i < prepared.length; i++) {
        const { tempPath, entry } = prepared[i] as { tempPath: string; entry: FileWriteBatch }
        if (commitFailed) {
          // Once a commit fails mid-way, the spec is: don't keep mutating —
          // surface the remaining as failed. Their temps remain on disk for
          // the caller to recover (atomic strategy explicitly does NOT
          // clean up remaining temps after a commit-mid failure so the
          // operator can inspect / replay).
          outcomes.push({
            kind: "failed",
            path: entry.path,
            reason: "aborted: prior commit failed (temp file remains for recovery)",
          })
          continue
        }
        // Signal abort mid-Phase-B: rename(K) already committed (destructive
        // on K's prior content). We surface K+1..N as failed-aborted. The
        // commit is partial — that's the cost of mid-flight cancellation on
        // a destructive op. Documented in the ADR.
        if (signal?.aborted) {
          outcomes.push({
            kind: "failed",
            path: entry.path,
            reason: "aborted: signal raised mid-commit (temp file remains for recovery)",
          })
          commitFailed = true
          continue
        }
        try {
          await fs.rename(tempPath, entry.path)
          outcomes.push({ kind: "ok", path: entry.path })
        } catch (e) {
          if (isExdev(e)) {
            // Cross-FS fallback: copy the temp file's bytes onto the original
            // (writes a new inode — readers see either pre- or post-content,
            // not a partial write) then unlink the temp. This loses crash-
            // atomicity for this file (window between copy + unlink), so the
            // outcome carries `warning: "non-atomic-fallback"` to surface the
            // degradation. If copy ALSO fails, mark failed and stop committing.
            try {
              await fs.copyFile(tempPath, entry.path)
              await fs.unlink(tempPath).catch(() => undefined)
              outcomes.push({
                kind: "ok",
                path: entry.path,
                warning: "non-atomic-fallback: cross-fs rename (EXDEV) fell back to copyFile",
              })
              continue
            } catch (copyErr) {
              outcomes.push({
                kind: "failed",
                path: entry.path,
                reason: `EXDEV cross-fs rename + copyFile fallback failed: ${
                  copyErr instanceof Error ? copyErr.message : String(copyErr)
                }`,
              })
              commitFailed = true
              continue
            }
          }
          outcomes.push({
            kind: "failed",
            path: entry.path,
            reason: e instanceof Error ? e.message : String(e),
          })
          commitFailed = true
        }
      }
      return outcomes
    },
  }
}
