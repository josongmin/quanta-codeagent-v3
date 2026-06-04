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

import { readdir } from "node:fs/promises"
import { basename, join } from "node:path"
import { type GlobRule, loadGlobRules } from "@/agent/glob-rules"
import { loadRepoRules } from "@/agent/repo-rules"
import { parseFrontmatter } from "@/skill/frontmatter"
import { readImportFile } from "../dedup"
import type {
  ConvertedHook,
  ConvertedItem,
  ConvertedMcpServer,
  ConvertedSubagent,
  MigrationWarning,
} from "./types"

/** Coerce an unknown into a non-null plain object, else undefined. */
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** Filter an unknown into a string[] (drops non-strings). Absent ⇒ []. */
const asStringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/** Build a `skipped_malformed` warning for `path`. */
const malformed = (path: string, detail: string): MigrationWarning => ({
  kind: "skipped_malformed",
  path,
  detail,
})

/** Read + JSON.parse `path`. Returns the parsed value, or a typed warning on
 *  absent / unreadable / malformed. Credential / symlink reads are refused by
 *  `readImportFile` (the rejection surfaces as `unreadable`, never a crash). */
const readJson = async (
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; warning: MigrationWarning }> => {
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

// ─── hooks (settings.json#hooks OR standalone hooks.json) → hook config ──

/** Extract the `{type:"command", command}` commands from one hook group. */
const commandsOf = (group: Record<string, unknown>): string[] => {
  const hooks = group.hooks
  if (!Array.isArray(hooks)) return []
  const cmds: string[] = []
  for (const h of hooks) {
    const ho = asObject(h)
    if (ho?.type === "command" && typeof ho.command === "string") cmds.push(ho.command)
  }
  return cmds
}

/** Translate one hook group into a typed binding, or undefined to skip. */
const translateHookGroup = (event: string, rawGroup: unknown): ConvertedHook | undefined => {
  const group = asObject(rawGroup)
  if (group === undefined) return undefined
  const commands = commandsOf(group)
  if (commands.length === 0) return undefined
  const matcher = typeof group.matcher === "string" ? group.matcher : undefined
  return { event, commands, ...(matcher !== undefined ? { matcher } : {}) }
}

/** Translate a `hooks` map (`{ <Event>: [ { matcher?, hooks:[…] } ] }`) into
 *  typed bindings. */
const translateHookMap = (hooks: Record<string, unknown>): ConvertedHook[] => {
  const out: ConvertedHook[] = []
  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue
    for (const rawGroup of rawGroups) {
      const t = translateHookGroup(event, rawGroup)
      if (t !== undefined) out.push(t)
    }
  }
  return out
}

/**
 * Translate Claude Code hooks → quanta hook config. Accepts BOTH the modern
 * inline shape (`settings.json#hooks`) AND a standalone `hooks.json` whose
 * TOP LEVEL is the hook map. We detect which by basename: a `hooks.json` is
 * the map directly; anything else is read as `settings.json` and we descend
 * into its `hooks` key. Empty result is still `ok:true` (an empty hooks block
 * is valid — the converter found nothing to import but did not fail).
 */
export const convertHooks = async (path: string): Promise<ConvertedItem> => {
  const parsed = await readJson(path)
  if (!parsed.ok) return { type: "hooks", ok: false, warning: parsed.warning }
  const obj = asObject(parsed.value)
  if (obj === undefined) {
    return { type: "hooks", ok: false, warning: malformed(path, "not an object") }
  }
  const hookMap = basename(path) === "hooks.json" ? obj : asObject(obj.hooks)
  if (hookMap === undefined) return { type: "hooks", ok: true, value: [] }
  return { type: "hooks", ok: true, value: translateHookMap(hookMap) }
}

// ─── .mcp.json → MCP server config (passthrough/normalize) ───────────────

/** Classify a Claude Code MCP entry's transport. stdio is the default when a
 *  `command` is present and no explicit type/url overrides. */
const classifyTransport = (entry: Record<string, unknown>): ConvertedMcpServer["transport"] => {
  const type = entry.type
  if (type === "http" || type === "sse" || type === "stdio") return type
  if (typeof entry.url === "string") return "http"
  if (typeof entry.command === "string") return "stdio"
  return "unknown"
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
  const obj = asObject(parsed.value)
  const servers = asObject(obj?.mcpServers)
  if (servers === undefined) return { type: "mcp", ok: true, value: [] }
  const out: ConvertedMcpServer[] = []
  for (const [name, rawEntry] of Object.entries(servers)) {
    const entry = asObject(rawEntry)
    if (entry === undefined) continue
    const transport = classifyTransport(entry)
    const command = typeof entry.command === "string" ? entry.command : undefined
    const args = Array.isArray(entry.args)
      ? entry.args.filter((a): a is string => typeof a === "string")
      : undefined
    out.push({
      name,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined ? { args } : {}),
    })
  }
  return { type: "mcp", ok: true, value: out }
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
