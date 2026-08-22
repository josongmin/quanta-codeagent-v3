import { describe, expect, test } from "bun:test"
import type { ToolContext, ToolEvent } from "@/tool"
import { testRunnerTool } from "@/tool/test-runner"

const collect = async (
  input: Parameters<typeof testRunnerTool.execute>[0],
  ctx: ToolContext,
): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const ev of testRunnerTool.execute(input, ctx)) out.push(ev)
  return out
}

describe("test_runner localEnv wiring", () => {
  test("explicit command inherits ctx.localEnv PATH prepend through runShell", async () => {
    const prefix = "/tmp/quanta-test-runner-local-env"
    const command = 'printf "%s" "$PATH"'
    const events = await collect({ command }, {
      cwd: "/tmp",
      signal: new AbortController().signal,
      localEnv: { vars: {}, pathPrepend: [prefix] },
    } as ToolContext)
    const result = events.at(-1)
    expect(result?.type).toBe("result")
    if (result?.type !== "result") throw new Error("expected result event")
    expect(result.result.ok).toBe(true)
    expect(result.result.output).toContain(`${prefix}:`)
    expect(result.result.evidence?.executedCommand).toBe(command)
  })
})
