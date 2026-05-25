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
import type {
  ChunkerOptions,
  ChunkUpsertPort,
  FileChunk,
  IndexError,
  IndexStats,
} from "./types"

export interface HeadlessIndexerOpts {
  /** Mutable map the test controls — additions / deletions reflect in
   *  the next `scanDelta` call. */
  readonly files: Map<string, { readonly text: string; readonly mtime: number }>
  readonly chunker?: ChunkerOptions
  readonly upsert?: ChunkUpsertPort
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
      const changed = mode === "initial" ? Array.from(snap.keys()) : [
        ...parts.added,
        ...parts.modified,
      ]
      const newChunks = new Map<string, readonly FileChunk[]>()
      for (const path of changed) {
        if (scanOpts.signal?.aborted) return err({ kind: "aborted" as const })
        const entry = opts.files.get(path)
        if (entry === undefined) continue
        const sha = snap.get(path)?.sha ?? ""
        const chunks = chunkFile(
          { path, text: entry.text, mtime: entry.mtime, sha },
          opts.chunker ?? {},
        )
        if (chunks.length > 0) newChunks.set(path, chunks)
      }
      if (opts.upsert !== undefined) {
        for (const path of changed) {
          if (scanOpts.signal?.aborted) return err({ kind: "aborted" as const })
          for (const c of newChunks.get(path) ?? []) await opts.upsert.upsert(c)
        }
        for (const path of parts.deleted) {
          if (scanOpts.signal?.aborted) return err({ kind: "aborted" as const })
          await opts.upsert.delete(path)
        }
      }
      for (const path of parts.deleted) corpus.delete(path)
      for (const [path, c] of newChunks) corpus.set(path, c)
      for (const path of parts.deleted) tracker.delete(path)
      for (const [path, stamp] of snap) tracker.put(path, stamp)
      let chunksProduced = 0
      for (const c of newChunks.values()) chunksProduced += c.length
      return ok({
        filesScanned: snap.size,
        filesSkipped: 0,
        chunksProduced,
        added: mode === "initial" ? snap.size : parts.added.length,
        modified: mode === "initial" ? 0 : parts.modified.length,
        deleted: mode === "initial" ? 0 : parts.deleted.length,
        skipped: new Map(),
      })
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
