import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import type { TaskRecord, TaskRegistry } from "./registry"

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

/** Race the registry's event-driven settle Promise against a timeout and the
 *  tool context's abort signal. We race instead of polling so the wait resolves
 *  the instant the task transitions to a terminal status (registry resolves
 *  the settler in `complete`/`fail`/`stop`) — no 100ms granularity, no wakeups.
 *  Both timer and abort listener are cleaned up unconditionally so a settled-
 *  early path leaves no dangling resources. */
const waitForSettle = async (
  registry: TaskRegistry,
  taskId: string,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<TaskRecord | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  const aborted = new Promise<void>((resolve) => {
    if (ctx.signal.aborted) {
      resolve()
      return
    }
    onAbort = () => resolve()
    ctx.signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    await Promise.race([registry.waitForSettle(taskId), timeout, aborted])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) ctx.signal.removeEventListener("abort", onAbort)
  }
  return registry.get(taskId)
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
