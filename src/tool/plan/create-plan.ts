/**
 * `create_plan` tool (ADR-0095 draft).
 *
 * Creates a new structured plan with todos + optional phases. Routes through
 * the duck-typed {@link PlanToolContext.planMutator} seam. Registered only when
 * a structured plan store is wired into `ctx.planMutator` (default-OFF
 * byte-identical otherwise).
 */
import { errMessage } from "@/shared"
import type { PlanToolContext, Tool, ToolEvent } from "../types"
import { planErrorMessage, planFailure } from "./error-mapping"
import { type CreatePlanInput, createPlanSchema } from "./schemas"

export const createPlanTool = (): Tool<CreatePlanInput> => ({
  name: "create_plan",
  description:
    "Create a structured plan with todos and optional phases. Returns version=0 + delta on " +
    "success. Reject if a plan already exists (use update_todos/update_plan instead).",
  inputSchema: createPlanSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  async *execute(input: CreatePlanInput, ctx: PlanToolContext): AsyncIterable<ToolEvent> {
    const mutator = ctx.planMutator
    if (mutator === undefined) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "create_plan unavailable: no structured plan store is wired in this session.",
          failure: { mode: "error", modelVisibleError: "structured plan store is not wired" },
        },
      }
      return
    }
    let result: ReturnType<typeof mutator.create>
    try {
      result = mutator.create(input)
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `create_plan failed: ${errMessage(e)}`,
          failure: { mode: "error", modelVisibleError: "internal mutator error" },
        },
      }
      return
    }
    if (!result.ok) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `create_plan rejected (${result.code}): ${planErrorMessage(result.code)}`,
          failure: planFailure(result.code),
        },
      }
      return
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: `Plan created (v${result.version}, ${result.touchedIds.length} todos).`,
      },
    }
  },
})
