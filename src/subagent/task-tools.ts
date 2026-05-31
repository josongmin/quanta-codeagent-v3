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

/** Default block timeout for `task_output(block:true)`. 30s balances "give
 *  a quick-running task time to settle" against "don't keep a tool call
 *  blocked indefinitely". Callers can override via `timeout_ms`. */
const DEFAULT_TASK_OUTPUT_BLOCK_MS = 30_000

/**
 * B2 — closed-port bound on the caller-supplied `timeout_ms`. Previously
 * `task_output(block:true)` applied any positive int verbatim (the schema only
 * rejected non-numbers), so a hostile / hallucinated `timeout_ms: 1e12` kept a
 * tool call blocked for ~31 years. This policy clamps the requested value into
 * `[minMs, maxMs]` (CLAMP, not reject — robustness over rigidity) and supplies
 * `defaultMs` when omitted. Mirrors `wait_agent`'s `WaitTimeoutPolicy`
 * (handlers-6.ts); kept as a SEPARATE type here so this contract slice stays
 * zod-only (handlers-6 pulls in `bun` Subprocess types). The host wires the
 * SAME bounds into both families.
 */
export interface TaskOutputTimeoutPolicy {
  /** Floor for the effective block timeout. */
  readonly minMs: number
  /** Ceiling for the effective block timeout. */
  readonly maxMs: number
  /** Effective timeout when the caller omits `timeout_ms`. */
  readonly defaultMs: number
}

/** Default policy — byte-identical to the pre-B2 behavior: omitted ⇒ 30s; a
 *  generous 1h ceiling so no existing override is clamped; 1ms floor. */
export const DEFAULT_TASK_OUTPUT_TIMEOUT_POLICY: TaskOutputTimeoutPolicy = {
  minMs: 1,
  maxMs: 3_600_000,
  defaultMs: DEFAULT_TASK_OUTPUT_BLOCK_MS,
}

/** Pure, total clamp of `requested` into `[minMs, maxMs]`; omitted ⇒
 *  `defaultMs`. A degenerate `minMs > maxMs` collapses to the ceiling
 *  (`maxMs` wins — never returns above the hard ceiling). With the default
 *  policy this is the identity on any pre-B2 caller (or 30s when omitted). */
export const clampTaskOutputTimeout = (
  policy: TaskOutputTimeoutPolicy,
  requested: number | undefined,
): number => Math.min(Math.max(requested ?? policy.defaultMs, policy.minMs), policy.maxMs)

const stopSchema = z.object({
  task_id: z.string().describe("Id of the background task to cancel"),
  owner_token: z
    .string()
    .describe(
      "Capability token returned by `task_run`. Without the matching token the registry refuses the stop — a sibling agent that only knows the task_id cannot cancel another task.",
    ),
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

/** `task_output` — poll (or block on) a background subagent task by id.
 *  B2: an optional {@link TaskOutputTimeoutPolicy} clamps the caller's
 *  `timeout_ms`. Omitted ⇒ {@link DEFAULT_TASK_OUTPUT_TIMEOUT_POLICY}, which is
 *  byte-identical to the pre-B2 behavior (omitted timeout ⇒ 30s). */
export const createTaskOutputTool = (
  registry: TaskRegistry,
  timeoutPolicy: TaskOutputTimeoutPolicy = DEFAULT_TASK_OUTPUT_TIMEOUT_POLICY,
): Tool<OutputInput> => ({
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
      rec = await waitForSettle(
        registry,
        input.task_id,
        ctx,
        // B2 — clamp the caller-supplied timeout into the injected band.
        clampTaskOutputTimeout(timeoutPolicy, input.timeout_ms),
      )
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
    // S17: token-gated stop. Three terminal outcomes, structurally distinct
    // (not just a single boolean) so the LLM sees what actually happened:
    //   - stopped   ⇒ ok:true   — the task was running AND the token matched.
    //   - denied    ⇒ ok:false  — task exists but the token is wrong/missing.
    //   - not-found ⇒ ok:false  — id unknown or already settled.
    const result = registry.stop(input.task_id, input.owner_token)
    yield {
      type: "result",
      result:
        result === "stopped"
          ? { ok: true, output: `Stopped task ${input.task_id}.` }
          : result === "denied"
            ? {
                ok: false,
                output: `Cannot stop ${input.task_id}: owner_token does not match. Pass the token returned by task_run.`,
              }
            : {
                ok: false,
                output: `Cannot stop ${input.task_id}: unknown or already settled.`,
              },
    }
  },
})
