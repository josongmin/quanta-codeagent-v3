import { z } from "zod"
import type { ApprovalDecision, ReviewerPort, ToolActionKeyed } from "@/permission"
import type { StreamPort } from "@/stream"
import { REVIEW_TOOL_FILTER } from "@/subagent"
import type { ReviewerRunner } from "@/tool/types"
import { createSubagentRunner } from "../subagent-runner"
import type { AgentConfig } from "../types"

const SILENT_STREAM: StreamPort = { emit() {} }

const GUARDIAN_RESULT_SHAPE =
  'JSON only: {"outcome":"guardian_approved"|"guardian_denied","rationale":"string","steer?":"string","riskLevel?":"low"|"medium"|"high"}'

const guardianReplySchema = z
  .object({
    outcome: z.enum(["guardian_approved", "guardian_denied"]),
    rationale: z.string().min(1),
    steer: z.string().min(1).optional(),
    riskLevel: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict()

const renderActionInput = (input: unknown): string => {
  try {
    return JSON.stringify(input, null, 2) ?? "null"
  } catch {
    return JSON.stringify({ nonSerializableInput: String(input) }, null, 2)
  }
}

const reviewerPrompt = (action: ToolActionKeyed, reviewKind: string | undefined): string =>
  [
    "You are the guardian reviewer for a tool approval gate.",
    "Review the proposed action and respond with JSON only.",
    "",
    "Decision rules:",
    '- return {"outcome":"guardian_approved",...} only when the action is acceptable as requested.',
    '- return {"outcome":"guardian_denied",...} when the action is unsafe, underspecified, or should be redirected.',
    '- when denying, include `steer` with a concise safer next step if one exists.',
    "",
    `Tool: ${action.tool}`,
    `Review kind: ${reviewKind ?? "unknown"}`,
    `Read only: ${action.isReadOnly ? "yes" : "no"}`,
    "Input JSON:",
    "```json",
    renderActionInput(action.input),
    "```",
    "",
    `Output shape: ${GUARDIAN_RESULT_SHAPE}`,
  ].join("\n")

const fallbackDecision = (
  rationale: string,
  decidedAt: number,
  steer?: string,
): ApprovalDecision => ({
  reviewer: "guardian_subagent",
  outcome: "guardian_denied",
  riskLevel: "high",
  rationale,
  decidedAt,
  ...(steer !== undefined ? { verb: { verb: "reject_and_tell" as const, message: steer } } : {}),
})

/** Build the silent reviewer runner the agent slice uses internally for
 *  `guardian_subagent` approvals and `git_review_diff`. The child loop is the
 *  normal `SubagentRunner`, but the inherited stream is replaced with a no-op
 *  sink so the reviewer's internal turns never leak into the parent UI. */
export const materializeReviewerAgent = (config: AgentConfig): ReviewerRunner | undefined => {
  if (config.reviewerAgent !== undefined) return config.reviewerAgent
  if (config.subagent === undefined) return undefined
  const parent: AgentConfig = { ...config, stream: SILENT_STREAM }
  const runner = createSubagentRunner(parent)
  const reviewer: ReviewerRunner = async (req) => {
    const result = await runner({
      prompt: req.prompt,
      depth: req.depth,
      isolation: "none",
      ...(req.taskKind !== undefined ? { taskKind: req.taskKind } : {}),
      ...(req.toolFilter !== undefined ? { toolFilter: [...req.toolFilter] } : {}),
      ...(req.budget !== undefined ? { budget: { ...req.budget } } : {}),
      ...(req.resultShape !== undefined ? { resultShape: req.resultShape } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    })
    return { ok: result.ok, finalText: result.finalText, turns: result.turns }
  }
  config.reviewerAgent = reviewer
  return reviewer
}

/** Concrete guardian-review adapter backed by the internal reviewer runner.
 *  Malformed / failed child output is treated as a fail-closed deny. */
export const createSubagentBackedGuardianReview = (opts: {
  reviewer: ReviewerRunner
  parentDepth?: number
  signal?: AbortSignal
}): ReviewerPort["guardianReview"] => {
  const childDepth = (opts.parentDepth ?? 0) + 1
  return async (action, ctx) => {
    if (action.isReadOnly) {
      return {
        reviewer: "guardian_subagent",
        outcome: "not_needed",
        riskLevel: "low",
        rationale: `read-only ${ctx.reviewKind ?? "action"} review for ${action.tool} requires no guardian escalation`,
        decidedAt: ctx.decidedAt,
      }
    }
    const result = await opts.reviewer({
      prompt: reviewerPrompt(action, ctx.reviewKind),
      depth: childDepth,
      taskKind: "review",
      toolFilter: REVIEW_TOOL_FILTER,
      budget: { maxTurns: 4 },
      resultShape: GUARDIAN_RESULT_SHAPE,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    if (!result.ok) {
      return fallbackDecision(
        `guardian reviewer failed for ${action.tool}: ${result.finalText || "no result"}`,
        ctx.decidedAt,
      )
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(result.finalText)
    } catch {
      return fallbackDecision(
        `guardian reviewer returned invalid JSON for ${action.tool}`,
        ctx.decidedAt,
      )
    }
    const parsed = guardianReplySchema.safeParse(decoded)
    if (!parsed.success) {
      return fallbackDecision(
        `guardian reviewer returned invalid JSON for ${action.tool}`,
        ctx.decidedAt,
      )
    }
    const reply = parsed.data
    return {
      reviewer: "guardian_subagent",
      outcome: reply.outcome,
      riskLevel: reply.riskLevel ?? "high",
      rationale: reply.rationale,
      decidedAt: ctx.decidedAt,
      ...(reply.outcome === "guardian_denied" && reply.steer !== undefined
        ? { verb: { verb: "reject_and_tell" as const, message: reply.steer } }
        : {}),
    }
  }
}
