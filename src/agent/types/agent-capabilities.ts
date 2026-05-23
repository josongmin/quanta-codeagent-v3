/**
 * Tier-1 capability option blocks (ADR-0011) — extracted from
 * `src/agent/types.ts` so the per-capability nested option shapes have a
 * discoverable home and `AgentConfig` doesn't carry their literal forms
 * inline. Co-located with `memory-config.ts` / `compaction-config.ts` so the
 * 4 capability axes (subagent / skills / workingState / branchSearch) sit
 * next to the other extracted config groups.
 *
 * SHAPES MUST stay byte-identical to the previous inline declarations on
 * `AgentConfig`. The `FeaturesConfig` `Pick<>` re-exported from `./types`
 * resolves these typed slots — changing a field here is a CONTRACT CHANGE
 * (bump the surface, don't silently widen).
 *
 * Default-OFF posture (RFC §1.2):
 *   - `subagent` absent ⇒ Agent/Task/TaskOutput/TaskStop tools NOT registered,
 *     loop byte-identical.
 *   - `skills` absent ⇒ no skill discovery, Skill/ToolSearch tools NOT
 *     registered, loop byte-identical. `skills: {}` ⇒ bundled system skills
 *     only; `skills: { dir }` ⇒ user dir + system skills.
 *   - `workingState` absent ⇒ no working-state block rendered,
 *     `update_working_state` tool NOT registered, loop byte-identical.
 *   - `branchSearch` lives in `./branch-search` (already named) — NOT
 *     redefined here; AgentConfig still references that import directly.
 *     This file documents the capability cluster as a unit; the
 *     `BranchSearchConfig` re-export keeps a single source of truth.
 */

export type { BranchSearchConfig } from "../branch-search"

/**
 * Nested option shape for `AgentConfig.subagent` — Tier-1 subagent system
 * (ADR-0011). Absent ⇒ the `Agent` / `Task` / `TaskOutput` / `TaskStop` tools
 * are NOT registered and the loop is byte-identical. When present the loop
 * builds a `SubagentRunner` (forked `runAgent`, depth+1, filtered registry)
 * and registers the tools. `maxDepth` caps recursion (the `Agent` tool refuses
 * a spawn that would exceed it).
 */
export type SubagentBlock = {
  maxDepth?: number
}

/**
 * Nested option shape for `AgentConfig.skills` — Tier-1 skill system
 * (ADR-0011). Absent ⇒ no skill discovery and the `Skill`/`ToolSearch` tools
 * are NOT registered (loop byte-identical). When present, skills are
 * discovered + the `Skill` / `ToolSearch` tools are registered.
 *
 * `dir` (OPTIONAL — ADR-0045 follow-up): the user skills directory. When
 * OMITTED, only the BUNDLED system skills (`localize-fault`, `progress-audit`
 * — version-pinned, shipped with the framework) are discovered. This lets a
 * host enable the discipline skills WITHOUT remembering to point at a user
 * dir (the whole rationale of bundled skills). `skills: {}` ⇒ system skills
 * only; `skills: { dir }` ⇒ user dir + system skills (system wins on a name
 * collision so a user skill cannot weaken a bundled one).
 *
 * `changedPaths` (optional, conservative L1→L2 wiring): when set, the
 * per-turn active-skills inventory is pre-filtered via
 * `skillsActivatedFor(allSkills, changedPaths)` — a skill with `paths:` in
 * its frontmatter only appears in the inventory when one of those globs
 * matches a changed path. A skill WITHOUT `paths:` is always included
 * (unconditional). `changedPaths` UNSET ⇒ no filter, exact prior behavior
 * (byte-identical). Hosts compute this list however they want (git diff,
 * file watcher, manual hint).
 */
export type SkillsBlock = {
  dir?: string
  changedPaths?: string[]
}

/**
 * Nested option shape for `AgentConfig.workingState` — Tier-1 working-state
 * opt-in (Codex memory L3 absorption). Absent ⇒ no working-state block is
 * rendered, the `update_working_state` tool is NOT registered, and the loop
 * is byte-identical. When set, the loop builds a session-scoped
 * `WorkingState`, plumbs it through `ToolContext.workingState`, registers the
 * `update_working_state` meta-tool, and renders the L3 block in the per-turn
 * reminder (BELOW repo-rules, ABOVE memory hints).
 */
export type WorkingStateBlock = {
  enabled: boolean
}
