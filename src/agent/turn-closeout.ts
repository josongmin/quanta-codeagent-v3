/**
 * T02 — Turn Outcome Authority (bugbash may-31, L1 H1/H2/M1/M2/M3 + L1 M5).
 *
 * ONE closeout path every terminal turn outcome passes through:
 *   success · refusal · budget-exhausted · approval-pause · abort · hard-error.
 *
 * Before this module the agent loop sealed the transcript, finalized the
 * turn-diff, flushed git-directives, and emitted work-metrics in PER-BRANCH
 * fragments — and the throw/pause path skipped ALL of them (L1 M5), while the
 * budget (L1 H2) and refusal (L1 M2) branches left orphan `tool_use` blocks in
 * working memory (invalid transcript → provider 400 on resume/fork/replay).
 *
 * This authority centralizes the two cross-cutting concerns:
 *
 *  1. {@link sealTranscript} — the transcript invariant. Every terminal outcome
 *     guarantees that no `tool_use` block is left without a matching
 *     `tool_result`. Budget exhaustion at a tool turn appends the pending
 *     `tool_result` blocks; a refusal turn strips the un-dispatched orphan
 *     `tool_use` blocks off the persisted assistant message.
 *
 *  2. {@link flushTurnObservability} — the observability invariant. Turn-diff
 *     `endTurn`, git-directive `flush`, and work-metrics emit fire EXACTLY ONCE
 *     per terminal turn, on the normal-return AND the throw/pause path.
 *
 * Pure given explicit deps (no `loop.ts` import). The loop wires the real
 * collaborators; tests inject recording fakes.
 */

import type { GitDirectiveCollector } from "@/git/directive-emit/turn-collector"
import type { Message } from "@/llm"
import type { WorkingMemory } from "@/memory"
import type { TurnDiffSession } from "./git-observability"
import { emitWorkMetrics } from "./session-resources"
import type { AgentConfig } from "./types"
import type { TurnWorkMetricsCollector } from "./work-metrics-collector"

/** The terminal turn shape the closeout authority classifies. Mirrors the
 *  loop's internal `TurnResult` union but kept structurally minimal so the
 *  authority does not import the loop. */
export type TurnCloseoutResult =
  | { readonly kind: "tools"; readonly resultBlocks: Message["content"] }
  | { readonly kind: "completed" }
  | { readonly kind: "aborted" }
  | { readonly kind: "error" }
  | { readonly kind: "refusal"; readonly message: Message }

/** Append the pending `tool_result` blocks for a tool-producing turn that is
 *  about to terminate WITHOUT continuing the loop (budget exhaustion, L1 H2).
 *
 *  The loop's `proceed` branch appends the assistant message (carrying the
 *  `tool_use` blocks) to working memory BEFORE the turn result is resolved.
 *  When the turn then terminates at the budget gate, the matching
 *  `tool_result` blocks (already produced by streaming dispatch) would never
 *  be appended — leaving the transcript ending on an unmatched `tool_use`.
 *  This seals it by appending the `{role:"user", content: resultBlocks}` turn,
 *  exactly as the continue path does. */
export const appendPendingToolResults = (
  wm: WorkingMemory<Message>,
  resultBlocks: Message["content"],
): void => {
  if (resultBlocks.length === 0) return
  wm.append({ role: "user", content: resultBlocks })
}

/** Strip un-dispatched orphan `tool_use` blocks from a refusing assistant
 *  message before it is persisted (L1 M2). On a refusal the streaming engine
 *  skips the deferred dispatch phase, so any queued `tool_use` blocks never
 *  produced a `tool_result`. Persisting them yields an invalid transcript.
 *  We keep all non-`tool_use` blocks (the visible refusal text); the message's
 *  observable refusal content is unchanged. */
export const stripOrphanToolUse = (message: Message): Message => {
  const kept = message.content.filter((b) => b.type !== "tool_use")
  if (kept.length === message.content.length) return message
  return { ...message, content: kept }
}

/**
 * Fire the per-turn observability flush EXACTLY ONCE: turn-diff `endTurn`
 * (emitted on the stream when non-null), git-directive `flush`, work-metrics
 * emit. Idempotent at the call site is the CALLER's responsibility — this
 * authority is invoked once per turn, from the single closeout seam that runs
 * on BOTH the normal-return and the throw/pause path (L1 M5).
 *
 * `resultKind` drives the work-metrics emit gate (aborted turns emit no
 * metrics — the snapshot is all-zeros, no signal).
 */
export const flushTurnObservability = async (args: {
  readonly cfg: AgentConfig
  readonly stream: AgentConfig["stream"]
  readonly turn: number
  readonly turnDiffSession: TurnDiffSession | undefined
  readonly gitDirectiveCollector: GitDirectiveCollector | undefined
  readonly workCollector: TurnWorkMetricsCollector | undefined
  readonly workTurnId: string | undefined
  readonly resultKind: "tools" | "completed" | "aborted" | "error" | "refusal"
}): Promise<void> => {
  if (args.turnDiffSession !== undefined) {
    const diffEvent = await args.turnDiffSession.endTurn(args.turn)
    if (diffEvent !== null) args.stream.emit(diffEvent)
  }
  args.gitDirectiveCollector?.flush()
  emitWorkMetrics(args.cfg, args.workCollector, args.workTurnId, args.resultKind)
}
