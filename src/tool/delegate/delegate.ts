/** `delegate` — SYNCHRONOUS mode-typed delegation (ADR-0393).
 *
 *  Hands a subtask to a child agent under a named MODE and BLOCKS until the
 *  child reaches a terminal state, then returns the typed
 *  {@link BoomerangResult} in-band. This is the SYNCHRONOUS boomerang sibling
 *  of the ASYNCHRONOUS background trio (`subagent_fork` / `subagent_poll` /
 *  `subagent_await`, ADR-0140): there the parent forks and harvests later;
 *  here the parent waits and gets the answer at the call site.
 *
 *  WHEN NOT TO USE (surfaced in the description so the model self-selects):
 *   - The call BLOCKS the parent — if you need to keep working in parallel
 *     while the child runs, use `subagent_fork` + `subagent_await` instead.
 *   - For a SIMPLE step you can do yourself (read a file, run one command),
 *     do it directly — delegation spends a whole child conversation + turn
 *     budget and is only worth it for a self-contained subtask that benefits
 *     from an isolated context + a posture (architect / debug / tdd / …).
 *
 *  Output contract: NEVER throws past the loop. Operational failures (budget
 *  overflow, mode-missing, cancellation, runner error, timeout) surface as an
 *  `ok:false` ToolResult whose `output` begins with the typed errorKind so the
 *  model can branch. An unknown mode supplied by the LLM is caught at the
 *  schema/validation boundary (the schema is a closed enum) — the port is
 *  never reached with a bad mode.
 *
 *  HITL tier: `always-confirm` — a synchronous delegation spawns a full child
 *  conversation under a mode posture; default to confirm. (The background
 *  `subagent_fork` is `pre-approval-ok` because it is bounded by the
 *  scheduler's concurrency cap; the sync path has no such cap and blocks the
 *  parent, so it is the more conservative tier.)
 *
 *  Context isolation (mirror of the producer contract): only the
 *  {@link BoomerangResult} crosses the boundary — the parent never sees the
 *  child's intermediate messages or tool transcripts. */

import { z } from "zod"
import { errMessage } from "@/shared"
import type { CoreToolContext, Tool, ToolEvent } from "../types"
import {
  type AgentMode,
  type BoomerangResult,
  DELEGATE_MODES,
  type DelegationPort,
  type DelegationRequest,
} from "./port"

/** Closed-enum mode schema — derived from the mirror list so adding a producer
 *  mode (and the mirror) automatically widens the tool input. A value outside
 *  the enum is rejected at parse time, so the port is never called with an
 *  unknown mode. */
const modeSchema = z.enum(DELEGATE_MODES as unknown as [AgentMode, ...AgentMode[]])

export const delegateInputSchema = z.object({
  mode: modeSchema.describe(
    "The child posture: 'architect' (design/plan), 'editor' (apply edits), " +
      "'debug' (root-cause), 'tdd' (test-first), 'explore' (read-only investigate). " +
      "Selects the child's prompt voice, tool subset, and budget cap.",
  ),
  task: z
    .string()
    .min(1)
    .describe(
      "The self-contained subtask prompt handed to the child agent. The child " +
        "runs in an ISOLATED conversation and returns only a summary + artifacts.",
    ),
  maxTurns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional turn ceiling for the child. Must be <= the mode's cap; a larger " +
        "value is rejected (returns ok:false errorKind=budget-overflow).",
    ),
  maxTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional provider-token ceiling for the child. Same overflow semantics as maxTurns.",
    ),
})
export type DelegateInput = z.infer<typeof delegateInputSchema>

/** Build the {@link DelegationRequest} from validated input + the tool's abort
 *  signal, OMITTING absent optional fields (exactOptionalPropertyTypes — never
 *  `undefined`-set). The parent's `ctx.signal` chains into the child so an
 *  abort on the parent unwinds the child (boomerang errorKind=cancelled). */
const inputToRequest = (input: DelegateInput, signal: AbortSignal): DelegationRequest => {
  const budget: { maxTurns?: number; maxTokens?: number } = {
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
  }
  return {
    mode: input.mode,
    prompt: input.task,
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    parentSignal: signal,
  }
}

/** Render a finished {@link BoomerangResult} into the model-facing text. The
 *  typed `errorKind` leads the output on failure so the model can branch on
 *  the KIND rather than regex-matching prose. */
const formatResult = (r: BoomerangResult): string => {
  const head = r.ok
    ? `delegate ok: mode=${r.mode} turns=${r.turns} durationMs=${r.durationMs}`
    : `delegate failed (${r.errorKind ?? "runner-error"}): mode=${r.mode} turns=${r.turns}`
  const lines = [head]
  if (!r.ok && r.errorMessage !== undefined && r.errorMessage.length > 0) {
    lines.push(`error: ${r.errorMessage}`)
  }
  if (r.summary.length > 0) lines.push(`summary: ${r.summary}`)
  if (r.artifacts !== undefined) {
    for (const [name, body] of Object.entries(r.artifacts)) {
      lines.push("---", `artifact ${name}:`, body)
    }
  }
  return lines.join("\n")
}

export const delegateTool = (port: DelegationPort): Tool<DelegateInput> => ({
  name: "delegate",
  description:
    "Delegate a self-contained subtask to a child agent under a named MODE " +
    "(architect/editor/debug/tdd/explore) and BLOCK until it finishes, then " +
    "receive its summary + artifacts in-band. The child runs in an isolated " +
    "conversation; only the result crosses back. " +
    "WHEN NOT TO USE: this BLOCKS the parent — if you need to keep working in " +
    "parallel use subagent_fork + subagent_await instead; for a simple step you " +
    "can do yourself (read one file, run one command), just do it directly " +
    "rather than spending a whole child conversation.",
  inputSchema: delegateInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "always-confirm",
  async *execute(input, ctx: CoreToolContext): AsyncIterable<ToolEvent> {
    const parsed = delegateInputSchema.safeParse(input)
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
    const req = inputToRequest(parsed.data, ctx.signal)
    let result: BoomerangResult
    try {
      result = await port.delegate(req)
    } catch (e) {
      // The port contract is NO-THROW for operational failures; a throw here
      // is an unexpected (programmer-bug) path. Surface it as a graceful
      // ok:false rather than letting it bubble past the loop.
      const msg = errMessage(e)
      yield { type: "result", result: { ok: false, output: `delegate error: ${msg}` } }
      return
    }
    yield {
      type: "result",
      result: { ok: result.ok, output: formatResult(result) },
    }
  },
})
