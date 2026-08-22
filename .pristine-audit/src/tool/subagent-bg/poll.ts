/** `subagent_poll` — ADR-0130. Non-blocking read of a background subagent's
 *  current status.
 *
 *  Output contract: NEVER throws past the loop. Unknown handle id is mapped
 *  to an `ok:false` ToolResult with `unknown-handle: …`. Read-only +
 *  concurrency-safe (multiple polls of the same id can run in parallel). */

import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"
import type { BackgroundSubagentSchedulerPort, SubagentBgResult } from "./port"

export const subagentPollInputSchema = z.object({
  id: z.string().min(1).describe("The subagent handle id returned by subagent_fork."),
})
export type SubagentPollInput = z.infer<typeof subagentPollInputSchema>

/** Format a {@link SubagentBgResult} as a deterministic multi-line summary
 *  for the model. Endpoints (start/end times) are EPOCH ms so the model can
 *  arithmetically compute durations without ISO parsing. */
const formatResult = (id: string, r: SubagentBgResult): string => {
  const lines = [`subagent ${id}: status=${r.status} turns=${r.turns}`, `startedAt=${r.startedAt}`]
  if (r.endedAt !== undefined) lines.push(`endedAt=${r.endedAt}`)
  lines.push(`summary: ${r.outputSummary}`)
  if (r.status === "failed" && r.errorMessage !== undefined) {
    lines.push(`error: ${r.errorMessage}`)
  }
  return lines.join("\n")
}

export const subagentPollTool = (
  scheduler: BackgroundSubagentSchedulerPort,
): Tool<SubagentPollInput> => ({
  name: "subagent_poll",
  description:
    "Look up the current status of a background subagent (subagent_fork handle) " +
    "WITHOUT blocking. Returns status (running|completed|failed|cancelled), turn " +
    "count, and a short summary. Use to check progress without committing to wait.",
  inputSchema: subagentPollInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = subagentPollInputSchema.safeParse(input)
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
    const result = scheduler.poll(parsed.data.id)
    if (result === null) {
      yield {
        type: "result",
        result: { ok: false, output: `unknown-handle: no subagent with id=${parsed.data.id}` },
      }
      return
    }
    yield {
      type: "result",
      result: { ok: true, output: formatResult(parsed.data.id, result) },
    }
  },
})
