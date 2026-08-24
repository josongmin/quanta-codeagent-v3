/**
 * Deterministic headless stub indexer (ADR-0277).
 *
 * No FS access — the caller provides the corpus as a map of `relPath →
 * file content`. Useful for tests that exercise the upsert seam, the
 * delta tracker, and the `Tool` wrapper without a real workspace.
 *
 * Each `scanInitial` / `scanDelta` invocation walks the injected map,
 * hashes contents, and applies the same delta semantics as the real
 * scanner.
 */

import { createHash } from "node:crypto"
import { err, ok, type Result } from "@/shared"
import { chunkFile } from "./chunker"
import { DeltaTracker, type FileStamp } from "./delta-tracker"
import type { CodebaseIndexer, ScanOptions } from "./port"
import type { ChunkerOptions, ChunkUpsertPort, FileChunk, IndexError, IndexStats } from "./types"

export interface HeadlessIndexerOpts {
  /** Mutable map the test controls — additions / deletions reflect in
   *  the next `scanDelta` call. */
  readonly files: Map<string, { readonly text: string; readonly mtime: number }>
  readonly chunker?: ChunkerOptions
  readonly upsert?: ChunkUpsertPort
}

/** Project a completed stub scan into {@link IndexStats}. Pure — the `initial`
 *  convention (report EVERYTHING as added, whatever the tracker knew) is the
 *  only thing the `mode` ternaries encode, and it is worth reading on its own. */
const headlessStats = (
  mode: "initial" | "delta",
  snap: ReadonlyMap<string, FileStamp>,
  parts: {
    readonly added: readonly string[]
    readonly modified: readonly string[]
    readonly deleted: readonly string[]
  },
  newChunks: ReadonlyMap<string, readonly FileChunk[]>,
): IndexStats => {
  let chunksProduced = 0
  for (const c of newChunks.values()) chunksProduced += c.length
  return {
    filesScanned: snap.size,
    filesSkipped: 0,
    chunksProduced,
    added: mode === "initial" ? snap.size : parts.added.length,
    modified: mode === "initial" ? 0 : parts.modified.length,
    deleted: mode === "initial" ? 0 : parts.deleted.length,
    skipped: new Map(),
  }
}

export const headlessIndexerStub = (opts: HeadlessIndexerOpts): CodebaseIndexer => {
  const tracker = new DeltaTracker()
  const corpus = new Map<string, readonly FileChunk[]>()
  let scanning = false
  let stopped = false

  const snapshot = (): Map<string, FileStamp> => {
    const out = new Map<string, FileStamp>()
    for (const [path, { text, mtime }] of opts.files) {
      const sha = createHash("sha1").update(text).digest("hex")
      out.set(path, { mtime, sha })
    }
    return out
  }

  /** Chunk every changed path. `null` means the scan was aborted part-way —
   *  the signal is polled between files, exactly as it was inline, so an abort
   *  is observed at the same granularity as before. */
  const chunkChanged = (
    changed: readonly string[],
    snap: Map<string, FileStamp>,
    signal: AbortSignal | undefined,
  ): Map<string, readonly FileChunk[]> | null => {
    const newChunks = new Map<string, readonly FileChunk[]>()
    for (const path of changed) {
      if (signal?.aborted) return null
      const entry = opts.files.get(path)
      if (entry === undefined) continue
      const sha = snap.get(path)?.sha ?? ""
      const chunks = chunkFile(
        { path, text: entry.text, mtime: entry.mtime, sha },
        opts.chunker ?? {},
      )
      if (chunks.length > 0) newChunks.set(path, chunks)
    }
    return newChunks
  }

  /** Push the scan through the upsert seam. `false` means aborted part-way. A
   *  port that throws is NOT caught here — `runScan` turns it into
   *  `scan-failed`, which is the stub's contract. */
  const upsertChunks = async (
    port: ChunkUpsertPort,
    changed: readonly string[],
    newChunks: ReadonlyMap<string, readonly FileChunk[]>,
    signal: AbortSignal | undefined,
  ): Promise<boolean> => {
    for (const path of changed) {
      if (signal?.aborted) return false
      for (const c of newChunks.get(path) ?? []) await port.upsert(c)
    }
    return true
  }

  const deleteRemoved = async (
    port: ChunkUpsertPort,
    deleted: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<boolean> => {
    for (const path of deleted) {
      if (signal?.aborted) return false
      await port.delete(path)
    }
    return true
  }

  const flushUpserts = async (
    changed: readonly string[],
    deleted: readonly string[],
    newChunks: ReadonlyMap<string, readonly FileChunk[]>,
    signal: AbortSignal | undefined,
  ): Promise<boolean> => {
    const port = opts.upsert
    if (port === undefined) return true
    // `&&` short-circuits, which is the original behaviour: an abort part-way
    // through the upserts skips the deletes entirely.
    return (
      (await upsertChunks(port, changed, newChunks, signal)) &&
      (await deleteRemoved(port, deleted, signal))
    )
  }

  /** Land the scan in the corpus and the tracker — deletions first, then the
   *  scan's own view, matching the real scanner's ordering. */
  const commitScan = (
    snap: Map<string, FileStamp>,
    deleted: readonly string[],
    newChunks: ReadonlyMap<string, readonly FileChunk[]>,
  ): void => {
    for (const path of deleted) corpus.delete(path)
    for (const [path, c] of newChunks) corpus.set(path, c)
    for (const path of deleted) tracker.delete(path)
    for (const [path, stamp] of snap) tracker.put(path, stamp)
  }

  const runScan = async (
    mode: "initial" | "delta",
    scanOpts: ScanOptions,
  ): Promise<Result<IndexStats, IndexError>> => {
    if (stopped) return err({ kind: "stopped" as const })
    if (scanning) return err({ kind: "scan-in-progress" as const })
    if (scanOpts.signal?.aborted) return err({ kind: "aborted" as const })
    scanning = true
    try {
      const snap = snapshot()
      const parts = tracker.diff(snap)
      const changed =
        mode === "initial" ? Array.from(snap.keys()) : [...parts.added, ...parts.modified]
      const newChunks = chunkChanged(changed, snap, scanOpts.signal)
      if (newChunks === null) return err({ kind: "aborted" as const })
      if (!(await flushUpserts(changed, parts.deleted, newChunks, scanOpts.signal))) {
        return err({ kind: "aborted" as const })
      }
      commitScan(snap, parts.deleted, newChunks)
      return ok(headlessStats(mode, snap, parts, newChunks))
    } catch (cause) {
      return err({ kind: "scan-failed" as const, cause })
    } finally {
      scanning = false
    }
  }

  return {
    scanInitial: (so = {}) => runScan("initial", so),
    scanDelta: (so = {}) => runScan("delta", so),
    *getCorpus(): Iterable<FileChunk> {
      const snap: FileChunk[] = []
      for (const chunks of corpus.values()) for (const c of chunks) snap.push(c)
      for (const c of snap) yield c
    },
    stop(): void {
      stopped = true
    },
  }
}
