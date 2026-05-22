/**
 * Skill slice (T1.C) — faithful-minimal port of Claude Code v2's skill system.
 *
 * Self-contained: this slice MUST NOT import @/agent. Public seams:
 *   - {@link Skill} / {@link ParsedFrontmatter} / {@link SkillEffort}  (types)
 *   - {@link parseFrontmatter}      dependency-free YAML-ish parser
 *   - {@link discoverSkills}        scan <dir>/&#42;/SKILL.md (+ <dir>/&#42;.md)
 *   - {@link createSkillTool}       the `Skill` tool (body + advisory note)
 *   - {@link createToolSearchTool}  the `ToolSearch` tool (lexical catalog search)
 *   - {@link skillToolAllowlist}    enforcement seam: a skill's declared tool allowlist
 *   - {@link skillModelOverride}    read seam: a skill's declared `model:` override (advisory)
 *   - {@link skillEffortOverride}   read seam: a skill's declared `effort:` override (advisory)
 *   - {@link skillsActivatedFor}    host-callable conditional-`paths:` helper
 *
 * What this slice does and does NOT do (honest seam, not a silent no-op):
 *
 *   - It DISCOVERS skills and exposes the `Skill` / `ToolSearch` tools. That
 *     part fully works once a host registers the tools.
 *   - It does NOT enforce a skill's `tools`/`model`/`effort` scope, and it does
 *     NOT auto-activate `paths:` skills. Those are turn-loop concerns this
 *     slice intentionally does not own.
 *
 * To make scoping/activation real, a host must do this itself (this slice does
 * none of it automatically):
 *
 *   1. At session start: `const skills = await discoverSkills(dir)`, then
 *      register `createSkillTool(skills)` and
 *      `createToolSearchTool(() => registry.specs())`.
 *   2. To enforce a skill's tool sandbox when it is activated: read
 *      `skillToolAllowlist(skill)` and intersect it with the turn's permitted
 *      tools (and apply `skill.model` / `skill.effort` if desired). Nothing
 *      here applies these for you.
 *   3. For conditional `paths:` skills: after file changes, call
 *      `skillsActivatedFor(skills, changedPaths)` and act on the result.
 *      Declaring `paths:` has no runtime effect until a host does this.
 */
export { MAX_GLOB_LEN, MAX_PATH_LEN, matchesAnyGlob, skillsActivatedFor } from "./activation"
export { discoverSkills } from "./discover"
export { parseFrontmatter } from "./frontmatter"
export {
  createSkillTool,
  scopingNote,
  skillEffortOverride,
  skillModelOverride,
  skillToolAllowlist,
} from "./skill-tool"
export {
  discoverSystemSkills,
  findLocalizeFaultSkill,
  findProgressAuditSkill,
  LOCALIZE_FAULT_SKILL_NAME,
  type LocalizeFaultTrigger,
  PROGRESS_AUDIT_SKILL_NAME,
  type ProgressAuditTrigger,
  systemSkillsDir,
  triggerLocalizeFault,
  triggerProgressAudit,
} from "./system-skills"
export { createToolSearchTool } from "./tool-search"
export type { ParsedFrontmatter, Skill, SkillEffort } from "./types"
