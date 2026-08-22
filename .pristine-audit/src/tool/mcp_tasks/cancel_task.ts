/** ADR-0196 — `cancel_mcp_task` model tool. Destructive: aborts an in-flight
 *  MCP task. Idempotent on terminal `cancelled` — the rmcp protocol returns
 *  `{ok:true}` so we surface the same. */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { backendErrorEvent, callPort } from "./no-throw"
import type { TasksHandle } from "./port"

export const cancelTaskInputSchema = z.object({
  taskId: z.string().min(1, "taskId is required"),
})
export type CancelTaskInput = z.infer<typeof cancelTaskInputSchema>

export const cancelMcpTaskTool = (port: TasksHandle): Tool<CancelTaskInput> => ({
  name: "cancel_mcp_task",
  description:
    "Cancel an in-flight MCP task. Idempotent on already-cancelled tasks; " +
    "returns `not-cancellable` when the task already finished.",
  inputSchema: cancelTaskInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "always-confirm",
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = cancelTaskInputSchema.safeParse(input)
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
    const taskId = parsed.data.taskId
    const cancelCall = await callPort(() => port.cancel(taskId))
    if (!cancelCall.ok) {
      yield backendErrorEvent(cancelCall.message)
      return
    }
    const outcome = cancelCall.value
    if (outcome.ok) {
      yield { type: "result", result: { ok: true, output: `cancelled: ${taskId}` } }
      return
    }
    yield {
      type: "result",
      result: {
        ok: false,
        output: `${outcome.reason}: ${taskId}`,
        failure:
          outcome.reason === "not-found"
            ? { mode: "not_found" }
            : { mode: "rejected", reason: outcome.reason },
      },
    }
  },
})
