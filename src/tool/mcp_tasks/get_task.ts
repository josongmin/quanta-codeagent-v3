/** ADR-0196 — `get_mcp_task` model tool. Read-only: fetches task info +
 *  current result (if terminal) for a given id. `not-ready` is a typed
 *  status, not a failure — the model should poll later. */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import { backendErrorEvent, callPort } from "./no-throw"
import type { TasksHandle, TasksTaskResult } from "./port"

export const getTaskInputSchema = z.object({
  taskId: z.string().min(1, "taskId is required"),
})
export type GetTaskInput = z.infer<typeof getTaskInputSchema>

/** Render a terminal (non-`not-ready`) task result into model-facing text. */
const renderTerminal = (r: Exclude<TasksTaskResult, { state: "not-ready" }>): string => {
  switch (r.state) {
    case "completed":
      return `completed: ${r.output}`
    case "failed":
      return `failed: ${r.error}`
    default:
      return "cancelled"
  }
}

export const getMcpTaskTool = (port: TasksHandle): Tool<GetTaskInput> => ({
  name: "get_mcp_task",
  description:
    "Fetch the current state + result for one MCP task. " +
    "Returns `not-ready` when the task is still running.",
  inputSchema: getTaskInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = getTaskInputSchema.safeParse(input)
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
    const infoCall = await callPort(() => port.getInfo(taskId))
    if (!infoCall.ok) {
      yield backendErrorEvent(infoCall.message)
      return
    }
    const info = infoCall.value
    if (info === null) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `not-found: ${taskId}`,
          failure: { mode: "not_found" },
        },
      }
      return
    }
    const resultCall = await callPort(() => port.getResult(taskId))
    if (!resultCall.ok) {
      yield backendErrorEvent(resultCall.message)
      return
    }
    const result = resultCall.value
    if (result.state === "not-ready") {
      yield {
        type: "result",
        result: { ok: true, output: `not-ready: ${taskId} [${info.state}]` },
      }
      return
    }
    const payload = renderTerminal(result)
    yield { type: "result", result: { ok: true, output: `${taskId} [${info.state}]\n${payload}` } }
  },
})
