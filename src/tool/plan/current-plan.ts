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

const renderPlanView = (plan: PlanReadonlyView): string =>
  [
    `Current plan: v${plan.version}`,
    `name: ${plan.name}`,
    `overview: ${plan.overview}`,
    `isProject: ${plan.isProject ? "true" : "false"}`,
    `todos: ${plan.todoCount}`,
    `phases: ${plan.phaseCount}`,
  ].join("\n")

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
          output: "current_plan unavailable: plan-mode is not active in this session.",
          failure: { mode: "error", modelVisibleError: "plan-mode is not active" },
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
