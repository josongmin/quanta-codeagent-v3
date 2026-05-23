/**
 * `@/tool/plan` barrel + factory (ADR-0095 draft). Builds the 4-tool array
 * the dispatch seam registers when `ctx.planMutator` is wired.
 */

import type { Tool } from "../types"
import { createPlanTool } from "./create-plan"
import { removeTodosTool } from "./remove-todos"
import { updatePlanTool } from "./update-plan"
import { updateTodosTool } from "./update-todos"

export { createPlanTool } from "./create-plan"
export { planErrorMessage, planFailure } from "./error-mapping"
export { removeTodosTool } from "./remove-todos"
export {
  type CreatePlanInput,
  createPlanSchema,
  type RemoveTodosInput,
  removeTodosSchema,
  type UpdatePlanInput,
  type UpdateTodosInput,
  updatePlanSchema,
  updateTodosSchema,
} from "./schemas"
export { updatePlanTool } from "./update-plan"
export { updateTodosTool } from "./update-todos"

/** Returns the 4 plan-mode tools. Compose by AgentConfig.planStore wiring
 *  at the dispatch seam — when planMutator is in ToolContext, all 4 register. */
// biome-ignore lint/suspicious/noExplicitAny: closed-list factory; downstream registry typing is invariant.
export const buildPlanTools = (): readonly Tool<any>[] => [
  createPlanTool(),
  updateTodosTool(),
  updatePlanTool(),
  removeTodosTool(),
]
