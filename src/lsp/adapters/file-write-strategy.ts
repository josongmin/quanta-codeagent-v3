/** ADR-0155 — `FileWriteStrategy` port (hexagonal extraction).
 *
 *  Extracts the on-disk write policy from `LspClient.applyWorkspaceEdit` (ADR-0143
 *  Phase 1 sequential / ADR-0152 Phase 2 tmp+rename) into a plug-in seam so the
 *  caller can choose the atomicity tier. Two adapters ship:
 *
 *    - `sequentialFileWriteStrategy` (fallback) — per-file write loop; if file K
 *      throws, files 1..K-1 are already on disk. Best-effort; cheapest path.
 *    - `atomicFileWriteStrategy` (default) — 2-phase commit: write every file to
 *      `<path>.tmp-<rand>` first; if all temps wrote OK, sequentially POSIX
 *      `rename(tmp, path)` to commit. Phase-1 failure ⇒ NO original modified
 *      (all temps unlinked). Phase-2 failure ⇒ partial commit (rename is
 *      destructive on its target); the failing path + remaining tmps surface
 *      as `failed` outcomes so the caller can recover.
 *
 *  Plane-clean: this file declares only types — no FS reach. Concrete adapters
 *  live alongside (`./file-write-sequential.ts`, `./file-write-atomic.ts`).
 *
 *  Wire shape: `applyBatch` returns one `FileWriteOutcome` per input entry, in
 *  the SAME ORDER as `batch`. The caller decides how to surface failures (the
 *  LSP `applyWorkspaceEdit` wrapper rolls a "throw if ANY failed" policy via
 *  the `lsp_rename_apply` tool path; other callers may prefer the typed list). */

/** Result of writing a single file in a batch.
 *
 *  - `ok` — content reached the target path on disk. `warning` flags a non-
 *    fatal degradation (e.g. cross-FS rename fell back to copy+delete which
 *    loses atomicity but preserved the write).
 *  - `failed` — content did NOT reach the target. `reason` carries the
 *    diagnostic; the file's prior content is either intact (atomic Phase-1
 *    rollback) or undefined (sequential mid-loop failure — best-effort). */
export type FileWriteOutcome =
  | { readonly kind: "ok"; readonly path: string; readonly warning?: string }
  | { readonly kind: "failed"; readonly path: string; readonly reason: string }

/** A single file write request. `path` is an absolute filesystem path; `content`
 *  is the EXACT bytes (UTF-8) the file should hold after the strategy commits. */
export interface FileWriteBatch {
  readonly path: string
  readonly content: string
}

/** Pluggable batch-write seam. Implementations decide atomicity policy. */
export interface FileWriteStrategy {
  /** Apply a batch of file writes. Returns per-file outcomes in input order.
   *  Implementations MUST honor `signal` cooperatively — once aborted, no
   *  further originals should be modified, and any in-flight temp files should
   *  be cleaned up where possible. Implementations MUST NOT throw on per-file
   *  failures; surface them as `outcome.kind: "failed"` instead. The only
   *  permitted throw is for catastrophic errors (e.g. malformed batch). */
  applyBatch(
    batch: ReadonlyArray<FileWriteBatch>,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<FileWriteOutcome>>
  /** Identifier for logs / OTel attribution. Two canonical values ship today:
   *  `"sequential"` (best-effort per-file) and `"atomic-temp-rename"` (2-phase). */
  readonly name: string
}

/** Minimal FS surface the bundled strategies depend on. Default implementations
 *  bind to `node:fs/promises` + `Bun.write`. `LspClient` injects a shim that
 *  routes through its protected seams (`writeFileText` / `renameFile` /
 *  `unlinkTmp` / `listDir` / `copyFile`) so existing test harnesses keep
 *  working without spawning a real FS. */
export interface FileWriteFs {
  /** Write `content` to `path`, replacing any prior bytes. Resolves on success;
   *  rejects on any IO error (caller decides if it's failure or rollback). */
  write(path: string, content: string): Promise<unknown>
  /** Atomic rename on the same filesystem (POSIX `rename(2)` semantics). May
   *  reject with `EXDEV` when `from` and `to` cross filesystem boundaries;
   *  the atomic strategy then falls back via {@link copyFile} + {@link unlink}. */
  rename(from: string, to: string): Promise<void>
  /** Cross-FS fallback path used when {@link rename} fails with `EXDEV`. Copies
   *  the temp file's bytes onto `to` (writes a new inode), preserving most of
   *  the atomicity guarantee — readers see either pre- or post-content, never
   *  a partial write — except for the (rare) crash window between the copy
   *  starting and `unlink` removing the temp. */
  copyFile(from: string, to: string): Promise<void>
  /** Best-effort unlink. Implementations SHOULD swallow ENOENT (file already
   *  gone) — callers use unlink for cleanup, not as a load-bearing op. */
  unlink(path: string): Promise<void>
  /** Return basenames in `dir`. Returns `[]` if the dir is missing / unreadable
   *  (sweep MUST never block a legitimate edit). */
  listDir(dir: string): Promise<string[]>
}
