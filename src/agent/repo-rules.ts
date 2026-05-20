import { readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Repo-local rule ingestion (Codex `repo-local-rule-ingestion-audit.md` mirror).
 *
 * Repos often ship an operational contract — canonical command paths, fail-
 * closed posture, patch discipline, "no heuristics" rules — in a top-level
 * markdown file (`AGENTS.md`, `CLAUDE.md`, or `.codex/CODEX-RULES.md`). When a
 * caller wires this loader, the rule body rides per-turn as a labelled
 * `<system-reminder>` block AHEAD of generic memory hints, so the LLM treats
 * it as REPO POLICY (authority) rather than routing hint.
 *
 * The loader is opt-in: `runAgent` only consumes `config.repoRules` when the
 * caller attaches it. Bench harnesses and other contexts that should NOT
 * adopt rules from the workspace just skip the call — byte-identical.
 *
 * Priority order matches Codex SSOT convention: `AGENTS.md` first (Codex's
 * canonical entrypoint), then `CLAUDE.md` (Claude Code convention), then
 * `.codex/CODEX-RULES.md` (legacy alt). Only the first present file with a
 * non-empty body wins; secondary files are intentionally NOT merged to avoid
 * silent dual-truth.
 */

export interface RepoRules {
  /** Absolute path to the source file. */
  sourcePath: string
  /** Logical entrypoint name as it appears in the repo (used in the rendered
   *  block so the LLM can cite the authority). */
  entrypoint: string
  /** Raw body, trimmed for the rendered block. */
  body: string
  /** Epoch ms the rules were loaded — useful for debugging and stale checks. */
  loadedAt: number
}

/** Files searched, in priority order. The first present + non-empty file wins.
 *  Order is part of the contract: `AGENTS.md` is Codex SSOT; `CLAUDE.md` is the
 *  Claude Code convention; the `.codex/` path is a legacy alternate. */
export const REPO_RULE_CANDIDATES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".codex/CODEX-RULES.md",
] as const

/** Load repo-local rules from the first present candidate under `cwd`. Returns
 *  `undefined` when no file is present or all candidates are empty — the
 *  byte-identical no-op. Errors other than ENOENT (e.g. permission) are
 *  swallowed; the loader falls through to the next candidate. Read ONCE per
 *  session by convention — Codex's anti-reread rule applies here too. */
export const loadRepoRules = async (cwd: string): Promise<RepoRules | undefined> => {
  for (const name of REPO_RULE_CANDIDATES) {
    const sourcePath = join(cwd, name)
    const body = await tryRead(sourcePath)
    if (body !== undefined && body.trim().length > 0) {
      return { sourcePath, entrypoint: name, body, loadedAt: Date.now() }
    }
  }
  return undefined
}

const tryRead = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

/** Render rules as the per-turn `<system-reminder>` section. The label cites
 *  the entrypoint so the LLM treats it as repo authority, distinct from the
 *  generic memory-hints section that lives downstream. */
export const renderRepoRulesBlock = (rules: RepoRules): string =>
  `## Repo-local rules (from ${rules.entrypoint})\n${rules.body.trim()}`
