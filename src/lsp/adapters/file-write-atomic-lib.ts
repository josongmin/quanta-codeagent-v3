/** ADR-0185 — `atomicLibFileWriteStrategy`: write-file-atomic (npm) adapter.
 *
 *  User principle: "외부에 잘 만들어진 거 있으면 외부 거 써." Sibling to ADR-0155
 *  `atomicFileWriteStrategy` (self-impl, kept for zero-dep callers). The public
 *  `FileWriteStrategy` port (ADR-0155) stays byte-identical — only `name`
 *  differs (`"atomic-temp-rename-lib"` vs `"atomic-temp-rename"`).
 *
 *  Delegates the temp+rename mechanics to `write-file-atomic@8` (npm, 150K
 *  downloads/wk, maintained by GitHub/npm). The lib internally:
 *    - generates cryptographically-named temp files (sha1 of `__filename + pid +
 *      threadId + invocation`) — no collision under parallel batches.
 *    - opens the temp with the supplied mode (or the existing file's mode), or
 *      0o666 default for a new file.
 *    - writes + `fsync` (default true; durability guarantee).
 *    - `rename(tmp, target)` — POSIX atomic on the same filesystem.
 *    - hooks `signal-exit` to unlink the temp on process abort.
 *    - serializes concurrent writes to the SAME absolute path internally
 *      (per-path queue) — concurrent writes to DIFFERENT paths still parallel.
 *
 *  Mirrors our self-impl posture: per-file isolation (one entry failing does
 *  not block the next), no batch-wide atomicity across files (same caveat as
 *  the self-impl — both adapters commit file-by-file). Differences:
 *    - lib's EXDEV (cross-FS) fallback is internal and opaque — we cannot
 *      observe it from outside, so no `warning: "non-atomic-fallback"` flag
 *      is surfaced for that path (documented trade-off).
 *    - lib does NOT accept an `AbortSignal` parameter — we check `signal`
 *      cooperatively at the per-entry boundary (before each `writeFile` call),
 *      matching the sequential adapter's abort semantics. */

import writeFileAtomic, { type WriteFileOptions } from "write-file-atomic"
import type { FileWriteBatch, FileWriteOutcome, FileWriteStrategy } from "./file-write-strategy"

export interface AtomicLibStrategyOpts {
  /** Chmod mode (octal) for the written file. Default: preserve existing
   *  file's mode (lib `stat`s the target) or `0o666` for new files. */
  readonly mode?: number
  /** `fsync` the temp fd before rename. Default: `true` (lib default — gives
   *  the durability guarantee on power-loss; pass `false` to trade durability
   *  for throughput on bulk writes that the caller will fsync separately). */
  readonly fsync?: boolean
}

/** Build a `FileWriteStrategy` that delegates per-file atomic writes to
 *  `write-file-atomic`. See module docstring for full semantics. */
export const atomicLibFileWriteStrategy = (opts: AtomicLibStrategyOpts = {}): FileWriteStrategy => {
  // Pre-build the options object the lib expects. We pass it per-call so each
  // entry sees the same shape; `mode` / `fsync` are omitted (not set to
  // `undefined`) when not configured — exactOptional friendly.
  const baseOpts: WriteFileOptions = {}
  if (opts.mode !== undefined) baseOpts.mode = opts.mode
  if (opts.fsync !== undefined) baseOpts.fsync = opts.fsync

  /** Apply a single entry. Returns its `FileWriteOutcome`. Extracted from the
   *  loop so the loop's cyclomatic complexity stays under biome's noExcessive
   *  cap. `signal` is checked HERE (not in the loop) so the per-entry guard
   *  and the lib call are co-located. */
  const applyOne = async (
    entry: FileWriteBatch,
    signal: AbortSignal | undefined,
  ): Promise<FileWriteOutcome> => {
    // Honor signal at the per-entry boundary. Lib has no signal hook; once a
    // call enters lib's write+fsync+rename pipeline we can't cancel it — but
    // we CAN stop launching new writes.
    if (signal?.aborted) {
      return { kind: "failed", path: entry.path, reason: "aborted" }
    }
    try {
      await writeFileAtomic(entry.path, entry.content, baseOpts)
      return { kind: "ok", path: entry.path }
    } catch (e) {
      return {
        kind: "failed",
        path: entry.path,
        reason: e instanceof Error ? e.message : String(e),
      }
    }
  }

  return {
    name: "atomic-temp-rename-lib",
    async applyBatch(
      batch: ReadonlyArray<FileWriteBatch>,
      signal?: AbortSignal,
    ): Promise<ReadonlyArray<FileWriteOutcome>> {
      if (batch.length === 0) return []

      // Pre-flight abort: nothing has been written yet → ALL entries failed.
      // Matches the self-impl's pre-flight semantics so the adapters are
      // interchangeable from the caller's POV.
      if (signal?.aborted) {
        return batch.map(
          (b): FileWriteOutcome => ({ kind: "failed", path: b.path, reason: "aborted" }),
        )
      }

      // Per-file loop. The lib internally serializes same-path writes; we run
      // entries sequentially here to match the self-impl's behavior under
      // failure (the next entry is still attempted — per-file isolation —
      // but we never run two writes concurrently from the same batch).
      const outcomes: FileWriteOutcome[] = []
      for (const entry of batch) {
        outcomes.push(await applyOne(entry, signal))
      }
      return outcomes
    },
  }
}
