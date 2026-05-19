/**
 * Skill slice (T1.C) — faithful-minimal port of Claude Code v2's skill system.
 *
 * Self-contained: this slice MUST NOT import @/agent. Public seams:
 *   - {@link Skill} / {@link ParsedFrontmatter} / {@link SkillEffort}  (types)
 *   - {@link parseFrontmatter}      dependency-free YAML-ish parser
 *   - {@link discoverSkills}        scan <dir>/&#42;/SKILL.md (+ <dir>/&#42;.md)
 *   - {@link createSkillTool}       the `Skill` tool (body + scoping note)
 *   - {@link createToolSearchTool}  the `ToolSearch` tool (lexical match)
 *   - {@link skillsActivatedFor}    pure conditional-`paths:` activation helper
 *
 * Recommended AgentConfig wiring (owned by the agent slice, not done here):
 *
 *   skills?: { dir: string }
 *
 * The agent slice would, at session start, call
 * `discoverSkills(config.skills.dir)`, register `createSkillTool(skills)` +
 * `createToolSearchTool(() => registry.specs())`, and on file-touch call
 * `skillsActivatedFor(skills, changedPaths)` to surface conditional skills.
 */
export { matchesAnyGlob, skillsActivatedFor } from "./activation"
export { discoverSkills } from "./discover"
export { parseFrontmatter } from "./frontmatter"
export { createSkillTool, scopingNote } from "./skill-tool"
export { createToolSearchTool } from "./tool-search"
export type { ParsedFrontmatter, Skill, SkillEffort } from "./types"
