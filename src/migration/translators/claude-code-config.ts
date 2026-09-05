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
import { asObject, decodeClaudeHookMap, decodeClaudeMcpServers } from "../claude-config-decode"
import { contentSha256OfText, readImportFile } from "../dedup"
import type { TranslatedHook, TranslatedMcpServer, TranslatedRule } from "../types"

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

export const translateMcpServers = async (root: string): Promise<TranslatedMcpServer[]> => {
  const parsed = await readJsonIfPresent(join(root, ".mcp.json"))
  return decodeClaudeMcpServers(parsed)
}

/** Translate `settings.json#hooks` into typed hook bindings. Claude Code shape:
 *  `hooks: { <EventName>: [ { matcher?, hooks: [{type:"command", command}] } ] }`.
 *  Absent file / absent `hooks` ⇒ `[]`. A group with zero command hooks is
 *  dropped (no signal). */
export const translateHooks = async (root: string): Promise<TranslatedHook[]> => {
  const parsed = await readJsonIfPresent(join(root, "settings.json"))
  const obj = asObject(parsed)
  return decodeClaudeHookMap(obj?.hooks)
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
