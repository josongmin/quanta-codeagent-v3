/** `subagent_fork` — ADR-0130. Forks a subagent into the background and
 *  returns the handle id immediately. The actual run proceeds detached;
 *  caller harvests via `subagent_poll` / `subagent_await`.
 *
 *  Output contract: NEVER throws past the loop. Cap-exceeded is mapped to
 *  an `ok:false` ToolResult whose `output` begins with the typed code
 *  (`cap-exceeded: …`). Other (unexpected) throws bubble — those are
 *  programmer bugs.
 *
 *  HITL tier: `pre-approval-ok` — detached work is bounded by the scheduler's
 *  `maxConcurrent` cap. The current 3-tool surface exposes follow-up reads
 *  (`subagent_poll` / `subagent_await`) but NOT a cancel tool. */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import type { BackgroundSubagentSchedulerPort, SubagentBgSpec } from "./port"
export const subagentForkInputSchema = z.object({
  task: z.string().min(1).describe("The prompt handed to the background subagent."),
  modelOverride: z.string().optional().describe("Optional model id swap for this run."),
  maxTurns: z.number().int().positive().optional().describe("Optional turn ceiling for the child."),
  metadata: z
    .record(z.string(), z.string())
    .optional()
    .refine((metadata) => metadata?.idempotent === undefined, {
      message: "metadata.idempotent is reserved; caller metadata cannot authorize restart replay",
      path: ["idempotent"],
    })
    .describe(
      "Free-form caller metadata pairs (e.g. {origin:'ci'}); replay-authorization keys are reserved.",
    ),
})
export type SubagentForkInput = z.infer<typeof subagentForkInputSchema>

/** Build the {@link SubagentBgSpec} from validated input, OMITTING absent
 *  optional fields (exactOptionalPropertyTypes — never `undefined`-set). */
const inputToSpec = (input: SubagentForkInput): SubagentBgSpec => {
  const base: { task: string } = { task: input.task }
  return {
    ...base,
    ...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  }
}

export const subagentForkTool = (
  scheduler: BackgroundSubagentSchedulerPort,
): Tool<SubagentForkInput> => ({
  name: "subagent_fork",
  description:
    "Fork a subagent into the background and return its handle id immediately. " +
    "The run proceeds asynchronously; harvest the result later with subagent_poll " +
    "or subagent_await(handle). Use for long-running tasks (e.g. 'check CI for 30min') " +
    "while the parent agent continues other work.",
  inputSchema: subagentForkInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(input, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = subagentForkInputSchema.safeParse(input)
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
    const spec = inputToSpec(parsed.data)
    let id: string
    try {
      id = scheduler.fork(spec)
    } catch (e) {
      const msg = errMessage(e)
      // Producer-side `SubagentBackgroundError("cap-exceeded")` carries a
      // message that already begins with `cap-exceeded:` — surface it
      // verbatim so callers see the typed code.
      yield { type: "result", result: { ok: false, output: msg } }
      return
    }
    yield {
      type: "result",
      result: { ok: true, output: `forked id=${id}` },
    }
  },
})
