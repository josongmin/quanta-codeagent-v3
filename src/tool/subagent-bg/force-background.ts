/** `subagent_force_background` — ADR-0487. Promote a QUEUED background
 *  subagent to run NOW (or to the FIFO head). This is the model-facing half of
 *  the `force_background` control-op: it only REORDERS the agent's own pool —
 *  it grants NO new exec capability and cannot exceed the scheduler's
 *  `maxConcurrent` cap except by AT MOST 1 under an explicit `allowBurst`
 *  (a one-slot courtesy, never a bypass — `risk: "meta"`).
 *
 *  Only meaningful when the host opted into the admission queue
 *  (`subagent.bgQueue` / `QUANTA_SUBAGENT_QUEUE`). With the queue off, no
 *  handle can be `queued`, so this tool always reports `queue_disabled`.
 *
 *  Output contract: NEVER throws past the loop — every outcome (including
 *  unknown id) maps to a deterministic ToolResult line. `promoted_now` /
 *  `moved_to_front` are `ok:true`; the no-op outcomes (`already_running`,
 *  `not_found`, `queue_disabled`) are `ok:false` so the model sees nothing
 *  changed.
 *
 *  Plane-clean: imports only `../types` + `zod` + `./port`. NO `@/agent`. */

import { z } from "zod"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import type { BackgroundSubagentSchedulerPort, SubagentBgForceOutcome } from "./port"

export const subagentForceBackgroundInputSchema = z.object({
  id: z.string().min(1).describe("The queued subagent handle id returned by subagent_fork."),
  allowBurst: z
    .boolean()
    .optional()
    .describe(
      "When no slot is free, transiently exceed maxConcurrent by AT MOST 1 to start " +
        "this task now. A second burst while already over-cap degrades to moved_to_front.",
    ),
})
export type SubagentForceBackgroundInput = z.infer<typeof subagentForceBackgroundInputSchema>

/** Map a closed {@link SubagentBgForceOutcome} to a stable ToolResult. The two
 *  promotion outcomes are successes; the three no-op outcomes are `ok:false`
 *  so the model can branch deterministically without prose parsing. */
const outcomeToResult = (
  id: string,
  outcome: SubagentBgForceOutcome,
): { ok: boolean; output: string } => {
  switch (outcome) {
    case "promoted_now":
      return { ok: true, output: `promoted_now: ${id} started immediately` }
    case "moved_to_front":
      return { ok: true, output: `moved_to_front: ${id} runs the instant a slot frees` }
    case "already_running":
      return { ok: false, output: `already_running: ${id} is running or terminal (no-op)` }
    case "not_found":
      return { ok: false, output: `not_found: no subagent with id=${id}` }
    case "queue_disabled":
      return {
        ok: false,
        output: "queue_disabled: admission queue is off (nothing can be queued)",
      }
  }
}

export const subagentForceBackgroundTool = (
  scheduler: BackgroundSubagentSchedulerPort,
): Tool<SubagentForceBackgroundInput> => ({
  name: "subagent_force_background",
  description:
    "Promote a QUEUED background subagent (subagent_fork handle) to run NOW, or to " +
    "the front of the FIFO wait-queue. Only meaningful when the admission queue is on; " +
    "default-OFF. Pass allowBurst to transiently exceed the concurrency cap by at most 1. " +
    "Reorders the agent's own pool only — grants no new capability.",
  inputSchema: subagentForceBackgroundInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = subagentForceBackgroundInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (ctx.signal.aborted) {
      yield { type: "result", result: { ok: false, output: "aborted before start" } }
      return
    }
    const { id, allowBurst } = parsed.data
    // exactOptionalPropertyTypes — OMIT `allowBurst` when absent, never undefined-set.
    const outcome = scheduler.forceBackground(
      id,
      allowBurst !== undefined ? { allowBurst } : undefined,
    )
    yield { type: "result", result: outcomeToResult(id, outcome) }
  },
})
