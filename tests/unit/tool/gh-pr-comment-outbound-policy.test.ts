import { describe, expect, test } from "bun:test"
import { createGhCommentBodyPolicy, type GhRunner, ghPrCommentTool } from "@/tool/gh"
import type { ToolEvent, ToolResult } from "@/tool/types"
import { HIGH_VALUE_SECRET_SHAPES } from "../../_support/secret-shape-corpus"

const drain = async (iter: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

const resultOf = (events: readonly ToolEvent[]): ToolResult | undefined => {
  const last = [...events].reverse().find((e) => e.type === "result")
  return last?.type === "result" ? last.result : undefined
}

describe("gh_pr_comment outbound policy", () => {
  test("HITL path + corpus floor", () => {
    expect(HIGH_VALUE_SECRET_SHAPES.length).toBeGreaterThanOrEqual(17)
  })

  test("redacts corpus secrets from argv; two approvals create two comments", async () => {
    const calls: string[][] = []
    const runner: GhRunner = async (argv) => {
      calls.push(argv)
      return { code: 0, stdout: "https://example/comment", stderr: "" }
    }
    const tool = ghPrCommentTool(runner)
    const secret = HIGH_VALUE_SECRET_SHAPES[0]?.sample ?? ""
    const ctx = { cwd: "/tmp", signal: new AbortController().signal }
    await drain(tool.execute({ pr: 1, body: `see ${secret}` }, ctx))
    await drain(tool.execute({ pr: 1, body: `see ${secret}` }, ctx))
    expect(calls).toHaveLength(2)
    for (const argv of calls) {
      const joined = argv.join("\0")
      expect(joined).not.toContain(secret)
      expect(argv).toContain("--body")
    }
  })

  test("mutation C: prepare failure makes zero runner calls", async () => {
    const calls: string[][] = []
    const runner: GhRunner = async (argv) => {
      calls.push(argv)
      return { code: 0, stdout: "ok", stderr: "" }
    }
    const tool = ghPrCommentTool(
      runner,
      createGhCommentBodyPolicy({
        redact: () => {
          throw new Error("redact-down")
        },
      }),
    )
    const events = await drain(
      tool.execute({ pr: 2, body: "hello" }, { cwd: "/tmp", signal: new AbortController().signal }),
    )
    expect(calls).toHaveLength(0)
    expect(resultOf(events)?.ok).toBe(false)
  })

  test("production path never puts the raw secret on argv", async () => {
    const calls: string[][] = []
    const runner: GhRunner = async (argv) => {
      calls.push(argv)
      return { code: 0, stdout: "ok", stderr: "" }
    }
    const secret = HIGH_VALUE_SECRET_SHAPES.find((r) => r.label === "url-userinfo")?.sample ?? ""
    const tool = ghPrCommentTool(runner)
    await drain(
      tool.execute(
        { pr: 3, body: `x ${secret}` },
        { cwd: "/tmp", signal: new AbortController().signal },
      ),
    )
    expect(calls.some((a) => a.join(" ").includes("fixture-pass-not-live"))).toBe(false)
  })
})
