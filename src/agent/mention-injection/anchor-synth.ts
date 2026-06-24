/**
 * ADR-0422 follow-up — deterministic LSP anchor synthesizer.
 *
 * The `@/agent/lsp-bridge` nav provider resolves a language server by FILE
 * extension (it reads the file's extension, picks pyright / typescript, and
 * opens a session). The ADR-0422 `createLspSymbolLookup` therefore needs an
 * ANCHOR FILE — a representative workspace file whose extension selects the
 * server. Until now production wired the adapter WITHOUT an anchor, so every
 * `@symbol` lookup short-circuited to `null` (the deliberate hold ADR-0422
 * recorded). This helper supplies the missing anchor by a fully DETERMINISTIC
 * rule (no scores, no thresholds, no heuristics):
 *
 *   1. Walk the workspace rooted at `cwd` breadth-first. At each directory,
 *      read its entries and sort them lexicographically (`<` on the raw name)
 *      so the traversal order is byte-stable across runs / filesystems.
 *   2. The FIRST file encountered (in that deterministic order) whose
 *      lowercase extension maps to a LANGUAGE in the injected
 *      `extensionToLanguage` table (built from lsp-bridge's `SERVERS` via
 *      `lspExtensionToLanguage`) becomes that language's anchor.
 *   3. A workspace may contain several languages (e.g. a `.ts` file and a
 *      `.py` file). Each supported language that is PRESENT yields one anchor,
 *      so the caller can build a UNION lookup (one `createLspSymbolLookup` per
 *      anchor). No language present ⇒ no anchors ⇒ LSP strategy is disabled
 *      (graceful — `@symbol` falls through to the semantic strategy / `null`).
 *
 * Languages are keyed by the SERVER BINARY (so the two extensions a single
 * server handles — e.g. typescript handles `.ts`/`.tsx`/`.js`/… — collapse to
 * ONE anchor, never one anchor per extension). The extension→binary mapping is
 * NOT re-declared here: the caller injects an `extensionToLanguage` map derived
 * from the lsp-bridge table so this module stays decoupled from the concrete
 * server roster (OCP — adding a language is one lsp-bridge edit).
 *
 * COST: the walk early-exits as soon as every distinct language present in the
 * roster has an anchor. It does NOT, however, rely on that early-exit to be
 * cheap — a roster language that is simply NOT PRESENT in the workspace (e.g.
 * the `.py` server on a pure-TypeScript repo) can never be satisfied, so the
 * early-exit never fires for it. Termination in that case is by TREE
 * EXHAUSTION, and tree exhaustion is fast because the walk PRUNES the
 * directories that dominate a real checkout: `node_modules`, `.git`, and any
 * dot-prefixed directory (`.quanta`, `.cache`, …) are never descended into.
 * The prune list is a fixed set of deterministic NAME matches — no scores, no
 * thresholds, no heuristics. Pruning never changes which anchor a normal tree
 * yields: source files live OUTSIDE those directories, so a file inside one was
 * never the legitimate anchor (if a prior version picked one, that was the bug
 * this fix closes). The `cwd` itself is exempt from the dot-dir rule — a
 * workspace rooted at a dot-dir (e.g. `cwd = /x/.quanta`) still has its direct
 * files inspected; only dot-prefixed SUBDIRECTORIES are pruned.
 * Benchmark reproducer scaffolds (`reproduce_issue.py` / `__repro_N_uuid.py`)
 * are also not legitimate anchors: they are synthetic executable probes copied
 * into the repo root before the agent runs, not source owner files. Prewarming
 * pyright on them can burn the full readiness budget while real package source
 * files are available.
 *
 * A `maxEntries` ceiling (default generous) is a hard NO-THROW backstop against
 * a pathological tree, NOT a tuning knob: it only bounds work, never changes
 * which anchor a given tree yields below the bound. With pruning in place a
 * normal repo exhausts long before the ceiling.
 *
 * NO-THROW: a `readdir` rejection on any directory is swallowed (that subtree
 * is skipped); a total failure yields an empty anchor list. The synthesizer
 * never throws and never hangs (it is bounded by `maxEntries`).
 *
 * SYMLINK LOOPS: the walk maintains a VISITED set keyed by each directory's
 * CANONICAL path (`lister.canonicalize`, when provided — typically `fs.realpath`).
 * A symlink loop (`/a/link → /b`, `/b/link → /a`) resolves both endpoints to
 * the same canonical key, so the second entry is recognised as already-visited
 * and pruned BEFORE the readDir. Determinism: the canonical key is computed
 * once per directory; a `canonicalize` rejection ⇒ fallback to the input path
 * as the visited key (still deterministic, the 1M `maxEntries` backstop is the
 * NO-THROW guarantee that termination cannot regress). Without a working
 * `canonicalize` (test fakes, in-memory trees, `node:fs` realpath rejecting)
 * the visited set still acts as an idempotent guard against duplicate enqueue
 * by input path — every dir is visited at most ONCE per key, so a tree without
 * cycles is byte-identical to the pre-visited-set behavior.
 */

import { promises as fsp } from "node:fs"
import { extname, join } from "node:path"
import { errMessage, logger } from "@/shared"

/** Minimal directory-listing port. Injected so the synthesizer is hermetic in
 *  tests (a fake tree) and decoupled from `node:fs` in the core. */
export interface AnchorDirLister {
  /** List a directory's entries. MUST reject (not return partial) on error;
   *  the synthesizer swallows the rejection and skips that subtree. */
  readDir(dir: string): Promise<readonly AnchorDirEntry[]>
  /**
   * Optional. Resolve a directory path to its CANONICAL form (follow symlinks
   * to their real target). The synthesizer uses this as the visited-set key so
   * a symlink loop (`A → B → A`) is detected after the first descent — the
   * second entry to A is recognised as already-visited and skipped.
   *
   * NO-THROW contract: rejection ⇒ the synthesizer falls back to the input
   * path verbatim as the visited key (still deterministic, still bounded by
   * the 1M backstop). Adapters that cannot canonicalize (test fakes, in-memory
   * trees) may simply omit this — the synthesizer treats `undefined` the same
   * way (the input path is the key). For a tree WITHOUT cycles this changes
   * nothing (every directory has a unique input path); for a tree WITH cycles,
   * a working `canonicalize` collapses the cycle to one visit.
   */
  canonicalize?(dir: string): Promise<string>
}

/** One directory entry — name + a file/dir discriminator. */
export interface AnchorDirEntry {
  readonly name: string
  readonly isDirectory: boolean
}

/** Canonical `node:fs`-backed {@link AnchorDirLister} — the production lister
 *  every caller shares (the synthesizer core stays `node:fs`-free). `withFileTypes`
 *  gives the file/dir discriminator without a per-entry `stat`; the synthesizer
 *  swallows `readDir` rejections so a transient fs error skips a subtree, not the
 *  run. `canonicalize` (realpath) lets the synthesizer's visited-set collapse
 *  symlink loops instead of burning entries to the backstop. */
export const nodeFsAnchorDirLister: AnchorDirLister = {
  readDir: async (dir: string): Promise<readonly AnchorDirEntry[]> => {
    const dirents = await fsp.readdir(dir, { withFileTypes: true })
    return dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }))
  },
  canonicalize: (dir: string): Promise<string> => fsp.realpath(dir),
}

/** Options for {@link synthesizeLspAnchors}. */
export interface SynthesizeAnchorsOptions {
  /** Workspace root to walk. */
  readonly cwd: string
  /** Lowercase extension (leading dot, e.g. `.ts`) → language KEY. The key is
   *  the server identity, so multiple extensions can map to ONE key (collapse
   *  to a single anchor). Derived from the lsp-bridge SERVERS table. */
  readonly extensionToLanguage: ReadonlyMap<string, string>
  /** Directory lister. Default = a `node:fs` reader (built by the caller via
   *  {@link nodeFsAnchorDirLister}). */
  readonly lister: AnchorDirLister
  /** Hard ceiling on entries inspected (NO-THROW backstop, not a tuning knob).
   *  Default 1_000_000 — exists only to fast-exit symlink loops / fs cycles,
   *  not to bound accuracy on real trees. `<= 0` ⇒ default. */
  readonly maxEntries?: number
}

/** One synthesized anchor — the absolute file path + the language it anchors. */
export interface SynthesizedAnchor {
  readonly anchorFile: string
  readonly language: string
}

/** Pathological-tree guard, NOT a tuning knob: a typical pruned src tree is
 *  <100k entries, so 1M ≫ any legitimate workspace. The cap exists ONLY to
 *  fast-exit a symlink loop / fs cycle (since we lack visited-realpath
 *  tracking yet); legitimate trees never reach it. The audit flagged the old
 *  50k as a magic threshold — bumped to 1M and re-anchored as a backstop. */
const DEFAULT_MAX_ENTRIES = 1_000_000

/** Directory NAMES that are never descended into. These dominate a real
 *  checkout (dependency trees, VCS metadata) and never legitimately hold the
 *  anchor source file. Fixed names — deterministic, no scoring. */
const PRUNED_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git"])
const REPRO_SCAFFOLD_FILE_RE = /^(__repro_\d+_[0-9a-fA-F-]+\.py|reproduce_issue\.py)$/

/** True when a SUBDIRECTORY named `name` must not be descended into: an
 *  explicit prune name OR a dot-prefixed directory (`.quanta`, `.cache`, …).
 *  Deterministic name match; applied only to subdirectories, never to `cwd`
 *  itself (the root exemption is handled by seeding the queue directly). */
const isPrunedDirName = (name: string): boolean =>
  PRUNED_DIR_NAMES.has(name) || name.startsWith(".")

const isSyntheticSourceAnchorName = (name: string): boolean => REPRO_SCAFFOLD_FILE_RE.test(name)

/** Mutable walk state threaded through the per-directory scan. `found` maps a
 *  language key to its winning anchor; `inspected` counts entries against the
 *  hard ceiling; `exhausted` flips once the ceiling is hit (NO-THROW backstop);
 *  `visitedCanonical` records every canonical directory key that has already
 *  been entered (symlink-loop guard — see file header). */
interface WalkState {
  readonly found: Map<string, string>
  inspected: number
  exhausted: boolean
  readonly visitedCanonical: Set<string>
}

/** NO-THROW canonicalization: ask the lister for `dir`'s canonical (realpath)
 *  form. Rejection (or a missing port method) ⇒ fall back to the input path so
 *  the visited set still acts as an idempotent guard against duplicate enqueue
 *  by input path — every directory is visited at most ONCE per key. */
const canonicalKey = async (dir: string, lister: AnchorDirLister): Promise<string> => {
  if (lister.canonicalize === undefined) return dir
  try {
    return await lister.canonicalize(dir)
  } catch {
    return dir
  }
}

/** Sort entries by raw name (`<`) for filesystem-independent traversal order. */
const sortEntries = (entries: readonly AnchorDirEntry[]): AnchorDirEntry[] =>
  [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

/** Scan ONE directory's (already-listed) entries in deterministic order:
 *  record the first file of each not-yet-found language and collect subdirs to
 *  enqueue. Mutates `state`; returns the subdirectory paths (in sorted order).
 *  PRUNED subdirectories (`node_modules` / `.git` / dot-prefixed) are dropped
 *  here so they are never enqueued — this keeps the walk bounded by the SOURCE
 *  tree even when a roster language is never present (audit-H fix). Honours
 *  `maxEntries` by flipping `state.exhausted`. */
const scanDir = (
  dir: string,
  entries: readonly AnchorDirEntry[],
  extensionToLanguage: ReadonlyMap<string, string>,
  maxEntries: number,
  state: WalkState,
): string[] => {
  const subdirs: string[] = []
  for (const entry of sortEntries(entries)) {
    state.inspected += 1
    if (state.inspected > maxEntries) {
      state.exhausted = true
      return subdirs
    }
    if (entry.isDirectory) {
      // Prune dependency / VCS / dot-prefixed subtrees: they never hold the
      // legitimate anchor and would otherwise dominate the walk.
      if (!isPrunedDirName(entry.name)) subdirs.push(join(dir, entry.name))
      continue
    }
    if (isSyntheticSourceAnchorName(entry.name)) continue
    const language = extensionToLanguage.get(extname(entry.name).toLowerCase())
    // FIRST file of a language (deterministic order) wins; later files of the
    // same language are ignored.
    if (language !== undefined && !state.found.has(language))
      state.found.set(language, join(dir, entry.name))
  }
  return subdirs
}

/**
 * Walk `cwd` deterministically and return one anchor file per language present
 * in the workspace. Pure of side effects beyond the injected `readDir`.
 *
 * Determinism contract: for a fixed tree + fixed `extensionToLanguage`, the
 * returned anchor for each language is byte-stable — it is the lexicographically
 * first file (breadth-first, entries sorted per directory) of that language.
 */
export const synthesizeLspAnchors = async (
  opts: SynthesizeAnchorsOptions,
): Promise<readonly SynthesizedAnchor[]> => {
  const maxEntries =
    typeof opts.maxEntries === "number" && Number.isFinite(opts.maxEntries) && opts.maxEntries > 0
      ? Math.floor(opts.maxEntries)
      : DEFAULT_MAX_ENTRIES

  // The full set of distinct roster language keys. This is ONLY an OPTIMISTIC
  // early-exit: stop walking the moment every roster language already has an
  // anchor (a fully-polyglot tree need not be exhausted). It is NOT the
  // termination bound — a roster language that is simply absent from the tree
  // (e.g. `.py` on a TS-only repo) can never satisfy it, so for that case the
  // loop terminates by QUEUE EXHAUSTION instead. Exhaustion is fast because
  // `scanDir` prunes node_modules/.git/dot-dirs from the queue (audit-H fix).
  const allLanguages = new Set(opts.extensionToLanguage.values())
  const state: WalkState = {
    found: new Map<string, string>(),
    inspected: 0,
    exhausted: false,
    visitedCanonical: new Set<string>(),
  }

  // Breadth-first queue of directories. Seed with the root (the root is never
  // pruned — only its dot-prefixed/node_modules/.git SUBDIRECTORIES are). The
  // root's canonical key is recorded BEFORE the loop so a symlink BACK to the
  // root from any descendant is recognised as a revisit and pruned. The
  // canonical key is computed at enqueue time (i.e. the FIRST time a path is
  // considered) — re-canonicalising at dequeue would double the realpath work
  // and admit a TOCTOU race where a symlink swap mid-walk produces divergent
  // keys for the same logical directory.
  const queue: string[] = [opts.cwd]
  state.visitedCanonical.add(await canonicalKey(opts.cwd, opts.lister))
  while (queue.length > 0 && !state.exhausted && state.found.size < allLanguages.size) {
    const dir = queue.shift()
    if (dir === undefined) break
    let entries: readonly AnchorDirEntry[]
    try {
      entries = await opts.lister.readDir(dir)
    } catch (e) {
      logger.warn(`mention.anchor-synth.readDir(${dir}): ${errMessage(e)}`)
      continue // NO-THROW: skip an unreadable subtree.
    }
    // Enqueue subdirs AFTER all files in this directory are examined so a
    // shallower file always out-ranks a deeper one (breadth-first). For each
    // candidate subdir, canonicalise FIRST and check the visited set: a
    // symlink loop's second arm collapses to a previously-recorded key and is
    // pruned BEFORE readDir is called on it.
    for (const sub of scanDir(dir, entries, opts.extensionToLanguage, maxEntries, state)) {
      const key = await canonicalKey(sub, opts.lister)
      if (state.visitedCanonical.has(key)) continue
      state.visitedCanonical.add(key)
      queue.push(sub)
    }
  }
  return [...state.found.entries()].map(toAnchor)
}

const toAnchor = ([language, anchorFile]: readonly [string, string]): SynthesizedAnchor => ({
  language,
  anchorFile,
})
