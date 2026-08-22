/**
 * Structural parity hellgate for the generic repo-search front door.
 *
 * Contract:
 * - `search_codebase` is explicitly read-only in plan mode.
 * - Every delegated read-only surface preserves it.
 * - The `localize-fault` skill allows it for broad repo search.
 * - Probe/bench observability treat it as a real Stage-1/search tool.
 *
 * This is intentionally cross-surface. The failure mode we are guarding
 * against is NOT one broken implementation; it is drift between several small
 * string allowlists that silently split the product contract again.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertNotMutatingInPlanMode, isMutatingTool, mutatingToolKind } from "../../src/agent/mode"
import { SIDE_CONVERSATION_TOOL_NAMES } from "../../src/agent/side-conversation/run"
import { classify } from "../../src/apps/bench/corpus/failure-classifier"
import type { InstanceResult } from "../../src/apps/bench/types"
import { observeFunnel } from "../../src/apps/probe/funnel"
import { SIDE_CONVERSATION_DEFAULT_TOOLS } from "../../src/host/runtime/internal/context-binding/side-conversation"
import { parseFrontmatter, systemSkillsDir } from "../../src/skill"
import {
  createAgentTool,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
} from "../../src/subagent"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"

const SKILL_MD = join(systemSkillsDir(), "localize-fault", "SKILL.md")

const ctxAt = (depth?: number): ToolContext =>
  ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    ...(depth !== undefined ? { depth } : {}),
  }) as ToolContext

const run = async (tool: Tool, input: unknown, ctx: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, ctx)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

const result = (r: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText: "done",
  turns: 1,
  ...r,
})

const capturingRunner = (): { runner: SubagentRunner; seen: () => SubagentRequest | undefined } => {
  let captured: SubagentRequest | undefined
  const runner: SubagentRunner = async (req) => {
    captured = req
    return result()
  }
  return { runner, seen: () => captured }
}

const setupClassifierFixture = (
  resultSeed: Omit<InstanceResult, "patchPath">,
  events: unknown[],
): { result: InstanceResult; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "search-surface-"))
  const patchPath = join(dir, `${resultSeed.id}.0.patch`)
  const trajectoryPath = join(dir, `${resultSeed.id}.0.jsonl`)
  writeFileSync(patchPath, resultSeed.patch)
  writeFileSync(trajectoryPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`)
  return {
    result: { ...resultSeed, patchPath },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const toolCall = (name: string): Record<string, unknown> => ({
  kind: "tool_call",
  data: { name },
})

const toolResult = (value: string): Record<string, unknown> => ({
  kind: "tool_result",
  data: { result: value },
})

const sessionEnd = (reason: string, turns: number): Record<string, unknown> => ({
  kind: "session_end",
  data: { reason, turns },
})

describe("HELL-search-surface parity", () => {
  test("plan-mode seam classifies search_codebase as explicit read-only", () => {
    expect(isMutatingTool("search_codebase")).toBe(false)
    expect(mutatingToolKind("search_codebase")).toBeNull()
    expect(() => assertNotMutatingInPlanMode("plan", "search_codebase")).not.toThrow()
  })

  test("delegated read-only surfaces retain search_codebase", () => {
    expect(SIDE_CONVERSATION_TOOL_NAMES).toContain("search_codebase")
    expect(SIDE_CONVERSATION_DEFAULT_TOOLS).toContain("search_codebase")
  })

  test("subagent read/review defaults retain search_codebase", async () => {
    const { runner, seen } = capturingRunner()
    const tool = createAgentTool({ runner })

    await run(tool, { prompt: "inspect", task_kind: "read" }, ctxAt(0))
    expect(seen()?.toolFilter).toContain("search_codebase")

    await run(tool, { prompt: "review", task_kind: "review" }, ctxAt(0))
    expect(seen()?.toolFilter).toContain("search_codebase")
  })

  test("localize-fault skill allowlist includes search_codebase for broad repo search", () => {
    const raw = readFileSync(SKILL_MD, "utf8")
    const { data, body } = parseFrontmatter(raw)
    expect(data.allowedTools).toContain("search_codebase")
    expect(body).toContain("broad repo search")
  })

  test("probe funnel treats search_codebase as a Stage-1 tool", () => {
    const report = observeFunnel([
      { seq: 1, kind: "tool_call", data: { name: "search_codebase" } },
      { seq: 2, kind: "tool_call", data: { name: "read" } },
      { seq: 3, kind: "tool_call", data: { name: "lsp_references" } },
    ] as never)
    expect(report.followed).toBe(true)
    expect(report.stagesReached).toBe(3)
    expect(report.sequence[0]).toBe("search_codebase")
  })

  test("bench failure classifier treats empty search_codebase streaks as search thrashing", () => {
    const events = [
      ...Array.from({ length: 5 }, () => [toolCall("search_codebase"), toolResult("")]).flat(),
      toolCall("read"),
      toolResult("src/foo.ts"),
      sessionEnd("completed", 6),
    ]
    const { result, cleanup } = setupClassifierFixture(
      { id: "thrash", passed: false, patch: "diff --git a/x b/x\n+y\n", turns: 6 },
      events,
    )
    try {
      expect(classify(result).signals).toContain("search_thrashing")
    } finally {
      cleanup()
    }
  })
})
