/**
 * Shared fixtures for Wave A admissibility integration suites.
 * Split across `admissibility-wave-a/*.test.ts` for reviewability — same coverage.
 */

import { z } from "zod"
import type { AgentConfig } from "@/agent"
import type { AdmissibilityAction } from "@/agent/admissibility-gate"
import type { ToolUseBlock } from "@/llm"
import type { ApprovalDecision, HITLTier, ReviewerPort, ReviewerTier } from "@/permission"
import { RulesStore } from "@/rules"
import type { Tool } from "@/tool"

export const bashSchema = z.object({ command: z.string() })

export const makeTool = (
  name: string,
  opts: {
    readOnly?: boolean
    schema?: z.ZodTypeAny
    hitlTier?: (input: unknown) => HITLTier
    extractShellCommand?: (input: unknown) => string | null
  } = {},
): Tool => {
  const tool: Tool = {
    name,
    description: `${name} tool`,
    inputSchema: (opts.schema ?? z.object({})) as z.ZodType<unknown>,
    isReadOnly: () => opts.readOnly ?? false,
    isConcurrencySafe: () => opts.readOnly ?? false,
    execute: async function* () {
      yield { type: "result", result: { ok: true, output: "ran" } }
    },
  }
  if (opts.hitlTier) {
    ;(tool as Tool & { hitlTier: (input: unknown) => HITLTier }).hitlTier = opts.hitlTier
  }
  if (opts.extractShellCommand) {
    ;(
      tool as Tool & { extractShellCommand: (input: unknown) => string | null }
    ).extractShellCommand = opts.extractShellCommand
  }
  return tool
}

export const call = (name: string, input: unknown = {}, id = "c1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

export const cfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "default" },
    ...over,
  }) as AgentConfig

export const actionOf = (
  tool: Tool,
  input: unknown = {},
): AdmissibilityAction & { shellCommand?: string | null } => {
  const a: AdmissibilityAction & { shellCommand?: string | null } = {
    tool: tool.name,
    input,
    isReadOnly: tool.isReadOnly(),
  }
  const e = (tool as Tool & { extractShellCommand?: (input: unknown) => string | null })
    .extractShellCommand
  if (e) {
    const cmd = e(input)
    if (cmd !== null) a.shellCommand = cmd
  }
  return a
}

export const loadedStore = (
  lines: string,
  layer: "system" | "user" | "project" = "user",
): RulesStore => {
  const s = new RulesStore()
  s.loadLayer(layer, lines, `${layer}.rules`)
  return s
}

export const makePort = (over: Partial<ReviewerPort> = {}): ReviewerPort => ({
  userReview:
    over.userReview ??
    (async () => {
      throw new Error("userReview not scripted")
    }),
  autoReview:
    over.autoReview ??
    (async () => {
      throw new Error("autoReview not scripted")
    }),
  guardianReview:
    over.guardianReview ??
    (async () => {
      throw new Error("guardianReview not scripted")
    }),
})

export const decision = (
  reviewer: ReviewerTier,
  outcome: ApprovalDecision["outcome"],
  decidedAt = 12345,
): ApprovalDecision => ({
  reviewer,
  outcome,
  riskLevel: "medium",
  rationale: `${reviewer} rendered ${outcome}`,
  decidedAt,
})
