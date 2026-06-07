import { describe, expect, test } from "bun:test"
import { branchSearchTool } from "@/agent/branch-search/tool"
import type { StreamInput } from "@/llm"
import type { ToolContext, ToolResult } from "@/tool"

const fakeLlm = {
  model: "fake-branch-search",
  async *stream(_input: StreamInput) {
    yield { type: "message_stop", stop_reason: "end_turn" } as const
  },
}

const ctx = (): ToolContext => ({
  cwd: "/repo",
  signal: new AbortController().signal,
})

const run = async (throwMsg: string): Promise<ToolResult> => {
  const tool = branchSearchTool({
    config: {
      defaultN: 2,
      defaultVerifierKinds: ["tsc"],
      timeoutPerBranchMs: 1000,
      isolation: "tmpdir",
    },
    runCandidate: async () => ({ kind: "completed", turns: 1 }),
    buildIsolator: () => {
      throw new Error(throwMsg)
    },
    baseLlm: fakeLlm,
  })
  let result: ToolResult | undefined
  for await (const ev of tool.execute({ task_description: "fix it", n: 2 }, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("branch_search did not yield a result")
  return result
}

describe("branchSearchTool", () => {
  test("surfaces orchestration failures as ok:false tool results", async () => {
    const result = await run("isolator blew up")
    expect(result.ok).toBe(false)
    expect(result.output).toContain("branch_search failed: isolator blew up")
    expect(result.failure).toEqual({
      mode: "error",
      modelVisibleError: "branch_search failed: isolator blew up",
    })
  })
})
