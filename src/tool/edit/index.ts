import { z } from "zod"
import { readFile, writeFile } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { applyExactEdit } from "./exact"
import { applyFuzzyEdit } from "./fuzzy"

const schema = z.object({
  path: z.string().describe("File path to edit"),
  old_string: z.string().describe("Exact text to replace (must be unique unless replace_all)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
  fuzzy: z
    .boolean()
    .optional()
    .describe(
      "If exact match fails, retry with whitespace-tolerant fuzzy matching (default false)",
    ),
})

type Input = z.infer<typeof schema>

export const editTool: Tool<Input> = {
  name: "edit",
  description: "Exact string replacement in an existing file. old_string must match verbatim.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Mutates the filesystem; conservatively never run concurrently.
  isConcurrencySafe: () => false,

  async *execute(input: Input, _ctx: ToolContext): AsyncIterable<ToolEvent> {
    const source = await readFile(input.path)
    const replaceAll = input.replace_all ?? false
    let result = applyExactEdit(source, input.old_string, input.new_string, replaceAll)
    if ((!result.ok || result.next === undefined) && input.fuzzy) {
      result = applyFuzzyEdit(source, input.old_string, input.new_string, replaceAll)
    }
    if (!result.ok || result.next === undefined) {
      yield { type: "result", result: { ok: false, output: result.message } }
      return
    }
    await writeFile(input.path, result.next)
    yield { type: "result", result: { ok: true, output: `${input.path}: ${result.message}` } }
  },
}
