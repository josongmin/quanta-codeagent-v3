/**
 * Repro-gen GROUNDING orchestrator + lexical adapter (jun-29 RFC, C4).
 *
 * Three-layer toggle architecture (RFC §4.5):
 *   - PURE CORE (C1, `@/agent/repro-test/grounding`): skeleton-strip + block
 *     builders. Inert until called.
 *   - GATED ORCHESTRATOR (this file, {@link retrieveExemplarSkeletons}): the ONE
 *     non-pure entry. `enabled=false` ⇒ `{}` (no I/O, byte-identical prompt). When
 *     on, it pulls related-test skeletons + issue signatures through INJECTED ports
 *     and assembles a {@link ReproGroundingInput}.
 *   - WIRING SEAM (C5, driver): builds the concrete ports + reads the
 *     `reproGrounding` posture bit, passes the result into `generateReproTests`.
 *
 * Swap-seam ownership (integration RFC v2 OBJ#3): the engine that decides "which
 * existing tests are relevant" is the injected {@link ReproGroundingPorts.relatedTests}.
 * Today it is the LEXICAL adapter ({@link buildLexicalReproGroundingPorts} over
 * `discoverImpactedTests`); a future `CodeIntelligencePort` (semantica) adapter
 * fills the SAME port — this orchestrator is unchanged.
 *
 * NO-LEAK: every skeleton passes through {@link stripTestBodies} here (defence in
 * depth — `exemplarBlock` re-strips again at prompt-build time). Assertion bodies
 * never reach the prompt.
 */

import type { ReproGroundingInput } from "@/agent/repro-test/generate"
import { stripTestBodies } from "@/agent/repro-test/grounding"
import {
  type DiscoverImpactedTestsArgs,
  discoverImpactedTests,
  isPythonTestFile,
  type RepoTextFile,
} from "./impacted-test-discovery"
import { listTrackedPythonFiles, readRepoTestFiles } from "./repo-regression-discovery-adapter"

/** A relevant existing test surfaced by the retrieval backend: its repo path +
 *  raw source text (bodies NOT yet stripped — the orchestrator strips). */
export interface RelatedTestFile {
  readonly path: string
  readonly text: string
}

/**
 * Injected retrieval ports. The orchestrator is engine-agnostic: it asks for
 * related tests + (optionally) signatures and never knows whether the backend is
 * lexical (`discoverImpactedTests`) or a static-analysis engine (semantica).
 */
export interface ReproGroundingPorts {
  /** Existing tests relevant to the issue's source files, MOST-RELEVANT FIRST.
   *  Returns raw {path,text}; the orchestrator strips bodies. Empty ⇒ no grounding. */
  readonly relatedTests: (sourceFiles: readonly string[]) => Promise<readonly RelatedTestFile[]>
  /** Optional: public signatures of the issue's symbols (e.g. from LSP), one per
   *  entry. Absent ⇒ no signature block. */
  readonly signatures?: (symbols: readonly string[]) => Promise<readonly string[]>
}

export interface RetrieveExemplarSkeletonsArgs {
  /** Posture gate (driver passes `posture.reproGrounding`). `false` ⇒ `{}`. */
  readonly enabled: boolean
  /** Source files the issue is about (localization output). Empty ⇒ no exemplar
   *  retrieval (the lexical backend keys related tests off these). */
  readonly sourceFiles: readonly string[]
  /** Symbols the issue mentions, for the signature block. */
  readonly issueSymbols?: readonly string[]
  /** Max exemplar skeletons to inject (token bound). Default 2. */
  readonly maxExemplars?: number
  readonly ports: ReproGroundingPorts
}

/** Default exemplar cap — 2 skeletons is enough to convey the fixture pattern
 *  without blowing the prompt budget (RFC R3 bound). */
export const DEFAULT_MAX_EXEMPLARS = 2

/**
 * GATED orchestrator. `enabled=false` ⇒ `{}` (no port calls, no I/O — the prompt
 * stays byte-identical). When on, retrieve related tests, strip bodies, take the
 * top-`maxExemplars`, and (optionally) fetch issue-symbol signatures. Any port
 * rejection degrades to "no grounding for that part" (never throws — a flaky
 * retrieval must not fail repro generation). Returns `{}` when nothing usable was
 * found, so the caller is byte-identical to the un-grounded path.
 */
/** Retrieve + strip up to `max` exemplar skeletons (most-relevant first). A port
 *  rejection degrades to `[]`. Empty-after-strip skeletons are skipped. */
const collectSkeletons = async (
  ports: ReproGroundingPorts,
  sourceFiles: readonly string[],
  max: number,
): Promise<readonly string[]> => {
  if (sourceFiles.length === 0) return []
  const related = await ports.relatedTests(sourceFiles).catch(() => [])
  const out: string[] = []
  for (const file of related) {
    if (out.length >= max) break
    const sk = stripTestBodies(file.text)
    if (sk.trim() !== "") out.push(sk)
  }
  return out
}

/** Fetch issue-symbol signatures via the optional port (only when both the port
 *  and a non-empty symbol set are present). Degrades to `[]` on throw. */
const collectSignatures = async (
  ports: ReproGroundingPorts,
  symbols: readonly string[],
): Promise<readonly string[]> => {
  if (ports.signatures === undefined || symbols.length === 0) return []
  const sigs = await ports.signatures(symbols).catch(() => [])
  return sigs.map((s) => s.trim()).filter((s) => s !== "")
}

export const retrieveExemplarSkeletons = async (
  args: RetrieveExemplarSkeletonsArgs,
): Promise<ReproGroundingInput> => {
  if (!args.enabled) return {}
  const max = Math.max(1, Math.floor(args.maxExemplars ?? DEFAULT_MAX_EXEMPLARS))
  const skeletons = await collectSkeletons(args.ports, args.sourceFiles, max)
  const signatures = await collectSignatures(args.ports, args.issueSymbols ?? [])
  return {
    ...(skeletons.length > 0 ? { exemplarSkeletons: skeletons } : {}),
    ...(signatures.length > 0 ? { issueSignatures: signatures } : {}),
  }
}

/* ── Cheap source-file inference (lexical localization for the exemplar key) ── */

/** Distinctive tokens the issue mentions: dotted module paths (`sphinx.ext.autodoc`)
 *  split into components + standalone identifiers length ≥ 5. Lowercased, deduped.
 *  Pure. NOT an answer-key signal — derived from the PUBLIC issue text only (never
 *  the gold patch), the same surface localization already uses. */
const issueTokens = (problemStatement: string): ReadonlySet<string> => {
  const out = new Set<string>()
  for (const m of problemStatement.matchAll(/[A-Za-z_][A-Za-z0-9_.]{3,}/g)) {
    for (const part of m[0].toLowerCase().split(".")) {
      if (part.length >= 5) out.add(part)
    }
  }
  return out
}

/** Lowercased path-component stems (dir names + filename sans `.py`). */
const componentStems = (path: string): readonly string[] =>
  path
    .toLowerCase()
    .split("/")
    .map((c) => c.replace(/\.py$/, ""))

/**
 * Infer the source files the issue is about, by matching {@link issueTokens}
 * against the path-component stems of tracked NON-test python files. Ranked by
 * match count (desc), then path (stable); capped at `maxFiles`. This is the
 * LEXICAL exemplar-retrieval key — the localization signal that
 * {@link discoverImpactedTests} scores existing tests against. A future
 * `CodeIntelligencePort` (semantica) replaces this with real localization.
 *
 * C6 audit fix: FLOOD tokens — ones matching > half the source files (i.e. the
 * package/top-dir name `sphinx`/`django`, which every file shares) — carry no
 * localization signal and would fill the cap with alphabetical noise. They are
 * DROPPED from scoring, so the ranking reflects only DISTINCTIVE matches. When
 * the issue offers only flood tokens, the result is `[]` (honestly inert) rather
 * than alphabetical noise. Empty issue / no distinctive match ⇒ `[]`. Pure.
 */
export const inferIssueSourceFiles = (
  problemStatement: string,
  trackedFiles: readonly string[],
  maxFiles = 5,
): readonly string[] => {
  if (typeof problemStatement !== "string" || problemStatement.trim() === "") return []
  const tokens = issueTokens(problemStatement)
  if (tokens.size === 0) return []
  const sources = trackedFiles
    .filter((p) => p.endsWith(".py") && !isPythonTestFile(p))
    .map((p) => ({ path: p, stems: new Set(componentStems(p)) }))
  if (sources.length === 0) return []
  // Drop flood tokens (match > half the files = package/dir names = no signal).
  const floodCutoff = sources.length / 2
  const live = [...tokens].filter((t) => {
    const n = sources.reduce((acc, s) => acc + (s.stems.has(t) ? 1 : 0), 0)
    return n > 0 && n <= floodCutoff
  })
  if (live.length === 0) return []
  const scored: { path: string; score: number }[] = []
  for (const s of sources) {
    const score = live.reduce((acc, t) => acc + (s.stems.has(t) ? 1 : 0), 0)
    if (score > 0) scored.push({ path: s.path, score })
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return scored.slice(0, Math.max(1, Math.floor(maxFiles))).map((s) => s.path)
}

/* ── Lexical adapter (default backend) ─────────────────────────────────────── */

/** Default cap on how many ranked related tests the lexical backend surfaces
 *  before the orchestrator's own `maxExemplars` slice. */
const DEFAULT_RELATED_MAX = 8

/**
 * Concrete LEXICAL {@link ReproGroundingPorts} over the existing
 * `discoverImpactedTests` engine: list tracked python test files, read them,
 * rank them against the localized source files by import/reference evidence, and
 * return the ranked {path,text}. Does NOT provide `signatures` (the issue-symbol
 * signature block is a ready-but-DEFERRED extension — no LSP signature port is
 * wired yet; the exemplar path ships first per RFC R2). Pure-ish glue over
 * injected I/O so it stays unit-testable.
 *
 * `trackedFiles`: when the driver already listed `git ls-files` (for source-file
 * inference), it passes the list here so the adapter does NOT re-run it (C6 audit:
 * was a double `git ls-files` per instance).
 */
export const buildLexicalReproGroundingPorts = (deps: {
  readonly sandbox: string
  readonly timeoutMs: number
  readonly maxRelated?: number
  /** Already-listed tracked files (avoids a second `git ls-files`). */
  readonly trackedFiles?: readonly string[]
  /** Injected for tests; default to the real adapters. */
  readonly listFiles?: typeof listTrackedPythonFiles
  readonly readTests?: typeof readRepoTestFiles
  readonly discover?: (args: DiscoverImpactedTestsArgs) => string[]
}): ReproGroundingPorts => {
  const listFiles = deps.listFiles ?? listTrackedPythonFiles
  const readTests = deps.readTests ?? readRepoTestFiles
  const discover = deps.discover ?? discoverImpactedTests
  const maxRelated = Math.max(1, Math.floor(deps.maxRelated ?? DEFAULT_RELATED_MAX))
  return {
    relatedTests: async (sourceFiles) => {
      if (sourceFiles.length === 0) return []
      const tracked = deps.trackedFiles ?? (await listFiles(deps.sandbox, deps.timeoutMs))
      // readRepoTestFiles filters to python TEST files internally.
      const repoFiles: readonly RepoTextFile[] = await readTests(deps.sandbox, tracked)
      if (repoFiles.length === 0) return []
      const rankedPaths = discover({ changedFiles: sourceFiles, repoFiles, maxTests: maxRelated })
      const byPath = new Map(repoFiles.map((f) => [f.path, f.text]))
      const out: RelatedTestFile[] = []
      for (const path of rankedPaths) {
        const text = byPath.get(path)
        if (text !== undefined && text.trim() !== "") out.push({ path, text })
      }
      return out
    },
  }
}
