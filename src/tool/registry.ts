import { ToolInputError } from "@/shared"
import { zodToJsonSchema } from "./schema"
import type { Tool, ToolContext, ToolResult, ToolSpec } from "./types"

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  constructor(tools: Tool[]) {
    for (const t of tools) this.tools.set(t.name, t as Tool)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.isReadOnly() ?? false
  }

  /** Schemas advertised to the model. */
  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.inputSchema),
    }))
  }

  /** Validate raw model input, then execute. Throws {@link ToolInputError}
   *  on a schema mismatch so the caller can feed it back as a tool error. */
  async run(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new ToolInputError(`Unknown tool: ${name}`)

    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
      throw new ToolInputError(`Invalid input for ${name}: ${issues}`)
    }
    return tool.execute(parsed.data, ctx)
  }
}
