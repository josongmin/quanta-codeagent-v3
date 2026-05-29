import { z } from "zod"
import { errMessage } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "./types"

/**
 * `request_plan_exit` tool (ADR-0086) — the model-driven exit from plan mode,
 * mirroring Claude Code's `ExitPlanMode`. When the agent has assembled a plan
 * and is ready to act, it calls this with the plan text; the dispatch seam
 * routes it to `ToolContext.requestPlanExit` (built from
 * `AgentConfig.planExitPort`), which surfaces the plan to whoever decides and
 * returns the 3-way outcome:
 *
 *   - `approved`          → the operator accepted; the surface (CLI/IDE) is
 *                           responsible for continuing in default mode so
 *                           subsequent turns may mutate. The tool tells the
 *                           model it may proceed.
 *   - `rejected`          → plan discarded; the model should stop / re-plan.
 *   - `changes_requested` → carries non-empty `feedback`; the model revises
 *                           the plan and may call this again.
 *
 * Registered ONLY when `AgentConfig.planExitPort` is wired (see
 * `buildSessionFeatures`). Absent ⇒ the tool is not in the registry and the
 * loop is byte-identical. Read-only + concurrency-UNSAFE (it blocks on an
 * operator decision; never overlap it with other work).
 *
 * Within-run lifecycle is owned by the agent loop: after an `approved`
 * decision, the loop flips the NEXT turn into default mode and may attach the
 * approved plan as read-only context. The tool itself still only relays the
 * typed decision text; it does not mutate state directly.
 */
const schema = z.object({
  plan: z.string().min(1).describe("The plan to present for approval (markdown ok)."),
})
type Input = z.infer<typeof schema>

const renderOutcome = (decision: string, feedback: string | undefined): string => {
  switch (decision) {
    case "approved":
      return "Plan APPROVED. The operator accepted — proceed with the plan in subsequent turns."
    case "rejected":
      return "Plan REJECTED. Do not proceed; stop or propose a different approach."
    case "changes_requested":
      return `Changes requested: ${feedback ?? "(no detail)"}. Revise the plan and call request_plan_exit again.`
    default:
      return `Plan exit returned an unknown decision: ${decision}.`
  }
}

export const requestPlanExitTool = (): Tool<Input> => ({
  name: "request_plan_exit",
  description:
    "Present the current plan for approval and exit plan mode. Returns the operator's " +
    "decision: approved (proceed) / rejected (stop) / changes_requested (revise with feedback). " +
    "Call this when the plan is complete and you are ready to act.",
  inputSchema: schema,
  isReadOnly: () => true,
  // Blocks on an operator decision — must never overlap other work.
  isConcurrencySafe: () => false,
  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const requester = ctx.requestPlanExit
    if (requester === undefined) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "request_plan_exit is unavailable: no plan-exit port is wired in this session.",
        },
      }
      return
    }
    yield { type: "progress", message: "awaiting plan-exit decision" }
    try {
      const outcome = await requester(input.plan)
      yield {
        type: "result",
        result: { ok: true, output: renderOutcome(outcome.decision, outcome.feedback) },
      }
    } catch (e) {
      yield {
        type: "result",
        result: { ok: false, output: `plan-exit failed: ${errMessage(e)}` },
      }
    }
  },
})
