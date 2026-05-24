/** `subagent_await` — ADR-0130. Block until a background subagent completes,
 *  with optional timeout. On timeout, returns ok:true with status="running"
 *  so the caller can decide whether to poll again later or stop waiting.
 *
 *  Output contract: NEVER throws past the loop. Unknown handle id is mapped
 *  to an `ok:false` ToolResult. Read-only + concurrency-safe (multiple awaits
 *  on the same id may race; scheduler resolves each with the same shared
 *  in-flight promise — no double work).
 *
 *  Cancellation: the tool's `ctx.signal` is forwarded into the scheduler's
 *  await signal. When `ctx.signal` aborts, the await unblocks but the
 *  underlying subagent is NOT cancelled. */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { BackgroundSubagentSchedulerPort, SubagentBgResult } from "./port"

export const subagentAwaitInputSchema = z.object({
  id: z.string().min(1).describe("The subagent handle id returned by subagent_fork."),
  timeoutMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Optional timeout in ms. When elapsed before the subagent completes, returns ok:true " +
        "with status='running' so the caller can decide whether to poll again later. " +
        "Absent ⇒ wait until completion (or external cancel).",
    ),
})
export type SubagentAwaitInput = z.infer<typeof subagentAwaitInputSchema>

/** Build a composite abort signal driving the scheduler's await. Returns the
 *  `signal` and a `dispose()` that cleans up listeners + timer. Separated
 *  from `execute` to keep the generator's cognitive complexity within cap. */
const buildAwaitSignal = (
  ctxSignal: AbortSignal,
  timeoutMs: number | undefined,
): { signal: AbortSignal; dispose: () => void } => {
  const ctrl = new AbortController()
  const cleanup: Array<() => void> = []
  if (ctxSignal.aborted) {
    ctrl.abort()
  } else {
    const onCtx = (): void => ctrl.abort()
    ctxSignal.addEventListener("abort", onCtx, { once: true })
    cleanup.push(() => ctxSignal.removeEventListener("abort", onCtx))
  }
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    cleanup.push(() => clearTimeout(t))
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      for (const fn of cleanup) fn()
    },
  }
}

const formatResult = (id: string, r: SubagentBgResult): string => {
  const lines = [`subagent ${id}: status=${r.status} turns=${r.turns}`, `startedAt=${r.startedAt}`]
  if (r.endedAt !== undefined) lines.push(`endedAt=${r.endedAt}`)
  lines.push(`summary: ${r.outputSummary}`)
  if (r.outputDetail !== undefined && r.outputDetail.length > 0 && r.status !== "running") {
    // For terminal status, include the full detail (model wants the answer).
    lines.push("---", r.outputDetail)
  }
  if (r.status === "failed" && r.errorMessage !== undefined) {
    lines.push(`error: ${r.errorMessage}`)
  }
  return lines.join("\n")
}

export const subagentAwaitTool = (
  scheduler: BackgroundSubagentSchedulerPort,
): Tool<SubagentAwaitInput> => ({
  name: "subagent_await",
  description:
    "Block until a background subagent (subagent_fork handle) completes. Optional " +
    "timeoutMs returns ok:true with status='running' if the deadline passes — the " +
    "caller can then poll again later. The full transcript/answer is included " +
    "on terminal status.",
  inputSchema: subagentAwaitInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = subagentAwaitInputSchema.safeParse(input)
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
    const id = parsed.data.id
    // Fast-path: poll first so we don't allocate a controller when already
    // terminal (common case for callers that race poll/await).
    const snap0 = scheduler.poll(id)
    if (snap0 === null) {
      yield {
        type: "result",
        result: { ok: false, output: `unknown-handle: no subagent with id=${id}` },
      }
      return
    }
    if (snap0.status !== "running") {
      yield { type: "result", result: { ok: true, output: formatResult(id, snap0) } }
      return
    }
    // Build a composite abort signal: ctx.signal OR timeout. Forward ONLY to
    // the scheduler's await — the subagent itself is NOT cancelled.
    const { signal, dispose } = buildAwaitSignal(ctx.signal, parsed.data.timeoutMs)
    let final: SubagentBgResult | null
    try {
      final = await scheduler.await(id, { signal })
    } finally {
      dispose()
    }
    if (final === null) {
      // Handle was pruned between poll and await — surface as unknown.
      yield {
        type: "result",
        result: { ok: false, output: `unknown-handle: no subagent with id=${id}` },
      }
      return
    }
    // Whether terminal or still running (timeout case), surface as ok:true —
    // caller branches on `status` to decide next step.
    yield {
      type: "result",
      result: { ok: true, output: formatResult(id, final) },
    }
  },
})
