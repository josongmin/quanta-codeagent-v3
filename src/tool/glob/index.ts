import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"

const schema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'"),
  path: z.string().optional().describe("Base directory (default cwd)"),
})

type Input = z.infer<typeof schema>

const MAX = 300

export const globTool: Tool<Input> = {
  name: "glob",
  description: "List files matching a glob pattern, relative to the base directory.",
  inputSchema: schema,
  isReadOnly: () => true,
  // Read-only directory scan; no side effects, safe to parallelize.
  isConcurrencySafe: () => true,

  // A bounded directory scan is fast; no progress event needed.
  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const base = input.path ?? ctx.cwd
    const glob = new Bun.Glob(input.pattern)
    const hits: string[] = []
    for await (const file of glob.scan({ cwd: base, onlyFiles: true, dot: false })) {
      hits.push(file)
      if (hits.length >= MAX + 1) break
    }
    if (hits.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no files matched)" } }
      return
    }
    hits.sort()
    const more = hits.length > MAX ? `\n… (truncated at ${MAX})` : ""
    yield { type: "result", result: { ok: true, output: hits.slice(0, MAX).join("\n") + more } }
  },
}
