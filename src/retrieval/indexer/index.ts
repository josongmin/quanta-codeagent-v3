/**
 * `@/retrieval/indexer` sub-barrel — ADR-0277.
 *
 * Public surface: the `CodebaseIndexer` port, the default scanner /
 * chunker / delta tracker primitives, and the headless test stub. The
 * indexer slice is leaf — it depends on `@/shared` plus `node:*` only.
 */

export {
  type ChunkInput,
  chunkFile,
  DEFAULT_OVERLAP_LINES,
  DEFAULT_WINDOW_LINES,
} from "./chunker"
export {
  chunkFileSyntactic,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_LINES_SPLIT,
  type SyntacticChunkOptions,
} from "./chunker-syntactic"
export { createDefaultIndexer } from "./default-scanner"
export {
  type DeltaPartition,
  DeltaTracker,
  type FileStamp,
} from "./delta-tracker"
export { type HeadlessIndexerOpts, headlessIndexerStub } from "./headless-stub"
export type { CodebaseIndexer, ScanOptions } from "./port"
export type {
  ChunkerOptions,
  ChunkUpsertPort,
  FileChunk,
  IndexError,
  IndexerOptions,
  IndexStats,
  ScannerOptions,
  SkipReason,
} from "./types"
