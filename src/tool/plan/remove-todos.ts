/**
 * `remove_todos` tool (ADR-0095 draft). Atomic batch — if removing any id
 * leaves a dangling dependency, the WHOLE batch is rejected with
 * `dependency_unknown` (no partial removal).
 */
import { errMessage } from "@/shared"
import type { PlanToolContext, Tool, ToolEvent } from "../types"
import { planErrorMessage, planFailure } from "./error-mapping"
import { type RemoveTodosInput, removeTodosSchema } from "./schemas"

export const removeTodosTool = (): Tool<RemoveTodosInput> => ({
  name: "remove_todos",
  description:
    "Remove one or more todos atomically. Rejects with dependency_unknown if any " +
    "remaining todo still depends on a removed id. Pass expected_version from the last result.",
  inputSchema: removeTodosSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  async *execute(input: RemoveTodosInput, ctx: PlanToolContext): AsyncIterable<ToolEvent> {
    const mutator = ctx.planMutator
    if (mutator === undefined) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "remove_todos unavailable: no structured plan store is wired in this session.",
          failure: { mode: "error", modelVisibleError: "structured plan store is not wired" },
        },
      }
      return
    }
    let result: ReturnType<typeof mutator.removeTodos>
    try {
      result = mutator.removeTodos(input.ids, input.expected_version)
    } catch (e) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `remove_todos failed: ${errMessage(e)}`,
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
          output: `remove_todos rejected (${result.code}): ${planErrorMessage(result.code)}`,
          failure: planFailure(result.code),
        },
      }
      return
    }
    yield {
      type: "result",
      result: {
        ok: true,
        output: `Removed ${result.touchedIds.length} todo(s) at v${result.version}.`,
      },
    }
  },
})
