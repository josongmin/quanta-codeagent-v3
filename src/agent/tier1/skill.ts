/**
 * Tier-1 per-subsystem builder: SKILL block (ADR-0011).
 *
 * Discovers user + bundled system skills, registers the `Skill` / `ToolSearch`
 * tools, builds the author-declared tool-allowlist map and
 * `{model?, effort?}` override map, and emits the per-turn suggestion
 * inventory (filtered by `changedPaths` when host wiring opts in).
 *
 * Behavior preserved verbatim from the previous `buildSkillFeatures` +
 * `skillOverrideEntry` helpers — only the *location* of these slices has
 * moved. The composer still gates the whole block on `config.skills`.
 *
 * DEFAULT-OFF: `config.skills` absent ⇒ this builder returns `undefined`
 * (byte-identical, RFC §1.2).
 */

import type { Tool } from "@/tool"
import type { Skill } from "../../skill"
import {
  createSkillTool,
  createToolSearchTool,
  discoverSkills,
  discoverSystemSkills,
  skillEffortOverride,
  skillModelOverride,
  skillsActivatedFor,
  skillToolAllowlist,
} from "../../skill"
import type { SkillTurnOverride } from "../loop"
import type { AgentConfig } from "../types"

/** Materialized skill block. All fields are required (the builder either
 *  returns this whole block or `undefined`); `allowlists` / `overrides` are
 *  themselves nullable for the "no skill declared any" case. */
export interface SkillBlock {
  /** `[Skill, ToolSearch]` tools to merge into the registry. */
  tools: Tool[]
  /** Skill name → author-declared tool allowlist, including an explicit
   *  empty list meaning "no tools permitted". Absent when no skill declared
   *  any allowlist at all. */
  allowlists: Map<string, string[]> | undefined
  /** Skill name → author-declared `{model?, effort?}` override, for skills
   *  that declared at least one. Absent when no skill declared either. */
  overrides: Map<string, SkillTurnOverride> | undefined
  /** Per-turn suggestion inventory (filtered by `changedPaths` when set). */
  inventory: { name: string; description: string }[]
}

/** ADR-0011 §6.2 → L4: the per-skill model/effort override entry, or
 *  `undefined` when the skill declares neither (a non-empty `model:` string
 *  AND/OR any defined `effort:`, including numeric 0). Extracted from the
 *  per-skill loop in {@link buildSkillBlock} so that loop stays a single
 *  branch (keeps the function under the cognitive-complexity budget). */
const skillOverrideEntry = (s: Skill): SkillTurnOverride | undefined => {
  const model = skillModelOverride(s)
  const effort = skillEffortOverride(s)
  if (model === undefined && effort === undefined) return undefined
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  }
}

/** Build the skill block from `config.skills`. Returns `undefined` when the
 *  block is absent so the composer can skip it. Pure except for
 *  `discoverSkills`'s directory IO. */
export const buildSkillBlock = async (config: AgentConfig): Promise<SkillBlock | undefined> => {
  if (!config.skills) return undefined

  const dir = config.skills.dir
  // `dir` OPTIONAL (ADR-0045 follow-up): when omitted, only bundled system
  // skills load. `discoverSkills` is only called when a user dir is given.
  const userSkills = dir !== undefined ? await discoverSkills(dir) : []
  // Bundled system skills (ADR-0045) — version-pinned, ship with the framework.
  // Merged into the discoverable set so the model can invoke disciplines like
  // `progress-audit` regardless of whether the user populated their own skills
  // dir. System skills WIN on a name collision so a user-supplied skill cannot
  // impersonate / weaken a system one (the `byName` second-pass overrides).
  const systemSkills = await discoverSystemSkills()
  const byName = new Map<string, Skill>()
  for (const s of userSkills) byName.set(s.name, s)
  for (const s of systemSkills) byName.set(s.name, s)
  const skills = [...byName.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const tools: Tool[] = [
    // `createSkillTool` ALWAYS receives the full discovered list — a user can
    // still invoke any skill by name. The `paths:` filter below only narrows
    // the per-turn SUGGESTION inventory, never the invocable surface (that
    // would silently strip authority).
    createSkillTool(skills),
    createToolSearchTool(() => config.registry.specs()),
  ]
  const al = new Map<string, string[]>()
  // ADR-0011 §6.2 → L4: build the per-skill model/effort override map alongside
  // the allowlist map. A skill contributes an entry only when it declares
  // `model:` AND/OR `effort:` (a non-empty model string, or any defined effort
  // including numeric 0). Skills with neither leave the map untouched, so an
  // all-advisory-free skill set yields `undefined` and the loop stays
  // byte-identical.
  const ov = new Map<string, SkillTurnOverride>()
  for (const s of skills) {
    const allow = skillToolAllowlist(s)
    if (allow) al.set(s.name, allow)
    const override = skillOverrideEntry(s)
    if (override) ov.set(s.name, override)
  }
  // Plain `{name, description}` shape so the prompt slice never imports
  // `@/skill` (slice isolation — Codex skills-audit mirror). Built ONCE here
  // (the loop calls buildSessionFeatures once at session start), then passed
  // through every turn without re-discovery.
  //
  // `paths:` conditional activation (L1→L2 host-driven wiring): when
  // `config.skills.changedPaths` is set, narrow the suggestion inventory to
  //   - every skill WITHOUT `paths:` (unconditional — always in the inventory),
  //   - plus every skill WITH `paths:` whose globs match any changed path
  //     (via `skillsActivatedFor` — the dedicated helper that already filters
  //     out unconditional skills).
  // `changedPaths` unset ⇒ identity, byte-identical with prior behavior —
  // RFC §1.2 default-OFF. The invocable surface (the `Skill` tool) is NEVER
  // narrowed — only the per-turn SUGGESTION inventory is filtered.
  const changedPaths = config.skills.changedPaths
  const activated =
    changedPaths !== undefined && changedPaths.length > 0
      ? [
          ...skills.filter((s) => s.paths === undefined || s.paths.length === 0),
          ...skillsActivatedFor(skills, changedPaths),
        ]
      : skills
  const inventory = activated.map((s) => ({ name: s.name, description: s.description }))
  return {
    tools,
    allowlists: al.size > 0 ? al : undefined,
    overrides: ov.size > 0 ? ov : undefined,
    inventory,
  }
}
