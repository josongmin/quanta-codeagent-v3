/**
 * Public types for the codebase indexer (ADR-0277).
 *
 * The indexer is a leaf primitive: it walks a workspace, chunks files,
 * and (optionally) forwards each chunk to a caller-supplied upsert
 * surface. Every cross-slice dependency is INLINE DUCK-TYPED — the slice
 * fence (ADR-0159) keeps `@/retrieval/indexer` depending on `@/shared`
 * plus `node:*` modules only.
 */

import type { CodeParserPort } from "@/retrieval/code-parser"

/** A single chunk extracted from a file. */
export interface FileChunk {
  /** Workspace-relative path with forward slashes. Stable id key prefix. */
  readonly path: string
  /** 1-based inclusive line bounds (line numbers as they appear in editors). */
  readonly startLine: number
  readonly endLine: number
  /** Raw chunk text (NOT trimmed; preserves indentation for downstream lexers). */
  readonly text: string
  /** Last modified timestamp of the source file (ms since epoch). */
  readonly mtime: number
  /** sha1 over the file's raw bytes. Used by the delta tracker. */
  readonly sha: string
}

/** Per-scan counters. */
export interface IndexStats {
  readonly filesScanned: number
  readonly filesSkipped: number
  readonly chunksProduced: number
  /** Files added since last scan (always 0 on `scanInitial`). */
  readonly added: number
  /** Files re-chunked since last scan (always 0 on `scanInitial`). */
  readonly modified: number
  /** Files deleted since last scan (always 0 on `scanInitial`). */
  readonly deleted: number
  /** Per-file skip reasons keyed by workspace-relative path. */
  readonly skipped: ReadonlyMap<string, SkipReason>
}

/** Closed reason a single file was skipped. The set is small on purpose;
 *  a new arm forces every consumer (rendering / metrics) to add the branch. */
export type SkipReason =
  | "binary"
  | "permission_denied"
  | "too_large"
  | "empty"
  | "symlink_cycle"
  | "read_failed"

/** 5-arm closed error taxonomy for the indexer surface. */
export type IndexError =
  | { readonly kind: "scan-in-progress" }
  | { readonly kind: "stopped" }
  | { readonly kind: "scan-failed"; readonly cause: unknown }
  | { readonly kind: "invalid-config"; readonly reason: string }
  | { readonly kind: "aborted" }

/** Options for the default scanner (per-instance). */
export interface ScannerOptions {
  /** Workspace root the scan is anchored at. Required. */
  readonly root: string
  /** Glob (relative to `root`) of files to consider. Default `src/**\/*.ts`. */
  readonly glob?: string
  /** Per-file byte cap. Files over this are skipped with `too_large`. Default 10 MB. */
  readonly maxBytes?: number
  /** Honour `.gitignore` / `.quantaignore` when true (default true). */
  readonly honorIgnoreFiles?: boolean
}

/** Options for the chunker (per-instance). */
export interface ChunkerOptions {
  /** Lines per chunk window. Default 50. */
  readonly windowLines?: number
  /** Overlapping lines between successive chunks. Default 20. Must be < windowLines. */
  readonly overlapLines?: number
}

/** Upsert seam — when set, every new / modified `FileChunk` flows here
 *  during a scan. Deletes go through `delete(path)`. The indexer never
 *  imports a concrete store; the wire site adapts. Both methods are
 *  fire-and-forget (the indexer awaits each call sequentially). */
export interface ChunkUpsertPort {
  upsert(chunk: FileChunk): Promise<void> | void
  delete(path: string): Promise<void> | void
}

/** Constructor options for the {@link CodebaseIndexer}. */
export interface IndexerOptions {
  readonly scanner: ScannerOptions
  readonly chunker?: ChunkerOptions
  readonly upsert?: ChunkUpsertPort
  /** RFC jun-6 — the "future LSP-symbol chunker" seam the port already names.
   *  An optional `CodeParserPort` (same `@/retrieval` slice). When present AND
   *  the `QUANTA_SYNTAX_CHUNK` knob is on, the scanner parses each supported
   *  file once and emits AST-aligned chunks (`chunkFileSyntactic`); otherwise
   *  the pure line-window `chunkFile` is used (byte-identical to today).
   *  Default absent ⇒ the parser is never consulted, no WASM loaded. */
  readonly parser?: CodeParserPort
}
