/**
 * External-config DETECT pass (H13).
 *
 * Walks the KNOWN external-config locations (no heuristics) and returns a typed
 * {@link ConfigInventory}. Mirrors Codex's `external_agent_config.rs` Detect
 * pass: a fixed set of `(scope, relative-path, item-type)` probes, each an
 * `access(2)` existence check — no bytes read here (the converters read bytes
 * later, through the parent slice's credential-safe read primitive).
 *
 * Two scopes:
 *   - `home`    → `~/.claude/settings.json`, `~/.claude/CLAUDE.md`, etc.
 *   - `project` → `<cwd>/CLAUDE.md`, `<cwd>/.claude/...`, `<cwd>/.cursor/...`.
 *
 * No-throw contract: a missing location is simply absent; a location that
 * errors on `stat` (e.g. a FILE planted where a DIR is expected → ENOTDIR on a
 * child probe) is swallowed and, where it prevents a scan, surfaced as a
 * `scan_failed` warning. Detect NEVER throws.
 */

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type {
  ConfigInventory,
  DetectedConfigItem,
  MigrationItemType,
  MigrationScope,
  MigrationWarning,
} from "./types"

/** Inputs to the detect pass. Both dirs are injected (no `homedir()` /
 *  `process.cwd()` inside the slice) so detect is pure with respect to the
 *  environment and trivially testable against a tmp fs. */
export interface DetectInput {
  /** The user's home directory (`~`) — the `home` scope root. */
  readonly homeDir: string
  /** The current project root (`cwd`) — the `project` scope root. */
  readonly projectDir: string
}

/** A single-file probe: a relative path under a scope root mapped to its
 *  item type. All probes are existence-checked; present ⇒ one inventory item. */
interface FileProbe {
  readonly rel: string
  readonly type: MigrationItemType
}

/** Single-file probes per scope. `hooks` is detected from BOTH the inlined
 *  `settings.json` (the modern Claude Code shape carries `hooks` inside
 *  settings) AND a standalone `hooks.json`; the converter handles either. We
 *  emit a `hooks` item when EITHER exists (deduped below by path). */
const HOME_FILE_PROBES: readonly FileProbe[] = Object.freeze([
  { rel: join(".claude", "settings.json"), type: "settings" },
  { rel: join(".claude", "settings.json"), type: "hooks" },
  { rel: join(".claude", "hooks.json"), type: "hooks" },
  // SOURCE-PATH disambiguation (RFC03-4): the user's HOME `~/.claude/CLAUDE.md`
  // is Claude's cross-project MEMORY file, NOT a repo-rules entrypoint. It is
  // classified `memory` (appended to raw_memories.md) — the classification is
  // by the SOURCE PATH's role (home `.claude` memory location), not a name-
  // keyword heuristic, and it is the ONLY probe for this path so the SAME file
  // is never double-imported as both `memory` and `agents_md`. A repo-root
  // `~/CLAUDE.md` (below) remains `agents_md`.
  { rel: join(".claude", "CLAUDE.md"), type: "memory" },
  { rel: "CLAUDE.md", type: "agents_md" },
  { rel: join(".claude", ".mcp.json"), type: "mcp" },
])

const PROJECT_FILE_PROBES: readonly FileProbe[] = Object.freeze([
  { rel: "CLAUDE.md", type: "agents_md" },
  { rel: "AGENTS.md", type: "agents_md" },
  { rel: join(".claude", "settings.json"), type: "settings" },
  { rel: join(".claude", "settings.json"), type: "hooks" },
  { rel: join(".claude", "hooks.json"), type: "hooks" },
  { rel: ".mcp.json", type: "mcp" },
  { rel: ".cursorrules", type: "cursor_rules" },
])

/** A directory probe: a relative dir whose presence (with at least one
 *  matching entry) yields a single inventory item of `type`. Used for
 *  subagents (`.claude/agents/*.md`) and Cursor rules (`.cursor/rules/*.mdc`). */
interface DirProbe {
  readonly rel: string
  readonly type: MigrationItemType
  /** Extension(s) an entry must carry to count (e.g. `.md`, `.mdc`). */
  readonly exts: readonly string[]
  /** When true, the probe matches iff at least one immediate SUBDIRECTORY holds
   *  a `SKILL.md` file — the `.claude/skills/<name>/SKILL.md` nesting. Flat
   *  `<dir>/*.md` matching (default) does not fit skills. */
  readonly nestedSkill?: boolean
}

const PROJECT_DIR_PROBES: readonly DirProbe[] = Object.freeze([
  { rel: join(".claude", "agents"), type: "subagents", exts: [".md"] },
  { rel: join(".cursor", "rules"), type: "cursor_rules", exts: [".mdc", ".md"] },
  // A skills dir with at least one `<name>/SKILL.md` → a `skills` item. Skills
  // nest one level deep, so this uses the nested-skill match (not flat `.md`).
  { rel: join(".claude", "skills"), type: "skills", exts: [".md"], nestedSkill: true },
])

const HOME_DIR_PROBES: readonly DirProbe[] = Object.freeze([
  { rel: join(".claude", "agents"), type: "subagents", exts: [".md"] },
  { rel: join(".claude", "skills"), type: "skills", exts: [".md"], nestedSkill: true },
])

/** Cap on directory entries scanned for a dir probe — a hostile competitor
 *  tree with a million files cannot pin the startup detect. We only need to
 *  know whether AT LEAST ONE matching entry exists, so we stop early anyway. */
const MAX_DIR_ENTRIES = 4096

/** Existence check that distinguishes "absent" (false) from "errored". A
 *  non-ENOENT/ENOTDIR error is reported via `onError` so the caller can decide
 *  whether to warn; the probe still counts as absent. */
const fileExists = async (
  path: string,
  onError: (w: MigrationWarning) => void,
): Promise<boolean> => {
  try {
    const st = await stat(path)
    return st.isFile()
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    onError({ kind: "unreadable", path, detail: code ?? "stat failed" })
    return false
  }
}

/** Returns true iff `dir` exists AND holds at least one entry whose name ends
 *  with one of `exts`. A scan failure (other than absent) is surfaced as a
 *  `scan_failed` warning and treated as "no matching entry". */
const dirHasMatch = async (
  dir: string,
  exts: readonly string[],
  onError: (w: MigrationWarning) => void,
): Promise<boolean> => {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    onError({ kind: "scan_failed", path: dir, detail: code ?? "readdir failed" })
    return false
  }
  let scanned = 0
  for (const name of names) {
    if (scanned >= MAX_DIR_ENTRIES) break
    scanned += 1
    if (exts.some((e) => name.endsWith(e))) return true
  }
  return false
}

/** Returns true iff `dir` exists AND at least one immediate subdirectory holds
 *  a `SKILL.md` file (the `.claude/skills/<name>/SKILL.md` nesting). Absent /
 *  ENOTDIR ⇒ false; a scan failure is warned + treated as "no match". Only the
 *  presence of the FILE counts (a bare subdir with no SKILL.md does not). */
const dirHasNestedSkill = async (
  dir: string,
  onError: (w: MigrationWarning) => void,
): Promise<boolean> => {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    onError({ kind: "scan_failed", path: dir, detail: code ?? "readdir failed" })
    return false
  }
  let scanned = 0
  for (const name of [...names].sort()) {
    if (scanned >= MAX_DIR_ENTRIES) break
    scanned += 1
    // A `stat` of `<subdir>/SKILL.md` — present + a real file ⇒ a skill exists.
    try {
      const st = await stat(join(dir, name, "SKILL.md"))
      if (st.isFile()) return true
    } catch {
      // absent / not a dir / unreadable ⇒ this entry is not a skill; keep going.
    }
  }
  return false
}

/** Probe one scope's files + dirs, appending detected items + warnings. */
const probeScope = async (
  root: string,
  scope: MigrationScope,
  fileProbes: readonly FileProbe[],
  dirProbes: readonly DirProbe[],
  items: DetectedConfigItem[],
  warnings: MigrationWarning[],
): Promise<void> => {
  const onError = (w: MigrationWarning): void => {
    warnings.push(w)
  }
  // Dedup key: a `(type, path)` pair is emitted at most once even if two
  // probes (e.g. settings + hooks both at settings.json) reference it under
  // the SAME type — they don't (different types), but the same TYPE+PATH from
  // overlapping probe lists is collapsed.
  const seen = new Set<string>()
  const push = (type: MigrationItemType, path: string): void => {
    const key = `${type}\x00${path}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ type, path, scope })
  }
  for (const probe of fileProbes) {
    const path = join(root, probe.rel)
    if (await fileExists(path, onError)) push(probe.type, path)
  }
  for (const probe of dirProbes) {
    const path = join(root, probe.rel)
    const matched = probe.nestedSkill
      ? await dirHasNestedSkill(path, onError)
      : await dirHasMatch(path, probe.exts, onError)
    if (matched) push(probe.type, path)
  }
}

/**
 * Detect external (Claude Code / Cursor) config artifacts under the home +
 * project roots. Pure with respect to env; NEVER throws. Returns an inventory
 * whose `items` is empty when nothing is planted (⇒ the caller offers no
 * prompt). Items are ordered scope-then-probe-order, deduped by (type, path).
 */
export const detectExternalConfigs = async (input: DetectInput): Promise<ConfigInventory> => {
  const items: DetectedConfigItem[] = []
  const warnings: MigrationWarning[] = []
  await probeScope(input.homeDir, "home", HOME_FILE_PROBES, HOME_DIR_PROBES, items, warnings)
  await probeScope(
    input.projectDir,
    "project",
    PROJECT_FILE_PROBES,
    PROJECT_DIR_PROBES,
    items,
    warnings,
  )
  return { items, warnings }
}

/** Expose the probe tables for the suite so a test can assert coverage of all
 *  item types without re-declaring the location list. */
export const detectProbes = (): {
  readonly homeFiles: readonly FileProbe[]
  readonly projectFiles: readonly FileProbe[]
  readonly homeDirs: readonly DirProbe[]
  readonly projectDirs: readonly DirProbe[]
} =>
  Object.freeze({
    homeFiles: HOME_FILE_PROBES,
    projectFiles: PROJECT_FILE_PROBES,
    homeDirs: HOME_DIR_PROBES,
    projectDirs: PROJECT_DIR_PROBES,
  })
