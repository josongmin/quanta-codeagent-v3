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
import { join, relative, sep } from "node:path"
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
}

const normalizeScanner = (
  scanner: ScannerOptions,
  chunker: ChunkerOptions | undefined,
  upsert: ChunkUpsertPort | undefined,
): ScannerInternalOpts => ({
  root: scanner.root,
  glob: scanner.glob ?? DEFAULT_GLOB,
  maxBytes: scanner.maxBytes ?? DEFAULT_MAX_BYTES,
  honorIgnoreFiles: scanner.honorIgnoreFiles ?? true,
  chunker: chunker ?? {},
  ...(upsert !== undefined ? { upsert } : {}),
})

/** Convert a relative path to forward-slash form regardless of platform. */
const toPosix = (p: string): string => (sep === "/" ? p : p.split(sep).join("/"))

/** Translate a glob (subset: `**`, `*`, `?`, literal) to a RegExp anchored
 *  at the workspace root. We accept the dialect `src/**\/*.ts` — sufficient
 *  for the canonical default. Out-of-dialect callers can pass a wider glob
 *  like `**\/*` and filter post-hoc with their own predicate (future hook). */
const globToRegex = (glob: string): RegExp => {
  let out = "^"
  let i = 0
  while (i < glob.length) {
    const c = glob[i] as string
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` matches across directory boundaries.
        out += ".*"
        i += 2
        // Eat a trailing `/` after `**` so `src/**\/foo` matches `src/foo`.
        if (glob[i] === "/") i++
        continue
      }
      // `*` matches anything except `/`.
      out += "[^/]*"
      i++
      continue
    }
    if (c === "?") {
      out += "[^/]"
      i++
      continue
    }
    if (c === ".") {
      out += "\\."
      i++
      continue
    }
    out += c.replace(/[\\$+()[\]{}|^]/g, "\\$&")
    i++
  }
  out += "$"
  return new RegExp(out)
}

interface IgnoreMatcher {
  isIgnored(relPath: string): boolean
  shouldDescend(relDir: string): boolean
}

/** Parse a `.gitignore`-style file body. Empty lines + `#` comments are
 *  skipped; lines starting with `!` are re-include rules. Returns a
 *  matcher that walks the rules in declaration order — last match wins.
 *  Subset of gitignore semantics: prefix `/` anchors to root, trailing
 *  `/` matches directories, `**` matches across boundaries, otherwise
 *  the pattern is a substring match against any path segment. */
const parseIgnore = (body: string): IgnoreMatcher => {
  type Rule = {
    readonly regex: RegExp
    readonly negate: boolean
    readonly dirOnly: boolean
    readonly rawPattern: string
    readonly anchored: boolean
  }
  const rules: Rule[] = []
  for (const raw of body.split("\n")) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#")) continue
    let pat = line
    const negate = pat.startsWith("!")
    if (negate) pat = pat.slice(1)
    const dirOnly = pat.endsWith("/")
    if (dirOnly) pat = pat.slice(0, -1)
    if (pat === "") continue
    // Anchored at root vs match-anywhere.
    const anchored = pat.startsWith("/")
    if (anchored) pat = pat.slice(1)
    const regexSrc = anchored
      ? `^${globToRegex(pat).source.slice(1, -1)}(?:/.*)?$`
      : `(?:^|/)${globToRegex(pat).source.slice(1, -1)}(?:/.*)?$`
    rules.push({ regex: new RegExp(regexSrc), negate, dirOnly, rawPattern: pat, anchored })
  }
  const isIgnored = (relPath: string): boolean => {
    let ignored = false
    for (const r of rules) {
      if (r.regex.test(relPath)) ignored = !r.negate
    }
    return ignored
  }
  const mayNeedDescend = (relDir: string): boolean => {
    const dirPrefix = relDir === "" ? "" : `${relDir}/`
    return rules.some((r) => {
      if (!r.negate) return false
      if (!r.anchored && !r.rawPattern.includes("/")) return true
      if (/[*?]/.test(r.rawPattern)) return true
      return r.rawPattern === relDir || r.rawPattern.startsWith(dirPrefix)
    })
  }
  return {
    isIgnored,
    shouldDescend: (relDir: string): boolean => !isIgnored(relDir) || mayNeedDescend(relDir),
  }
}

const EMPTY_MATCHER: IgnoreMatcher = {
  isIgnored: () => false,
  shouldDescend: () => true,
}

/** Load and combine ignore files present at `root`. Missing files are
 *  silently ignored (matches Cursor / git behaviour). */
const loadIgnore = async (root: string, honor: boolean): Promise<IgnoreMatcher> => {
  if (!honor) return EMPTY_MATCHER
  const bodies: string[] = []
  for (const name of [".gitignore", ".quantaignore"]) {
    try {
      const buf = await fsp.readFile(join(root, name), "utf8")
      bodies.push(buf)
    } catch {
      // ENOENT / EACCES — silently skip.
    }
  }
  if (bodies.length === 0) return EMPTY_MATCHER
  return parseIgnore(bodies.join("\n"))
}

interface FileVisit {
  readonly absPath: string
  readonly relPath: string
}

/** Walk `root` and yield every file visit, honouring the ignore matcher
 *  and breaking out on symlink cycles. Pure of upsert side effects. */
async function* walk(
  root: string,
  matcher: IgnoreMatcher,
  signal: AbortSignal | undefined,
  globRe: RegExp,
  cycleDetected: Set<string>,
  cycleSink: (path: string) => void,
): AsyncGenerator<FileVisit, void, void> {
  const seenInodes = new Set<string>()
  const stack: string[] = [root]
  while (stack.length > 0) {
    if (signal?.aborted) return
    const dir = stack.pop() as string
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (signal?.aborted) return
      const abs = join(dir, ent.name)
      const rel = toPosix(relative(root, abs))
      if (rel === "" || rel.startsWith("..")) continue
      if (ent.isDirectory()) {
        if (matcher.isIgnored(rel) && !matcher.shouldDescend(rel)) continue
      } else if (matcher.isIgnored(rel)) {
        continue
      }
      let stats: Awaited<ReturnType<typeof fsp.lstat>>
      try {
        stats = await fsp.lstat(abs)
      } catch {
        continue
      }
      if (stats.isSymbolicLink()) {
        // Resolve target; if the target inode was already visited, bail.
        let real: Awaited<ReturnType<typeof fsp.stat>>
        try {
          real = await fsp.stat(abs)
        } catch {
          continue
        }
        const inoKey = `${real.dev}:${real.ino}`
        if (seenInodes.has(inoKey)) {
          cycleSink(rel)
          cycleDetected.add(rel)
          continue
        }
        seenInodes.add(inoKey)
        if (real.isDirectory()) {
          stack.push(abs)
        } else if (real.isFile()) {
          if (globRe.test(rel)) yield { absPath: abs, relPath: rel }
        }
        continue
      }
      const inoKey = `${stats.dev}:${stats.ino}`
      if (seenInodes.has(inoKey)) continue
      seenInodes.add(inoKey)
      if (stats.isDirectory()) {
        stack.push(abs)
      } else if (stats.isFile()) {
        if (globRe.test(rel)) yield { absPath: abs, relPath: rel }
      }
    }
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

interface ScanState {
  readonly corpus: Map<string, readonly FileChunk[]>
  readonly tracker: DeltaTracker
  scanning: boolean
  stopped: boolean
}

const newScanState = (): ScanState => ({
  corpus: new Map(),
  tracker: new DeltaTracker(),
  scanning: false,
  stopped: false,
})

interface DoScanOutcome {
  readonly snapshot: Map<string, FileStamp>
  readonly chunksByPath: Map<string, readonly FileChunk[]>
  readonly skipped: Map<string, SkipReason>
  readonly aborted: boolean
}

/** Single scan pass — walks, reads, chunks. Pure of corpus / tracker
 *  state; the outer driver applies the delta. */
const doScan = async (
  opts: ScannerInternalOpts,
  signal: AbortSignal | undefined,
): Promise<DoScanOutcome> => {
  const matcher = await loadIgnore(opts.root, opts.honorIgnoreFiles)
  const globRe = globToRegex(opts.glob)
  const snapshot = new Map<string, FileStamp>()
  const chunksByPath = new Map<string, readonly FileChunk[]>()
  const skipped = new Map<string, SkipReason>()
  const cycleSet = new Set<string>()
  let aborted = false
  for await (const visit of walk(opts.root, matcher, signal, globRe, cycleSet, (p) =>
    skipped.set(p, "symlink_cycle"),
  )) {
    if (signal?.aborted) {
      aborted = true
      break
    }
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
    const chunks = chunkFile(
      { path: visit.relPath, text, mtime: res.outcome.mtime, sha },
      opts.chunker,
    )
    if (chunks.length > 0) chunksByPath.set(visit.relPath, chunks)
  }
  if (signal?.aborted) aborted = true
  return { snapshot, chunksByPath, skipped, aborted }
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
      const out = await doScan(this.opts, scanOpts.signal)
      if (out.aborted) return err({ kind: "aborted" as const })
      const parts = this.st.tracker.diff(out.snapshot)
      const changed = mode === "initial" ? Array.from(out.snapshot.keys()) : [
        ...parts.added,
        ...parts.modified,
      ]
      // Apply upserts BEFORE updating tracker state so an upsert failure
      // does not leave the tracker claiming the file is already indexed.
      try {
        await applyUpserts(this.opts.upsert, changed, out.chunksByPath, scanOpts.signal)
        await applyDeletes(this.opts.upsert, parts.deleted, scanOpts.signal)
      } catch (cause) {
        return err({ kind: "scan-failed" as const, cause })
      }
      // Update corpus: drop deletions, set added + modified, keep unchanged.
      for (const path of parts.deleted) this.st.corpus.delete(path)
      for (const path of changed) {
        const c = out.chunksByPath.get(path)
        if (c !== undefined) this.st.corpus.set(path, c)
      }
      // Update tracker.
      for (const path of parts.deleted) this.st.tracker.delete(path)
      for (const [path, stamp] of out.snapshot) this.st.tracker.put(path, stamp)
      let chunksProduced = 0
      for (const path of changed) {
        chunksProduced += (out.chunksByPath.get(path) ?? []).length
      }
      const stats: IndexStats = {
        filesScanned: out.snapshot.size,
        filesSkipped: out.skipped.size,
        chunksProduced,
        added: mode === "initial" ? out.snapshot.size : parts.added.length,
        modified: mode === "initial" ? 0 : parts.modified.length,
        deleted: mode === "initial" ? 0 : parts.deleted.length,
        skipped: out.skipped,
      }
      return ok(stats)
    } catch (cause) {
      return err({ kind: "scan-failed" as const, cause })
    } finally {
      this.st.scanning = false
    }
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
  return new DefaultIndexer(normalizeScanner(opts.scanner, opts.chunker, opts.upsert))
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
