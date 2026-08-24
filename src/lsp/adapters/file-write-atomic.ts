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
import { errMessage } from "@/shared"
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

/** One prepared Phase-A temp: the temp path plus the entry it will commit. */
interface PreparedTemp {
  readonly tempPath: string
  readonly entry: FileWriteBatch
}

/** Phase-A result. `failIndex < 0` ⇒ every entry got a temp. */
interface PrepareResult {
  readonly prepared: ReadonlyArray<PreparedTemp>
  readonly failIndex: number
  readonly failReason: string
}

const failed = (path: string, reason: string): FileWriteOutcome => ({
  kind: "failed",
  path,
  reason,
})

/** Reason strings are part of the wire contract (callers surface them verbatim
 *  and tests pin them) — table, so a phase can never drift its own wording. */
const REASON = {
  aborted: "aborted",
  priorEntryFailed: "aborted: prior entry failed",
  priorCommitFailed: "aborted: prior commit failed (temp file remains for recovery)",
  abortedMidCommit: "aborted: signal raised mid-commit (temp file remains for recovery)",
  exdevFallback: "non-atomic-fallback: cross-fs rename (EXDEV) fell back to copyFile",
} as const

/** Phase A — write every entry's content to its temp path, in batch order.
 *  Stops at the FIRST failure (write throw OR signal abort) and reports where.
 *  Never touches an original file; the caller rolls back what was prepared. */
const prepareTemps = async (
  fs: FileWriteFs,
  batch: ReadonlyArray<FileWriteBatch>,
  makeTempPath: (path: string) => string,
  signal: AbortSignal | undefined,
): Promise<PrepareResult> => {
  const prepared: PreparedTemp[] = []
  for (let i = 0; i < batch.length; i++) {
    const entry = batch[i]
    if (!entry) continue
    if (signal?.aborted) return { prepared, failIndex: i, failReason: REASON.aborted }
    const tempPath = makeTempPath(entry.path)
    try {
      await fs.write(tempPath, entry.content)
      prepared.push({ tempPath, entry })
    } catch (e) {
      return { prepared, failIndex: i, failReason: errMessage(e) }
    }
  }
  return { prepared, failIndex: -1, failReason: "" }
}

/** Phase-A rollback: unlink every temp already written, in preparation order.
 *  Cleanup errors are swallowed — the rollback must not mask the real failure. */
const rollbackTemps = async (
  fs: FileWriteFs,
  prepared: ReadonlyArray<PreparedTemp>,
): Promise<void> => {
  for (const { tempPath } of prepared) {
    await fs.unlink(tempPath).catch(() => undefined)
  }
}

/** Phase-A abort outcome set: every entry failed. The failing entry carries its
 *  own reason; every OTHER entry (rolled back before it, or never attempted
 *  after it) carries the same `prior entry failed` reason — the two sides of
 *  `failIndex` were spelled out separately but always agreed. */
const phaseAFailureOutcomes = (
  batch: ReadonlyArray<FileWriteBatch>,
  failIndex: number,
  failReason: string,
): ReadonlyArray<FileWriteOutcome> =>
  batch.map((b, i) => failed(b.path, i === failIndex ? failReason : REASON.priorEntryFailed))

/** Outcome of committing ONE prepared temp. `stop` ⇒ the batch must not commit
 *  any further entry (their temps stay on disk for operator recovery). */
interface CommitStep {
  readonly outcome: FileWriteOutcome
  readonly stop: boolean
}

/** EXDEV fallback: copy the temp's bytes onto the original (new inode ⇒ readers
 *  see pre- or post-content, never a partial write) then drop the temp. Loses
 *  crash-atomicity for this file, so the outcome carries a `warning`. The
 *  copy MUST precede the unlink — unlinking first would destroy the only good
 *  copy of the content if the copy then failed. */
const commitViaCopyFallback = async (
  fs: FileWriteFs,
  tempPath: string,
  path: string,
): Promise<CommitStep> => {
  try {
    await fs.copyFile(tempPath, path)
    await fs.unlink(tempPath).catch(() => undefined)
    return { outcome: { kind: "ok", path, warning: REASON.exdevFallback }, stop: false }
  } catch (copyErr) {
    return {
      outcome: failed(
        path,
        `EXDEV cross-fs rename + copyFile fallback failed: ${errMessage(copyErr)}`,
      ),
      stop: true,
    }
  }
}

/** Phase-B single commit: POSIX `rename(temp, original)`, with the documented
 *  EXDEV copy+delete degradation. Any other rename failure stops the batch. */
const commitOne = async (fs: FileWriteFs, tempPath: string, path: string): Promise<CommitStep> => {
  try {
    await fs.rename(tempPath, path)
    return { outcome: { kind: "ok", path }, stop: false }
  } catch (e) {
    if (isExdev(e)) return commitViaCopyFallback(fs, tempPath, path)
    return { outcome: failed(path, errMessage(e)), stop: true }
  }
}

/** Phase B — commit prepared temps in order. Three per-entry states, one place:
 *  already-dead (a prior commit failed) ⇒ failed; live-but-aborted ⇒ failed and
 *  the batch dies; otherwise attempt the commit and adopt its `stop`. */
const commitPrepared = async (
  fs: FileWriteFs,
  prepared: ReadonlyArray<PreparedTemp>,
  signal: AbortSignal | undefined,
): Promise<ReadonlyArray<FileWriteOutcome>> => {
  const outcomes: FileWriteOutcome[] = []
  let commitFailed = false
  for (const { tempPath, entry } of prepared) {
    if (commitFailed) {
      outcomes.push(failed(entry.path, REASON.priorCommitFailed))
      continue
    }
    if (signal?.aborted) {
      outcomes.push(failed(entry.path, REASON.abortedMidCommit))
      commitFailed = true
      continue
    }
    const step = await commitOne(fs, tempPath, entry.path)
    outcomes.push(step.outcome)
    commitFailed = step.stop
  }
  return outcomes
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

      // Pre-flight abort: nothing has happened yet -> ALL entries failed.
      if (signal?.aborted) return batch.map((b) => failed(b.path, REASON.aborted))

      // Phase A: every temp is written BEFORE any original is touched.
      const { prepared, failIndex, failReason } = await prepareTemps(
        fs,
        batch,
        makeTempPath,
        signal,
      )
      if (failIndex >= 0) {
        await rollbackTemps(fs, prepared)
        return phaseAFailureOutcomes(batch, failIndex, failReason)
      }

      // Phase B: commit, in the same order the temps were prepared.
      return commitPrepared(fs, prepared, signal)
    },
  }
}
