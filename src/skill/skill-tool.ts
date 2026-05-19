import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import type { Skill } from "./types"

const schema = z.object({
  name: z
    .string()
    .describe("The name of a skill from the available-skills list. Do not guess names."),
})

type Input = z.infer<typeof schema>

/**
 * The author-declared `tools:` allowlist for a skill, if any. This is the
 * documented enforcement seam: a host that wants to actually sandbox a skill's
 * tool access should read this and apply it to the turn's permission set. The
 * skill slice itself does NOT enforce it.
 */
export const skillToolAllowlist = (s: Skill): string[] | undefined =>
  s.tools && s.tools.length > 0 ? s.tools : undefined

/**
 * One-line human-readable summary of the scoping a skill *declares*. These are
 * ADVISORY metadata the skill author wrote in frontmatter — they are NOT an
 * enforced sandbox. Nothing in this slice (or, currently, the host) restricts
 * tool/model/effort based on them; a host must opt in via the enforcement seam
 * ({@link skillToolAllowlist}). The wording is deliberately phrased so neither
 * the model nor a reader concludes a guarantee is in force.
 */
export const scopingNote = (s: Skill): string => {
  const parts: string[] = []
  if (s.tools && s.tools.length > 0) parts.push(`tools: ${s.tools.join(", ")}`)
  if (s.model) parts.push(`model: ${s.model}`)
  if (s.effort !== undefined) parts.push(`effort: ${String(s.effort)}`)
  return parts.length === 0
    ? "[skill scope] none declared"
    : `[skill scope] author-declared (advisory, not enforced): ${parts.join(" | ")}`
}

/**
 * The `Skill` tool. Input `{ name }`; on execute it returns the matched skill's
 * markdown BODY as the tool result `output` so the model proceeds with those
 * instructions in context, prefixed with a one-line note of any
 * tool/model/effort scoping the skill *declares*.
 *
 * Honesty note: the declared `tools`/`model`/`effort` scope is ADVISORY only.
 * This slice does not, and cannot from here, restrict tool access, swap the
 * model, or change effort — those are turn-loop concerns. A host that wants
 * real enforcement must read {@link skillToolAllowlist} (and `skill.model` /
 * `skill.effort`) and apply them itself when activating a skill. Until a host
 * does that, the scope shown in the result and on the {@link Skill} type is
 * informational metadata, not a sandbox guarantee.
 */
export const createSkillTool = (skills: Skill[]): Tool<Input> => {
  const byName = new Map(skills.map((s) => [s.name, s]))
  const catalogue = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")

  return {
    name: "Skill",
    description:
      "Invoke a named skill: its instructions are injected into your context so " +
      "you can proceed with them. Available skills:\n" +
      (catalogue === "" ? "(none discovered)" : catalogue),
    inputSchema: schema,
    isReadOnly: () => true,
    // Returns static skill text; no observable interaction with other calls.
    isConcurrencySafe: () => true,

    async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
      const want = input.name.trim().replace(/^\//, "") // tolerate a "/foo" form
      const skill = byName.get(want)
      if (!skill) {
        const names = [...byName.keys()].join(", ") || "(none)"
        yield {
          type: "result",
          result: { ok: false, output: `Unknown skill: ${want}. Available: ${names}` },
        }
        return
      }
      yield {
        type: "result",
        result: { ok: true, output: `${scopingNote(skill)}\n\n${skill.body}` },
      }
    },
  }
}
