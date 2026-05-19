import { z } from "zod"
import { FsJailError, fileExists, writeFile } from "@/storage"
import type { Tool, ToolContext, ToolEvent } from "../types"

const schema = z.object({
  path: z.string().describe("File path (absolute or relative to cwd)"),
  content: z.string().describe("Full file content to write"),
})

type Input = z.infer<typeof schema>

export const writeTool: Tool<Input> = {
  name: "write",
  description: "Write a file, creating or fully overwriting it. Creates parent dirs.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Mutates the filesystem; conservatively never run concurrently.
  isConcurrencySafe: () => false,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    // Resolve relative paths against the session cwd, not process.cwd().
    // The jail check fires inside fileExists()/writeFile() BEFORE any bytes
    // are written, so a denied path is NEVER a partial write.
    try {
      const existed = await fileExists(input.path, ctx.cwd)
      await writeFile(input.path, input.content, ctx.cwd)
      const bytes = Buffer.byteLength(input.content, "utf8")
      yield {
        type: "result",
        result: {
          ok: true,
          output: `${existed ? "Overwrote" : "Created"} ${input.path} (${bytes} bytes)`,
        },
      }
    } catch (e) {
      if (e instanceof FsJailError) {
        yield { type: "result", result: { ok: false, output: e.message } }
        return
      }
      throw e
    }
  },
}
