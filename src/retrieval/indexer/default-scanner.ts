/**
 * Default workspace scanner (ADR-0277).
 *
 * Walks `root` honouring `.gitignore` and `.quantaignore`. Implements
 * the `CodebaseIndexer` port; reads files with `node:fs`. Pure of
 * `process.env` — every knob flows through the constructor.
 *
 * Hard guarantees (HELL-IDX-01 … HELL-IDX-21):
 *  - Symlink cycles short-circuit via inode tracking.
 *  - 0-byte / binary / >maxBytes files skip with a typed `SkipReason`.
 *  - EACCES on read skips with `permission_denied` (no throw past the
 *    `Result` boundary).
 *  - Concurrent scans surface `Err("scan-in-progress")` on the second
 *    call.
 *  - `AbortSignal` is honoured at every async boundary; mid-scan abort
 *    leaves the corpus in a partial-but-consistent state.
 *  - `.gitignore` parsing: blank line + `#` comment skip; `!pattern`
 *    re-includes a prior-excluded path.
 *  - Paths are stored / surfaced with FORWARD slashes (workspace-
 *    relative) for cross-platform stability.
 */

import { createHash } from "node:crypto"
import { type Dirent, promises as fsp } from "node:fs"
import { join, relative } from "node:path"
import type { CodeParserPort } from "@/retrieval/code-parser"
import { err, ok, type Result, runtimeConfig } from "@/shared"
import { globToRegex, type IgnoreMatcher, loadIgnore, toPosix } from "@/shared/ignore-matcher"
import { chunkFile } from "./chunker"
import { chunkFileSyntactic } from "./chunker-syntactic"
import { DeltaTracker, type FileStamp } from "./delta-tracker"
import type { CodebaseIndexer, ScanOptions } from "./port"
import type {
  ChunkerOptions,
  ChunkUpsertPort,
  FileChunk,
  IndexError,
  IndexStats,
  ScannerOptions,
  SkipReason,
} from "./types"

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const DEFAULT_GLOB = "src/**/*.ts"

interface ScannerInternalOpts {
  readonly root: string
  readonly glob: string
  readonly maxBytes: number
  readonly honorIgnoreFiles: boolean
  readonly chunker: ChunkerOptions
  readonly upsert?: ChunkUpsertPort
  /** RFC jun-6 — optional syntax-aware parser. Consulted ONLY when the
   *  `QUANTA_SYNTAX_CHUNK` knob is on (checked at the chunk site). */
  readonly parser?: CodeParserPort
}

const normalizeScanner = (
  scanner: ScannerOptions,
  chunker: ChunkerOptions | undefined,
  upsert: ChunkUpsertPort | undefined,
  parser: CodeParserPort | undefined,
): ScannerInternalOpts => ({
  root: scanner.root,
  glob: scanner.glob ?? DEFAULT_GLOB,
  maxBytes: scanner.maxBytes ?? DEFAULT_MAX_BYTES,
  honorIgnoreFiles: scanner.honorIgnoreFiles ?? true,
  chunker: chunker ?? {},
  ...(upsert !== undefined ? { upsert } : {}),
  ...(parser !== undefined ? { parser } : {}),
})

/** RFC jun-6 — pick the chunker. Default (knob off / no parser / unsupported)
 *  is the BYTE-IDENTICAL line-window `chunkFile`. When the `QUANTA_SYNTAX_CHUNK`
 *  knob is on AND a parser is wired, parse once and emit AST-aligned chunks
 *  (which themselves fall back to the line-window on a `{ok:false}` outcome).
 *  NO-THROW: a parser that rejects falls back to the line-window. */
const chunkOneFile = async (
  opts: ScannerInternalOpts,
  input: { path: string; text: string; mtime: number; sha: string },
): Promise<readonly FileChunk[]> => {
  if (opts.parser !== undefined && runtimeConfig().syntaxChunk) {
    try {
      const outcome = await opts.parser.parse(input.path, input.text)
      return chunkFileSyntactic(input, outcome, opts.chunker)
    } catch {
      // Defensive — the port is NO-THROW, but never let a parser fault abort
      // the scan; fall back to the line-window.
      return chunkFile(input, opts.chunker)
    }
  }
  return chunkFile(input, opts.chunker)
}

// `toPosix`, `globToRegex`, `IgnoreMatcher`, `loadIgnore` — the gitignore
// dialect — now live in `@/shared/ignore-matcher` (shared with the CLI `@`
// autocomplete recursive lister). Imported above; behaviour is unchanged.

interface FileVisit {
  readonly absPath: string
  readonly relPath: string
}

/**
 * What the walker should do with one directory entry.
 *
 * `walk` used to decide this inline, which is what made it the single most
 * cognitively complex function in `src/` (score 65 against a cap of 15): four
 * independent concerns — ignore matching, symlink resolution, inode
 * cycle-detection, glob matching — interleaved across two nearly identical
 * tails, one for the symlink case and one for everything else. The duplication
 * is the dangerous part: a rule fixed in one tail and forgotten in the other
 * changes behaviour only for symlinked paths, which is exactly the input nobody
 * has a fixture for.
 */
type EntryVerdict =
  | { readonly kind: "skip" }
  /** A symlink whose target inode was already visited — the caller records it. */
  | { readonly kind: "cycle" }
  | { readonly kind: "descend" }
  | { readonly kind: "file" }

/**
 * Classify one entry: ignore rules, then `lstat`, then (for a symlink) the
 * target's identity, then the inode ledger.
 *
 * `seenInodes` is MUTATED here, exactly as before — an entry claims its inode at
 * the moment it is classified, and that ordering is load-bearing: when a symlink
 * is popped before the file it points at, the LINK path is the one that gets
 * yielded and the real path is deduped away. Preserved deliberately, not
 * inherited by accident; the differential fixture pins it.
 *
 * Every failed syscall is a `skip`, matching the original's `try/catch continue`
 * — an unreadable entry must not abort a scan of the tree around it.
 */
const classifyEntry = async (
  ent: Dirent,
  abs: string,
  rel: string,
  matcher: IgnoreMatcher,
  globRe: RegExp,
  seenInodes: Set<string>,
): Promise<EntryVerdict> => {
  if (ent.isDirectory()) {
    if (matcher.isIgnored(rel) && !matcher.shouldDescend(rel)) return { kind: "skip" }
  } else if (matcher.isIgnored(rel)) {
    return { kind: "skip" }
  }

  let stats: Awaited<ReturnType<typeof fsp.lstat>>
  try {
    stats = await fsp.lstat(abs)
  } catch {
    return { kind: "skip" }
  }

  // A symlink is judged by what it RESOLVES to, so both branches end up asking
  // the same three questions of a stat result — asked once, here.
  let target = stats
  if (stats.isSymbolicLink()) {
    try {
      target = await fsp.stat(abs)
    } catch {
      return { kind: "skip" }
    }
  }

  const inoKey = `${target.dev}:${target.ino}`
  if (seenInodes.has(inoKey)) {
    // Only a symlink revisit is reported as a cycle; a hard-link or repeat
    // sighting of a plain entry is silently deduped, as before.
    return stats.isSymbolicLink() ? { kind: "cycle" } : { kind: "skip" }
  }
  seenInodes.add(inoKey)

  if (target.isDirectory()) return { kind: "descend" }
  if (target.isFile() && globRe.test(rel)) return { kind: "file" }
  return { kind: "skip" }
}

/** Walk `root` and yield every file visit, honouring the ignore matcher
 *  and breaking out on symlink cycles. Pure of upsert side effects. */
/** Everything `walk` needs to act on one directory's entries. `stack` and
 *  `seenInodes` are the walk's own mutable ledgers, threaded rather than
 *  rebuilt so the traversal order and the inode dedup are unchanged. */
interface WalkContext {
  readonly root: string
  readonly matcher: IgnoreMatcher
  readonly signal: AbortSignal | undefined
  readonly globRe: RegExp
  readonly seenInodes: Set<string>
  readonly stack: string[]
  readonly cycleDetected: Set<string>
  readonly cycleSink: (path: string) => void
  /** Called with the REL path of a directory whose `readdir` failed. Its files
   *  were never observed, so they must not be diffed as deletions. */
  readonly unreadableSink: (relDir: string) => void
}

/** Yield the file visits in ONE directory, pushing its subdirectories onto the
 *  walk's stack. An unreadable directory yields nothing rather than aborting the
 *  traversal — the same `try/catch continue` the caller used to hold inline. */
async function* visitDirectory(
  ctx: WalkContext,
  dir: string,
): AsyncGenerator<FileVisit, void, void> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    // NOT the same as "this directory is empty". Every file under here is now
    // UNOBSERVED, and `DeltaTracker.diff` defines deleted as tracked-but-not-
    // observed — so swallowing this silently made a transient EACCES/EMFILE
    // purge live files from the corpus AND the vector store. Report it so the
    // scan is honest and the driver can withhold the deletions.
    ctx.unreadableSink(toPosix(relative(ctx.root, dir)))
    return
  }
  for (const ent of entries) {
    if (ctx.signal?.aborted) return
    const abs = join(dir, ent.name)
    const rel = toPosix(relative(ctx.root, abs))
    if (rel === "" || rel.startsWith("..")) continue
    const verdict = await classifyEntry(ent, abs, rel, ctx.matcher, ctx.globRe, ctx.seenInodes)
    if (verdict.kind === "cycle") {
      ctx.cycleSink(rel)
      ctx.cycleDetected.add(rel)
    } else if (verdict.kind === "descend") {
      ctx.stack.push(abs)
    } else if (verdict.kind === "file") {
      yield { absPath: abs, relPath: rel }
    }
  }
}

async function* walk(
  root: string,
  matcher: IgnoreMatcher,
  signal: AbortSignal | undefined,
  globRe: RegExp,
  cycleDetected: Set<string>,
  cycleSink: (path: string) => void,
  unreadableSink: (relDir: string) => void,
): AsyncGenerator<FileVisit, void, void> {
  const ctx: WalkContext = {
    root,
    matcher,
    signal,
    globRe,
    seenInodes: new Set<string>(),
    stack: [root],
    cycleDetected,
    cycleSink,
    unreadableSink,
  }
  while (ctx.stack.length > 0) {
    if (signal?.aborted) return
    yield* visitDirectory(ctx, ctx.stack.pop() as string)
  }
}

const sha1OfBytes = (buf: Buffer): string => createHash("sha1").update(buf).digest("hex")

/** Try to decode as UTF-8; returns undefined when the bytes are not
 *  valid UTF-8 (i.e. a binary file). */
const tryDecodeUtf8 = (buf: Buffer): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf)
  } catch {
    return undefined
  }
}

interface ReadOutcome {
  readonly mtime: number
  readonly bytes: Buffer
}

/** Read a file with size + permission gates; returns `null` on a skip
 *  reason. Caller registers the reason in `IndexStats.skipped`. */
const readFileGuarded = async (
  visit: FileVisit,
  maxBytes: number,
): Promise<{ readonly outcome: ReadOutcome } | { readonly skip: SkipReason }> => {
  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(visit.absPath)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") return { skip: "read_failed" }
    if (code === "EACCES" || code === "EPERM") return { skip: "permission_denied" }
    return { skip: "read_failed" }
  }
  if (stat.size === 0) return { skip: "empty" }
  if (stat.size > maxBytes) return { skip: "too_large" }
  let bytes: Buffer
  try {
    bytes = await fsp.readFile(visit.absPath)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "EACCES" || code === "EPERM") return { skip: "permission_denied" }
    if (code === "ENOENT") return { skip: "read_failed" }
    return { skip: "read_failed" }
  }
  return { outcome: { mtime: stat.mtimeMs, bytes } }
}

/** G9-04 fast-path identity: what a bare `stat` reveals about a file, plus the
 *  sha computed the last time its content was actually read. mtime alone is
 *  NOT sufficient identity (some editors restore it) — the fast path requires
 *  BOTH `mtimeMs` and `size` to match, and any signature change falls through
 *  to the sha-based full path, which stays the authority. */
interface StatSig {
  readonly mtimeMs: number
  readonly size: number
  readonly sha: string
}

interface ScanState {
  readonly corpus: Map<string, readonly FileChunk[]>
  readonly tracker: DeltaTracker
  /** Prior-pass stat signatures — the fast-path cache. Committed only after a
   *  scan lands (same transaction as tracker/corpus), so a failed upsert pass
   *  leaves it cold and the next tick re-reads. */
  readonly statSigs: Map<string, StatSig>
  scanning: boolean
  stopped: boolean
}

const newScanState = (): ScanState => ({
  corpus: new Map(),
  tracker: new DeltaTracker(),
  statSigs: new Map(),
  scanning: false,
  stopped: false,
})

interface DoScanOutcome {
  readonly snapshot: Map<string, FileStamp>
  readonly chunksByPath: Map<string, readonly FileChunk[]>
  readonly skipped: Map<string, SkipReason>
  readonly aborted: boolean
  /** Stat signature of every file observed this pass (fast-pathed or read);
   *  the driver commits these as the next pass's fast-path cache. */
  readonly statSigs: Map<string, StatSig>
  /** REL paths of directories whose `readdir` failed this pass. Files beneath
   *  them were never observed, so the driver must not diff them as deletions. */
  readonly unreadableDirs: readonly string[]
}

/** `stat` alone, for the fast-path check. Any failure returns undefined and
 *  the caller falls through to `readFileGuarded`, which owns the error → skip
 *  mapping — the fast path must never invent a new failure surface. */
const tryStatSignature = async (
  absPath: string,
): Promise<{ readonly mtimeMs: number; readonly size: number } | undefined> => {
  try {
    const st = await fsp.stat(absPath)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return undefined
  }
}

/** Fast path (G9-04): when the stat signature (mtimeMs+size) matches the
 *  prior pass, record the prior sha into `snapshot`/`statSigs` and return
 *  true — read + hash + chunk are skipped. The stamp is byte-identical to
 *  what the full path produced last pass, so `DeltaTracker.diff` still
 *  classifies the file as unchanged and still sees it for deletion diffing.
 *  Any mismatch (or stat failure) returns false: the sha path is authority. */
const tookFastPath = async (
  visit: FileVisit,
  priorSigs: ReadonlyMap<string, StatSig>,
  snapshot: Map<string, FileStamp>,
  statSigs: Map<string, StatSig>,
): Promise<boolean> => {
  const prior = priorSigs.get(visit.relPath)
  if (prior === undefined) return false
  const sig = await tryStatSignature(visit.absPath)
  if (sig === undefined || sig.mtimeMs !== prior.mtimeMs || sig.size !== prior.size) return false
  snapshot.set(visit.relPath, { mtime: prior.mtimeMs, sha: prior.sha })
  statSigs.set(visit.relPath, prior)
  return true
}

/** Single scan pass — walks, reads, chunks. Pure of corpus / tracker state
 *  (the outer driver applies the delta); `priorSigs` is consulted read-only:
 *  a file whose stat signature (mtimeMs+size) matches its prior-pass entry is
 *  fast-pathed — its recorded sha is reused and read/hash/chunk are skipped.
 *  A changed, new, or unstattable file takes the full sha-authority path. */
const doScan = async (
  opts: ScannerInternalOpts,
  signal: AbortSignal | undefined,
  priorSigs: ReadonlyMap<string, StatSig>,
): Promise<DoScanOutcome> => {
  const matcher = await loadIgnore(opts.root, opts.honorIgnoreFiles)
  const globRe = globToRegex(opts.glob)
  const snapshot = new Map<string, FileStamp>()
  const chunksByPath = new Map<string, readonly FileChunk[]>()
  const statSigs = new Map<string, StatSig>()
  const skipped = new Map<string, SkipReason>()
  const cycleSet = new Set<string>()
  const unreadableDirs = new Set<string>()
  let aborted = false
  for await (const visit of walk(
    opts.root,
    matcher,
    signal,
    globRe,
    cycleSet,
    (p) => skipped.set(p, "symlink_cycle"),
    (relDir) => {
      unreadableDirs.add(relDir)
      skipped.set(relDir === "" ? "." : relDir, "permission_denied")
    },
  )) {
    if (signal?.aborted) {
      aborted = true
      break
    }
    if (await tookFastPath(visit, priorSigs, snapshot, statSigs)) continue
    const res = await readFileGuarded(visit, opts.maxBytes)
    if ("skip" in res) {
      skipped.set(visit.relPath, res.skip)
      continue
    }
    const text = tryDecodeUtf8(res.outcome.bytes)
    if (text === undefined) {
      skipped.set(visit.relPath, "binary")
      continue
    }
    const sha = sha1OfBytes(res.outcome.bytes)
    snapshot.set(visit.relPath, { mtime: res.outcome.mtime, sha })
    statSigs.set(visit.relPath, {
      mtimeMs: res.outcome.mtime,
      size: res.outcome.bytes.byteLength,
      sha,
    })
    const chunks = await chunkOneFile(opts, {
      path: visit.relPath,
      text,
      mtime: res.outcome.mtime,
      sha,
    })
    if (chunks.length > 0) chunksByPath.set(visit.relPath, chunks)
  }
  if (signal?.aborted) aborted = true
  return { snapshot, chunksByPath, skipped, aborted, statSigs, unreadableDirs: [...unreadableDirs] }
}

/** Deletions the scan is ENTITLED to apply. A path under a directory we could
 *  not read was never observed, and unobserved is not gone — withholding it
 *  costs a stale entry until the next clean pass, whereas applying it destroys
 *  corpus and vector-store rows for files that still exist. */
const deletionsOutsideUnreadableDirs = (
  deleted: readonly string[],
  unreadableDirs: readonly string[],
): readonly string[] => {
  if (unreadableDirs.length === 0) return deleted
  // `""` is the ROOT — if the root itself became unreadable, nothing observed
  // this pass is evidence of anything.
  if (unreadableDirs.includes("")) return []
  const prefixes = unreadableDirs.map((d) => `${d}/`)
  return deleted.filter((p) => !prefixes.some((pre) => p.startsWith(pre)))
}

const applyUpserts = async (
  upsert: ChunkUpsertPort | undefined,
  changed: readonly string[],
  chunksByPath: ReadonlyMap<string, readonly FileChunk[]>,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (upsert === undefined) return
  for (const path of changed) {
    if (signal?.aborted) return
    const chunks = chunksByPath.get(path) ?? []
    for (const c of chunks) {
      if (signal?.aborted) return
      await upsert.upsert(c)
    }
  }
}

const applyDeletes = async (
  upsert: ChunkUpsertPort | undefined,
  deleted: readonly string[],
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (upsert === undefined) return
  for (const path of deleted) {
    if (signal?.aborted) return
    await upsert.delete(path)
  }
}

/**
 * Project a completed scan into the public {@link IndexStats}.
 *
 * Split out of `runScan` with {@link DefaultIndexer.commitScanState}: that
 * method was one function carrying the refusal gates, the scan, the upsert
 * bracket, three state-mutation loops and this projection, and the `mode`
 * ternaries below read very differently depending on which of those you are
 * looking at. Pure — it reads the scan output, never the indexer's state — so
 * the "initial reports everything as added" convention is checkable on its own.
 */
const buildScanStats = (
  mode: "initial" | "delta",
  out: Awaited<ReturnType<typeof doScan>>,
  parts: {
    readonly added: readonly string[]
    readonly modified: readonly string[]
    readonly deleted: readonly string[]
  },
  changed: readonly string[],
): IndexStats => {
  let chunksProduced = 0
  for (const path of changed) chunksProduced += (out.chunksByPath.get(path) ?? []).length
  return {
    filesScanned: out.snapshot.size,
    filesSkipped: out.skipped.size,
    chunksProduced,
    added: mode === "initial" ? out.snapshot.size : parts.added.length,
    modified: mode === "initial" ? 0 : parts.modified.length,
    deleted: mode === "initial" ? 0 : parts.deleted.length,
    skipped: out.skipped,
  }
}

class DefaultIndexer implements CodebaseIndexer {
  private readonly opts: ScannerInternalOpts
  private readonly st = newScanState()

  constructor(opts: ScannerInternalOpts) {
    this.opts = opts
  }

  async scanInitial(scanOpts: ScanOptions = {}): Promise<Result<IndexStats, IndexError>> {
    return this.runScan("initial", scanOpts)
  }

  async scanDelta(scanOpts: ScanOptions = {}): Promise<Result<IndexStats, IndexError>> {
    return this.runScan("delta", scanOpts)
  }

  private async runScan(
    mode: "initial" | "delta",
    scanOpts: ScanOptions,
  ): Promise<Result<IndexStats, IndexError>> {
    if (this.st.stopped) return err({ kind: "stopped" as const })
    if (this.st.scanning) return err({ kind: "scan-in-progress" as const })
    if (scanOpts.signal?.aborted) return err({ kind: "aborted" as const })
    this.st.scanning = true
    try {
      // "initial" bypasses the fast-path cache: its contract is a full
      // read + chunk + upsert of everything observed, and a fast-pathed file
      // has no chunks in `chunksByPath` to upsert.
      const priorSigs: ReadonlyMap<string, StatSig> =
        mode === "delta" ? this.st.statSigs : new Map()
      const out = await doScan(this.opts, scanOpts.signal, priorSigs)
      if (out.aborted) return err({ kind: "aborted" as const })
      const raw = this.st.tracker.diff(out.snapshot)
      const parts = {
        ...raw,
        deleted: deletionsOutsideUnreadableDirs(raw.deleted, out.unreadableDirs),
      }
      const changed =
        mode === "initial" ? Array.from(out.snapshot.keys()) : [...parts.added, ...parts.modified]
      // Apply upserts BEFORE updating tracker state so an upsert failure
      // does not leave the tracker claiming the file is already indexed.
      try {
        await applyUpserts(this.opts.upsert, changed, out.chunksByPath, scanOpts.signal)
        await applyDeletes(this.opts.upsert, parts.deleted, scanOpts.signal)
      } catch (cause) {
        return err({ kind: "scan-failed" as const, cause })
      }
      this.commitScanState(out, parts.deleted, changed)
      return ok(buildScanStats(mode, out, parts, changed))
    } catch (cause) {
      return err({ kind: "scan-failed" as const, cause })
    } finally {
      this.st.scanning = false
    }
  }

  /** Land a completed scan in the corpus and the change tracker.
   *
   *  Ordering is load-bearing and unchanged: deletions leave the corpus before
   *  the scan's chunks are written, and the tracker is only told about a path
   *  after the corpus already holds its chunks — so a caller that observes the
   *  tracker can never see a path claimed as indexed whose chunks are missing. */
  private commitScanState(
    out: Awaited<ReturnType<typeof doScan>>,
    deleted: readonly string[],
    changed: readonly string[],
  ): void {
    for (const path of deleted) this.st.corpus.delete(path)
    for (const path of changed) {
      const c = out.chunksByPath.get(path)
      if (c !== undefined) this.st.corpus.set(path, c)
    }
    for (const path of deleted) this.st.tracker.delete(path)
    for (const [path, stamp] of out.snapshot) this.st.tracker.put(path, stamp)
    // Fast-path cache follows the tracker exactly: a path skipped this pass
    // (and thus diffed as deleted) loses its signature, so a later reappearance
    // takes the full read path rather than trusting a stale sha.
    for (const path of deleted) this.st.statSigs.delete(path)
    for (const [path, sig] of out.statSigs) this.st.statSigs.set(path, sig)
  }

  *getCorpus(): Iterable<FileChunk> {
    // Snapshot the corpus into a flat array first so mid-iteration
    // mutations (e.g. a concurrent scanDelta finished its writes) do
    // not corrupt iteration order.
    const snap: FileChunk[] = []
    for (const chunks of this.st.corpus.values()) {
      for (const c of chunks) snap.push(c)
    }
    for (const c of snap) yield c
  }

  stop(): void {
    this.st.stopped = true
  }
}

export const createDefaultIndexer = (opts: {
  readonly scanner: ScannerOptions
  readonly chunker?: ChunkerOptions
  readonly upsert?: ChunkUpsertPort
  readonly parser?: CodeParserPort
}): CodebaseIndexer => {
  if (opts.scanner.root === "" || typeof opts.scanner.root !== "string") {
    // Surface as a tiny adapter that always returns invalid-config — the
    // production wire never trips this (root is process.cwd()), but the
    // boundary is honest. Returning a fake indexer rather than throwing
    // keeps the constructor no-throw.
    return invalidConfigIndexer("scanner.root must be a non-empty string")
  }
  const ch = opts.chunker
  const w = ch?.windowLines
  const o = ch?.overlapLines
  if (w !== undefined && o !== undefined && o >= w) {
    return invalidConfigIndexer("chunker.overlapLines must be < windowLines")
  }
  return new DefaultIndexer(normalizeScanner(opts.scanner, opts.chunker, opts.upsert, opts.parser))
}

const invalidConfigIndexer = (reason: string): CodebaseIndexer => ({
  async scanInitial() {
    return err({ kind: "invalid-config" as const, reason })
  },
  async scanDelta() {
    return err({ kind: "invalid-config" as const, reason })
  },
  *getCorpus() {
    /* empty */
  },
  stop() {
    /* no-op */
  },
})
