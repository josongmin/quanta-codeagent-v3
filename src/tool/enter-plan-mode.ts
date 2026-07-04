import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "./types"

/**
 * `enter_plan_mode` tool — the model-driven ENTRY into plan mode, the inverse
 * of `request_plan_exit` (which mirrors Claude Code's `ExitPlanMode`). Where the
 * exit tool needs an operator decision (it is about to UNLOCK mutation), entry
 * needs none: switching into plan mode only RESTRICTS the agent to read-only, so
 * it is the fail-safe direction. The model calls this when it decides a task is
 * non-trivial and wants to investigate + plan before acting.
 *
 * The tool itself does not mutate loop state directly (same discipline as
 * `request_plan_exit`): it relays the reason to `ToolContext.enterPlanMode`
 * (built from `AgentConfig.planExitPort`, so entry is only offered when a clean
 * exit is also wired). The agent loop consumes the request at the NEXT turn
 * boundary and flips collaboration mode to `plan` (see `applyPendingPlanEntry`).
 * A second call while already in plan mode is a no-op.
 *
 * Registered ONLY when `AgentConfig.planExitPort` is wired (see
 * `buildEnterPlanBlock`). Absent ⇒ the tool is not in the registry and the loop
 * is byte-identical. Read-only + concurrency-SAFE (it blocks on nobody).
 */
const schema = z.object({
  reason: z
    .string()
    .min(1)
    .describe("Why you are switching into plan mode (one line; surfaced to the operator)."),
})
type Input = z.infer<typeof schema>

export const enterPlanModeTool = (): Tool<Input> => ({
  name: "enter_plan_mode",
  description:
    "Switch yourself into plan mode: mutating tools (write/edit/bash/git/spawn) become blocked at " +
    "the dispatch seam starting next turn, so you investigate read-only and assemble a plan. Call " +
    "this when a task is non-trivial (multi-file, ambiguous, or architectural) and you want to plan " +
    "before acting. No operator approval is needed to ENTER (it only restricts you); when the plan " +
    "is ready, call request_plan_exit to leave plan mode and act. No-op if already in plan mode.",
  inputSchema: schema,
  isReadOnly: () => true,
  // Blocks on nobody — it only flips a mode flag for the next turn. Safe to
  // overlap with other read-only work (unlike request_plan_exit).
  isConcurrencySafe: () => true,
  async *execute(input: Input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const enter = ctx.enterPlanMode
    if (enter === undefined) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: "enter_plan_mode is unavailable: no plan lifecycle is wired in this session.",
        },
      }
      return
    }
    enter(input.reason)
    yield {
      type: "result",
      result: {
        ok: true,
        output:
          "Plan mode will be ACTIVE from the next turn. Mutating tools are now fenced off — " +
          "investigate read-only, then call request_plan_exit when the plan is ready.",
      },
    }
  },
})
