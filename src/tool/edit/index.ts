import { z } from "zod"
import { readFile, writeFile } from "@/storage"
import type { Tool, ToolContext, ToolResult } from "../types"
import { applyExactEdit } from "./exact"

const schema = z.object({
  path: z.string().describe("File path to edit"),
  old_string: z.string().describe("Exact text to replace (must be unique unless replace_all)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
})

type Input = z.infer<typeof schema>

export const editTool: Tool<Input> = {
  name: "edit",
  description: "Exact string replacement in an existing file. old_string must match verbatim.",
  inputSchema: schema,
  isReadOnly: () => false,

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    const source = await readFile(input.path)
    const result = applyExactEdit(
      source,
      input.old_string,
      input.new_string,
      input.replace_all ?? false,
    )
    if (!result.ok || result.next === undefined) {
      return { ok: false, output: result.message }
    }
    await writeFile(input.path, result.next)
    return { ok: true, output: `${input.path}: ${result.message}` }
  },
}
