/**
 * `current_plan` tool (ADR-0095 draft).
 *
 * Read-only snapshot of the current structured plan state. Surfaces the
 * existing `PlanToolContext.planMutator.current()` path to the model so CAS
 * retries can fetch the latest `expected_version` without mutating.
 */
import { errMessage } from "@/shared"
import type { PlanReadonlyView, PlanToolContext, Tool, ToolEvent } from "../types"
import { type CurrentPlanInput, currentPlanSchema } from "./schemas"

const renderTaskLine = (t: PlanReadonlyView["tasks"][number]): string => {
  const parts = [`  - ${t.id}`]
  if (t.owner !== undefined) parts.push(`owner=${t.owner}`)
  parts.push(`blockedBy=[${t.blockedBy.join(", ")}]`)
  parts.push(`blocks=[${t.blocks.join(", ")}]`)
  return parts.join(" ")
}

const renderPlanView = (plan: PlanReadonlyView): string => {
  const head = [
    `Current plan: v${plan.version}`,
    `name: ${plan.name}`,
    `overview: ${plan.overview}`,
    `isProject: ${plan.isProject ? "true" : "false"}`,
    `todos: ${plan.todoCount}`,
    `phases: ${plan.phaseCount}`,
  ]
  // RFC07-3: model-visible owner/blockedBy/blocks projection in canonical order.
  if (plan.tasks.length > 0) {
    head.push("tasks:")
    for (const t of plan.tasks) head.push(renderTaskLine(t))
  }
  return head.join("\n")
}

export const currentPlanTool = (): Tool<CurrentPlanInput> => ({
  name: "current_plan",
  description:
    "Read the current structured plan snapshot. Returns the latest version, name, overview, " +
    "project flag, and todo/phase counts. Call this before a CAS retry after version_conflict.",
  inputSchema: currentPlanSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(_input: CurrentPlanInput, ctx: PlanToolContext): AsyncIterable<ToolEvent> {
    const mutator = ctx.planMutator
    if (mutator === undefined) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "current_plan unavailable: no structured plan store is wired in this session.",
          failure: { mode: "error", modelVisibleError: "structured plan store is not wired" },
        },
      }
      return
    }
    let plan: ReturnType<typeof mutator.current>
    try {
      plan = mutator.current()
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `current_plan failed: ${errMessage(e)}`,
          failure: { mode: "error", modelVisibleError: "internal mutator error" },
        },
      }
      return
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: plan === null ? "No active plan." : renderPlanView(plan),
      },
    }
  },
})
