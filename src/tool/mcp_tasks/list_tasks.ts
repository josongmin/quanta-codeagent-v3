/** ADR-0196 — `list_mcp_tasks` model tool. Read-only enumerator over the
 *  `McpTasksPort` (duck-typed `TasksHandle`). Surfaces typed `cursor-stale`
 *  failure as `ok:false` (the model retries with no cursor). */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { TasksHandle, TasksTaskInfo } from "./port"

export const listTasksInputSchema = z.object({
  cursor: z.string().optional().describe("Opaque resume cursor from a prior call"),
})
export type ListTasksInput = z.infer<typeof listTasksInputSchema>

const MAX_OUTPUT = 50_000

const renderInfo = (t: TasksTaskInfo): string => {
  const titlePart = t.title !== undefined ? `  ${t.title}` : ""
  const progressPart = t.progress !== undefined ? `  ${Math.round(t.progress * 100)}%` : ""
  return `  - ${t.taskId}  [${t.state}]${titlePart}${progressPart}`
}

const truncate = (s: string): string =>
  s.length <= MAX_OUTPUT ? s : `${s.slice(0, MAX_OUTPUT)}\n… (truncated)`

export const listMcpTasksTool = (port: TasksHandle): Tool<ListTasksInput> => ({
  name: "list_mcp_tasks",
  description:
    "List long-running MCP tasks (cursor-paginated). " +
    "Use to discover tasks before polling get_mcp_task or cancelling.",
  inputSchema: listTasksInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = listTasksInputSchema.safeParse(input)
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
    const outcome = await port.list(parsed.data.cursor)
    if (!outcome.ok) {
      yield {
        type: "result",
        result: {
          ok: false,
          output: `cursor-stale: server reset the listing window. retry without a cursor.`,
          failure: { mode: "error", modelVisibleError: "cursor-stale" },
        },
      }
      return
    }
    const { tasks, nextCursor } = outcome.page
    if (tasks.length === 0) {
      yield { type: "result", result: { ok: true, output: "(no MCP tasks)" } }
      return
    }
    const header = `${tasks.length} task${tasks.length === 1 ? "" : "s"}:`
    const lines = tasks.map(renderInfo)
    const footer = nextCursor !== undefined ? `\nnextCursor: ${nextCursor}` : ""
    yield {
      type: "result",
      result: { ok: true, output: truncate([header, ...lines].join("\n") + footer) },
    }
  },
})
