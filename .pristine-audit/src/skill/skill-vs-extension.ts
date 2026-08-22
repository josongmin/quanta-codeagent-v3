/**
 * Skill vs Extension classifier + allowed-tool gate (Cluster E / F14, ADR-0040).
 *
 * `SkillFrontmatter.category` is the SSOT for whether an entry is auto-
 * triggerable by the model (`skill`) or system-level only (`extension`).
 * Routing decisions in the host loop dispatch on the value returned here.
 *
 * The allowed-tool gate is intentionally an EXPLICIT whitelist: an empty
 * `allowedTools: []` means NO tools are permitted while the skill is active.
 * It does NOT mean "all tools" — Cluster E hard rule "ZERO heuristics".
 */
import type { SkillFrontmatter } from "./skill-frontmatter"

export type SkillOrExtension =
  | { kind: "skill"; userInvocable: boolean }
  | { kind: "extension"; userInvocable: false }

/** Pure dispatch on `category`. Extensions are always non-user-invocable
 *  (slash-commands route through Skills only — see ADR-0040 §결정). */
export const classify = (fm: SkillFrontmatter): SkillOrExtension => {
  if (fm.category === "skill") return { kind: "skill", userInvocable: fm.userInvocable }
  if (fm.category === "extension") {
    if (fm.userInvocable) {
      // Defensive — Zod accepts the combo, but it would silently lie about
      // routability. Catch the contradiction loudly at runtime too.
      throw new ToolNotAllowedBySkillError(
        `extension '${fm.name}' must not declare userInvocable:true`,
      )
    }
    return { kind: "extension", userInvocable: false }
  }
  // Exhaustiveness — unreachable while the Zod enum stays {skill, extension}.
  throw new ToolNotAllowedBySkillError(
    `unknown category '${(fm as { category: string }).category}'`,
  )
}

export class ToolNotAllowedBySkillError extends Error {
  override readonly name = "ToolNotAllowedBySkillError"
}

/** Throws if `toolName` is not in the frontmatter's whitelist. Empty list →
 *  no tool may be used. The host MUST call this before dispatching any tool
 *  invocation while a skill/extension is active. */
export const assertAllowedTool = (fm: SkillFrontmatter, toolName: string): void => {
  if (!fm.allowedTools.includes(toolName)) {
    throw new ToolNotAllowedBySkillError(
      `tool '${toolName}' not permitted by '${fm.name}' (allowedTools=${
        fm.allowedTools.length === 0 ? "[]" : JSON.stringify(fm.allowedTools)
      })`,
    )
  }
}

/** Non-throwing companion — useful when the host wants to filter a candidate
 *  tool set down to the permitted subset without try/catch. */
export const isToolAllowed = (fm: SkillFrontmatter, toolName: string): boolean =>
  fm.allowedTools.includes(toolName)
