/**
 * `create_plan` tool (ADR-0095 draft).
 *
 * Creates a new structured plan with todos + optional phases. Routes through
 * the duck-typed {@link ToolContext.planMutator} seam. Registered only when
 * `ctx.planMutator` is wired (default-OFF byte-identical otherwise).
 */
import type { Tool, ToolContext, ToolEvent } from "../types"
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
  async *execute(input: CreatePlanInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const mutator = ctx.planMutator
    if (mutator === undefined) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "create_plan unavailable: plan-mode is not active in this session.",
          failure: { mode: "error", modelVisibleError: "plan-mode is not active" },
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
          output: `create_plan failed: ${(e as Error).message ?? String(e)}`,
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
