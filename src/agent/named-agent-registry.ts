import { lstat, readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { AGENT_PROMPT_MODES } from "@/shared"
import { parseFrontmatter } from "@/skill"

/**
 * §20.1/§20.2 — Named-agent runtime loader + registry (Claude Code / Cursor
 * `.claude/agents/<name>.md` "subagent definition" parity).
 *
 * A subagent definition is a markdown file whose FRONTMATTER carries a role
 * identity and whose BODY is the role's system prompt:
 *
 *   ---
 *   name: explorer
 *   description: Read-only codebase explorer
 *   tools: ["read", "grep", "glob"]   # OPTIONAL allowlist — NARROW-ONLY (see below)
 *   model: gpt-5                       # OPTIONAL — resolved fail-closed agent-side
 *   mode: review                       # OPTIONAL — one of AGENT_PROMPT_MODES
 *   ---
 *   You are a meticulous read-only explorer. ...   <-- becomes the child's system
 *
 * This module reads `.quanta/agents/*.md` (the native path that the migration
 * PERSIST adapter writes to — `persist.ts#persistSubagents`; `.claude/agents` is
 * also scanned for direct Claude-Code parity) and builds a `Map<agentType,
 * NamedAgentDefinition>`. The agent-side subagent runner consults
 * {@link NamedAgentResolver.resolve} when a spawn carries a matching
 * `req.agentType` and threads the definition's `{ system, tools, model, mode }`
 * onto the spawn so a forked child runs with its OWN role identity.
 *
 * --- REUSE: the frontmatter parser ---
 *
 * Parsing REUSES `@/skill`'s `parseFrontmatter` — the SAME dependency-free
 * YAML-ish parser the migration converter (`convert.ts#convertSubagentFile`,
 * which imports `@/skill/frontmatter#parseFrontmatter`) uses to READ these same
 * files, plus skills + glob-rules. We do NOT duplicate a parser. `data.tools`
 * arrives as the parser's `string[]` (inline `[...]` or block list) or a bare
 * scalar; `data.model`/`data.mode`/`data.name` arrive as `string`; the markdown
 * `body` is the system prompt. No new dependency.
 *
 * --- SECURITY (tool widening) — the crux ---
 *
 * A definition's `tools:` list is REPO-CONTROLLED (`.quanta/agents/*.md` is
 * checked into the repo / writable by an untrusted contributor). It is carried
 * as an ADVISORY allowlist ONLY: the runner threads it onto the spawn's
 * `toolFilter`, and `filterRegistry(parent.registry, toolFilter)` INTERSECTS it
 * against the parent's ALREADY-GRANTED tool surface (`allow.has(name)` keyed off
 * the PARENT registry's `specs()`). So a definition requesting `tools: [bash]`
 * when the parent holds no `bash` tool yields a child registry WITHOUT `bash` —
 * a named definition can only ever NARROW, never widen (most-restrictive-wins).
 * This module performs NO grant of its own and never touches the parent
 * registry; the widening guard lives entirely in the existing intersection.
 *
 * --- DEFAULT-OFF / byte-identical ---
 *
 * No `.quanta/agents` (and no `.claude/agents`) directory ⇒ the registry is
 * EMPTY ⇒ `resolve(agentType)` is always `undefined` ⇒ the spawn path is
 * byte-identical (the runner's `req.system ?? parent.system` keeps the parent
 * identity). The host wires this only when it loads the registry up front.
 */

/** Directories scanned for named-agent definitions, in priority order. Native
 *  `.quanta/agents` (the migration PERSIST destination) wins over `.claude/agents`
 *  (direct Claude-Code parity) on a duplicate `agentType` (first-loaded wins). */
export const NAMED_AGENT_DIRS = [".quanta/agents", ".claude/agents"] as const

/** Recognised definition file extension. */
const AGENT_EXTENSION = ".md"

/** Per-definition system-prompt body cap. A runaway definition file is
 *  truncated with a marker rather than rejected — mirrors `glob-rules.ts`'s
 *  `MAX_RULE_BYTES` posture (usability over hard-fail, but bounded). */
export const MAX_AGENT_SYSTEM_BYTES = 64 * 1024

/** Cap on the NUMBER of definition files loaded. Mirrors `glob-rules.ts`'s
 *  `MAX_RULE_FILES` — a hostile repo cannot pin memory/CPU by planting an
 *  unbounded number of definition files. 256 covers any realistic repo and
 *  matches the migration converter's `MAX_SUBAGENT_FILES`. */
export const MAX_AGENT_FILES = 256

/** A loaded named-agent definition — the role identity a matching `agentType`
 *  injects into a forked child. All fields except `agentType`/`system` are
 *  optional. */
export interface NamedAgentDefinition {
  /** The `agentType` key (frontmatter `name`, else the file basename). */
  agentType: string
  /** Markdown body — the child's role system prompt. Never empty (a definition
   *  with an empty body is dropped at load). */
  system: string
  /** ADVISORY tool allowlist. NARROW-ONLY: the runner intersects this against
   *  the parent's granted surface (`filterRegistry`); it can never widen. Absent
   *  when the frontmatter declared no `tools`. */
  tools?: string[]
  /** Model id the child should run on (resolved fail-closed against
   *  `modelCandidates` agent-side). Absent ⇒ parent's model. */
  model?: string
  /** Prompt mode (one of {@link AGENT_PROMPT_MODES}). A frontmatter `mode:`
   *  that is not a recognised mode is dropped here (defers to the parent). */
  mode?: string
  /** Absolute path the definition was loaded from (observability). */
  sourcePath: string
}

/** Read-only resolver port the subagent runner consults. Structurally typed so
 *  the runner / spawn path depends only on this shape, not the concrete class
 *  (closed-port DI — the runner reads it off `AgentConfig.namedAgentResolver`). */
export interface NamedAgentResolver {
  /** Resolve a definition by `agentType`, or `undefined` when no matching
   *  definition exists (so the spawn path stays byte-identical). */
  resolve(agentType: string): NamedAgentDefinition | undefined
}

/** In-memory registry of named-agent definitions. PURE: holds only the loaded
 *  map; all IO happened in {@link loadNamedAgents}. */
export class NamedAgentRegistry implements NamedAgentResolver {
  private readonly byType: ReadonlyMap<string, NamedAgentDefinition>

  constructor(definitions: readonly NamedAgentDefinition[]) {
    const map = new Map<string, NamedAgentDefinition>()
    // First-wins on a duplicate agentType (native dir scanned first).
    for (const def of definitions) {
      if (!map.has(def.agentType)) map.set(def.agentType, def)
    }
    this.byType = map
  }

  resolve(agentType: string): NamedAgentDefinition | undefined {
    return this.byType.get(agentType)
  }

  /** Snapshot of all loaded definitions (observability / tests). */
  all(): NamedAgentDefinition[] {
    return [...this.byType.values()]
  }

  get size(): number {
    return this.byType.size
  }
}

/** Normalise a frontmatter `tools` value (string | string[] | absent) to a
 *  trimmed, non-empty string[], or `undefined` when none was declared. A bare
 *  scalar is comma-split (tolerates `tools: read, grep`); an array is taken
 *  as-is. Mirrors `convert.ts#normalizeTools`. */
const normalizeTools = (raw: string | string[] | undefined): string[] | undefined => {
  if (raw === undefined) return undefined
  const parts = Array.isArray(raw) ? raw : raw.split(",")
  const out = parts.map((p) => p.trim()).filter((p) => p.length > 0)
  return out.length > 0 ? out : undefined
}

/** Validate a frontmatter `mode:` against the prompt-mode SSOT. An unrecognised
 *  value (or absent / non-scalar) ⇒ `undefined` (the child defers to the
 *  parent's mode — a malformed `mode:` cannot blank the inherited posture). */
const normalizeMode = (raw: string | string[] | undefined): string | undefined => {
  if (typeof raw !== "string") return undefined
  const m = raw.trim()
  return (AGENT_PROMPT_MODES as readonly string[]).includes(m) ? m : undefined
}

/** Parse one definition file into a {@link NamedAgentDefinition}, or `undefined`
 *  when it is a symlink, not a regular file, unreadable, or has an empty body. */
const tryLoadDefinition = async (path: string): Promise<NamedAgentDefinition | undefined> => {
  try {
    // SECURITY: reject symlinks — a symlinked definition could point at a secret
    // and its contents would ride into the child's system prompt as authority.
    // `lstat` does not follow the link (same posture as glob-rules.ts).
    const st = await lstat(path)
    if (st.isSymbolicLink() || !st.isFile()) return undefined
    const raw = await readFile(path, "utf8")
    const { data, body } = parseFrontmatter(raw)
    const trimmed = body.trim()
    if (trimmed.length === 0) return undefined
    const system =
      trimmed.length > MAX_AGENT_SYSTEM_BYTES
        ? `${trimmed.slice(0, MAX_AGENT_SYSTEM_BYTES)}\n\n[truncated: ${trimmed.length} bytes total]`
        : trimmed
    const nameRaw = typeof data.name === "string" ? data.name.trim() : ""
    const agentType = nameRaw.length > 0 ? nameRaw : basename(path, AGENT_EXTENSION)
    const tools = normalizeTools(data.tools as string | string[] | undefined)
    const modelRaw = typeof data.model === "string" ? data.model.trim() : ""
    const mode = normalizeMode(data.mode as string | string[] | undefined)
    return {
      agentType,
      system,
      ...(tools !== undefined ? { tools } : {}),
      ...(modelRaw.length > 0 ? { model: modelRaw } : {}),
      ...(mode !== undefined ? { mode } : {}),
      sourcePath: path,
    }
  } catch {
    // ENOENT / EACCES / parse failure ⇒ skip this file (best-effort loader).
    return undefined
  }
}

/** Scan ONE agent directory, appending up to `remaining` parsed definitions to
 *  `out` (in sorted-name order). Absent directory ⇒ no-op. Extracted so
 *  {@link loadNamedAgents} stays within the cognitive-complexity budget. */
const scanAgentDir = async (
  abs: string,
  remaining: number,
  out: NamedAgentDefinition[],
): Promise<void> => {
  let names: string[]
  try {
    names = await readdir(abs)
  } catch {
    return // directory absent ⇒ skip
  }
  let budget = remaining
  for (const name of [...names].sort()) {
    if (budget <= 0) break
    if (!name.toLowerCase().endsWith(AGENT_EXTENSION)) continue
    const def = await tryLoadDefinition(join(abs, name))
    if (def) {
      out.push(def)
      budget -= 1
    }
  }
}

/**
 * Load every named-agent definition under `cwd`'s agent directories. Returns an
 * EMPTY registry (no matches) when no directory exists or none parse — the
 * byte-identical default-OFF path. Files load in a deterministic order (dir
 * priority, then sorted name) so resolution is stable across runs. Stops after
 * {@link MAX_AGENT_FILES} successfully-loaded definitions. Read ONCE per session
 * by convention; the runner reads the resulting registry per spawn.
 */
export const loadNamedAgents = async (cwd: string): Promise<NamedAgentRegistry> => {
  const defs: NamedAgentDefinition[] = []
  for (const dir of NAMED_AGENT_DIRS) {
    const remaining = MAX_AGENT_FILES - defs.length
    if (remaining <= 0) break
    await scanAgentDir(join(cwd, dir), remaining, defs)
  }
  return new NamedAgentRegistry(defs)
}
