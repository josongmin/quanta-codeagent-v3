/**
 * ADR-0457 — codex skill ECOSYSTEM bundled resources (gap C).
 *
 * A directory-form skill (`<dir>/<name>/SKILL.md`) MAY ship sibling resource
 * directories that codex's skill-creator establishes:
 *
 *   <name>/
 *     SKILL.md
 *     agents/openai.yaml   UI / harness metadata (display_name, icons, …)
 *     scripts/             executable automation (file-name list only)
 *     references/          on-demand docs (file-name list only)
 *     assets/              output / icon files (file-name list only)
 *
 * This module records PRESENCE + direct file-name lists for the three plain
 * directories and parses ONLY the small, known `interface:` block of
 * `agents/openai.yaml`. References / assets / scripts are NOT loaded into model
 * context — that is on-demand (the skill body reads them via the normal read
 * tool when its instructions say to). Token discipline is the whole point.
 *
 * Fail-safe posture mirrors `discover.ts`: any IO / parse error on a resource
 * is swallowed and the resource is simply omitted. Discovery NEVER crashes on a
 * malformed bundled resource. No new dependency — the tiny `interface:` parser
 * is hand-rolled (the file has no `---` fence so the SKILL.md frontmatter
 * parsers do not apply).
 */
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { checkSkillSize } from "./skill-size"
import type { SkillAgentInterface, SkillResources } from "./types"

/** The four codex resource subdirs. `agents` is parsed; the rest are listed. */
const RESOURCE_DIRS = ["agents", "scripts", "references", "assets"] as const

/** Strip one matching pair of wrapping quotes from a scalar. */
const unquote = (s: string): string => {
  const t = s.trim()
  if (t.length >= 2) {
    const a = t[0]
    const b = t[t.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1)
  }
  return t
}

/**
 * Map a snake_case `interface:` child key to the camelCase {@link
 * SkillAgentInterface} field. Unknown keys (e.g. future `icon_*` variants or
 * `dependencies`/`policy` blocks) are ignored — additive-safe.
 */
const INTERFACE_KEY_MAP: Readonly<Record<string, keyof SkillAgentInterface>> = Object.freeze({
  display_name: "displayName",
  short_description: "shortDescription",
  default_prompt: "defaultPrompt",
  icon_small: "iconSmall",
  icon_large: "iconLarge",
  brand_color: "brandColor",
})

/**
 * Parse the `interface:` block of an `agents/openai.yaml` body. Minimal,
 * dependency-free: handles exactly `interface:` followed by indented
 * `key: "value"` children, stopping at the next top-level (non-indented) key.
 * Anything else (other top-level blocks like `dependencies:` / `policy:`,
 * deeper nesting, list values) is ignored. Returns undefined when no
 * recognised interface field is found (so the caller omits `agentsYaml`).
 */
/** Record an indented `key: "value"` interface child into `out` (mapped to its
 *  camelCase field). No-op for unrecognised keys or empty values. */
const recordInterfaceChild = (raw: string, out: Record<string, string>): void => {
  const child = raw.match(/^\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/)
  if (!child) return
  const mapped = INTERFACE_KEY_MAP[child[1] ?? ""]
  if (mapped === undefined) return
  const value = unquote((child[2] ?? "").trim())
  if (value !== "") out[mapped] = value
}

export const parseOpenaiYamlInterface = (text: string): SkillAgentInterface | undefined => {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let inInterface = false
  const out: Record<string, string> = {}
  for (const raw of lines) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue
    if (/^\s/.test(raw)) {
      if (inInterface) recordInterfaceChild(raw, out)
      continue
    }
    // Top-level key: enter the block on `interface:`, leave on any other.
    inInterface = /^interface\s*:\s*$/.test(raw)
  }
  return Object.keys(out).length > 0 ? (out as SkillAgentInterface) : undefined
}

/** Read + parse `agents/openai.yaml`'s interface block; undefined on any error.
 *  The read is size-bounded by the SAME `checkSkillSize` cap discovery uses for
 *  SKILL.md — an oversized/garbage `agents/openai.yaml` (e.g. an auto-fetched
 *  untrusted skill) is skipped, not slurped into the heap (OOM/DoS guard). */
const readAgentsInterface = async (skillDir: string): Promise<SkillAgentInterface | undefined> => {
  try {
    const path = join(skillDir, "agents", "openai.yaml")
    const sized = await checkSkillSize(path)
    if (!sized.ok) return undefined // absent, oversized, or unstattable ⇒ skip
    const raw = await readFile(path, "utf8")
    return parseOpenaiYamlInterface(raw)
  } catch {
    // Missing file is the common case; a malformed/unreadable one is swallowed
    // too — a bundled resource must never crash discovery (fail-safe posture).
    return undefined
  }
}

/** Direct file names inside `<skillDir>/<sub>`; undefined when absent/empty. */
const listResourceFiles = async (
  skillDir: string,
  sub: string,
): Promise<readonly string[] | undefined> => {
  try {
    const entries = await readdir(join(skillDir, sub), { withFileTypes: true })
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return files.length > 0 ? files : undefined
  } catch {
    return undefined
  }
}

/**
 * Discover bundled resources for a directory-form skill given its SKILL.md
 * path. Returns undefined when the skill ships none of the four subdirs (so the
 * caller omits `Skill.resources` entirely — byte-identical for plain skills).
 * Fail-safe throughout: any error on one resource omits just that resource.
 */
export const discoverSkillResources = async (
  skillMdPath: string,
): Promise<SkillResources | undefined> => {
  const skillDir = dirname(skillMdPath)
  const [agentsYaml, scripts, references, assets] = await Promise.all([
    readAgentsInterface(skillDir),
    listResourceFiles(skillDir, "scripts"),
    listResourceFiles(skillDir, "references"),
    listResourceFiles(skillDir, "assets"),
  ])
  const resources: SkillResources = {
    ...(agentsYaml !== undefined ? { agentsYaml } : {}),
    ...(scripts !== undefined ? { scripts } : {}),
    ...(references !== undefined ? { references } : {}),
    ...(assets !== undefined ? { assets } : {}),
  }
  return Object.keys(resources).length > 0 ? resources : undefined
}

/** Exported for tests / docs: the recognised resource subdir names. */
export const SKILL_RESOURCE_DIRS = RESOURCE_DIRS
