import { existsSync } from "node:fs"
import { lstat, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

/**
 * Repo-local rule ingestion (Codex `repo-local-rule-ingestion-audit.md` mirror,
 * extended ADR-0098 with tree-scoping + deeper-wins).
 *
 * Repos often ship an operational contract — canonical command paths, fail-
 * closed posture, patch discipline, "no heuristics" rules — in a top-level
 * markdown file (`AGENTS.md`, `CLAUDE.md`, or `.codex/CODEX-RULES.md`). In a
 * monorepo, packages also often want their own AGENTS.md to layer rules on
 * top of the root contract. The loader walks CWD → repo-root collecting any
 * AGENTS.md/CLAUDE.md/.codex file it finds at each directory level and
 * renders them in root → cwd order so deeper-wins via LLM positional bias
 * (later content overrides earlier in same-axis conflicts).
 *
 * Stop conditions (the walk halts at any of):
 *   1. A directory containing `.git` (repo root — INCLUDED then stop)
 *   2. Filesystem root (`dirname(dir) === dir`)
 *   3. `MAX_DEPTH` (16) hops without hitting `.git` — runaway safety
 *
 * Backward compatibility: when only one layer is found the rendered `body` is
 * the raw layer content (no `### From <path>` subheader) so existing consumers
 * (`prompt.ts:491`) see byte-identical output. Multi-layer body uses subheaders
 * so the LLM can attribute and a human auditor can see which file a rule came
 * from.
 *
 * Same-dir priority within one level is unchanged: `AGENTS.md` first (Codex
 * SSOT), then `CLAUDE.md` (Claude Code convention), then `.codex/CODEX-RULES.md`
 * (legacy alt). Only the first present + non-empty file wins per dir.
 *
 * The loader is opt-in: `runAgent` only consumes `config.repoRules` when the
 * caller attaches it. Bench harnesses and other contexts that should NOT
 * adopt rules from the workspace just skip the call — byte-identical.
 */

/** A single rule file discovered during the walk. */
export interface RepoRulesLayer {
  /** Absolute path to the source file. */
  sourcePath: string
  /** Entrypoint name as it appears in the repo (`AGENTS.md`, `CLAUDE.md`, or
   *  `.codex/CODEX-RULES.md`). */
  entrypoint: string
  /** Raw body (trimmed, with per-layer truncation marker if it exceeded
   *  {@link MAX_BYTES}). */
  body: string
  /** Path relative to the consuming cwd, with `./` (cwd) or `../` (ancestor)
   *  prefix. Used in the rendered subheader for attribution. */
  relativePath: string
  /** Steps from cwd up to the dir containing this file. 0 = cwd itself,
   *  1 = parent, … */
  depth: number
}

export interface RepoRules {
  /** Absolute path to the deepest (closest to cwd) layer's source. Kept for
   *  backward compat — single-citation callers see the most-specific file. */
  sourcePath: string
  /** Entrypoint name of the deepest layer. */
  entrypoint: string
  /** Rendered body. Single-layer ⇒ raw layer body (byte-identical pre-tree).
   *  Multi-layer ⇒ root → cwd ordered layers joined with `### From <path>`
   *  subheaders, blank lines between layers. */
  body: string
  /** Epoch ms the rules were loaded. */
  loadedAt: number
  /** All discovered layers in root → cwd order (highest depth first, depth-0
   *  last). Optional at the type level so legacy callers / test fixtures that
   *  hand-build a single-layer `RepoRules` literal stay type-compatible; the
   *  production loader always populates it. Empty array is not possible: when
   *  no layers are found the loader returns `undefined` instead of an empty-
   *  layer `RepoRules`. */
  layers?: readonly RepoRulesLayer[]
}

/** Files searched at each directory level, in priority order. The first
 *  present + non-empty file wins per directory. */
export const REPO_RULE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", ".codex/CODEX-RULES.md"] as const

/** Max bytes per layer body. Bodies larger than this are truncated with a
 *  marker rather than rejected outright. Applies per-layer, not in total. */
export const MAX_BYTES = 64 * 1024

/** Max directories the walk visits before forcibly terminating. Guards against
 *  pathological setups (very deep paths under no git repo) — real monorepos
 *  almost never nest beyond ~5 levels. */
const MAX_DEPTH = 16

/** Load repo-local rules by walking CWD → repo root. Returns `undefined` when
 *  no layers are present anywhere along the walk. Errors other than ENOENT
 *  (e.g. permission) are swallowed per-layer; the loader continues to the
 *  next candidate / parent dir. Read ONCE per session by convention. */
export const loadRepoRules = async (cwd: string): Promise<RepoRules | undefined> => {
  const resolvedCwd = resolve(cwd)
  const collected: RepoRulesLayer[] = []
  let dir = resolvedCwd
  let depth = 0

  for (let i = 0; i < MAX_DEPTH; i++) {
    const layer = await loadLayerForDir(dir, resolvedCwd, depth)
    if (layer !== undefined) collected.push(layer)

    // After processing the current dir, decide whether to walk up. The `.git`
    // boundary is checked AFTER the dir is processed so the repo-root layer
    // (if any) is always included.
    if (existsSync(join(dir, ".git"))) break
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
    depth += 1
  }

  if (collected.length === 0) return undefined

  // collected is in cwd→root order (depth 0 first). For the rendered body we
  // want root→cwd so deeper layers appear LAST (LLM positional bias = deeper-
  // wins). The `layers` field exposes this same root→cwd ordering for callers
  // that want to inspect provenance.
  const ordered = [...collected].sort((a, b) => b.depth - a.depth)
  const deepest = collected[0]! // cwd-closest layer (depth ascending; pos 0 = smallest depth = closest to cwd)

  const body =
    ordered.length === 1 ? ordered[0]!.body : ordered.map(renderLayerSection).join("\n\n")

  return {
    sourcePath: deepest.sourcePath,
    entrypoint: deepest.entrypoint,
    body,
    loadedAt: Date.now(),
    layers: ordered,
  }
}

const loadLayerForDir = async (
  dir: string,
  resolvedCwd: string,
  depth: number,
): Promise<RepoRulesLayer | undefined> => {
  for (const name of REPO_RULE_CANDIDATES) {
    const sourcePath = join(dir, name)
    const body = await tryRead(sourcePath)
    if (body !== undefined && body.trim().length > 0) {
      return {
        sourcePath,
        entrypoint: name,
        body,
        relativePath: computeRelativePath(resolvedCwd, sourcePath),
        depth,
      }
    }
  }
  return undefined
}

const computeRelativePath = (cwd: string, sourcePath: string): string => {
  const rel = relative(cwd, sourcePath)
  // Normalize Windows backslashes to forward slashes for label stability —
  // the label rides into the LLM prompt and humans compare it to git paths.
  const normalized = rel.split(sep).join("/")
  if (normalized.startsWith("..")) return normalized
  return `./${normalized}`
}

const tryRead = async (path: string): Promise<string | undefined> => {
  try {
    // SECURITY: `lstat` does NOT follow symlinks. We reject symlinks entirely
    // because an attacker (or careless contributor) could symlink AGENTS.md
    // at `~/.ssh/id_rsa` (or any other secret), and the contents would then
    // ride into the LLM prompt every turn as REPO POLICY. Refusal is the only
    // safe policy: the link target has no trust relationship with the repo,
    // but the LLM would treat the rendered body as authority.
    const st = await lstat(path)
    if (st.isSymbolicLink()) return undefined
    if (!st.isFile()) return undefined
    const body = await readFile(path, "utf8")
    if (body.length > MAX_BYTES) {
      // Truncate per-layer with an explicit marker so the LLM (and human
      // auditors) can see that the rules were cut. The byte count refers to
      // the UTF-16 code units returned by `readFile("utf8")` — same unit
      // String.prototype.length reports, kept consistent for the marker.
      return `${body.slice(0, MAX_BYTES)}\n\n[truncated: ${body.length} bytes total, showing first 64 KiB]`
    }
    return body
  } catch {
    // ENOENT, EACCES, EISDIR, and any other transient/permission failure all
    // fall through silently — the loader is best-effort and the next
    // candidate (or no rules at all) is the correct outcome.
    return undefined
  }
}

const renderLayerSection = (layer: RepoRulesLayer): string =>
  `### From ${layer.relativePath}\n${layer.body.trim()}`

/** Render rules as the per-turn `<system-reminder>` section. The label cites
 *  the entrypoint so the LLM treats it as repo authority, distinct from the
 *  generic memory-hints section that lives downstream.
 *
 *  Single-layer (legacy / pre-tree): byte-identical to the original `(from
 *  <entrypoint>)` header so existing prompt-dynamic / sota-codex assertions and
 *  the cached system-prompt prefix stay untouched.
 *
 *  Multi-layer (ADR-0098 tree scoping): a parenthetical hint ("rules from
 *  deeper directories override shallower ones") rides next to the entrypoint
 *  citation so the LLM doesn't have to infer deeper-wins from positional
 *  ordering alone. This is the §18.1 verbatim contract surfaced into the
 *  rendered prompt. */
export const renderRepoRulesBlock = (rules: RepoRules): string => {
  const layerCount = rules.layers?.length ?? 1
  const header =
    layerCount > 1
      ? `## Repo-local rules (from ${rules.entrypoint}; rules from deeper directories override shallower ones)`
      : `## Repo-local rules (from ${rules.entrypoint})`
  return `${header}\n${rules.body.trim()}`
}
