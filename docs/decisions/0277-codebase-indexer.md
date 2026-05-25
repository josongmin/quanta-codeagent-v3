# ADR-0277: Codebase indexer slice

- **Status**: Accepted
- **Date**: 2026-05-25
- **Related**: ADR-0159 (`@/retrieval` slice fence), ADR-0260
  (lexical-search BM25 / ripgrep), ADR-0261 (pluggable Embedder /
  VectorStore registry), ADR-0265 (SearchPipeline composer),
  ADR-0278 (auto-register wire that consumes this slice).
- **References**:
  - `src/retrieval/indexer/types.ts` — `FileChunk`, `IndexStats`,
    `IndexError` 5-arm closed taxonomy, `ScannerOptions`,
    `IndexerOptions`.
  - `src/retrieval/indexer/port.ts` — `CodebaseIndexer { scanInitial,
    scanDelta, getCorpus, stop }`.
  - `src/retrieval/indexer/chunker.ts` — pure line-window chunker
    (default 50 lines / 20 overlap), configurable.
  - `src/retrieval/indexer/delta-tracker.ts` — `Map<path,{mtime,sha}>`
    diff detection (additions / modifications / deletions).
  - `src/retrieval/indexer/default-scanner.ts` — glob walk with
    `.gitignore` / `.quantaignore` parsing (blank line, `#` comment,
    `!` negation), symlink-loop detection, byte-size cap, EACCES skip.
  - `src/retrieval/indexer/headless-stub.ts` — deterministic test stub
    (no FS).
  - `src/retrieval/indexer/index.ts` — sub-barrel.
  - `tests/unit/retrieval/indexer-hellgate.test.ts` — 25 adversarial
    cases (HELL-IDX-01 … HELL-IDX-25).

## Context

Cursor opens a repo and starts a background indexer: glob → chunk →
embed → upsert into a vector store. File mtime watch drives an
incremental delta scan. `semantic_search` is then the default tool.

Today our `@/retrieval` slice ships the BM25 lexical engine
(ADR-0260), the pluggable Embedder + VectorStore registry (ADR-0261),
the SearchPipeline composer + 5 presets (ADR-0265), and the
`runHybridQuery` 3-stage funnel — but **nothing scans the workspace
into a corpus**. The pipeline has shape, no fuel.

A naïve "walk + read + chunk" written inline at the agent assembly
site would be wrong on at least seven boundaries: gitignore semantics,
symlink cycles, binary detection, huge-file caps, EACCES handling,
delta detection, and concurrent scan safety. Each is a known footgun;
each deserves a closed adversarial case.

## Decision

Ship a brand-new sub-slice `src/retrieval/indexer/` that exposes a
single closed port:

```ts
export interface CodebaseIndexer {
  scanInitial(opts?: { signal?: AbortSignal }): Promise<Result<IndexStats, IndexError>>
  scanDelta(opts?: { signal?: AbortSignal }):  Promise<Result<IndexStats, IndexError>>
  getCorpus(): Iterable<FileChunk>
  stop(): void
}
```

Behaviour:

1. **Pure walk** — `default-scanner.ts` walks `root` honouring
   `.gitignore` and `.quantaignore`. Blank lines and `#` comments are
   skipped; `!pattern` re-includes a prior-excluded path (gitignore
   semantics). The walker tracks visited inodes (`dev:ino`) to
   short-circuit symlink cycles (A→B→A). Per-file gates: byte size
   cap (default 10 MB, configurable), UTF-8 decode failure ⇒ skip
   with `degradeReason: "binary"`, EACCES ⇒ skip with
   `degradeReason: "permission_denied"`, 0-byte file ⇒ skip (no
   chunk).
2. **Pure chunker** — `chunker.ts` slices a file's content into
   `FileChunk`s using a line-window with overlap (default 50 lines
   per chunk, 20-line overlap). Pure function — no clock, no I/O.
3. **Delta tracker** — a `Map<path, { mtime, sha }>`. `scanDelta`
   walks again, compares (mtime, sha) per file: equal ⇒ skip,
   different ⇒ re-chunk + upsert, missing ⇒ delete. File rename is
   modelled as delete-of-old + add-of-new (no rename detection in
   v1).
4. **Concurrent scan guard** — a re-entrancy flag forces the second
   concurrent `scanInitial` / `scanDelta` call to resolve with
   `Err("scan-in-progress")`. There is no queue; callers retry.
5. **AbortSignal honoured at every loop boundary**. A mid-scan abort
   leaves the corpus in a partial-but-consistent state (every chunk
   the upsert seam saw before abort stays, no half-files).
6. **Closed error taxonomy (5-arm)** — `IndexError` enumerates every
   non-success path: `scan-in-progress`, `stopped`, `scan-failed`,
   `invalid-config`, `aborted`. A new arm forces every consumer to
   add the missing branch.
7. **Default-OFF**. Nothing in `@/agent` / `@/runner` / `@/apps`
   constructs an indexer at module load. The composition root wires
   it conditionally (ADR-0278).

## Slice fence

The indexer lives **inside** `@/retrieval` and depends on `@/shared`
plus `node:fs` / `node:path` / `node:crypto` only. It NEVER imports
`@/agent`, `@/tool`, `@/runner`, etc. The upsert surface is
duck-typed: when `IndexerOptions.upsert` is provided, every new /
modified `FileChunk` flows through it; when absent the indexer is a
pure corpus producer the caller iterates with `getCorpus()`. This
keeps the slice fence (ADR-0159) honest.

## Knobs

- `QUANTA_INDEX` — `"on"` enables the indexer at the composition
  root (default off). See ADR-0278.
- `QUANTA_INDEX_GLOB` — file glob the default scanner consumes
  (default `src/**/*.ts`).
- `QUANTA_INDEX_INTERVAL_MS` — polling cadence for `scanDelta`
  (default 5000 ms). Consumed by ADR-0278.

## Consequences

- **Positive**: A vector-store-backed pipeline now has a way to
  populate itself from a real workspace. Hellgate locks the 8
  failure modes Cursor and CodeIndex stumbled on (symlink loop /
  binary / huge file / EACCES / 0-byte / newline path / negation
  gitignore / concurrent scan). The slice fence stays intact.
- **Negative**: Line-window chunking is structurally blind to
  TypeScript symbol boundaries. A function split across the window
  edge produces two half-chunks. See deliberate hold.

## Deliberate hold

LSP-aware (tree-sitter) symbol chunking is a strictly better
strategy for code corpora — function-aligned chunks survive renames
better and produce cleaner reranker inputs. We ship line-window
first because it is provably correct on every file type (including
non-TS) and adds no native dependency. The promotion path is a
sibling `symbol-chunker.ts` that satisfies the same `chunker` port;
the indexer is agnostic to which one runs.

## Notes

- The scanner uses `fs.promises.readdir({ withFileTypes: true })` so
  symlink loops are detected via `lstat()` inode tracking rather than
  the platform's resolver — predictable across Linux / macOS.
- Binary detection is a single UTF-8 decode attempt with the WHATWG
  `TextDecoder({ fatal: true })`. A file containing a `\0` byte fails
  decode and is classified `binary`; this is the same heuristic
  ripgrep uses for `--text` opt-in. No magic-byte sniffing — the test
  is byte-deterministic.
- The SHA used by the delta tracker is `node:crypto`
  `createHash("sha1")` over the raw file bytes — collision-resistant
  enough for delta detection, fast enough for 1000-file scans
  (HELL-IDX-21).
