import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { parseFrontmatter } from "./frontmatter"
<<<<<<< Updated upstream
import { checkSkillSize } from "./skill-size"
=======
import { checkSkillSize, MAX_SKILL_SIZE_BYTES } from "./skill-size"
>>>>>>> Stashed changes
import type { Skill, SkillEffort } from "./types"

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

/** Build a {@link Skill} from a file's raw contents. */
const toSkill = (name: string, sourcePath: string, raw: string): Skill => {
  const { data, body } = parseFrontmatter(raw)
  const description =
    asScalar(data.description) ??
    body
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ??
    ""

  const skill: Skill = {
    name: asScalar(data.name) ?? name,
    description,
    body,
    sourcePath,
  }
  const tools = asList(data.tools)
  if (tools) skill.tools = tools
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
<<<<<<< Updated upstream
/** Skip + log when a candidate file exceeds the 30 MB skill cap. Stat-failed
 *  outcomes are silent — a missing file is the normal "not a skill" case. */
const tooLargeWarning = (path: string, size: number): void => {
  console.warn(`[skill] skipped ${path}: ${size} bytes exceeds the 30 MB cap`)
=======
/** Log a skipped skill once. `console.warn` chosen because @/skill is a leaf
 *  slice (no logger import), and the message must surface during a discovery
 *  pass where no agent context is available. */
const warnSkippedSkill = (path: string, size: number): void => {
  const detail =
    size > 0 ? `${size} bytes exceeds ${MAX_SKILL_SIZE_BYTES} cap` : "stat failed (unreadable)"
  console.warn(`[skill] skipped ${path}: ${detail}`)
>>>>>>> Stashed changes
}

/** Read the directory-form skill (`<dir>/<name>/SKILL.md`), or null if absent. */
const readNestedSkill = async (dir: string, name: string): Promise<Skill | null> => {
  const skillFile = join(dir, name, "SKILL.md")
<<<<<<< Updated upstream
  const sized = await checkSkillSize(skillFile)
  if (!sized.ok) {
    if (sized.reason === "too-large") tooLargeWarning(sized.path, sized.size)
=======
  const size = await checkSkillSize(skillFile)
  if (!size.ok) {
    // Skip on oversized OR stat error. A missing SKILL.md is the normal
    // "this directory isn't a skill dir" path — silent. A stat error on an
    // existing but unreadable file is logged so the user knows why discovery
    // skipped it.
    if (size.size > 0) warnSkippedSkill(skillFile, size.size)
>>>>>>> Stashed changes
    return null
  }
  try {
    const raw = await readFile(skillFile, "utf8")
    return toSkill(name, skillFile, raw)
  } catch {
    // No SKILL.md in this dir — not a skill dir, skip.
    return null
  }
}

/** Read a flat command file (`<dir>/<name>.md`), or null if not a skill / unreadable. */
const readFlatSkill = async (dir: string, fileName: string): Promise<Skill | null> => {
  const id = basename(fileName, ".md")
  if (id.toLowerCase() === "skill") return null // SKILL.md handled via dir form
  const file = join(dir, fileName)
<<<<<<< Updated upstream
  const sized = await checkSkillSize(file)
  if (!sized.ok) {
    if (sized.reason === "too-large") tooLargeWarning(sized.path, sized.size)
=======
  const size = await checkSkillSize(file)
  if (!size.ok) {
    if (size.size > 0) warnSkippedSkill(file, size.size)
>>>>>>> Stashed changes
    return null
  }
  try {
    const raw = await readFile(file, "utf8")
    return toSkill(id, file, raw)
  } catch {
    // Unreadable file — skip.
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

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
