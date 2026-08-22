/**
 * `report_agent_job_result` — batch-worker result-reporting tool (GAP7-2, ADR-0510).
 *
 * A batch job (`spawn_agents_on_csv`) dispatches ONE subagent per CSV row. Instead
 * of the parent PARSING the child's free-text final message (brittle), the child
 * calls `report_agent_job_result` with its STRUCTURED result; the dispatch adapter
 * mints a per-row {@link JobResultReporter}, injects this tool into the child via
 * the `SubagentRequest.extraTools` seam, and prefers the reported value over the
 * final-text parse.
 *
 * Plane-clean: `../types` + `zod` only — the reporter is an injected port, so this
 * leaf never imports `@/agent`. CAPTURE-ONCE: the first report wins; a second call
 * is rejected (a row produces exactly one structured result). NO-THROW.
 */
import { z } from "zod"
import type { Tool, ToolContext, ToolEvent } from "../types"

/** Per-dispatch sink the batch adapter reads after the child settles. */
export interface JobResultReporter {
  /** Record the child's structured result. Returns false if already reported
   *  (capture-once) — the tool surfaces that as an error to the child. */
  report(value: unknown): boolean
}

/** A capturing {@link JobResultReporter} + the read side for the adapter. */
export interface CapturedJobResult {
  readonly reporter: JobResultReporter
  /** `{ reported:true, value }` once the child called the tool, else `reported:false`. */
  taken(): { readonly reported: boolean; readonly value: unknown }
}

/** Build a capture-once reporter. The batch adapter mints ONE per row dispatch. */
export const createJobResultReporter = (): CapturedJobResult => {
  let reported = false
  let value: unknown
  return {
    reporter: {
      report: (v) => {
        if (reported) return false
        reported = true
        value = v
        return true
      },
    },
    taken: () => (reported ? { reported: true, value } : { reported: false, value: undefined }),
  }
}

export const reportJobResultInputSchema = z.object({
  // `z.unknown()` (NOT refined) keeps the schema a plain ZodObject so its input
  // and output types match (the `Tool<I>` contract); `result`'s required-ness is
  // enforced in `execute` (a refine would diverge the in/out types).
  result: z
    .unknown()
    .describe(
      "Your STRUCTURED result for this batch row (any JSON: object/array/string/number). " +
        "This is recorded as the row's output — report it ONCE when done.",
    ),
})
export type ReportJobResultInput = z.infer<typeof reportJobResultInputSchema>

/** Build the `report_agent_job_result` tool over a per-dispatch reporter. */
export const reportJobResultTool = (reporter: JobResultReporter): Tool<ReportJobResultInput> => ({
  name: "report_agent_job_result",
  description:
    "Report your STRUCTURED result for this batch row (any JSON). Call this exactly " +
    "once when the row's task is complete — it is recorded as the row's output " +
    "(more reliable than leaving the result in your final message).",
  inputSchema: reportJobResultInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  hitlTier: () => "none",
  async *execute(input, _c: ToolContext): AsyncIterable<ToolEvent> {
    const parsed = reportJobResultInputSchema.safeParse(input)
    if (!parsed.success) {
      yield {
        type: "result",
        result: { ok: false, output: `invalid input: ${parsed.error.message}` },
      }
      return
    }
    if (parsed.data.result === undefined) {
      yield { type: "result", result: { ok: false, output: "invalid input: result is required" } }
      return
    }
    const accepted = reporter.report(parsed.data.result)
    yield {
      type: "result",
      result: accepted
        ? { ok: true, output: "result recorded for this batch row" }
        : { ok: false, output: "a result was already reported for this row (capture-once)" },
    }
  },
})
