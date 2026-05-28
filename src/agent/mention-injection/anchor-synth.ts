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
 *      lowercase extension is in {@link LSP_SUPPORTED_EXTENSIONS} for a given
 *      LANGUAGE becomes that language's anchor.
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
 *
 * A `maxEntries` ceiling (default generous) is a hard NO-THROW backstop against
 * a pathological tree, NOT a tuning knob: it only bounds work, never changes
 * which anchor a given tree yields below the bound. With pruning in place a
 * normal repo exhausts long before the ceiling.
 *
 * NO-THROW: a `readdir` rejection on any directory is swallowed (that subtree
 * is skipped); a total failure yields an empty anchor list. The synthesizer
 * never throws and never hangs (it is bounded by `maxEntries`).
 */

import { extname, join } from "node:path"

/** Minimal directory-listing port. Injected so the synthesizer is hermetic in
 *  tests (a fake tree) and decoupled from `node:fs` in the core. */
export interface AnchorDirLister {
  /** List a directory's entries. MUST reject (not return partial) on error;
   *  the synthesizer swallows the rejection and skips that subtree. */
  readDir(dir: string): Promise<readonly AnchorDirEntry[]>
}

/** One directory entry — name + a file/dir discriminator. */
export interface AnchorDirEntry {
  readonly name: string
  readonly isDirectory: boolean
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
   *  Default 50_000. `<= 0` ⇒ default. */
  readonly maxEntries?: number
}

/** One synthesized anchor — the absolute file path + the language it anchors. */
export interface SynthesizedAnchor {
  readonly anchorFile: string
  readonly language: string
}

const DEFAULT_MAX_ENTRIES = 50_000

/** Directory NAMES that are never descended into. These dominate a real
 *  checkout (dependency trees, VCS metadata) and never legitimately hold the
 *  anchor source file. Fixed names — deterministic, no scoring. */
const PRUNED_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git"])

/** True when a SUBDIRECTORY named `name` must not be descended into: an
 *  explicit prune name OR a dot-prefixed directory (`.quanta`, `.cache`, …).
 *  Deterministic name match; applied only to subdirectories, never to `cwd`
 *  itself (the root exemption is handled by seeding the queue directly). */
const isPrunedDirName = (name: string): boolean =>
  PRUNED_DIR_NAMES.has(name) || name.startsWith(".")

/** Mutable walk state threaded through the per-directory scan. `found` maps a
 *  language key to its winning anchor; `inspected` counts entries against the
 *  hard ceiling; `exhausted` flips once the ceiling is hit (NO-THROW backstop). */
interface WalkState {
  readonly found: Map<string, string>
  inspected: number
  exhausted: boolean
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
  const state: WalkState = { found: new Map<string, string>(), inspected: 0, exhausted: false }

  // Breadth-first queue of directories. Seed with the root (the root is never
  // pruned — only its dot-prefixed/node_modules/.git SUBDIRECTORIES are).
  const queue: string[] = [opts.cwd]
  while (queue.length > 0 && !state.exhausted && state.found.size < allLanguages.size) {
    const dir = queue.shift()
    if (dir === undefined) break
    let entries: readonly AnchorDirEntry[]
    try {
      entries = await opts.lister.readDir(dir)
    } catch {
      continue // NO-THROW: skip an unreadable subtree.
    }
    // Enqueue subdirs AFTER all files in this directory are examined so a
    // shallower file always out-ranks a deeper one (breadth-first).
    for (const sub of scanDir(dir, entries, opts.extensionToLanguage, maxEntries, state)) {
      queue.push(sub)
    }
  }
  return [...state.found.entries()].map(toAnchor)
}

const toAnchor = ([language, anchorFile]: readonly [string, string]): SynthesizedAnchor => ({
  language,
  anchorFile,
})
