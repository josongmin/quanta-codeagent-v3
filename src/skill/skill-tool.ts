import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import type { Skill } from "./types"

const schema = z.object({
  name: z
    .string()
    .describe("The name of a skill from the available-skills list. Do not guess names."),
})

type Input = z.infer<typeof schema>

/** One-line human-readable summary of the scoping a skill declares. */
export const scopingNote = (s: Skill): string => {
  const parts: string[] = []
  if (s.tools && s.tools.length > 0) parts.push(`tools: ${s.tools.join(", ")}`)
  if (s.model) parts.push(`model: ${s.model}`)
  if (s.effort !== undefined) parts.push(`effort: ${String(s.effort)}`)
  return parts.length === 0
    ? "[skill scope] none declared"
    : `[skill scope] ${parts.join(" | ")} (enforced by the main thread)`
}

/**
 * The `Skill` tool (analysis §2.1). Input `{ name }`; on execute it returns the
 * matched skill's markdown BODY as the tool result `output` so the model
 * proceeds with those instructions in context, prefixed with a one-line note of
 * any tool/model/effort scoping the skill declares.
 *
 * NOTE (main-thread seam): actual *enforcement* of `tools`/`model`/`effort`
 * scoping (turn-scoped permission union + model/effort override, CC's
 * `contextModifier`) is loop surgery owned by the agent slice — out of scope
 * here. We surface the declared scope in the result and on the {@link Skill}
 * type for later wiring.
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
