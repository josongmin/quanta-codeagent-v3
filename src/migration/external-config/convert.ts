/**
 * External-config IMPORT pass — per-item-type converters (H13).
 *
 * Each converter is a small, focused function that turns ONE competitor config
 * artifact into the quanta shape. The conversions are SHORT because the
 * read-time parsers already exist:
 *
 *   - `agents_md`    → REUSES `@/agent/repo-rules#loadRepoRules`
 *   - `cursor_rules` → REUSES `@/agent/glob-rules#loadGlobRules`
 *   - `mcp` / `hooks`→ REUSES the parent slice's `translateMcpServers` /
 *                       `translateHooks` shapes (Claude Code config translator)
 *   - `settings`     → new, tiny: `permissions{allow,deny,ask}` + `defaultMode`
 *   - `subagents`    → new, tiny: frontmatter (`@/skill/frontmatter`) + body
 *
 * No-throw contract: every converter returns a discriminated `ConvertedItem`.
 * A malformed / empty source yields `ok:false` with a typed `MigrationWarning`
 * — never an exception. All byte reads route through the parent slice's
 * `readImportFile` (credential-ban + no-follow-symlink, N10).
 */

import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { type GlobRule, loadGlobRules } from "@/agent/glob-rules"
import { loadRepoRules } from "@/agent/repo-rules"
import { parseFrontmatter, parseSkillMarkdown } from "@/skill/frontmatter"
import { asObject, decodeClaudeHookMap, decodeClaudeMcpServers } from "../claude-config-decode"
import { readImportFile } from "../dedup"
import type { ConvertedItem, ConvertedSkill, ConvertedSubagent, MigrationWarning } from "./types"

/** Filter an unknown into a string[] (drops non-strings). Absent ⇒ []. */
const asStringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/** Build a `skipped_malformed` warning for `path`. */
const malformed = (path: string, detail: string): MigrationWarning => ({
  kind: "skipped_malformed",
  path,
  detail,
})

/** DoS cap on a single competitor config file. A JSON config of more than 4 MiB
 *  is hostile (or unsupported): parsing it would buffer the whole file + the
 *  parse tree in memory. We `stat` the size BEFORE any byte is read so an
 *  oversized file is refused without ever loading it into a parse. */
const MAX_CONFIG_BYTES = 4 * 1024 * 1024

/** Read + JSON.parse `path`. Returns the parsed value, or a typed warning on
 *  absent / unreadable / malformed / oversized. Credential / symlink reads are
 *  refused by `readImportFile` (the rejection surfaces as `unreadable`, never a
 *  crash). An over-cap file is refused on size alone — never read into a parse. */
const readJson = async (
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; warning: MigrationWarning }> => {
  try {
    const st = await stat(path)
    if (st.isFile() && st.size > MAX_CONFIG_BYTES) {
      return {
        ok: false,
        warning: malformed(path, `config file too large (${st.size} bytes > ${MAX_CONFIG_BYTES})`),
      }
    }
  } catch {
    // stat failure (absent / race) falls through to the read below, which
    // produces the precise absent/unreadable warning.
  }
  let raw: string
  try {
    raw = await readImportFile(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, warning: malformed(path, "absent") }
    }
    return { ok: false, warning: { kind: "unreadable", path, detail: code ?? "read failed" } }
  }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false, warning: malformed(path, "invalid JSON") }
  }
}

// ─── settings.json → permission/config shape ─────────────────────────────

/**
 * Translate Claude Code `settings.json` → quanta permission/config fragment.
 * Claude Code shape: `{ permissions: { allow[], deny[], ask[] }, defaultMode }`.
 * Unknown keys are dropped (no silent passthrough). Absent `permissions` ⇒
 * empty allow/deny/ask (still `ok:true` — an empty settings file is valid).
 */
export const convertSettings = async (path: string): Promise<ConvertedItem> => {
  const parsed = await readJson(path)
  if (!parsed.ok) return { type: "settings", ok: false, warning: parsed.warning }
  const obj = asObject(parsed.value)
  if (obj === undefined) {
    return { type: "settings", ok: false, warning: malformed(path, "not an object") }
  }
  const perms = asObject(obj.permissions) ?? {}
  const defaultMode = typeof obj.defaultMode === "string" ? obj.defaultMode : undefined
  return {
    type: "settings",
    ok: true,
    value: {
      allow: asStringList(perms.allow),
      deny: asStringList(perms.deny),
      ask: asStringList(perms.ask),
      ...(defaultMode !== undefined ? { defaultMode } : {}),
    },
  }
}

export const convertHooks = async (path: string): Promise<ConvertedItem> => {
  const parsed = await readJson(path)
  if (!parsed.ok) return { type: "hooks", ok: false, warning: parsed.warning }
  const obj = asObject(parsed.value)
  if (obj === undefined) {
    return { type: "hooks", ok: false, warning: malformed(path, "not an object") }
  }
  const hookMap = basename(path) === "hooks.json" ? obj : obj.hooks
  return { type: "hooks", ok: true, value: decodeClaudeHookMap(hookMap) }
}

/**
 * Translate `.mcp.json` → quanta MCP server entries. Passthrough of the
 * modeled fields (name + transport + command + args). `env` is deliberately
 * DROPPED (may hold secrets — never carry credentials across the import
 * boundary). Absent `mcpServers` ⇒ empty list (`ok:true`).
 */
export const convertMcp = async (path: string): Promise<ConvertedItem> => {
  const parsed = await readJson(path)
  if (!parsed.ok) return { type: "mcp", ok: false, warning: parsed.warning }
  return { type: "mcp", ok: true, value: decodeClaudeMcpServers(parsed.value) }
}

// ─── .claude/agents/<name>.md → subagent spec ────────────────────────────

/** Normalize a frontmatter `tools` value (string | string[]) to string[].
 *  Claude Code writes `tools: Read, Grep` (comma) OR a YAML list. */
const normalizeTools = (raw: unknown): string[] => {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  }
  return asStringList(raw)
}

/**
 * Translate ONE Claude Code subagent file (`.claude/agents/<name>.md`) → a
 * quanta subagent spec. Frontmatter carries `name`/`description`/`tools`; the
 * markdown body is the system prompt. A missing `name` falls back to the file
 * stem (the Claude Code convention). An empty body carries no signal ⇒
 * `ok:false`. Public for direct per-file testing.
 */
export const convertSubagentFile = async (path: string): Promise<ConvertedItem> => {
  let raw: string
  try {
    raw = await readImportFile(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { type: "subagents", ok: false, warning: malformed(path, "absent") }
    }
    return {
      type: "subagents",
      ok: false,
      warning: { kind: "unreadable", path, detail: code ?? "read failed" },
    }
  }
  const { data, body } = parseFrontmatter(raw)
  const systemPrompt = body.trim()
  if (systemPrompt.length === 0) {
    return { type: "subagents", ok: false, warning: malformed(path, "empty body") }
  }
  const stem = basename(path).replace(/\.md$/i, "")
  const name =
    typeof data.name === "string" && data.name.trim().length > 0 ? data.name.trim() : stem
  const description =
    typeof data.description === "string" && data.description.trim().length > 0
      ? data.description.trim()
      : undefined
  const spec: ConvertedSubagent = {
    name,
    ...(description !== undefined ? { description } : {}),
    tools: normalizeTools(data.tools),
    systemPrompt,
    sourcePath: path,
  }
  return { type: "subagents", ok: true, value: [spec] }
}

/** Cap on subagent files scanned from a directory — a hostile competitor tree
 *  cannot pin the import. Real `.claude/agents` holds a handful of files. */
const MAX_SUBAGENT_FILES = 256

/**
 * Translate a Claude Code subagents DIRECTORY (`.claude/agents/`) → all the
 * quanta subagent specs it holds. Each `*.md` file is converted via
 * {@link convertSubagentFile}; files that yield no signal (empty body) are
 * skipped (their per-file warning is dropped — the directory result reports
 * only the specs it found). Absent dir / zero usable specs ⇒ `ok:false`.
 * Accepts a single FILE path too (delegates to {@link convertSubagentFile}).
 */
export const convertSubagents = async (path: string): Promise<ConvertedItem> => {
  let names: string[]
  try {
    names = await readdir(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // Not a directory ⇒ treat `path` as a single subagent file.
    if (code === "ENOTDIR") return convertSubagentFile(path)
    if (code === "ENOENT") {
      return { type: "subagents", ok: false, warning: malformed(path, "absent") }
    }
    return {
      type: "subagents",
      ok: false,
      warning: { kind: "scan_failed", path, detail: code ?? "readdir failed" },
    }
  }
  const specs: ConvertedSubagent[] = []
  let scanned = 0
  for (const name of [...names].sort()) {
    if (scanned >= MAX_SUBAGENT_FILES) break
    if (!name.toLowerCase().endsWith(".md")) continue
    scanned += 1
    const r = await convertSubagentFile(join(path, name))
    if (r.ok && r.type === "subagents") specs.push(...r.value)
  }
  if (specs.length === 0) {
    return { type: "subagents", ok: false, warning: malformed(path, "no usable subagents") }
  }
  return { type: "subagents", ok: true, value: specs }
}

// ─── CLAUDE.md / AGENTS.md → repo-rules (REUSES @/agent/repo-rules) ───────

/**
 * Translate a `CLAUDE.md` / `AGENTS.md` → quanta repo-rules by REUSING the
 * read-time `loadRepoRules` parser. `loadRepoRules` walks `cwd → repo root`
 * collecting `AGENTS.md`/`CLAUDE.md`; we point it at the file's directory so it
 * loads exactly that layer (plus any ancestor layers, which is the same
 * deeper-wins semantics the live loader applies). Empty ⇒ `loadRepoRules`
 * returns undefined ⇒ `ok:false` (no phantom rule).
 */
export const convertAgentsMd = async (path: string): Promise<ConvertedItem> => {
  const dir = join(path, "..")
  let rules: Awaited<ReturnType<typeof loadRepoRules>>
  try {
    rules = await loadRepoRules(dir)
  } catch {
    return { type: "agents_md", ok: false, warning: malformed(path, "rule load failed") }
  }
  if (rules === undefined) {
    return { type: "agents_md", ok: false, warning: malformed(path, "empty or absent") }
  }
  return {
    type: "agents_md",
    ok: true,
    value: { entrypoint: rules.entrypoint, sourcePath: rules.sourcePath, body: rules.body },
  }
}

// ─── .cursor/rules/*.mdc / .cursorrules → glob-rules (REUSES glob-rules) ──

/** Map one `GlobRule` (from the read-time loader) → the converter output. */
const fromGlobRule = (
  g: GlobRule,
): {
  readonly sourcePath: string
  readonly description?: string
  readonly globs: readonly string[]
  readonly alwaysApply: boolean
  readonly body: string
} => ({
  sourcePath: g.sourcePath,
  ...(g.description !== undefined ? { description: g.description } : {}),
  globs: g.globs,
  alwaysApply: g.alwaysApply,
  body: g.body,
})

/**
 * Translate Cursor rules (`.cursor/rules/*.mdc`, plus `.quanta/rules`) →
 * quanta glob-rules by REUSING the read-time `loadGlobRules` parser. Takes the
 * PROJECT DIR (not a single file) because `loadGlobRules` scans the rule
 * directories. No rules found ⇒ `ok:false` (nothing to import).
 *
 * NOTE: `.cursorrules` (the single-file legacy form) is NOT parsed by
 * `loadGlobRules`; it is detected separately and imported via `convertAgentsMd`
 * semantics is out of scope here — the cursor_rules dir form is the SOTA path
 * and the one Cursor itself migrated to.
 */
export const convertCursorRules = async (projectDir: string): Promise<ConvertedItem> => {
  let rules: GlobRule[]
  try {
    rules = await loadGlobRules(projectDir)
  } catch {
    return { type: "cursor_rules", ok: false, warning: malformed(projectDir, "rule load failed") }
  }
  if (rules.length === 0) {
    return { type: "cursor_rules", ok: false, warning: malformed(projectDir, "no rules found") }
  }
  return { type: "cursor_rules", ok: true, value: rules.map(fromGlobRule) }
}

// ─── .claude/skills/<name>/SKILL.md → STAGED skill proposal ──────────────
//
// Imported skills are UNTRUSTED executable-supply-chain artifacts. This
// converter VALIDATES each imported `SKILL.md` through the SAME discovery
// schema quanta's own loader uses (`parseSkillMarkdown`), FORCES
// `stability:experimental`, and REFUSES a name that collides with a SYSTEM
// skill (system cannot be shadowed — RFC03-4 §Trust). It emits ONLY typed
// `ConvertedSkill` data (name + normalized bytes + provenance). The PERSIST
// step routes those bytes through the RFC03-2/3 staging/promote contract (an
// injected `SkillStagePort`) — this converter NEVER writes to the live skills
// directory (that is a promotion-after-approve action, not an import action).

/** Options for {@link convertSkills}. `systemSkillNames` is the pinned
 *  snapshot's system-skill name set (the host supplies it — the migration slice
 *  cannot reach `@/skill` to discover it) so a name collision is REFUSED. */
export interface ConvertSkillsOptions {
  readonly systemSkillNames: ReadonlySet<string>
}

/** Cap on skill dirs scanned — a hostile competitor tree cannot pin the import. */
const MAX_IMPORT_SKILLS = 256

/** Force `stability:experimental` in the frontmatter of a validated SKILL.md so
 *  an imported skill is never presented as stable, without re-rendering (we
 *  keep the author's body/description verbatim). Replaces an existing
 *  `stability:` frontmatter line; the schema guaranteed one is present. */
const forceExperimentalStability = (skillMd: string): string =>
  skillMd.replace(/^stability:.*$/m, "stability: experimental")

/**
 * Convert ONE imported `SKILL.md` file. Validates through the discovery schema;
 * refuses a system-name collision; forces experimental stability. Returns the
 * typed `ConvertedSkill` or `null` (skip — malformed / shadowed). Public for
 * per-file testing.
 */
export const convertSkillFile = async (
  path: string,
  systemSkillNames: ReadonlySet<string>,
): Promise<ConvertedSkill | null> => {
  let raw: string
  try {
    raw = await readImportFile(path)
  } catch {
    return null
  }
  const parsed = parseSkillMarkdown(raw)
  if (!parsed.ok) return null
  const { name, description } = parsed.value.frontmatter
  // System-shadow refusal — a system skill cannot be shadowed by an import.
  if (systemSkillNames.has(name)) return null
  return {
    name,
    description,
    stability: "experimental",
    skillMd: forceExperimentalStability(raw),
    sourcePath: path,
  }
}

/**
 * Translate a Claude Code SKILLS DIRECTORY (`.claude/skills/`) → all the quanta
 * skill specs it holds. Each `<name>/SKILL.md` is validated + shadow-checked via
 * {@link convertSkillFile}; entries that fail validation OR shadow a system
 * skill are skipped. Absent dir / zero usable skills ⇒ `ok:false`.
 */
export const convertSkills = async (
  skillsDir: string,
  opts: ConvertSkillsOptions,
): Promise<ConvertedItem> => {
  let names: string[]
  try {
    names = await readdir(skillsDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { type: "skills", ok: false, warning: malformed(skillsDir, "absent") }
    }
    return {
      type: "skills",
      ok: false,
      warning: { kind: "scan_failed", path: skillsDir, detail: code ?? "readdir failed" },
    }
  }
  const specs: ConvertedSkill[] = []
  let scanned = 0
  for (const name of [...names].sort()) {
    if (scanned >= MAX_IMPORT_SKILLS) break
    const skillMdPath = join(skillsDir, name, "SKILL.md")
    let isFile: boolean
    try {
      isFile = (await stat(skillMdPath)).isFile()
    } catch {
      continue // no SKILL.md under this entry ⇒ not a skill.
    }
    if (!isFile) continue
    scanned += 1
    const spec = await convertSkillFile(skillMdPath, opts.systemSkillNames)
    if (spec !== null) specs.push(spec)
  }
  if (specs.length === 0) {
    return { type: "skills", ok: false, warning: malformed(skillsDir, "no usable skills") }
  }
  return { type: "skills", ok: true, value: specs }
}

// ─── ~/.claude/CLAUDE.md (memory form) → raw_memories.md append ───────────
//
// Claude's home `~/.claude/CLAUDE.md` is the cross-project MEMORY file. It is
// UNTRUSTED text: the PERSIST step APPENDS it to the existing `raw_memories.md`
// evidence trail ONLY — never to `MEMORY.md` (which must pass consolidation).
// This converter reads + validates non-emptiness and carries the body +
// provenance (the source path is the double-append dedup key in persist).

/**
 * Convert an imported memory file (`~/.claude/CLAUDE.md`) → a `ConvertedMemory`.
 * Empty / whitespace-only ⇒ `ok:false` (no phantom append). Absent / unreadable
 * ⇒ typed warning (never throws).
 */
export const convertMemory = async (path: string): Promise<ConvertedItem> => {
  let raw: string
  try {
    raw = await readImportFile(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { type: "memory", ok: false, warning: malformed(path, "absent") }
    }
    return {
      type: "memory",
      ok: false,
      warning: { kind: "unreadable", path, detail: code ?? "read failed" },
    }
  }
  const body = raw.trim()
  if (body.length === 0) {
    return { type: "memory", ok: false, warning: malformed(path, "empty memory file") }
  }
  return { type: "memory", ok: true, value: { sourcePath: path, body } }
}
