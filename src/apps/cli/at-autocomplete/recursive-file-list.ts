/**
 * RFC-12 / ADR-0439 §4.2 (jun-15 SOTA++) — Recursive workspace file lister.
 *
 * SUPERSEDES the single-directory lister for the composite provider. The old
 * lister only `readdir`-ed the ONE directory the query's path-prefix pointed
 * at, so `@driver` (a bare basename) found nothing unless `driver.ts` sat at
 * the workspace root — the "real files don't show up" bug. This lister
 * enumerates the WHOLE workspace once (lazily, on the first query after `@`
 * opens), caches it, then filters in-memory on every keystroke — the VS Code
 * Ctrl-P / Cursor model.
 *
 * Enumeration is `rg --files` (ripgrep), the SAME primitive Claude Code /
 * VS Code use for their file pickers: native-fast (~0.2s vs ~6s for an
 * equivalent JS walk on this repo) and it honours `.gitignore` /`.ignore`
 * (INCLUDING nested ones) + skips hidden + does not follow symlinks. When `rg`
 * is absent we degrade to a bounded JS walk that honours the ROOT
 * `.gitignore` (`@/shared/ignore-matcher`, the indexer's SSOT) — slower and
 * coarser, but correct.
 *
 * Honesty / rule compliance:
 *  - Ranking reuses the SAME validated `rankByTier` primitive (prefix >
 *    substring, stable) the slash palette + kebab kinds use. NO new fuzzy
 *    score is invented (the `no-heuristics-only-validated` rule). A bare
 *    query (no `/`) ranks against the BASENAME so `@driver` reaches
 *    `src/.../driver.ts`; a slash query ranks against the full relative path.
 *  - Jail: `rg --files` only emits paths under `root` and never follows
 *    symlinks, so an out-of-root target can never surface; the JS fallback
 *    additionally drops symlinks escaping `root` (realpath + `is-path-inside`,
 *    same idiom as the resolver). Absolute queries short-circuit to `[]`.
 *  - NO-THROW: every fs / subprocess failure degrades (rg→walk→`[]`).
 *
 * Known limitation: the index is cached for the lister's lifetime (one REPL
 * session). Files CREATED mid-session are not surfaced until restart — the
 * same trade-off VS Code makes before its watcher catches up.
 */

import { type Dirent, promises as fs } from "node:fs"
import { basename, isAbsolute, join, relative, resolve as resolvePath } from "node:path"
import isPathInside from "is-path-inside"
import { type IgnoreMatcher, loadIgnore, toPosix } from "@/shared/ignore-matcher"
import { rankByTier } from "./fuzzy"
import type { AtCandidate } from "./port"

/** Enumerate workspace files relative to `root`. Returns forward-slash
 *  paths, or `null` to signal "source unavailable — use the fallback".
 *  Injected so tests can drive both the rg path and the walk path. */
export type FileSource = (root: string, signal?: AbortSignal) => Promise<readonly string[] | null>

/** Options for {@link createRecursiveFileLister}. */
export interface RecursiveFileListerOptions {
  /** Workspace root. MUST equal the `createFileResolver` root so listed
   *  candidates are exactly the ones the resolver can later read. */
  readonly fileRoot: string
  /** Max candidates returned per query. Default 8 (= `MAX_VISIBLE_CANDIDATES`). */
  readonly maxResults?: number
  /** Hard guard on indexed entries (memory + fallback-walk latency). The list
   *  is sorted shallow-first, so the cap drops the DEEPEST entries. Default
   *  50000. */
  readonly maxFiles?: number
  /** Honour `.gitignore` / `.quantaignore` in the JS fallback walk. Default
   *  true. (The rg path always honours ignore files.) */
  readonly honorIgnore?: boolean
  /** Primary file source. Default = `rg --files`. */
  readonly fileSource?: FileSource
}

const DEFAULT_MAX = 8
const DEFAULT_MAX_FILES = 50_000

/** Directory names ALWAYS pruned. `.git` etc. are covered by the hidden-dot
 *  rule; `node_modules` is the common non-dot offender (and a belt-and-braces
 *  for repos that fail to `.gitignore` it). */
const ALWAYS_PRUNE = new Set(["node_modules"])

/** One indexed workspace entry. `rel` is forward-slash, root-relative. */
interface IndexEntry {
  readonly rel: string
  readonly isDir: boolean
}

/** The cached index: entries PLUS the two match-key arrays (full-rel +
 *  basename) precomputed ONCE, so a keystroke never re-maps `basename()`
 *  over the whole index (the empty-`@` query touches every entry, ~50k worst
 *  case). {@link projectQuery} then reads the right key array. */
interface BuiltIndex {
  readonly entries: readonly IndexEntry[]
  readonly rels: readonly string[]
  readonly bases: readonly string[]
}

/** Lexical `Array#sort` comparator. Extracted because BOTH orderings below
 *  (walk sibling order, index depth tie-break) need it and a nested ternary
 *  inline in a callback is where a third of this module's complexity lived.
 *  Code-unit order — NOT locale collation, which would make the index order
 *  environment-dependent. */
const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Read one numeric option. Contract: a finite number > 0 is truncated toward
 *  zero; anything else (absent, 0, negative, NaN, Infinity, non-number) yields
 *  `fallback`. The two option sites were byte-identical guard chains. */
const positiveIntOption = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback

// ── ripgrep file source ────────────────────────────────────────────────

/** Default {@link FileSource}: `rg --files` rooted at `root`. NO-THROW —
 *  any spawn failure (rg missing ⇒ ENOENT throw, non-zero exit) ⇒ `null`,
 *  which routes the lister to the JS-walk fallback. */
export const ripgrepFileSource: FileSource = async (root, signal) => {
  try {
    const proc = Bun.spawn(
      // `--files` lists every non-ignored file; the `node_modules` glob is a
      // safety net for trees that don't gitignore it. rg skips hidden files
      // and does not follow symlinks by default — both intentional here.
      ["rg", "--files", "--glob=!**/node_modules/**"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "ignore",
        ...(signal !== undefined ? { signal } : {}),
      },
    )
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    const lines = stdout.split("\n").filter((l) => l.length > 0)
    // rg emits VALID files to stdout even when it exits non-zero because a
    // SUB-directory was unreadable (EACCES ⇒ exit 2). Discarding that stdout
    // would drop the whole index to the ~40× slower walk for one permission-
    // denied folder. So: any stdout ⇒ use it. Empty stdout with exit 0/1 ⇒ a
    // genuinely empty / all-ignored tree ⇒ `[]` (NOT the walk). Empty stdout
    // with a hard error (>1) ⇒ `null` ⇒ fall back to the walk.
    if (lines.length > 0) return lines
    if (code === 0 || code === 1) return []
    return null
  } catch {
    return null // rg not on PATH / spawn failed ⇒ fall back to the walk
  }
}

/** A relative path that must never be indexed: absolute, or escaping `root`
 *  via `..`. rg never emits these (root-relative, no symlink follow), but a
 *  hand-rolled / future {@link FileSource} might — cheap defense-in-depth so
 *  the jail does not rely solely on the source's good behaviour. */
const isUnsafeRel = (rel: string): boolean =>
  rel === "" || rel === ".." || rel.startsWith("../") || rel.includes("/../") || isAbsolute(rel)

/** Expand a flat file list into indexed entries: every file PLUS each unique
 *  ancestor directory (so `@src/` browse + dir descent still work). Sorted
 *  shallow-first then lexically — a deterministic tie-break that floats
 *  top-level matches above deep ones at equal rank tier. */
const deriveEntries = (relFiles: readonly string[], maxFiles: number): readonly IndexEntry[] => {
  const dirs = new Set<string>()
  const files: string[] = []
  for (const raw of relFiles) {
    const rel = toPosix(raw)
    if (isUnsafeRel(rel)) continue // jail: drop absolute / `..`-escaping paths
    files.push(rel)
    const parts = rel.split("/")
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"))
  }
  const entries: IndexEntry[] = [
    ...files.map((rel) => ({ rel, isDir: false })),
    ...[...dirs].map((rel) => ({ rel, isDir: true })),
  ]
  const depth = (e: IndexEntry): number => e.rel.split("/").length
  entries.sort((a, b) => depth(a) - depth(b) || compareNames(a.rel, b.rel))
  return entries.length > maxFiles ? entries.slice(0, maxFiles) : entries
}

// ── JS-walk fallback (rg absent) ───────────────────────────────────────

/** Canonicalise (follow symlinks where resolvable). NO-THROW. */
const canonicalize = async (abs: string): Promise<string> => {
  try {
    return await fs.realpath(abs)
  } catch {
    return abs
  }
}

/** Async containment: `true` iff `abs` is at/below `root` after symlink
 *  resolution. Mirrors the resolver's `isInsideRoot`. NO-THROW. */
const isInsideRoot = async (canonRoot: string, abs: string): Promise<boolean> => {
  try {
    const canonTarget = await canonicalize(abs)
    return canonTarget === canonRoot || isPathInside(canonTarget, canonRoot)
  } catch {
    return false
  }
}

/** Everything the per-entry classifier needs that does not change during a
 *  walk. Bundled so the three helpers below take one argument instead of
 *  three, and so the `canonRoot` realpath happens exactly once. */
interface WalkContext {
  /** The root EXACTLY as the caller passed it — `relative()` must use this
   *  (not the realpath) so emitted `rel`s match the caller's notion of root. */
  readonly root: string
  /** `realpath(resolve(root))`. The containment comparison basis. */
  readonly canonRoot: string
  readonly matcher: IgnoreMatcher
}

/** What the walk should do with one directory entry.
 *  - `skip`  — drop it entirely (hidden / pruned / ignored / escapes the jail)
 *  - `file`  — emit a file candidate; never descended
 *  - `dir`   — descend into `abs`; `emit` says whether the directory ITSELF is
 *              offered as a candidate. `emit:false` + descend is the negated
 *              re-include case (`ignored/` + `!ignored/keep.ts`): the child is
 *              reachable while the parent stays hidden. */
type WalkStep =
  | { readonly kind: "skip" }
  | { readonly kind: "file"; readonly rel: string }
  | { readonly kind: "dir"; readonly rel: string; readonly abs: string; readonly emit: boolean }

const WALK_SKIP: WalkStep = { kind: "skip" }

/** Classify ONE directory entry. This is where the walk's whole prune policy
 *  lives, in the order it must be applied:
 *    1. hidden (leading dot — covers `.git`, and the ignore FILES themselves)
 *    2. `ALWAYS_PRUNE` by name (`node_modules`), independent of any ignore file
 *    3. path-shape guard (defensive; unreachable after rule 1 — see below)
 *    4. jail — a SYMLINK whose realpath escapes `root` is dropped. Note a
 *       symlink is never `isDirectory()` under `withFileTypes`, so a link to a
 *       directory becomes a FILE candidate and is never descended; that is
 *       also why no cycle ledger is needed. A BROKEN link canonicalises to
 *       itself, tests as in-root, and is therefore KEPT.
 *    5. ignore-file rules, with the dir/file asymmetry described on `WalkStep`.
 *  NO-THROW (the only I/O is `isInsideRoot`, which swallows). Async ONLY
 *  because rule 4 awaits — matching the original inline code. */
const classifyWalkEntry = async (ctx: WalkContext, dir: string, ent: Dirent): Promise<WalkStep> => {
  const name = ent.name
  if (name.startsWith(".")) return WALK_SKIP // hidden (covers .git)
  if (ALWAYS_PRUNE.has(name)) return WALK_SKIP
  const abs = join(dir, name)
  const rel = toPosix(relative(ctx.root, abs))
  // Defence-in-depth only: `readdir` never yields "." / ".." and rule 1 already
  // dropped every dot-name, so `rel` cannot be "" or start with "..". Kept
  // because it is the last line between a future `dir` source and the jail.
  if (rel === "" || rel.startsWith("..")) return WALK_SKIP
  if (ent.isSymbolicLink() && !(await isInsideRoot(ctx.canonRoot, abs))) return WALK_SKIP
  if (ent.isDirectory()) {
    const ignored = ctx.matcher.isIgnored(rel)
    if (ignored && !ctx.matcher.shouldDescend(rel)) return WALK_SKIP
    return { kind: "dir", rel, abs, emit: !ignored }
  }
  if (ctx.matcher.isIgnored(rel)) return WALK_SKIP
  return { kind: "file", rel }
}

/** One directory's contribution to the walk. */
interface DirScan {
  /** Candidates to append, in emission order. */
  readonly emitted: readonly IndexEntry[]
  /** Absolute paths to enqueue for a later level, in the same order. */
  readonly descend: readonly string[]
}

/** Read ONE directory and classify its children.
 *
 *  `budget` is how many more entries the caller may accept; the scan stops
 *  emitting AND enqueueing the moment it is reached, which is exactly what the
 *  original inner `break` did (it abandoned the rest of the directory, queued
 *  siblings included). Callers pass `maxFiles - out.length`, which is always
 *  >= 1 because the outer loop breaks first.
 *
 *  Siblings are sorted by name BEFORE classification, so emission order — and
 *  therefore the order the user sees in the dropdown — is deterministic.
 *  An unreadable directory yields an EMPTY scan (not an error): the walk keeps
 *  going and the directory itself, already emitted by its parent, stays. */
const scanDirectory = async (ctx: WalkContext, dir: string, budget: number): Promise<DirScan> => {
  const emitted: IndexEntry[] = []
  const descend: string[] = []
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { emitted, descend }
  }
  entries.sort((a, b) => compareNames(a.name, b.name))
  for (const ent of entries) {
    if (emitted.length >= budget) break
    const step = await classifyWalkEntry(ctx, dir, ent)
    if (step.kind === "skip") continue
    if (step.kind === "file") {
      emitted.push({ rel: step.rel, isDir: false })
      continue
    }
    if (step.emit) emitted.push({ rel: step.rel, isDir: true })
    descend.push(step.abs)
  }
  return { emitted, descend }
}

/** Breadth-first workspace walk → flat, ignore-pruned, jailed entry list.
 *  The rg fallback. Slower + only honours the ROOT ignore files, but correct
 *  and bounded by `maxFiles`. NO-THROW.
 *
 *  ORDER IS PART OF THE CONTRACT: level-order (FIFO queue), alphabetical
 *  within each directory, a directory emitted before its own contents but
 *  interleaved with its sibling files. The `@`-dropdown shows the head of this
 *  list, so changing it is a user-visible change. */
const buildIndexViaWalk = async (
  root: string,
  matcher: IgnoreMatcher,
  maxFiles: number,
  signal: AbortSignal | undefined,
): Promise<readonly IndexEntry[]> => {
  const ctx: WalkContext = { root, canonRoot: await canonicalize(resolvePath(root)), matcher }
  const out: IndexEntry[] = []
  const queue: string[] = [resolvePath(root)]
  let head = 0
  while (head < queue.length) {
    if (signal?.aborted || out.length >= maxFiles) break
    const scan = await scanDirectory(ctx, queue[head++] as string, maxFiles - out.length)
    out.push(...scan.emitted)
    queue.push(...scan.descend)
  }
  return out
}

// ── candidate projection ───────────────────────────────────────────────

/** Project an indexed entry into an {@link AtCandidate}. Directories get a
 *  trailing `/` so a follow-up keystroke descends. */
const toCandidate = (entry: IndexEntry): AtCandidate => {
  const display = entry.isDir ? `${entry.rel}/` : entry.rel
  return {
    kind: "file",
    insertText: `@${display}`,
    label: display,
    detail: entry.isDir ? "dir" : "file",
  }
}

/** Is this (root, query) pair answerable at all? Three cheap refusals that
 *  must all happen BEFORE the index is built:
 *    - no usable `fileRoot`             ⇒ the lister is inert
 *    - a non-string query               ⇒ refused, never coerced
 *    - an ABSOLUTE query                ⇒ the jail; short-circuits so an
 *      absolute path can never even trigger an enumeration.
 *  `&&` short-circuit keeps `isAbsolute` off a non-string query. */
const isQueryable = (root: unknown, query: unknown): boolean =>
  typeof root === "string" && root.length > 0 && typeof query === "string" && !isAbsolute(query)

/** Filter + rank + project a built index for one query, capped at `max`.
 *
 *  Key selection is the whole point: a query WITHOUT a `/` ranks against
 *  BASENAMES (so `@driver` reaches `src/apps/bench/driver.ts`), a query WITH
 *  one ranks against full relative paths (so `@src/apps` works). A consequence
 *  worth knowing: once the user types the trailing `/`, the directory itself
 *  drops out of its own listing, because rel keys carry no trailing slash.
 *
 *  Pure + NO-THROW; ties and order come entirely from `rankByTier`. */
const projectQuery = (built: BuiltIndex, query: string, max: number): readonly AtCandidate[] => {
  const q = toPosix(query)
  const keys = q.includes("/") ? built.rels : built.bases
  const out: AtCandidate[] = []
  for (const r of rankByTier(keys, q)) {
    if (out.length >= max) break
    const entry = built.entries[r.index]
    if (entry === undefined) continue
    out.push(toCandidate(entry))
  }
  return out
}

/**
 * Build a recursive workspace file lister. The enumeration runs at most once
 * per lister instance (cached); concurrent first-calls share the one
 * in-flight build. An absent / non-string `fileRoot` ⇒ every call ⇒ `[]`.
 */
export const createRecursiveFileLister = (
  opts: RecursiveFileListerOptions,
): ((query: string, signal?: AbortSignal) => Promise<readonly AtCandidate[]>) => {
  const root = opts?.fileRoot
  const max = positiveIntOption(opts?.maxResults, DEFAULT_MAX)
  const maxFiles = positiveIntOption(opts?.maxFiles, DEFAULT_MAX_FILES)
  const honor = opts?.honorIgnore !== false
  const fileSource = opts?.fileSource ?? ripgrepFileSource

  let index: BuiltIndex | null = null
  let building: Promise<BuiltIndex> | null = null

  // NOTE: the build is deliberately NOT cancelled by a per-keystroke signal.
  // It runs to completion once (rg ~150ms; walk bounded by `maxFiles`) and is
  // cached unconditionally on success, so the cache validity never depends on
  // abort timing (a completed-then-aborted build was previously discarded,
  // forcing a re-enumeration every keystroke). A superseded keystroke simply
  // drops its own result via the `signal?.aborted` checks below; the shared
  // build keeps going for the next one.
  const build = async (): Promise<BuiltIndex> => {
    const absRoot = resolvePath(root as string)
    const fromSource = await fileSource(absRoot, undefined)
    const entries =
      fromSource !== null
        ? deriveEntries(fromSource, maxFiles)
        : await buildIndexViaWalk(
            root as string,
            await loadIgnore(absRoot, honor),
            maxFiles,
            undefined,
          )
    return {
      entries,
      rels: entries.map((e) => e.rel),
      bases: entries.map((e) => basename(e.rel)),
    }
  }

  const ensureIndex = async (): Promise<BuiltIndex> => {
    if (index !== null) return index
    if (building === null) {
      building = build()
        .then((built) => {
          index = built
          return built
        })
        .finally(() => {
          building = null
        })
    }
    return building
  }

  return async (query: string, signal?: AbortSignal): Promise<readonly AtCandidate[]> => {
    if (!isQueryable(root, query)) return []
    if (signal?.aborted) return []
    let built: BuiltIndex
    try {
      built = await ensureIndex()
    } catch {
      // A failed build is NOT cached — the next keystroke retries.
      return []
    }
    // Re-check: the build deliberately outlives a superseded keystroke, so a
    // signal aborted DURING it drops this result while keeping the cache.
    if (signal?.aborted) return []
    return projectQuery(built, query, max)
  }
}
