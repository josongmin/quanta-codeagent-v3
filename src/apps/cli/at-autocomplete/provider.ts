/**
 * RFC-12 / ADR-0439 §4.1-4.2 — Composite `AtCandidateProvider`.
 *
 * Combines per-kind sub-listers (file / symbol now; skill / plugin / app via
 * OPTIONAL injected list callbacks — see RFC §4.2 design-honesty note: those
 * registries expose `lookup` but no `list`, so until a `list()` lands they
 * are graceful-empty). Kind selection mirrors the parser cascade
 * (`parser.ts:183-189`): a `/` in the query ⇒ file only; an uppercase leading
 * char ⇒ symbol + file (so `@README` still resolves); otherwise a file probe
 * (covers `@foo.ts`) PLUS the kebab kinds (skill/plugin/app). Multi-kind
 * results are concatenated FILES-FIRST so the dropdown's primary purpose
 * (`@path`) is never starved out of the visible window by many matching
 * skills (the prior files-last order buried them past the cap).
 *
 * Each kind's candidates are ranked by the deterministic 3-tier
 * `rankByTier` (RFC §4.5) against the query — exact before prefix before substring,
 * stable. This INCLUDES file candidates: the recursive lister
 * (`recursive-file-list.ts`) indexes the whole workspace then ranks the
 * matches with the SAME primitive, so a bare `@driver` reaches a deep
 * `src/.../driver.ts`. The `score` field carries the tier so a downstream
 * renderer that re-sorts stays consistent. NO-THROW: a thrown sub-lister
 * contributes `[]`.
 */

import { mentionFirstLine } from "@/shared"
import { rankByTier } from "./fuzzy"
import type { AtCandidate, AtCandidateProvider } from "./port"
import { createRecursiveFileLister, type RecursiveFileListerOptions } from "./recursive-file-list"
import { createSymbolLister, type SymbolListerOptions } from "./symbol-list"

/** A name + description registry entry the kebab listers consume. */
export interface NamedEntry {
  readonly name: string
  readonly description: string
  /** RFC-12-2 — OPTIONAL override for the payload spliced AFTER the kind sigil.
   *  When present the candidate's `insertText` uses `<sigil><insertName>` while
   *  the dropdown `label` stays `name`. Used by the thread lister so the user
   *  sees/ranks by the human title (`name`) but the inserted mention carries the
   *  opaque session id (`insertName`) the `@thread:` resolver looks up. Absent ⇒
   *  `name` doubles as the payload (skill / plugin / app / mcp / subagent). */
  readonly insertName?: string
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
  /** RFC-12-2 — OPTIONAL MCP-server list callback (server name → `@mcp:<name>`).
   *  Absent ⇒ no mcp candidates (byte-identical). */
  readonly listMcpServers?: () => readonly NamedEntry[]
  /** RFC-12-2 — OPTIONAL named-agent (subagent) list callback
   *  (`@subagent:<name>`). Absent ⇒ no subagent candidates. */
  readonly listSubagents?: () => readonly NamedEntry[]
  /** RFC-12-2 — OPTIONAL prior-thread list callback (session id → `@thread:<id>`,
   *  label = title). Absent ⇒ no thread candidates. */
  readonly listThreads?: () => readonly NamedEntry[]
  /** Per-kind candidate cap for the kebab kinds (skill/plugin/app) + symbols.
   *  Default 8 (= `MAX_VISIBLE_CANDIDATES`). */
  readonly maxPerKind?: number
  /** File candidate cap. Larger than `maxPerKind` so the dropdown can scroll
   *  past the visible window + show a "+N more" signal. Default 50. */
  readonly maxFileResults?: number
}

const DEFAULT_MAX = 8
const DEFAULT_FILE_MAX = 50

/** The insertion sigil for each kebab-listed kind. `skill` ⇒ `@name`, `plugin`
 *  ⇒ `plugin://name`, `app` ⇒ `@@name`, and the RFC-12-2 colon-literals ⇒
 *  `@<literal>:<name>` (so submit-time `parseMentions` re-classifies them into
 *  the dedicated mcp / subagent / thread alternatives). */
const KEBAB_SIGIL: Record<"skill" | "plugin" | "app" | "mcp" | "subagent" | "thread", string> = {
  skill: "@",
  plugin: "plugin://",
  app: "@@",
  mcp: "@mcp:",
  subagent: "@subagent:",
  thread: "@thread:",
}

/** Rank a kebab registry's entries against the query and project them into
 *  candidates for the given kind. `label` stays the bare name (the dropdown
 *  display); `insertText` carries the kind's sigil so submit-time re-parse
 *  round-trips (RFC §4.6). */
const listKebab = (
  entries: readonly NamedEntry[],
  query: string,
  kind: "skill" | "plugin" | "app" | "mcp" | "subagent" | "thread",
  max: number,
): readonly AtCandidate[] => {
  const ranked = rankByTier(
    entries.map((e) => e.name),
    query,
  )
  const sigil = KEBAB_SIGIL[kind]
  const out: AtCandidate[] = []
  for (const r of ranked) {
    if (out.length >= max) break
    const entry = entries[r.index]
    if (entry === undefined) continue
    const payload = entry.insertName !== undefined ? entry.insertName : entry.name
    out.push({
      kind,
      insertText: `${sigil}${payload}`,
      label: entry.name,
      detail: mentionFirstLine(entry.description),
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
  const fileMax =
    typeof deps.maxFileResults === "number" &&
    Number.isFinite(deps.maxFileResults) &&
    deps.maxFileResults > 0
      ? Math.trunc(deps.maxFileResults)
      : DEFAULT_FILE_MAX
  const fileOpts: RecursiveFileListerOptions = { fileRoot: deps.fileRoot, maxResults: fileMax }
  const fileLister = createRecursiveFileLister(fileOpts)
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
      // A slash ⇒ path browse ⇒ files only (kebab/symbol names carry no slash).
      if (query.includes("/")) {
        return safe(() => fileLister(query, signal))
      }
      // Uppercase-leading ⇒ symbol intent (ClassName), BUT still probe files:
      // a repo's `@README` / `@Makefile` / `@LICENSE` are real files and must
      // not be swallowed by the symbol route. Symbols lead each round; files
      // interleave so both stay reachable (regression: uppercase was symbol-
      // only and these files never surfaced).
      if (/^[A-Z]/.test(query)) {
        const [symbols, ufiles] = await Promise.all([
          safe(() => symbolLister(query, signal)),
          safe(() => fileLister(query, signal)),
        ])
        return [...symbols, ...ufiles]
      }
      // Lowercase / empty: a file probe (covers `@foo.ts`) PLUS the kebab
      // kinds. EVERY lister is wrapped in `safe` — the kebab `deps.list*()`
      // callbacks run SYNCHRONOUSLY, so a throw there (or inside `listKebab`)
      // must NOT reject the whole batch and wipe the file candidates. `safe`
      // keeps each kind's failure isolated (NO-THROW contract, RFC §6.1).
      const [files, skills, plugins, apps, mcp, subagents, threads] = await Promise.all([
        safe(() => fileLister(query, signal)),
        safe(async () =>
          deps.listSkills ? listKebab(deps.listSkills(), query, "skill", max) : [],
        ),
        safe(async () =>
          deps.listPlugins ? listKebab(deps.listPlugins(), query, "plugin", max) : [],
        ),
        safe(async () => (deps.listApps ? listKebab(deps.listApps(), query, "app", max) : [])),
        // RFC-12-2 — each new lister is INDEPENDENTLY `safe`-wrapped so a throw
        // in one owner (MCP registry / named-agent registry / session store)
        // cannot wipe the other kinds' candidates (NO-THROW §6.1).
        safe(async () =>
          deps.listMcpServers ? listKebab(deps.listMcpServers(), query, "mcp", max) : [],
        ),
        safe(async () =>
          deps.listSubagents ? listKebab(deps.listSubagents(), query, "subagent", max) : [],
        ),
        safe(async () =>
          deps.listThreads ? listKebab(deps.listThreads(), query, "thread", max) : [],
        ),
      ])
      // Files FIRST so the dropdown's primary purpose (`@path`) is never
      // starved out of the visible window by many matching skills/plugins
      // (the prior `[...skills, ...files]` order buried files past the cap).
      // Concatenation (not round-robin) keeps each kind's rows grouped under a
      // single section header instead of spamming a header per row.
      return [...files, ...skills, ...plugins, ...apps, ...mcp, ...subagents, ...threads]
    },
  }
}
