/**
 * `@/retrieval/indexer` sub-barrel — ADR-0277.
 *
 * Public surface: the `CodebaseIndexer` port, the default scanner /
 * chunker / delta tracker primitives, and the headless test stub. The
 * indexer slice is leaf — it depends on `@/shared` plus `node:*` only.
 */

export {
  chunkFile,
  type ChunkInput,
  DEFAULT_OVERLAP_LINES,
  DEFAULT_WINDOW_LINES,
} from "./chunker"
export { createDefaultIndexer } from "./default-scanner"
export {
  type DeltaPartition,
  DeltaTracker,
  type FileStamp,
} from "./delta-tracker"
export { headlessIndexerStub, type HeadlessIndexerOpts } from "./headless-stub"
export type { CodebaseIndexer, ScanOptions } from "./port"
export type {
  ChunkerOptions,
  ChunkUpsertPort,
  FileChunk,
  IndexerOptions,
  IndexError,
  IndexStats,
  ScannerOptions,
  SkipReason,
} from "./types"
