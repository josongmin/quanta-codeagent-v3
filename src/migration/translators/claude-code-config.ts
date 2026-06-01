/**
 * Claude Code config translator (ADR-0430).
 *
 * Translates the NON-session artifacts a Claude Code install carries — MCP
 * server config, hooks, and repo-rule memory files — into typed quanta
 * equivalents. Pure with respect to v3 state: returns translated values; the
 * importer tallies them and the CLI surface persists what it can.
 *
 * Scope (ADR-0430 §what-we-skip): only the kinds quanta has an equivalent for.
 *   - MCP: read `.mcp.json` (`mcpServers` map). stdio servers carry
 *     command+args; http/sse are reported with their transport so the caller
 *     can skip what quanta does not model. Credentials/`env` are NOT carried.
 *   - Hooks: read `settings.json#hooks` (Claude Code shape: event → matcher
 *     groups → `hooks[]` with `{ type:"command", command }`).
 *   - Rules: read `CLAUDE.md` memory files (project root + `.claude/CLAUDE.md`).
 *
 * Defensive by contract: a missing file is `[]`/empty (ENOENT swallowed); a
 * malformed file is skipped, never thrown. N10: every read routes through
 * {@link readImportFile}, which refuses credential files before any syscall.
 */

import { join } from "node:path"
import { contentSha256OfText, readImportFile } from "../dedup"
import type { TranslatedHook, TranslatedMcpServer, TranslatedRule } from "../types"

/** Coerce an unknown into a non-null plain object, else undefined. */
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

/** Read + JSON.parse a file. ENOENT ⇒ undefined (absent is not an error);
 *  malformed JSON ⇒ undefined (skip, never throw). Other read errors (e.g.
 *  EACCES, or the N10 credential ban) propagate. */
const readJsonIfPresent = async (path: string): Promise<unknown | undefined> => {
  let raw: string
  try {
    raw = await readImportFile(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw err
  }
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Classify a Claude Code MCP server entry's transport. stdio is the default
 *  when a `command` is present and no explicit `type`/`url` says otherwise. */
const classifyTransport = (entry: Record<string, unknown>): TranslatedMcpServer["transport"] => {
  const type = entry.type
  if (type === "http" || type === "sse" || type === "stdio") return type
  if (typeof entry.url === "string") return "http"
  if (typeof entry.command === "string") return "stdio"
  return "unknown"
}

/** Translate `.mcp.json` (`<root>/.mcp.json`) into typed MCP server entries.
 *  Absent file ⇒ `[]`. Each entry carries name + transport; stdio entries
 *  also carry command+args. `env` is deliberately dropped (may hold secrets;
 *  N10 spirit — we never carry credentials across). */
export const translateMcpServers = async (root: string): Promise<TranslatedMcpServer[]> => {
  const parsed = await readJsonIfPresent(join(root, ".mcp.json"))
  const obj = asObject(parsed)
  const servers = asObject(obj?.mcpServers)
  if (servers === undefined) return []
  const out: TranslatedMcpServer[] = []
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
  return out
}

/** Extract the `{ type:"command", command }` shell commands from one Claude
 *  Code hook group's `hooks[]` array. Non-command hook types are skipped. */
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

/** Translate one Claude Code hook group into a typed hook binding, or
 *  undefined to skip (not an object, or zero command hooks ⇒ no signal). */
const translateHookGroup = (event: string, rawGroup: unknown): TranslatedHook | undefined => {
  const group = asObject(rawGroup)
  if (group === undefined) return undefined
  const commands = commandsOf(group)
  if (commands.length === 0) return undefined
  const matcher = typeof group.matcher === "string" ? group.matcher : undefined
  return { event, commands, ...(matcher !== undefined ? { matcher } : {}) }
}

/** Translate `settings.json#hooks` into typed hook bindings. Claude Code shape:
 *  `hooks: { <EventName>: [ { matcher?, hooks: [{type:"command", command}] } ] }`.
 *  Absent file / absent `hooks` ⇒ `[]`. A group with zero command hooks is
 *  dropped (no signal). */
export const translateHooks = async (root: string): Promise<TranslatedHook[]> => {
  const parsed = await readJsonIfPresent(join(root, "settings.json"))
  const obj = asObject(parsed)
  const hooks = asObject(obj?.hooks)
  if (hooks === undefined) return []
  const out: TranslatedHook[] = []
  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) continue
    for (const rawGroup of rawGroups) {
      const translated = translateHookGroup(event, rawGroup)
      if (translated !== undefined) out.push(translated)
    }
  }
  return out
}

/** Candidate CLAUDE.md memory locations under a Claude Code source root. The
 *  detector roots at `<home>/.claude`, so the project-root `CLAUDE.md` lives
 *  at `<root>/../CLAUDE.md` and the user memory at `<root>/CLAUDE.md`. */
const ruleCandidatePaths = (root: string): string[] => [
  join(root, "CLAUDE.md"),
  join(root, "..", "CLAUDE.md"),
]

/** Translate Claude Code `CLAUDE.md` memory files into typed rule documents.
 *  Each present file becomes one rule with a content hash (dedup key). Absent
 *  files are skipped. Empty/whitespace-only files carry no signal ⇒ dropped. */
export const translateRules = async (root: string): Promise<TranslatedRule[]> => {
  const out: TranslatedRule[] = []
  const seen = new Set<string>()
  for (const path of ruleCandidatePaths(root)) {
    let text: string
    try {
      text = await readImportFile(path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") continue
      throw err
    }
    if (text.trim() === "") continue
    const contentHash = await contentSha256OfText(text)
    if (seen.has(contentHash)) continue
    seen.add(contentHash)
    out.push({ sourcePath: path, contentHash, text })
  }
  return out
}
