import { z } from "zod"
import { readFile, statFile } from "@/storage"
import type { Tool, ToolContext, ToolResult } from "../types"

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
  offset: z.number().optional().describe("1-based line to start from"),
  limit: z.number().optional().describe("Max lines to read (default 2000)"),
})

type Input = z.infer<typeof schema>

const DEFAULT_LIMIT = 2000

export const readTool: Tool<Input> = {
  name: "read",
  description:
    "Read a text file. Returns content with 1-based line numbers (`<n>\\t<line>`). " +
    "Use offset/limit for large files.",
  inputSchema: schema,
  isReadOnly: () => true,

  async execute(input: Input, _ctx: ToolContext): Promise<ToolResult> {
    const info = await statFile(input.path)
    if (info.isDirectory) return { ok: false, output: `${input.path} is a directory` }

    const text = await readFile(input.path)
    const lines = text.split("\n")
    const start = Math.max(0, (input.offset ?? 1) - 1)
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LIMIT))
    const numbered = lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n")

    const note = end < lines.length ? `\n… (${lines.length - end} more lines, use offset)` : ""
    return { ok: true, output: numbered === "" ? "(empty file)" : numbered + note }
  },
}
