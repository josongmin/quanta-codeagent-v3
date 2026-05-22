/**
 * Plugin manifest loader + discovery (Cluster E / F13, ADR-0039).
 *
 * - `loadPluginManifest(pluginDir)` — read + validate a single plugin root.
 *   FAILS loudly when the manifest is missing, JSON-malformed, or Zod-invalid.
 *   No auto-fix, no defaulting, no swallowed errors (Cluster E hard rule).
 *
 * - `discoverPlugins(rootDir)` — walk the tree under `rootDir`, return all
 *   directories that contain `<dir>/.quanta-plugin/plugin.json`. Depth is
 *   capped at 4 to prevent runaway scans on large monorepos / node_modules.
 *
 * Slice contract: this module is allowed to touch the filesystem and import
 * `./plugin-manifest.ts`. It MUST NOT import other slices (Biome enforces).
 */
import type { Dirent } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import {
  MCPRootSchema,
  type MCPServerSpec,
  PLUGIN_DIR_NAME,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MCP_FILE,
  PLUGIN_SKILLS_DIR,
  type PluginManifest,
  PluginManifestSchema,
} from "./plugin-manifest"

/** A skill entry observed under `<pluginDir>/skills/<name>/SKILL.md`. The
 *  loader does NOT parse the SKILL.md frontmatter (that is the skill
 *  frontmatter slice's job in F14 — `./skill-frontmatter.ts`). */
export interface PluginSkillEntry {
  name: string
  skillMdPath: string
}

/** Fully-resolved plugin: manifest + optional first-listed MCP server +
 *  skills directory enumeration. `mcpServer` exists only when the plugin
 *  ships a `.mcp.json` with at least one server. When multiple servers are
 *  declared we keep them all under `mcpServers` (key-preserving). */
export interface LoadedPlugin {
  dir: string
  manifest: PluginManifest
  mcpServers?: Record<string, MCPServerSpec>
  skillEntries: PluginSkillEntry[]
}

/** Lightweight discovery record (no manifest parse) — useful when the host
 *  wants the path list cheaply before deciding which to load. */
export interface DiscoveredPlugin {
  dir: string
  manifestPath: string
}

const MAX_DISCOVERY_DEPTH = 4

/** Strongly-typed error so callers can branch on cause without string-match. */
export class PluginManifestError extends Error {
  override readonly name = "PluginManifestError"
  override readonly cause: "missing" | "json" | "schema" | "io"
  readonly path: string
  constructor(message: string, cause: "missing" | "json" | "schema" | "io", path: string) {
    super(message)
    this.cause = cause
    this.path = path
  }
}

const readJson = async (
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; err: PluginManifestError }> => {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return { ok: false, err: new PluginManifestError(`not found: ${path}`, "missing", path) }
    }
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, err: new PluginManifestError(`io error at ${path}: ${msg}`, "io", path) }
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      err: new PluginManifestError(`malformed JSON at ${path}: ${msg}`, "json", path),
    }
  }
}

/** Enumerate `<pluginDir>/skills/*` for `SKILL.md` files. Returns empty when
 *  the skills directory is absent — that is a legitimate state (a plugin may
 *  ship only MCP servers). Skills are returned sorted by name for
 *  deterministic test output. */
const collectSkillEntries = async (pluginDir: string): Promise<PluginSkillEntry[]> => {
  const skillsDir = join(pluginDir, PLUGIN_SKILLS_DIR)
  let entries: Dirent[]
  try {
    entries = (await readdir(skillsDir, { withFileTypes: true })) as Dirent[]
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return []
    throw e
  }
  const out: PluginSkillEntry[] = []
  for (const ent of entries) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue
    const skillMd = join(skillsDir, ent.name, "SKILL.md")
    try {
      const st = await stat(skillMd)
      if (st.isFile()) out.push({ name: ent.name, skillMdPath: skillMd })
    } catch {
      // No SKILL.md inside this dir (or it is unreadable) — not a plugin skill
      // entry. Silent skip here is intentional and documented: this enumerates
      // *plugin-shipped* skills only, so a foreign dir under skills/ is the
      // common, expected case, not an error. Logging it would be per-scan noise.
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

/** Load + validate one plugin root. Order: manifest (required) → mcp
 *  (optional) → skills enumeration. Errors are raised as
 *  {@link PluginManifestError} so the caller can react to cause without
 *  string parsing. */
export const loadPluginManifest = async (pluginDir: string): Promise<LoadedPlugin> => {
  const manifestPath = join(pluginDir, PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILE)
  const manifestRead = await readJson(manifestPath)
  if (!manifestRead.ok) throw manifestRead.err
  const parsed = PluginManifestSchema.safeParse(manifestRead.value)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n")
    throw new PluginManifestError(
      `manifest schema mismatch at ${manifestPath}:\n${issues}`,
      "schema",
      manifestPath,
    )
  }
  const manifest = parsed.data

  const mcpPath = join(pluginDir, PLUGIN_MCP_FILE)
  let mcpServers: Record<string, MCPServerSpec> | undefined
  const mcpRead = await readJson(mcpPath)
  if (mcpRead.ok) {
    const mcpParsed = MCPRootSchema.safeParse(mcpRead.value)
    if (!mcpParsed.success) {
      const issues = mcpParsed.error.issues
        .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")
      throw new PluginManifestError(
        `.mcp.json schema mismatch at ${mcpPath}:\n${issues}`,
        "schema",
        mcpPath,
      )
    }
    mcpServers = mcpParsed.data.mcpServers
  } else if (mcpRead.err.cause !== "missing") {
    // A present-but-broken `.mcp.json` is an error — we only ignore
    // genuinely-absent files. Cluster E hard rule: no swallowed errors.
    throw mcpRead.err
  }

  const skillEntries = await collectSkillEntries(pluginDir)
  const loaded: LoadedPlugin = { dir: pluginDir, manifest, skillEntries }
  if (mcpServers !== undefined) loaded.mcpServers = mcpServers
  return loaded
}

/** Recursively walk `rootDir` (capped at depth 4) collecting directories
 *  whose `.quanta-plugin/plugin.json` exists. Returns lightweight records;
 *  call {@link loadPluginManifest} on each to validate. Skips
 *  `node_modules` / `.git` / dotfile dirs other than `.quanta-plugin`
 *  itself so realistic monorepo scans terminate. */
const DISCOVERY_SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build"])

const safeReaddir = async (dir: string): Promise<Dirent[] | null> => {
  try {
    return (await readdir(dir, { withFileTypes: true })) as Dirent[]
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return null
    throw e
  }
}

const recordIfPluginRoot = async (
  dir: string,
  entries: readonly Dirent[],
  found: DiscoveredPlugin[],
): Promise<void> => {
  if (!entries.some((e) => e.isDirectory() && e.name === PLUGIN_DIR_NAME)) return
  const manifestPath = join(dir, PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILE)
  try {
    const st = await stat(manifestPath)
    if (st.isFile()) found.push({ dir, manifestPath })
  } catch {
    // .quanta-plugin/ exists but no plugin.json — not a plugin. Skip.
  }
}

const isDescendable = (n: string): boolean => {
  if (n === PLUGIN_DIR_NAME) return false
  if (DISCOVERY_SKIP_DIRS.has(n)) return false
  if (n.startsWith(".")) return false
  return true
}

export const discoverPlugins = async (rootDir: string): Promise<DiscoveredPlugin[]> => {
  const found: DiscoveredPlugin[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DISCOVERY_DEPTH) return
    const entries = await safeReaddir(dir)
    if (entries === null) return
    await recordIfPluginRoot(dir, entries, found)
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      if (!isDescendable(ent.name)) continue
      await visit(join(dir, ent.name), depth + 1)
    }
  }
  await visit(rootDir, 0)
  found.sort((a, b) => {
    if (a.dir < b.dir) return -1
    if (a.dir > b.dir) return 1
    const ba = basename(a.dir)
    const bb = basename(b.dir)
    return ba < bb ? -1 : ba > bb ? 1 : 0
  })
  return found
}
