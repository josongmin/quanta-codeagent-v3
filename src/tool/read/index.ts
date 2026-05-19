import { z } from "zod"
import { readFile, statFile } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"

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
  // Pure read of a single file: no side effects, safe to run concurrently.
  isConcurrencySafe: () => true,

  // A single file read is fast; no progress event needed.
  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    // Resolve relative paths against the session cwd, not process.cwd().
    const info = await statFile(input.path, ctx.cwd)
    if (info.isDirectory) {
      yield { type: "result", result: { ok: false, output: `${input.path} is a directory` } }
      return
    }

    const text = await readFile(input.path, ctx.cwd)
    const lines = text.split("\n")
    const start = Math.max(0, (input.offset ?? 1) - 1)
    const end = Math.min(lines.length, start + (input.limit ?? DEFAULT_LIMIT))
    const numbered = lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join("\n")

    const note = end < lines.length ? `\n… (${lines.length - end} more lines, use offset)` : ""
    yield {
      type: "result",
      result: { ok: true, output: numbered === "" ? "(empty file)" : numbered + note },
    }
  },
}
