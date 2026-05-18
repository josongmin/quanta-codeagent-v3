import { z } from "zod"
import { runShell } from "@/runtime"
import type { Tool, ToolContext, ToolResult } from "../types"

const schema = z.object({
  pattern: z.string().describe("Regex pattern (ripgrep syntax)"),
  path: z.string().optional().describe("File or directory to search (default cwd)"),
  glob: z.string().optional().describe("Filter files by glob, e.g. '*.ts'"),
})

type Input = z.infer<typeof schema>

const sq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

const MAX_LINES = 200

export const grepTool: Tool<Input> = {
  name: "grep",
  description: "Search file contents with ripgrep. Returns `path:line:match` rows.",
  inputSchema: schema,
  isReadOnly: () => true,

  async execute(input: Input, ctx: ToolContext): Promise<ToolResult> {
    const parts = ["rg", "--line-number", "--no-heading", "--color=never"]
    if (input.glob) parts.push("-g", sq(input.glob))
    parts.push("-e", sq(input.pattern))
    if (input.path) parts.push(sq(input.path))

    const r = await runShell(parts.join(" "), { cwd: ctx.cwd, signal: ctx.signal })

    if (r.exitCode === 1 && !r.stdout) return { ok: true, output: "(no matches)" }
    if (r.exitCode > 1 || r.timedOut) {
      return { ok: false, output: r.stderr.trim() || `ripgrep failed (exit ${r.exitCode})` }
    }
    const lines = r.stdout.trimEnd().split("\n")
    const shown = lines.slice(0, MAX_LINES).join("\n")
    const more = lines.length > MAX_LINES ? `\n… (${lines.length - MAX_LINES} more matches)` : ""
    return { ok: true, output: shown + more }
  },
}
