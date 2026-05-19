import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import type { TaskRecord, TaskRegistry } from "./registry"

const POLL_INTERVAL_MS = 100

const outputSchema = z.object({
  task_id: z.string().describe("Id returned by a background agent launch"),
  block: z
    .boolean()
    .optional()
    .describe("Wait until the task settles (or timeout) instead of a snapshot"),
  timeout_ms: z.number().optional().describe("Max ms to block when block:true (default 30000)"),
})

type OutputInput = z.infer<typeof outputSchema>

const stopSchema = z.object({
  task_id: z.string().describe("Id of the background task to cancel"),
})

type StopInput = z.infer<typeof stopSchema>

const render = (t: TaskRecord): string => {
  const lines = [
    `task_id: ${t.id}`,
    `status: ${t.status}`,
    t.agentType ? `agent_type: ${t.agentType}` : undefined,
    `description: ${t.description}`,
  ].filter(Boolean)
  if (t.status === "completed" && t.result) {
    lines.push("", `result (${t.result.turns} turns):`, t.result.finalText)
  } else if (t.status === "failed") {
    lines.push("", `error: ${t.error ?? t.result?.finalText ?? "unknown"}`)
  } else if (t.status === "stopped") {
    lines.push("", "(task was stopped before completion)")
  }
  return lines.join("\n")
}

const settled = (t: TaskRecord) => t.status !== "running"

const notFound = (taskId: string): ToolEvent => ({
  type: "result",
  result: { ok: false, output: `No task found with id: ${taskId}` },
})

/** Poll the registry until the task settles, the deadline passes, or the
 *  context is aborted. Returns the latest record (or undefined if removed). */
const waitForSettle = async (
  registry: TaskRegistry,
  taskId: string,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<TaskRecord | undefined> => {
  const deadline = Date.now() + timeoutMs
  let rec = registry.get(taskId)
  while (Date.now() < deadline) {
    if (ctx.signal.aborted) break
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    rec = registry.get(taskId)
    if (!rec || settled(rec)) break
  }
  return rec
}

/** `task_output` — poll (or block on) a background subagent task by id. */
export const createTaskOutputTool = (registry: TaskRegistry): Tool<OutputInput> => ({
  name: "task_output",
  description:
    "Read the status/result of a background subagent task. Set block:true to " +
    "wait until it settles (bounded by timeout_ms).",
  inputSchema: outputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async *execute(input: OutputInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    let rec = registry.get(input.task_id)
    if (!rec) {
      yield notFound(input.task_id)
      return
    }

    if (input.block === true && !settled(rec)) {
      yield { type: "progress", message: `Waiting for ${input.task_id}…` }
      rec = await waitForSettle(registry, input.task_id, ctx, input.timeout_ms ?? 30_000)
      if (rec && !settled(rec)) {
        yield {
          type: "result",
          result: { ok: true, output: `timeout — task ${input.task_id} still running` },
        }
        return
      }
    }

    rec = registry.get(input.task_id)
    if (!rec) {
      yield notFound(input.task_id)
      return
    }
    yield {
      type: "result",
      result: { ok: rec.status !== "failed", output: render(rec) },
    }
  },
})

/** `task_stop` — cancel a running background subagent task by id. */
export const createTaskStopTool = (registry: TaskRegistry): Tool<StopInput> => ({
  name: "task_stop",
  description: "Cancel a running background subagent task by its task_id.",
  inputSchema: stopSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,

  // eslint-disable-next-line require-yield
  async *execute(input: StopInput): AsyncIterable<ToolEvent> {
    const ok = registry.stop(input.task_id)
    yield {
      type: "result",
      result: ok
        ? { ok: true, output: `Stopped task ${input.task_id}.` }
        : {
            ok: false,
            output: `Cannot stop ${input.task_id}: unknown or already settled.`,
          },
    }
  },
})
