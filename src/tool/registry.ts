import { join } from "node:path"
import { ToolExecutionError, ToolInputError } from "@/shared"
import { capToolOutput, envMaxChars } from "./output-spill"
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

  /** Validate then ask the tool whether this call may run concurrently with
   *  other concurrency-safe calls. Unknown tool or invalid input ⇒ false
   *  (the safe default: serialize it). */
  isConcurrencySafe(name: string, rawInput: unknown): boolean {
    const tool = this.tools.get(name)
    if (!tool) return false
    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) return false
    return tool.isConcurrencySafe(parsed.data)
  }

  /** Validate raw model input, then drive the tool's event stream. Progress
   *  events are forwarded to `onProgress`; the terminal result is returned.
   *  Throws {@link ToolInputError} on a schema mismatch (caller feeds it back
   *  as a tool error) and {@link ToolExecutionError} if the tool ends without
   *  emitting a result. */
  async run(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
    onProgress?: (message: string) => void,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) throw new ToolInputError(`Unknown tool: ${name}`)

    const parsed = tool.inputSchema.safeParse(rawInput)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
      throw new ToolInputError(`Invalid input for ${name}: ${issues}`)
    }

    let result: ToolResult | undefined
    for await (const ev of tool.execute(parsed.data, ctx)) {
      if (ev.type === "progress") {
        onProgress?.(ev.message)
      } else {
        result = ev.result
      }
    }
    if (result === undefined) {
      throw new ToolExecutionError(`Tool ${name} produced no result`)
    }
    const { output } = capToolOutput(result.output, {
      maxChars: envMaxChars(process.env),
      spillDir: join(ctx.cwd, ".quanta", "tool-output"),
    })
    return output === result.output ? result : { ...result, output }
  }
}
