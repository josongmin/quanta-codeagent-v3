/**
 * Rule indicator — Codex `repo-local-rule-ingestion-audit.md` inspired surface.
 *
 * Surfaces in the CLI the count + identity of repo-local rule files that are
 * loaded / matched for the current session: AGENTS.md, CLAUDE.md, and the
 * file-scoped `.cursor/rules/*.mdc` + `.quanta/rules/*.md` set. Without this
 * indicator a user cannot tell which rule files the model is being primed
 * with — the existing loaders (`@/agent/repo-rules`, `@/agent/glob-rules`)
 * read the files invisibly and inject the rendered body into the prompt.
 *
 * Two visible artifacts ride on the inventory:
 *   1. A short inline pill `[rules: 3/4 matched]` that joins the existing
 *      status-pills row (the four-pill chrome). See {@link renderRuleBadge}.
 *   2. A boxed list (`/rules` slash command body) painting every discovered
 *      rule with its kind/scope/size. See {@link renderRuleList}.
 *
 * Slice discipline:
 *   - This module is `src/apps/cli/*` and READ-ONLY against `@/agent`. It
 *     calls `loadRepoRules` + `loadGlobRules` + `selectGlobRules` exactly as
 *     the loop does — but the loop's outputs are unchanged. No new prompt
 *     surface, no new wire to the LLM. The indicator is purely a UI mirror.
 *   - No mutation of any rule file. The user is told what is in scope; rule
 *     editing happens out of band (their editor).
 *
 * Gating contract:
 *   - The pill is gated by `QUANTA_PILL_RULES` (default OFF — jun-11 user
 *     call: the pill is noise in the default chrome). `QUANTA_PILL_RULES=1`
 *     opts the pill back into the status row.
 *   - The master `QUANTA_RULE_INDICATOR=0` knob also short-circuits the
 *     inventory builder (returns the empty inventory immediately) so even the
 *     `/rules` slash command paints "(disabled)" without touching disk.
 *   - Non-TTY surfaces inherit the empty pill via `status-pills.ts` (which
 *     never paints to a non-TTY sink) — this module itself does not check
 *     TTY; that is the composer's job.
 *
 * Cost note: `buildRuleInventory` runs the same fs walk the agent loop
 * already runs per session. Calling it once at REPL boot mirrors the load
 * the loop performs; calling it per turn would double-stat. The composer
 * is responsible for caching across the session.
 */

import { stat } from "node:fs/promises"
import { basename } from "node:path"
import {
  type GlobRule,
  loadGlobRules,
  loadRepoRules,
  type RepoRules,
  selectGlobRules,
} from "@/agent"
import { parseEnvFlag } from "@/runner/assemble"

/** Provenance of a single rule entry. Closed literal so a typo at the call
 *  site fails to compile.
 *
 *   - `global`  : top-level operational contract loaded whole (AGENTS.md,
 *                 CLAUDE.md, .codex/CODEX-RULES.md). Always active when present.
 *   - `glob`    : file-scoped rule (`.cursor/rules/*.mdc`, `.quanta/rules/*.md`)
 *                 whose `globs:` frontmatter is consulted per turn. `active`
 *                 reflects the current-turn `changedPaths` selection.
 *   - `section` : reserved for future layer-level provenance (e.g. one
 *                 `### From <path>` chunk of a multi-layer repo-rules tree). */
export type RuleKind = "global" | "glob" | "section"

/** A single rule file discovered for the session. The shape is UI-facing —
 *  it cites the on-disk path, the kind, and whether the rule is in force
 *  for the current cwd / changedPaths. */
export interface RuleSource {
  /** Repo-relative or basename-style display path. Examples:
   *   - `"CLAUDE.md"`
   *   - `"AGENTS.md"`
   *   - `".quanta/rules/style.md"`
   *   - `".cursor/rules/perf.mdc"`
   *  Caller already normalises to forward slashes. */
  readonly path: string
  /** Provenance kind. See {@link RuleKind}. */
  readonly kind: RuleKind
  /** Was this rule active for the current session/cwd?
   *
   *  For `global` rules: always `true` when the file is present + non-empty.
   *  For `glob`   rules: `true` iff `selectGlobRules` picked it up for the
   *                       supplied `changedPaths` (or the rule declares
   *                       `alwaysApply: true`). */
  readonly active: boolean
  /** Matched glob pattern for conditional rules (only meaningful when
   *  `kind === "glob"`). For `alwaysApply: true` we record `"always"`. */
  readonly matchedPattern?: string
  /** Number of changed-path matches for this rule (advisory; used in the
   *  `/rules list` table to hint how often a rule fires). `undefined` for
   *  `kind === "global"`. */
  readonly matchedPathCount?: number
  /** Raw glob patterns retained for `/rules path <pat>` simulation. Empty
   *  array for `global`/`alwaysApply` rules (those fire regardless of path). */
  readonly globs?: readonly string[]
  /** Byte size of the rule file on disk. Helpful for budget intuition. */
  readonly bytes?: number
}

/** Aggregate inventory passed to the badge + list renderers. */
export interface RuleInventory {
  readonly sources: readonly RuleSource[]
  /** Count of `source.active === true`. */
  readonly activeCount: number
  /** `sources.length`. */
  readonly totalCount: number
}

/** Master ENV knob — `"0" | "false" | "off"` ⇒ skip the entire inventory
 *  build (returns the empty inventory). Default `"1"`. */
export const RULE_INDICATOR_ENV = "QUANTA_RULE_INDICATOR" as const

/** Per-pill knob (composer-level; pill suppression flips this OFF without
 *  affecting the `/rules` slash command). Default `"1"`. */
export const RULE_PILL_ENV = "QUANTA_PILL_RULES" as const

/** Empty inventory singleton — returned when disabled, or when no rule
 *  files were discovered. Frozen so accidental mutation throws in strict
 *  mode (defensive — the caller is supposed to treat it as read-only). */
export const EMPTY_RULE_INVENTORY: RuleInventory = Object.freeze({
  sources: Object.freeze([]),
  activeCount: 0,
  totalCount: 0,
}) as RuleInventory

/** Cap on the number of rule sources surfaced in the inventory. Mirrors
 *  `glob-rules.MAX_RULE_FILES` so a pathological repo cannot stretch the
 *  rendered list beyond a single viewport. */
export const MAX_RULE_SOURCES = 256

// env-flag truth table is the shared `parseEnvFlag` from @/runner/assemble.

/** True iff the indicator subsystem is enabled (env knob `QUANTA_RULE_INDICATOR`
 *  not set OR not falsy). Surface code checks this before painting the pill. */
export const isRuleIndicatorEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  parseEnvFlag(env[RULE_INDICATOR_ENV], true)

/** True iff the rule pill should ride in the status-pill row. The pill is a
 *  subset of the indicator master switch: disabling the pill does NOT disable
 *  the `/rules` slash command. Default OFF (opt-in via `QUANTA_PILL_RULES=1`);
 *  the master indicator stays default-ON so `/rules` keeps working. */
export const isRulePillEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  isRuleIndicatorEnabled(env) && parseEnvFlag(env[RULE_PILL_ENV], false)

/** Compute a best-effort byte size for a source path. ENOENT / EACCES /
 *  EISDIR all fall through to `undefined` — display omits the size hint when
 *  the file is no longer readable. */
const tryByteSize = async (path: string): Promise<number | undefined> => {
  try {
    const st = await stat(path)
    if (st.isFile()) return st.size
    return undefined
  } catch {
    return undefined
  }
}

/** Render a `RepoRules` value into 1..N `RuleSource` rows (one per layer for
 *  multi-layer tree, one row for single-layer). Always-active. */
const repoRulesToSources = async (rules: RepoRules | undefined): Promise<RuleSource[]> => {
  if (rules === undefined) return []
  const layers = rules.layers ?? []
  if (layers.length === 0) {
    const bytes = await tryByteSize(rules.sourcePath)
    return [
      {
        path: rules.entrypoint,
        kind: "global",
        active: true,
        ...(bytes !== undefined ? { bytes } : {}),
      },
    ]
  }
  const rows: RuleSource[] = []
  for (const layer of layers) {
    const bytes = await tryByteSize(layer.sourcePath)
    rows.push({
      path: layer.relativePath,
      kind: "global",
      active: true,
      ...(bytes !== undefined ? { bytes } : {}),
    })
  }
  return rows
}

/** Render a `GlobRule[]` + selection into `RuleSource` rows. */
const globRulesToSources = async (
  rules: GlobRule[],
  selected: GlobRule[],
  cwd: string,
  changedPaths: string[],
): Promise<RuleSource[]> => {
  const selectedSet = new Set(selected.map((r) => r.sourcePath))
  const rows: RuleSource[] = []
  for (const rule of rules) {
    const active = selectedSet.has(rule.sourcePath)
    const matchedPattern = rule.alwaysApply
      ? "always"
      : rule.globs.length > 0
        ? rule.globs.join(", ")
        : undefined
    // For glob rules count how many of the changed paths actually matched.
    // For alwaysApply we leave the count undefined (the count is the size of
    // changedPaths, which is not meaningful).
    let matchedPathCount: number | undefined
    if (active && !rule.alwaysApply && rule.globs.length > 0) {
      // Lazy-import to avoid pulling matchesAnyGlob into the static import
      // graph for callers that never reach this branch.
      const { matchesAnyGlob } = await import("@/skill")
      matchedPathCount = changedPaths.filter((p) => matchesAnyGlob(p, rule.globs)).length
    }
    const bytes = await tryByteSize(rule.sourcePath)
    const displayPath = toRelativeDisplay(cwd, rule.sourcePath)
    rows.push({
      path: displayPath,
      kind: "glob",
      active,
      ...(matchedPattern !== undefined ? { matchedPattern } : {}),
      ...(matchedPathCount !== undefined ? { matchedPathCount } : {}),
      globs: [...rule.globs],
      ...(bytes !== undefined ? { bytes } : {}),
    })
  }
  return rows
}

/** Display path: cwd-relative when the source is under cwd; basename when
 *  the source is outside cwd (the loader walks parent dirs, so an AGENTS.md
 *  in an ancestor may sit outside the current display root). Forward-slash
 *  normalised. */
const toRelativeDisplay = (cwd: string, sourcePath: string): string => {
  const norm = sourcePath.split("\\").join("/")
  const normCwd = cwd.split("\\").join("/").replace(/\/+$/u, "")
  if (norm.startsWith(`${normCwd}/`)) return norm.slice(normCwd.length + 1)
  return basename(norm)
}

export interface BuildRuleInventoryOpts {
  /** Working directory the loaders walk. */
  readonly cwd: string
  /** Per-turn changed-paths set (empty when no turn has run yet — the
   *  `alwaysApply` rules still register as active in that case). */
  readonly changedPaths?: readonly string[]
  /** Env source — defaults to `process.env`. Injected for hermetic tests. */
  readonly env?: NodeJS.ProcessEnv
}

/** Build the inventory by re-running the same loaders the agent loop runs.
 *  Returns {@link EMPTY_RULE_INVENTORY} when the indicator is disabled or
 *  when nothing was discovered. Read-only — no filesystem writes. */
export const buildRuleInventory = async (opts: BuildRuleInventoryOpts): Promise<RuleInventory> => {
  const env = opts.env ?? process.env
  if (!isRuleIndicatorEnabled(env)) return EMPTY_RULE_INVENTORY
  const changed = [...(opts.changedPaths ?? [])]

  // Both loaders are best-effort (they swallow ENOENT etc.). Run in parallel
  // since they touch disjoint paths.
  const [repo, glob] = await Promise.all([
    loadRepoRules(opts.cwd).catch(() => undefined),
    loadGlobRules(opts.cwd).catch(() => [] as GlobRule[]),
  ])

  const selected = selectGlobRules(glob, changed)
  const [repoRows, globRows] = await Promise.all([
    repoRulesToSources(repo),
    globRulesToSources(glob, selected, opts.cwd, changed),
  ])

  const sources = [...repoRows, ...globRows].slice(0, MAX_RULE_SOURCES)
  if (sources.length === 0) return EMPTY_RULE_INVENTORY
  const activeCount = sources.reduce((n, s) => n + (s.active ? 1 : 0), 0)
  return {
    sources,
    activeCount,
    totalCount: sources.length,
  }
}

// ─── badges + list rendering ────────────────────────────────────────────────

const ESC = "\x1b["
const RESET = `${ESC}0m`
const DIM = `${ESC}2m`
const FG_CYAN = `${ESC}36m`

/** Render the short inline pill that joins the existing status-pill row.
 *  Returns `""` when the inventory is empty (no pill).
 *
 *  Format: `[rules: <active>/<total> matched]` (dim cyan when colour is on). */
export const renderRuleBadge = (inv: RuleInventory): string => {
  if (inv.totalCount === 0) return ""
  return `${DIM}${FG_CYAN}[rules: ${inv.activeCount}/${inv.totalCount} matched]${RESET}`
}

/** Scope label inside the parenthetical (one of `global`, `always`, `glob`,
 *  `glob: <pattern>`). Extracted from {@link formatRow} so that function stays
 *  within the biome cognitive-complexity budget. */
const formatScopeLabel = (s: RuleSource): string => {
  if (s.kind === "global") return "global"
  if (s.matchedPattern === "always") return "always"
  if (s.matchedPattern !== undefined) return `glob: ${s.matchedPattern}`
  return "glob"
}

/** Match-count / no-match hint (e.g. `, matched 12 paths` or `, no match`).
 *  Empty string for `global` rules and active rules without an explicit count. */
const formatMatchHint = (s: RuleSource): string => {
  if (s.matchedPathCount !== undefined && s.matchedPathCount > 0) {
    const plural = s.matchedPathCount === 1 ? "" : "s"
    return `, matched ${s.matchedPathCount} path${plural}`
  }
  if (s.kind === "glob" && !s.active) return ", no match"
  return ""
}

/** Format a single rule row for the boxed list. */
const formatRow = (s: RuleSource): string => {
  const marker = s.active ? "✓" : "◌"
  const name = s.path.padEnd(32)
  const scope = formatScopeLabel(s)
  const matchHint = formatMatchHint(s)
  const sizeHint = s.bytes !== undefined ? `, ${formatBytes(s.bytes)}` : ""
  return `  ${marker} ${name} (${scope}${matchHint}${sizeHint})`
}

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  const kib = n / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  const mib = kib / 1024
  return `${mib.toFixed(1)} MiB`
}

/** Render the full boxed list shown by the `/rules` slash command. */
export const renderRuleList = (inv: RuleInventory): string => {
  if (inv.totalCount === 0) {
    return [
      "─ Rules ─────────────────────────────────────────",
      "  (no rules configured)",
      "─────────────────────────────────────────────────",
    ].join("\n")
  }
  const header = "─ Rules ─────────────────────────────────────────"
  const footer = "─────────────────────────────────────────────────"
  const rows = inv.sources.map(formatRow)
  const inactive = inv.totalCount - inv.activeCount
  const summary = `  ${inv.activeCount} active · ${inactive} inactive`
  return [header, ...rows, "", summary, footer].join("\n")
}

/** Strip ANSI escapes — exposed for tests so they can assert plain text
 *  without depending on the colour codes. */
export const stripAnsi = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
  s.replace(/\x1b\[[0-9;]*m/g, "")

/** Simulate matching a single path against the discovered glob rules.
 *  Used by `/rules path <pat>` to answer "if I touched this file, which
 *  rules would fire?" without running a real turn. The match uses the same
 *  `matchesAnyGlob` semantics the agent loop uses.
 *
 *  Global / alwaysApply rules ALWAYS appear in the matched set since they
 *  fire on every turn regardless of changedPaths. */
export const simulatePath = async (
  inv: RuleInventory,
  path: string,
): Promise<{ path: string; matched: RuleSource[] }> => {
  const { matchesAnyGlob } = await import("@/skill")
  const matched = inv.sources.filter((s) => {
    if (s.kind === "global") return true
    if (s.matchedPattern === "always") return true
    if (s.globs === undefined || s.globs.length === 0) return false
    return matchesAnyGlob(path, [...s.globs])
  })
  return { path, matched }
}
