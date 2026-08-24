import { readdir, readFile } from "node:fs/promises"
import { basename, join, sep } from "node:path"
import { errMessage, parseThinClientRoute, runtimeConfig } from "@/shared"
import { parseFrontmatter } from "./frontmatter"
import { normalizeSkillFrontmatter } from "./manifest-compat"
import { liftRawDependenciesBlock } from "./skill-frontmatter"
import { discoverSkillImplicitPolicy, discoverSkillResources } from "./skill-resources"
import { checkSkillSize, MAX_SKILL_SIZE_BYTES } from "./skill-size"
import {
  isSkillInstallState,
  isSkillScope,
  type Skill,
  type SkillEffort,
  type SkillInstallState,
  type SkillScope,
} from "./types"

/** Coerce a frontmatter value to a string[] (single scalar → one-element list). */
const asList = (v: string | string[] | undefined): string[] | undefined => {
  if (v === undefined) return undefined
  if (Array.isArray(v)) return v.length > 0 ? v : undefined
  return v.trim() === "" ? undefined : [v.trim()]
}

/** Parse an effort frontmatter value: numeric string → number, else the token. */
const asEffort = (v: string | string[] | undefined): SkillEffort | undefined => {
  if (typeof v !== "string" || v.trim() === "") return undefined
  const t = v.trim()
  if (/^\d+$/.test(t)) return Number(t)
  if (t === "low" || t === "medium" || t === "high" || t === "max") return t
  return undefined
}

const asScalar = (v: string | string[] | undefined): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined

type DeclaredAllowedTools =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "declared"; value: string[] }

/**
 * Runtime SSOT for tool scoping:
 *   1. strict-style `allowedTools:` when the key is present AND well-formed
 *   2. legacy lenient `tools:` fallback only when `allowedTools:` is absent
 *
 * If `allowedTools:` is present but malformed (scalar / non-string / empty
 * element), runtime does NOT silently fall back to `tools:`. That would keep
 * the legacy mirror authoritative and defeat the frontmatter SSOT cutover.
 */
const declaredAllowedTools = (v: string | string[] | undefined): DeclaredAllowedTools => {
  if (v === undefined) return { kind: "absent" }
  if (!Array.isArray(v)) return { kind: "invalid" }
  const trimmed = v.map((item) => item.trim())
  return trimmed.every((item) => item !== "")
    ? { kind: "declared", value: trimmed }
    : { kind: "invalid" }
}

/**
 * ADR-0134 — infer skill scope from the load path. The lenient frontmatter
 * parser accepts an explicit `scope:` field (validated by
 * {@link isSkillScope}); if it's absent or malformed we fall back to the
 * canonical path-shape heuristics below. The directory tokens are tested
 * against the platform-normalized POSIX separator so the inference works on
 * Windows too.
 *
 * Order matters — admin/team/repo/personal/user/system patterns are evaluated
 * before the conservative "builtIn" default so a path like
 * `/.../system-skills/.../SKILL.md` resolves to "system" even when the file
 * also lives inside a user's home directory.
 */
const inferScopeFromPath = (sourcePath: string): SkillScope => {
  // Normalize to POSIX separators so the same heuristics work on Windows.
  const p = sourcePath.replaceAll(sep, "/")
  if (p.includes("/admin-skills/")) return "admin"
  if (p.includes("/.team-skills/")) return "team"
  if (p.includes("/.quanta/skills/")) return "repo"
  if (p.includes("/.quanta/personal-skills/")) return "personal"
  if (p.includes("/.quanta/admin-skills/")) return "admin"
  // Pre-0134 fallback: ~/.claude/skills/ ⇒ user (auto-migrate target).
  if (p.includes("/.claude/skills/")) return "user"
  if (p.includes("/.quanta/user-skills/") || p.includes("/.quanta-user/skills/")) return "user"
  // Bundled SSOT — src/skill/system-skills/<name>/SKILL.md.
  if (p.includes("/skill/system-skills/")) return "system"
  // Anything else (loaded from in-code / unknown layout) ⇒ builtIn.
  return "builtIn"
}

/** ADR-0134 — resolve scope: explicit frontmatter wins, else path-infer. */
const resolveScope = (data: Record<string, string | string[]>, sourcePath: string): SkillScope => {
  const declared = asScalar(data.scope)
  if (declared !== undefined && isSkillScope(declared)) return declared
  return inferScopeFromPath(sourcePath)
}

/** ADR-0134 — resolve installState: explicit > admin-scope backfill > undefined.
 *  Mirrors the strict parser's invariant (admin ⇒ "required") so the registry
 *  sees consistent shape from either parse path. */
const resolveInstallState = (
  data: Record<string, string | string[]>,
  scope: SkillScope,
): SkillInstallState | undefined => {
  const declared = asScalar(data.installState ?? data.install_state)
  const explicit = declared !== undefined && isSkillInstallState(declared) ? declared : undefined
  if (scope === "admin") return "required"
  return explicit
}

/** ADR-0134 — resolve adminInstalledBy: admin scope only. */
const resolveAdminInstalledBy = (
  data: Record<string, string | string[]>,
  scope: SkillScope,
): string | null | undefined => {
  if (scope !== "admin") return undefined
  return asScalar(data.adminInstalledBy ?? data.admin_installed_by) ?? null
}

/**
 * jun-7-misc 02 — codex-shape ingest (strict `=== "1"` opt-in). Default-OFF ⇒
 * the lenient parser output is returned UNCHANGED ⇒ byte-identical. When armed,
 * rename the two enumerated kebab keys (`allowed-tools` → `allowedTools`,
 * `user-invocable` → `userInvocable`; native camel wins on conflict) so the
 * tool-scoping read at `declaredAllowedTools(data.allowedTools)` sees a codex
 * kebab `allowed-tools` block-list instead of SILENTLY DROPPING it. The
 * normalizer only renames SHAPE; the grant VALUE is unchanged.
 */
const ingestCompatData = (
  data: Record<string, string | string[]>,
): Record<string, string | string[]> =>
  runtimeConfig().manifestCompat
    ? (normalizeSkillFrontmatter(data) as Record<string, string | string[]>)
    : data

/** Build a {@link Skill} from a file's raw contents. */
const toSkill = (name: string, sourcePath: string, raw: string): Skill => {
  const parsed = parseFrontmatter(raw)
  const body = parsed.body
  const data = ingestCompatData(parsed.data)
  const description =
    asScalar(data.description) ??
    body
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ??
    ""

  const scope = resolveScope(data, sourcePath)
  const installState = resolveInstallState(data, scope)
  const adminInstalledBy = resolveAdminInstalledBy(data, scope)
  // ADR-0457 — codex skill ECOSYSTEM frontmatter (gaps A+B). Both optional;
  // `argument-hint` is a kebab key, `metadata.short-description` is captured by
  // the lenient parser as the dotted key `metadata.short-description`.
  const argumentHint = asScalar(data["argument-hint"])
  const shortDescription = asScalar(data["metadata.short-description"])
  // ADR-0476 — lift the raw `dependencies` block here, where the FULL SKILL.md
  // content (`raw`, incl. frontmatter) is in hand. `skill.body` is post-
  // frontmatter, so the block would be invisible if lifted later. NO-THROW:
  // returns undefined when no `dependencies:` block exists ⇒ field absent.
  const rawDependencies = liftRawDependenciesBlock(raw)
  // ADR-0493 — thin-client dispatch route (kebab key). NO-THROW parse: an
  // unknown token degrades to undefined ⇒ field absent ⇒ resolves "local".
  const thinClientDispatch = parseThinClientRoute(asScalar(data["thin-client-dispatch"]))

  const skill: Skill = {
    name: asScalar(data.name) ?? name,
    description,
    body,
    sourcePath,
    scope,
    ...(installState !== undefined ? { installState } : {}),
    ...(adminInstalledBy !== undefined ? { adminInstalledBy } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(shortDescription !== undefined ? { shortDescription } : {}),
    ...(rawDependencies !== undefined ? { rawDependencies } : {}),
    ...(thinClientDispatch !== undefined ? { thinClientDispatch } : {}),
  }
  const strictTools = declaredAllowedTools(data.allowedTools)
  if (strictTools.kind === "declared") {
    skill.tools = strictTools.value
  } else if (strictTools.kind === "absent") {
    const tools = asList(data.tools)
    if (tools) skill.tools = tools
  }
  const model = asScalar(data.model)
  if (model) skill.model = model
  const effort = asEffort(data.effort)
  if (effort !== undefined) skill.effort = effort
  const paths = asList(data.paths)
  if (paths) skill.paths = paths
  return skill
}

/**
 * Scan `<dir>` for skills. Recognises both layouts CC supports:
 *   - `<dir>/<skill-name>/SKILL.md`  (skill id = directory name)
 *   - `<dir>/<skill-name>.md`        (legacy command; skill id = file stem)
 *
 * Frontmatter `name:` overrides the derived id. A missing/empty dir yields [].
 * Skills are returned sorted by name for deterministic output; on a name
 * collision the directory-form (SKILL.md) wins over the flat *.md form.
 */
/** Skip + log when a candidate file exceeds the 30 MB skill cap. Stat-failed
 *  outcomes are silent — a missing file is the normal "not a skill" case.
 *  `@/skill` is a leaf slice (no `@/observability` import allowed by Biome
 *  boundaries) so `console.warn` is the only sanctioned sink here. */
const tooLargeWarning = (path: string, size: number): void => {
  // Include raw byte cap alongside the human-readable "30 MB" label so log
  // consumers (and unit tests) can correlate the message with
  // `MAX_SKILL_SIZE_BYTES` without re-parsing the prose.
  // biome-ignore lint/suspicious/noConsole: leaf slice cannot import a structured logger
  console.warn(
    `[skill] skipped ${path}: ${size} bytes exceeds the 30 MB cap (${MAX_SKILL_SIZE_BYTES} bytes)`,
  )
}

/** Warn when a candidate file passed the size check (so it exists & is in
 *  range) yet the subsequent read failed — a genuine permissions / transient
 *  IO error rather than the normal "no SKILL.md, not a skill" case. Discovery
 *  still continues past the entry; this only makes the swallow observable.
 *  Same leaf-slice constraint as {@link tooLargeWarning}: `console.warn` is the
 *  only sanctioned sink. */
const unreadableWarning = (path: string, reason: string): void => {
  // biome-ignore lint/suspicious/noConsole: leaf slice cannot import a structured logger
  console.warn(`[skill] skipped ${path}: unreadable (${reason})`)
}

/** Read the directory-form skill (`<dir>/<name>/SKILL.md`), or null if absent. */
const readNestedSkill = async (dir: string, name: string): Promise<Skill | null> =>
  readSkillAt(name, join(dir, name, "SKILL.md"))

/**
 * Read ONE directory-form skill from an explicit `SKILL.md` path.
 *
 * Split out of {@link readNestedSkill} because the bundled system skills cannot
 * be found by walking a directory: in a `bun build --compile` binary the source
 * tree does not exist, so their SKILL.md files are EMBEDDED and addressed by
 * path, not discovered. Same parse, same fail-safe resource handling — only the
 * way the path is obtained differs.
 */
export const readSkillAt = async (name: string, skillFile: string): Promise<Skill | null> => {
  const sized = await checkSkillSize(skillFile)
  if (!sized.ok) {
    if (sized.reason === "too-large") tooLargeWarning(sized.path, sized.size)
    return null
  }
  try {
    const raw = await readFile(skillFile, "utf8")
    const skill = toSkill(name, skillFile, raw)
    // ADR-0457 — directory-form skills MAY ship bundled resources (agents/
    // scripts/ references/ assets/). Fail-safe: a malformed resource omits just
    // that resource and never aborts the skill (helper swallows all errors).
    const [resources, allowImplicit] = await Promise.all([
      discoverSkillResources(skillFile),
      // §2.3 — codex policy.allow_implicit_invocation. Additive: absent ⇒ field
      // omitted (default = implicit allowed), byte-identical to before.
      discoverSkillImplicitPolicy(skillFile),
    ])
    return {
      ...skill,
      ...(resources !== undefined ? { resources } : {}),
      ...(allowImplicit !== undefined ? { allowImplicitInvocation: allowImplicit } : {}),
    }
  } catch (e) {
    // `checkSkillSize` already stat-confirmed the file exists & is in range, so
    // reaching here means the read itself failed (permissions / transient IO),
    // NOT the normal "no SKILL.md, not a skill dir" case. Make it observable
    // then continue discovery past this entry.
    unreadableWarning(skillFile, errMessage(e))
    return null
  }
}

/** Read a flat command file (`<dir>/<name>.md`), or null if not a skill / unreadable. */
const readFlatSkill = async (dir: string, fileName: string): Promise<Skill | null> => {
  const id = basename(fileName, ".md")
  if (id.toLowerCase() === "skill") return null // SKILL.md handled via dir form
  const file = join(dir, fileName)
  const sized = await checkSkillSize(file)
  if (!sized.ok) {
    if (sized.reason === "too-large") tooLargeWarning(sized.path, sized.size)
    return null
  }
  try {
    const raw = await readFile(file, "utf8")
    return toSkill(id, file, raw)
  } catch (e) {
    // `checkSkillSize` already stat-confirmed the file; a failure here is a
    // genuine read error (permissions / transient IO), not "not a skill".
    // Make it observable then continue discovery past this entry.
    unreadableWarning(file, errMessage(e))
    return null
  }
}

/** Classify one directory entry, reading its skill if applicable. */
const readEntrySkill = async (
  dir: string,
  ent: import("node:fs").Dirent,
): Promise<{ form: "nested" | "flat"; skill: Skill } | null> => {
  if (ent.isDirectory() || ent.isSymbolicLink()) {
    const skill = await readNestedSkill(dir, ent.name)
    return skill ? { form: "nested", skill } : null
  }
  if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
    const skill = await readFlatSkill(dir, ent.name)
    return skill ? { form: "flat", skill } : null
  }
  return null
}

export const discoverSkills = async (dir: string): Promise<Skill[]> => {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // Missing/unreadable skills root is the normal "user has no skills here"
    // case (fired for every absent search path at session start). Logging it
    // would be per-startup noise, so we stay silent by design and yield [].
    return []
  }

  // Two passes so SKILL.md (directory form) deterministically wins collisions.
  const flat: Skill[] = []
  const nested: Skill[] = []
  for (const ent of entries) {
    const got = await readEntrySkill(dir, ent)
    if (!got) continue
    if (got.form === "nested") nested.push(got.skill)
    else flat.push(got.skill)
  }

  const byName = new Map<string, Skill>()
  for (const s of flat) byName.set(s.name, s)
  for (const s of nested) byName.set(s.name, s) // nested overrides flat

  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
