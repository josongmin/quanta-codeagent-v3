import { z } from "zod"
import { runShell } from "@/runtime"
import type { Tool, ToolContext, ToolEvent } from "../types"

const schema = z.object({
  command: z.string().describe("Shell command to run via bash -lc"),
  timeout_ms: z.number().optional().describe("Timeout in ms (default 120000)"),
})

type Input = z.infer<typeof schema>

const MAX_OUTPUT = 30_000
const CMD_PREVIEW = 80

export const bashTool: Tool<Input> = {
  name: "bash",
  description:
    "Run a shell command (bash). Returns combined stdout/stderr and exit code. " +
    "Non-zero exit is reported, not thrown.",
  inputSchema: schema,
  isReadOnly: () => false,
  // Arbitrary shell side effects are unknowable; never run concurrently.
  isConcurrencySafe: () => false,

  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const cmd = input.command
    const shown = cmd.length > CMD_PREVIEW ? `${cmd.slice(0, CMD_PREVIEW)}…` : cmd
    yield { type: "progress", message: `running: ${shown}` }

    const r = await runShell(cmd, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
    })

    let body = [r.stdout, r.stderr].filter(Boolean).join("\n").trimEnd()
    if (body.length > MAX_OUTPUT) {
      body = `${body.slice(0, MAX_OUTPUT)}\n… (truncated, ${body.length - MAX_OUTPUT} more chars)`
    }
    const status = r.timedOut ? "timed out" : r.exitCode === 0 ? "exit 0" : `exit ${r.exitCode}`
    yield {
      type: "result",
      result: {
        ok: r.exitCode === 0 && !r.timedOut,
        output: `[${status}]\n${body || "(no output)"}`,
      },
    }
  },
}
