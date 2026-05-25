/**
 * `CodebaseIndexer` port (ADR-0277).
 *
 * The narrow closed surface every concrete indexer (default scanner,
 * headless stub, future LSP-symbol chunker) honours. Callers in
 * `@/apps/agent` reach IN to construct the default impl; the slice
 * fence (ADR-0159) keeps the reverse forbidden.
 */

import type { Result } from "@/shared"
import type { FileChunk, IndexError, IndexStats } from "./types"

export interface ScanOptions {
  /** Caller-supplied cancellation. The indexer checks this at every
   *  await boundary and resolves with `Err("aborted")` on cancel. */
  readonly signal?: AbortSignal
}

export interface CodebaseIndexer {
  /** Walk the workspace from scratch; populate the corpus. Idempotent
   *  (calling twice produces the same corpus); the second concurrent
   *  call resolves with `Err("scan-in-progress")`. */
  scanInitial(opts?: ScanOptions): Promise<Result<IndexStats, IndexError>>
  /** Walk again and apply only the (added / modified / deleted)
   *  differences against the in-memory delta tracker. */
  scanDelta(opts?: ScanOptions): Promise<Result<IndexStats, IndexError>>
  /** Snapshot iterator over the current corpus. NOT live — mutations
   *  to the indexer state during iteration are NOT observed by the
   *  returned iterable. */
  getCorpus(): Iterable<FileChunk>
  /** Mark the indexer permanently stopped. Subsequent scan calls
   *  resolve with `Err("stopped")`. Safe to call multiple times. */
  stop(): void
}

export type { FileChunk, IndexError, IndexStats }
