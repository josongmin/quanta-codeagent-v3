import { z } from "zod"
import type {
  ActionAssessment,
  ApprovalDecision,
  ReviewerPort,
  ToolActionKeyed,
} from "@/permission"
import type { StreamPort } from "@/stream"
import type { ReviewerRunner } from "@/tool/types"
import { reviewerApprovalStructuredReason } from "../deny-reason-wire"
import { createSubagentRunner } from "../subagent-runner"
import type { AgentConfig } from "../types"

const SILENT_STREAM: StreamPort = { emit() {} }
const REVIEWER_MAX_TURNS = 4
const REVIEWER_TOOL_FILTER = ["read", "grep", "glob"] as const
const REVIEWER_CACHE = new WeakMap<AgentConfig, ReviewerRunner>()

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
    "- when denying, include `steer` with a concise safer next step if one exists.",
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

const decodeGuardianDecision = (
  finalText: string,
  tool: string,
  decidedAt: number,
): ApprovalDecision => {
  let decoded: unknown
  try {
    decoded = JSON.parse(finalText)
  } catch {
    return fallbackDecision(`guardian reviewer returned invalid JSON for ${tool}`, decidedAt)
  }
  const parsed = guardianReplySchema.safeParse(decoded)
  if (!parsed.success) {
    return fallbackDecision(`guardian reviewer returned invalid JSON for ${tool}`, decidedAt)
  }
  const reply = parsed.data
  return {
    reviewer: "guardian_subagent",
    outcome: reply.outcome,
    riskLevel: reply.riskLevel ?? "high",
    rationale: reply.rationale,
    decidedAt,
    ...(reply.outcome === "guardian_denied" && reply.steer !== undefined
      ? { verb: { verb: "reject_and_tell" as const, message: reply.steer } }
      : {}),
  }
}

/** Build the silent reviewer runner the agent slice uses internally for
 *  `guardian_subagent` approvals and `git_review_diff`. The child loop is the
 *  normal `SubagentRunner`, but the inherited stream is replaced with a no-op
 *  sink so the reviewer's internal turns never leak into the parent UI. */
export const materializeReviewerAgent = (config: AgentConfig): ReviewerRunner | undefined => {
  const cached = REVIEWER_CACHE.get(config)
  if (cached !== undefined) return cached
  if (config.subagent === undefined) return undefined
  const parent: AgentConfig = { ...config, stream: SILENT_STREAM }
  const runner = createSubagentRunner(
    parent,
    config.subagent.maxDepth !== undefined ? { maxDepth: config.subagent.maxDepth } : {},
  )
  const reviewer: ReviewerRunner = async (req) => {
    const result = await runner({
      prompt: req.prompt,
      depth: req.depth,
      isolation: "none",
      budget: { maxTurns: REVIEWER_MAX_TURNS },
      ...(req.taskKind !== undefined ? { taskKind: req.taskKind } : {}),
      ...(req.toolFilter !== undefined ? { toolFilter: [...req.toolFilter] } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    })
    return { ok: result.ok, finalText: result.finalText, turns: result.turns }
  }
  REVIEWER_CACHE.set(config, reviewer)
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
      toolFilter: REVIEWER_TOOL_FILTER,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    if (!result.ok) {
      return fallbackDecision(
        `guardian reviewer failed for ${action.tool}: ${result.finalText || "no result"}`,
        ctx.decidedAt,
      )
    }
    return decodeGuardianDecision(result.finalText, action.tool, ctx.decidedAt)
  }
}

/* ------------------------------------------------------------------------- *
 * jun-7-misc 03 (ADR-0497) — richer per-action ASSESSOR variant.
 *
 * Behind the `QUANTA_GUARDIAN_ASSESSOR` knob, the guardian renders a typed
 * `ActionAssessment` instead of the binary outcome. This is the SAME guardian
 * round-trip (no extra LLM pass — ticket §9.3); only the reply SHAPE is richer.
 * It is wired into the OPTIONAL `ReviewerPort.guardianAssess` method; the binary
 * path above is untouched, so the OFF default is byte-identical.
 *
 * SAFETY: every malformed / failed / unparseable reply ⇒ `{kind:"deny"}`
 * (fail-closed). The downstream `collapseAssessment` is the conservative,
 * fail-closed boundary; this decoder mirrors that floor.
 * ------------------------------------------------------------------------- */

const ASSESS_RESULT_SHAPE =
  'JSON only. One of: {"kind":"allow","rationale":"string","riskLevel":"low"|"medium"|"high"} | ' +
  '{"kind":"allow_with_edit","rationale":"string","updatedInput":<corrected tool input>,"steer":"string"} | ' +
  '{"kind":"ask","rationale":"string"} | ' +
  '{"kind":"deny","rationale":"string"} | ' +
  '{"kind":"deny_and_steer","rationale":"string","steer":"string"} | ' +
  '{"kind":"escalate","rationale":"string","axis":"sandbox"|"network"|"permission"}'

const assessReplySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("allow"),
      rationale: z.string().min(1),
      riskLevel: z.enum(["low", "medium", "high"]).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("allow_with_edit"),
      rationale: z.string().min(1),
      updatedInput: z.unknown(),
      steer: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("ask"), rationale: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("deny"), rationale: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("deny_and_steer"),
      rationale: z.string().min(1),
      steer: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("escalate"),
      rationale: z.string().min(1),
      axis: z.enum(["sandbox", "network", "permission"]),
    })
    .strict(),
])

const assessorPrompt = (action: ToolActionKeyed, reviewKind: string | undefined): string =>
  [
    "You are the guardian assessor for a tool approval gate.",
    "Assess the proposed action and respond with JSON only.",
    "",
    "Decision kinds (pick exactly one):",
    '- "allow": run the action as-proposed (only when clearly acceptable).',
    '- "allow_with_edit": the action is fine ONLY with a correction — supply the corrected `updatedInput` and a `steer` describing the change. The original is NOT run; the correction is fed back to the model.',
    '- "ask": you are uncertain — escalate to the human operator.',
    '- "deny": reject the action (unsafe / not derivable from a safer step).',
    '- "deny_and_steer": reject AND supply a `steer` with a concrete safer next step.',
    '- "escalate": the action needs a sandbox/network/permission policy amendment, not a yes/no — name the `axis`.',
    "When in doubt, prefer the more restrictive kind. Never allow an unsafe action.",
    "",
    `Tool: ${action.tool}`,
    `Review kind: ${reviewKind ?? "unknown"}`,
    `Read only: ${action.isReadOnly ? "yes" : "no"}`,
    "Input JSON:",
    "```json",
    renderActionInput(action.input),
    "```",
    "",
    `Output shape: ${ASSESS_RESULT_SHAPE}`,
  ].join("\n")

/** Fail-closed assessment. Mirrors `fallbackDecision` — every parse / run
 *  failure collapses (via `collapseAssessment`) to `guardian_denied`. The
 *  `denyReason` is a CATEGORICAL `layer:"reviewer"` record (C6 no-leak: never
 *  the raw input / command). */
const fallbackAssessment = (safeReason: string, rationale: string): ActionAssessment => ({
  kind: "deny",
  rationale,
  denyReason: reviewerApprovalStructuredReason(safeReason),
})

const decodeAssessment = (finalText: string, tool: string): ActionAssessment => {
  let decoded: unknown
  try {
    decoded = JSON.parse(finalText)
  } catch {
    return fallbackAssessment(
      "guardian assessor returned invalid JSON",
      `guardian assessor returned invalid JSON for ${tool}`,
    )
  }
  const parsed = assessReplySchema.safeParse(decoded)
  if (!parsed.success) {
    return fallbackAssessment(
      "guardian assessor returned an unrecognized assessment",
      `guardian assessor returned an unrecognized assessment for ${tool}`,
    )
  }
  const reply = parsed.data
  switch (reply.kind) {
    case "allow":
      return { kind: "allow", rationale: reply.rationale, riskLevel: reply.riskLevel ?? "high" }
    case "allow_with_edit":
      return {
        kind: "allow_with_edit",
        rationale: reply.rationale,
        updatedInput: reply.updatedInput,
        steer: reply.steer,
      }
    case "ask":
      return { kind: "ask", rationale: reply.rationale }
    case "deny":
      return fallbackAssessment("reviewer denied the action", reply.rationale)
    case "deny_and_steer":
      return {
        kind: "deny_and_steer",
        rationale: reply.rationale,
        steer: reply.steer,
        denyReason: reviewerApprovalStructuredReason("reviewer denied the action"),
      }
    case "escalate":
      return { kind: "escalate", rationale: reply.rationale, escalation: { axis: reply.axis } }
    default: {
      // Exhaustive over the parsed union; an unhandled kind fails closed.
      const _exhaustive: never = reply
      return fallbackAssessment(
        "guardian assessor returned an unknown assessment kind",
        `guardian assessor returned an unknown assessment kind for ${tool}: ${String(_exhaustive)}`,
      )
    }
  }
}

/** Concrete guardian-ASSESSOR adapter (ADR-0497). Sibling to
 *  `createSubagentBackedGuardianReview`; emits the typed `ActionAssessment` that
 *  `collapseAssessment` reduces to a standard `ApprovalDecision`. Malformed /
 *  failed child output ⇒ a fail-closed `{kind:"deny"}`. Wired into
 *  `ReviewerPort.guardianAssess` ONLY when the knob is on (composition root). */
export const createSubagentBackedGuardianAssess = (opts: {
  reviewer: ReviewerRunner
  parentDepth?: number
  signal?: AbortSignal
}): NonNullable<ReviewerPort["guardianAssess"]> => {
  const childDepth = (opts.parentDepth ?? 0) + 1
  return async (action, ctx): Promise<ActionAssessment> => {
    if (action.isReadOnly) {
      return {
        kind: "allow",
        rationale: `read-only ${ctx.reviewKind ?? "action"} for ${action.tool} requires no guardian escalation`,
        riskLevel: "low",
      }
    }
    const result = await opts.reviewer({
      prompt: assessorPrompt(action, ctx.reviewKind),
      depth: childDepth,
      taskKind: "review",
      toolFilter: REVIEWER_TOOL_FILTER,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    if (!result.ok) {
      return fallbackAssessment(
        "guardian assessor failed",
        `guardian assessor failed for ${action.tool}: ${result.finalText || "no result"}`,
      )
    }
    return decodeAssessment(result.finalText, action.tool)
  }
}
