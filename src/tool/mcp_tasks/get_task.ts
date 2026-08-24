/** ADR-0196 — `get_mcp_task` model tool. Read-only: fetches task info +
 *  current result (if terminal) for a given id. `not-ready` is a typed
 *  status, not a failure — the model should poll later. */

import { z } from "zod"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import { backendErrorEvent, callPort } from "./no-throw"
import type { TasksHandle, TasksTaskInfo, TasksTaskResult } from "./port"

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

/** TICKET-21 — render the optional ttl/poll/related metadata as a trailing
 *  suffix. Each piece appears ONLY when the server advertised it; with NONE of
 *  the three the suffix is the empty string → the render is byte-identical to
 *  the legacy output (the existing line-exact tests stay green).
 *
 *  `ttlMs` is the server's advertised remaining budget (a one-shot getInfo has
 *  no elapsed clock to subtract), surfaced human-relative as "~Nms left".
 *  `relatedTaskIds` is an actionable affordance: the sibling ids the model can
 *  poll / cancel together. */
const renderMeta = (info: TasksTaskInfo): string => {
  const parts: string[] = []
  if (info.ttlMs !== undefined) parts.push(`ttl: ~${info.ttlMs}ms left`)
  if (info.pollIntervalMs !== undefined) parts.push(`poll: ~${info.pollIntervalMs}ms`)
  if (info.relatedTaskIds !== undefined && info.relatedTaskIds.length > 0) {
    parts.push(`related: ${info.relatedTaskIds.join(", ")} — poll/cancel together`)
  }
  return parts.length > 0 ? `\n${parts.join("  ·  ")}` : ""
}

export const getMcpTaskTool = (port: TasksHandle): Tool<GetTaskInput> => ({
  name: "get_mcp_task",
  description:
    "Fetch the current state + result for one MCP task. " +
    "Returns `not-ready` when the task is still running.",
  inputSchema: getTaskInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
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
    const meta = renderMeta(info)
    if (result.state === "not-ready") {
      yield {
        type: "result",
        result: { ok: true, output: `not-ready: ${taskId} [${info.state}]${meta}` },
      }
      return
    }
    const payload = renderTerminal(result)
    yield {
      type: "result",
      result: { ok: true, output: `${taskId} [${info.state}]\n${payload}${meta}` },
    }
  },
})
