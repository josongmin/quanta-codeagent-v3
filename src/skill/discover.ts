import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { parseFrontmatter } from "./frontmatter"
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
    body.split("\n").find((l) => l.trim() !== "")?.trim() ??
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
export const discoverSkills = async (dir: string): Promise<Skill[]> => {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const byName = new Map<string, Skill>()
  // Two passes so SKILL.md (directory form) deterministically wins collisions.
  const flat: Skill[] = []
  const nested: Skill[] = []

  for (const ent of entries) {
    if (ent.isDirectory() || ent.isSymbolicLink()) {
      const skillFile = join(dir, ent.name, "SKILL.md")
      try {
        const raw = await readFile(skillFile, "utf8")
        nested.push(toSkill(ent.name, skillFile, raw))
      } catch {
        // No SKILL.md in this dir — not a skill dir, skip.
      }
      continue
    }
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
      const id = basename(ent.name, ".md")
      if (id.toLowerCase() === "skill") continue // SKILL.md handled via dir form
      const file = join(dir, ent.name)
      try {
        const raw = await readFile(file, "utf8")
        flat.push(toSkill(id, file, raw))
      } catch {
        // Unreadable file — skip.
      }
    }
  }

  for (const s of flat) byName.set(s.name, s)
  for (const s of nested) byName.set(s.name, s) // nested overrides flat

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}
