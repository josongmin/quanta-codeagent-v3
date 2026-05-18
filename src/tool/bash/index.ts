import { z } from "zod"
import { runShell } from "@/runtime"
import type { Tool, ToolContext, ToolResult } from "../types"

const schema = z.object({
  command: z.string().describe("Shell command to run via bash -lc"),
  timeout_ms: z.number().optional().describe("Timeout in ms (default 120000)"),
})

type Input = z.infer<typeof schema>

const MAX_OUTPUT = 30_000

export const bashTool: Tool<Input> = {
  name: "bash",
  description:
    "Run a shell command (bash). Returns combined stdout/stderr and exit code. " +
    "Non-zero exit is reported, not thrown.",
  inputSchema: schema,
  isReadOnly: () => false,

  async execute(input: Input, ctx: ToolContext): Promise<ToolResult> {
    const r = await runShell(input.command, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
    })

    let body = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd()
    if (body.length > MAX_OUTPUT) {
      body = `${body.slice(0, MAX_OUTPUT)}\n… (truncated, ${body.length - MAX_OUTPUT} more chars)`
    }
    const status = r.timedOut ? "timed out" : r.exitCode === 0 ? "exit 0" : `exit ${r.exitCode}`
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      output: `[${status}]\n${body || "(no output)"}`,
    }
  },
}
