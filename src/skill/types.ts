/**
 * Skill slice public types (T1.C). Faithful-minimal port of Claude Code v2's
 * skill system (see docs/analysis/skill-system.md). This slice is
 * self-contained: it MUST NOT import @/agent. It may import @/tool / @/shared.
 */

/** Effort override a skill may declare. Mirrors CC's low|medium|high|max|<int>. */
export type SkillEffort = "low" | "medium" | "high" | "max" | number

/**
 * A discovered skill. `body` is the markdown instructions injected into the
 * model context when the skill is invoked. The scoping fields (`tools`,
 * `model`, `effort`) are surfaced here for the main thread to enforce later —
 * this slice only *declares* them, it does not wire permission/model seams.
 */
export interface Skill {
  /** Stable id — directory name (or file basename for `<dir>/*.md`). */
  name: string
  /** Frontmatter `description` (falls back to first body line if absent). */
  description: string
  /** Markdown body after the frontmatter block. */
  body: string
  /** Frontmatter `tools:` allowlist, if declared. */
  tools?: string[]
  /** Frontmatter `model:` override, if declared (e.g. "inherit" or a model id). */
  model?: string
  /** Frontmatter `effort:` override, if declared. */
  effort?: SkillEffort
  /** Frontmatter `paths:` globs for conditional activation, if declared. */
  paths?: string[]
  /** Absolute path the skill was loaded from (SKILL.md or *.md). */
  sourcePath: string
}

/** Parsed frontmatter + body, before being shaped into a {@link Skill}. */
export interface ParsedFrontmatter {
  data: Record<string, string | string[]>
  body: string
}
