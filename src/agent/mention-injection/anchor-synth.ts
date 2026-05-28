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
 * roster has an anchor — it never scans more of the tree than necessary to
 * satisfy the lookup. A `maxEntries` ceiling (default generous) is a hard
 * NO-THROW backstop against a pathological tree, NOT a tuning knob: it only
 * bounds work, never changes which anchor a given tree yields below the bound.
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
 *  Honours `maxEntries` by flipping `state.exhausted`. */
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
    const full = join(dir, entry.name)
    if (entry.isDirectory) {
      subdirs.push(full)
      continue
    }
    const language = extensionToLanguage.get(extname(entry.name).toLowerCase())
    // FIRST file of a language (deterministic order) wins; later files of the
    // same language are ignored.
    if (language !== undefined && !state.found.has(language)) state.found.set(language, full)
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

  // The full set of distinct language keys — used for the early-exit check
  // (stop walking once every language present has an anchor).
  const allLanguages = new Set(opts.extensionToLanguage.values())
  const state: WalkState = { found: new Map<string, string>(), inspected: 0, exhausted: false }

  // Breadth-first queue of directories. Seed with the root.
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
