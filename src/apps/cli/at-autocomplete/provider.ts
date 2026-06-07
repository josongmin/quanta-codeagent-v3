/**
 * RFC-12 / ADR-0439 §4.1-4.2 — Composite `AtCandidateProvider`.
 *
 * Combines per-kind sub-listers (file / symbol now; skill / plugin / app via
 * OPTIONAL injected list callbacks — see RFC §4.2 design-honesty note: those
 * registries expose `lookup` but no `list`, so until a `list()` lands they
 * are graceful-empty). Kind selection mirrors the parser cascade
 * (`parser.ts:183-189`): a `/` in the query ⇒ file; an uppercase leading
 * char ⇒ symbol; otherwise the kebab kinds (skill/plugin/app) PLUS a
 * lowercase file probe (covers `@foo.ts`).
 *
 * Each kind's candidates are ranked by the deterministic 2-tier
 * `rankByTier` (RFC §4.5) against the query — prefix before substring,
 * stable. The `score` field carries the tier so a downstream renderer that
 * re-sorts stays consistent. NO-THROW: a thrown sub-lister contributes `[]`.
 */

import { createFileLister, type FileListerOptions } from "./file-list"
import { rankByTier } from "./fuzzy"
import type { AtCandidate, AtCandidateProvider } from "./port"
import { createSymbolLister, type SymbolListerOptions } from "./symbol-list"

/** A name + description registry entry the kebab listers consume. */
export interface NamedEntry {
  readonly name: string
  readonly description: string
}

/** Dependencies for {@link createCompositeAtProvider}. */
export interface CompositeAtProviderDeps {
  /** Workspace root for file listing (= `createFileResolver` root). */
  readonly fileRoot: string
  /** LSP symbol lookup port (`createLspSymbolLookup(...)`). Absent ⇒ no
   *  symbol candidates. */
  readonly symbolLookup?: SymbolListerOptions["symbolLookup"]
  /** OPTIONAL skill registry list callback. Absent ⇒ no skill candidates
   *  (the registry exposes `lookup` only today — RFC §4.2). */
  readonly listSkills?: () => readonly NamedEntry[]
  /** OPTIONAL plugin registry list callback. Absent ⇒ no plugin candidates. */
  readonly listPlugins?: () => readonly NamedEntry[]
  /** OPTIONAL app catalog list callback. Absent ⇒ no app candidates. */
  readonly listApps?: () => readonly NamedEntry[]
  /** Per-kind candidate cap. Default 8 (= `MAX_VISIBLE_CANDIDATES`). */
  readonly maxPerKind?: number
}

const DEFAULT_MAX = 8

/** First line of a description (CRLF-tolerant) — mirrors the resolver
 *  `firstLineOf` idiom so detail columns match the resolve surface. */
const firstLineOf = (description: string): string => {
  const nl = description.search(/\r?\n/)
  return (nl < 0 ? description : description.slice(0, nl)).trim()
}

/** Rank a kebab registry's entries against the query and project them into
 *  candidates for the given kind (`skill` ⇒ `@name`, `plugin` ⇒
 *  `plugin://name`, `app` ⇒ `@@name`). */
const listKebab = (
  entries: readonly NamedEntry[],
  query: string,
  kind: "skill" | "plugin" | "app",
  max: number,
): readonly AtCandidate[] => {
  const ranked = rankByTier(
    entries.map((e) => e.name),
    query,
  )
  const sigil = kind === "plugin" ? "plugin://" : kind === "app" ? "@@" : "@"
  const out: AtCandidate[] = []
  for (const r of ranked) {
    if (out.length >= max) break
    const entry = entries[r.index]
    if (entry === undefined) continue
    out.push({
      kind,
      insertText: `${sigil}${entry.name}`,
      label: entry.name,
      detail: firstLineOf(entry.description),
      score: r.tier,
    })
  }
  return out
}

/**
 * Build the composite provider. Concrete sub-listers (fs walk, LSP) are
 * created from the injected deps; the keypress wire only ever sees the
 * narrow {@link AtCandidateProvider} port.
 */
export const createCompositeAtProvider = (deps: CompositeAtProviderDeps): AtCandidateProvider => {
  const max =
    typeof deps.maxPerKind === "number" && Number.isFinite(deps.maxPerKind) && deps.maxPerKind > 0
      ? Math.trunc(deps.maxPerKind)
      : DEFAULT_MAX
  const fileOpts: FileListerOptions = { fileRoot: deps.fileRoot, maxResults: max }
  const fileLister = createFileLister(fileOpts)
  const symbolOpts: SymbolListerOptions = {
    maxResults: max,
    ...(deps.symbolLookup !== undefined ? { symbolLookup: deps.symbolLookup } : {}),
  }
  const symbolLister = createSymbolLister(symbolOpts)

  const safe = async (
    fn: () => Promise<readonly AtCandidate[]>,
  ): Promise<readonly AtCandidate[]> => {
    try {
      return await fn()
    } catch {
      return []
    }
  }

  return {
    list: async (query: string, signal?: AbortSignal): Promise<readonly AtCandidate[]> => {
      if (typeof query !== "string") return []
      // Kind inference mirrors the parser cascade (parser.ts:183-189).
      if (query.includes("/")) {
        return safe(() => fileLister(query, signal))
      }
      if (/^[A-Z]/.test(query)) {
        return safe(() => symbolLister(query, signal))
      }
      // Lowercase / empty: kebab kinds + a lowercase file probe (covers
      // `@foo.ts`). Run in parallel and concat in deterministic kind order.
      // EVERY lister is wrapped in `safe` — the kebab `deps.list*()` callbacks
      // run SYNCHRONOUSLY, so a throw there (or inside `listKebab`) must NOT
      // reject the whole batch and wipe the file candidates. `safe` keeps each
      // kind's failure isolated to that kind (NO-THROW contract, RFC §6.1).
      const [files, skills, plugins, apps] = await Promise.all([
        safe(() => fileLister(query, signal)),
        safe(async () =>
          deps.listSkills ? listKebab(deps.listSkills(), query, "skill", max) : [],
        ),
        safe(async () =>
          deps.listPlugins ? listKebab(deps.listPlugins(), query, "plugin", max) : [],
        ),
        safe(async () => (deps.listApps ? listKebab(deps.listApps(), query, "app", max) : [])),
      ])
      return [...skills, ...plugins, ...apps, ...files]
    },
  }
}
