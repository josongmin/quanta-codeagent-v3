import { z } from "zod"
import type { ProgressSink, Tool, ToolContext, ToolEvent } from "./types"

/**
 * `communicate_update` — C2 (jun-4-communicate-update.md). A read-only,
 * zero-blast-radius structured progress-report tool absorbed from Cursor
 * 3.5.33's `agent.v1.CommunicateUpdateArgs`. The model calls it MID-TURN to
 * report a typed progress triple WITHOUT ending the turn:
 *
 *   - `current_step`       — the live "what step am I on" line, updated
 *                            whenever the subtask changes.
 *   - `final_summary`      — set-once-per-turn executive summary (optional).
 *   - `completed_subtitle` — set-once 4-6-word past-tense agent subtitle
 *                            (optional).
 *
 * The ONLY effect is emitting ONE typed `progress_update` observability event
 * onto the host-wired {@link ProgressSink} (a duck-typed mirror on
 * {@link ToolContext}, identical discipline to `vcsEventSink` / `toolDiff` —
 * `@/tool` stays a slice leaf and never imports `@/stream` / `@/agent`). The
 * host (composition root) adapts the mirror onto the EXISTING `AgentEvent`
 * stream as a `progress_update` event. The event is RENDER-ONLY: it carries no
 * loop-control authority and the model receives a benign `ok:true` ack.
 *
 * ABSENT sink ⇒ `ctx.progressSink?.emit` is a no-op and the run is
 * byte-identical (the model still gets `ok:true`). Best-effort observability:
 * "no sink" degrades to silent success, not a hard `ok:false`.
 *
 * Built via {@link createCommunicateUpdateTool} so it composes with the
 * registry exactly like the other factory tools.
 */

// SECURITY caps (mirrors `update-working-state.ts`'s DoS discipline): every
// string is bounded so a single call cannot balloon the event stream / jsonl
// recorder. `current_step` rides every UI status update; the terminal fields
// are set once but still capped. Values chosen to match the Cursor field
// semantics (concise step line / 1-3 sentence summary / 4-6 word subtitle).
const MAX_CURRENT_STEP = 200
const MAX_FINAL_SUMMARY = 4_000
const MAX_COMPLETED_SUBTITLE = 80

const schema = z.object({
  current_step: z
    .string()
    .min(1)
    .max(MAX_CURRENT_STEP, `current_step must not exceed ${MAX_CURRENT_STEP} characters`)
    .describe(
      "Major step or phase you are on. Update when the subtask changes. Keep the " +
        "text concise, high-level, and user-friendly.",
    ),
  final_summary: z
    .string()
    .min(1)
    .max(MAX_FINAL_SUMMARY, `final_summary must not exceed ${MAX_FINAL_SUMMARY} characters`)
    .optional()
    .describe(
      "Concise executive summary of your work (typically 1-3 sentences). Include " +
        "the most relevant takeaways for the user, as implied by their original " +
        "request. Omit tool calls / results, code or log excerpts, long file paths, " +
        "line numbers, and low-level implementation details. Set this field ONCE " +
        "per turn, as the last thing you do before your final response, at the same " +
        "time you set `completed_subtitle`.",
    ),
  completed_subtitle: z
    .string()
    .min(1)
    .max(
      MAX_COMPLETED_SUBTITLE,
      `completed_subtitle must not exceed ${MAX_COMPLETED_SUBTITLE} characters`,
    )
    .optional()
    .describe(
      "4-6 word, past-tense, final summary of the work you have completed. Will be " +
        "used as your agent subtitle in the UI. Keep it concise, high-level, and " +
        "user-friendly. Set this field ONCE per turn, alongside `final_summary`.",
    ),
})

export type CommunicateUpdateInput = z.infer<typeof schema>
export const communicateUpdateInputSchema = schema

/**
 * Build the `communicate_update` tool. The tool reads its sink from
 * {@link ToolContext.progressSink} (surfaced by the dispatch seam from
 * `AgentConfig.progressSink`); when no sink is wired the emit is a no-op and the
 * run is byte-identical.
 */
export const createCommunicateUpdateTool = (): Tool<CommunicateUpdateInput> => ({
  name: "communicate_update",
  description:
    "Report a structured progress update WITHOUT ending the turn. Use it mid-turn " +
    "to surface the current step you are on (a live status line in the UI), and — " +
    "ONCE per turn, just before your final reply — an executive `final_summary` " +
    "plus a 4-6 word past-tense `completed_subtitle`. This is a status channel, " +
    "not a reply: it never blocks, never touches the filesystem / shell / git, " +
    "and returns immediately so you can keep working.",
  inputSchema: schema,
  // No FS, no shell, no git, no session-state mutation — the only effect is
  // emitting an observability event. Read-only ⇒ unconditionally allowed in
  // plan posture; never routes through the mutating-tool dispatch guard.
  isReadOnly: () => true,
  // Fire-and-continue: it does NOT block on any host decision (contrast
  // `request_user_input`), and touches nothing, so overlapping calls are safe.
  isConcurrencySafe: () => true,
  // HITL secure-by-default: read-only + zero blast radius. Without this explicit
  // tier the fail-closed `inferToolTier` fallback could classify a non-mutating
  // call as `always-confirm` and trigger `onConfirm` on every progress report —
  // a deadlock in HITL-enabled sessions. Pre-approval is correct (same reasoning
  // as `update_working_state`'s explicit tier).
  hitlTier: (): "pre-approval-ok" => "pre-approval-ok",

  // biome-ignore lint/correctness/useYield: single terminal `result` yield; the
  // emit is a synchronous fire-and-continue side effect with no intermediate
  // progress events.
  async *execute(input: CommunicateUpdateInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
    emitProgress(ctx.progressSink, input)
    yield { type: "result", result: { ok: true, output: "progress reported" } }
  },
})

/** Forward the structured progress mirror to the host-wired sink, conditionally
 *  spreading the optional terminal fields so the emitted mirror is byte-exact
 *  (no `undefined` fields under `exactOptionalPropertyTypes`). Extracted from
 *  `execute` so the tool factory stays under the cognitive-complexity budget.
 *  The sink contract is NO-THROW; the absent-sink case is a no-op. */
const emitProgress = (sink: ProgressSink | undefined, input: CommunicateUpdateInput): void => {
  if (sink === undefined) return
  sink.emit({
    current_step: input.current_step,
    ...(input.final_summary !== undefined ? { final_summary: input.final_summary } : {}),
    ...(input.completed_subtitle !== undefined
      ? { completed_subtitle: input.completed_subtitle }
      : {}),
  })
}
