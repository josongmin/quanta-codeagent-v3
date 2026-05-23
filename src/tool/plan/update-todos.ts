/**
 * `update_todos` tool (ADR-0095 draft).
 *
 * Patches one or more todos (status / content / deps / phase / assignee /
 * verifyHint) via the {@link ToolContext.planMutator} seam. `merge:true`
 * preserves unspecified fields; `merge:false` clears optional ones (null
 * sentinel always clears regardless).
 */
import type { Tool, ToolContext, ToolEvent } from "../types"
import { planErrorMessage, planFailure } from "./error-mapping"
import { type UpdateTodosInput, updateTodosSchema } from "./schemas"

export const updateTodosTool = (): Tool<UpdateTodosInput> => ({
  name: "update_todos",
  description:
    "Patch one or more todos (status, content, deps, phase, assignee, verifyHint). " +
    "Pass expected_version from the last current()/result. merge:true preserves " +
    "unspecified fields; merge:false clears optional ones.",
  inputSchema: updateTodosSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  async *execute(input: UpdateTodosInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const mutator = ctx.planMutator
    if (mutator === undefined) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "update_todos unavailable: plan-mode is not active.",
          failure: { mode: "error", modelVisibleError: "plan-mode is not active" },
        },
      }
      return
    }
    let result: ReturnType<typeof mutator.updateTodos>
    try {
      result = mutator.updateTodos(input.patches, input.merge, input.expected_version)
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `update_todos failed: ${(e as Error).message ?? String(e)}`,
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
          output: `update_todos rejected (${result.code}): ${planErrorMessage(result.code)}`,
          failure: planFailure(result.code),
        },
      }
      return
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: `Patched ${result.touchedIds.length} todo(s) at v${result.version}.`,
      },
    }
  },
})
