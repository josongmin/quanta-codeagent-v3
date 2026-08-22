import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import {
  createSubagentBackedGuardianReview,
  materializeReviewerAgent,
} from "@/agent/tier1/reviewer-subagent"
import type { PermissionContext, ReviewContext, ToolActionKeyed } from "@/permission"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"
import type { ReviewerRequest, ReviewerRunner } from "@/tool/types"

const baseConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

const perm: PermissionContext = { mode: "acceptEdits" }

describe("materializeReviewerAgent", () => {
  test("returns undefined when subagent support is absent", () => {
    expect(materializeReviewerAgent(baseConfig())).toBeUndefined()
  })
})

describe("dispatch reviewerAgent wiring", () => {
  test("injects reviewerAgent into ToolContext when subagent support is enabled", async () => {
    let seen: ToolContext["reviewerAgent"] | undefined
    const probeTool: Tool = {
      name: "probe",
      description: "probe",
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async function* (_input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        seen = ctx.reviewerAgent
        yield {
          type: "result",
          result: { ok: true, output: ctx.reviewerAgent !== undefined ? "wired" : "missing" },
        }
      },
    }
    const cfg = baseConfig({
      registry: new ToolRegistry([probeTool]),
      subagent: { maxDepth: 2 },
    })
    const res = await dispatchTool(
      { type: "tool_use", id: "c1", name: "probe", input: {} },
      cfg,
      perm,
    )
    expect(res.ok).toBe(true)
    expect(res.preview).toBe("wired")
    expect(typeof seen).toBe("function")
  })
})

describe("createSubagentBackedGuardianReview", () => {
  const action: ToolActionKeyed = {
    tool: "edit",
    input: { path: "src/app.ts" },
    isReadOnly: false,
    actionKey: "edit",
  }
  const ctx: ReviewContext = {
    sessionId: "s1",
    turnId: "1",
    priorDenials: [],
    configReviewer: "guardian_subagent",
    decidedAt: 42,
  }

  test("uses the current narrow ReviewerRequest contract and parses approval JSON", async () => {
    let seen: ReviewerRequest | undefined
    const reviewer: ReviewerRunner = async (req: ReviewerRequest) => {
      seen = req
      return {
        ok: true,
        finalText: JSON.stringify({
          outcome: "guardian_approved",
          rationale: "looks safe",
          riskLevel: "low",
        }),
        turns: 1,
      }
    }
    const review = createSubagentBackedGuardianReview({ reviewer, parentDepth: 2 })
    const decision = await review(action, ctx)
    expect(seen).toMatchObject({
      depth: 3,
      taskKind: "review",
      toolFilter: ["read", "grep", "glob"],
    })
    expect(Object.hasOwn(seen ?? {}, "budget")).toBe(false)
    expect(Object.hasOwn(seen ?? {}, "resultShape")).toBe(false)
    expect(decision).toMatchObject({
      reviewer: "guardian_subagent",
      outcome: "guardian_approved",
      riskLevel: "low",
      rationale: "looks safe",
    })
  })

  test("fails closed when the reviewer returns invalid JSON", async () => {
    const reviewer: ReviewerRunner = async () => ({
      ok: true,
      finalText: "not json",
      turns: 1,
    })
    const review = createSubagentBackedGuardianReview({ reviewer })
    const decision = await review(action, ctx)
    expect(decision).toMatchObject({
      reviewer: "guardian_subagent",
      outcome: "guardian_denied",
      riskLevel: "high",
    })
    expect(decision.rationale).toContain("invalid JSON")
  })
})
