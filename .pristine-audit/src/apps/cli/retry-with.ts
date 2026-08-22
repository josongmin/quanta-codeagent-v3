/**
 * ADR-0066 model-swap retry — CLI `/retry-with [<model-id>]` slash command.
 *
 * Wire-up of {@link resolveRetryModel} + {@link streamWithModel}
 * (`src/llm/model-swap.ts`) as a SESSION-time slash command:
 *
 *  - `/retry-with` (no arg)            → escalate to the next candidate after
 *                                        the current model in the configured
 *                                        ordered list.
 *  - `/retry-with <model-id>`          → request that specific candidate;
 *                                        `NoAlternateModelError` if unknown or
 *                                        identical to the current model.
 *
 * On a successful resolve we DROP the most-recent assistant message from the
 * transcript (keyed by `Message.id`) and re-stream the prior turn against the
 * chosen candidate via {@link streamWithModel}. The leading `stream_reset`
 * tombstone propagates so any consumer that had accumulated the prior partial
 * MUST discard it and assemble fresh from the new stream (semantics documented
 * on {@link StreamEvent} `stream_reset`).
 *
 * Default OFF posture (RFC §1.2): without an injected
 * {@link RetryWithSessionState} on the {@link SlashContext}, this command
 * prints "no model candidates configured" and is a no-op — byte-identical to
 * the surface NOT registering the command at all. NEVER silently succeeds when
 * unconfigured.
 *
 * Slice contract: lives in `src/apps/cli/**` — allowed to import `@/llm`
 * (`ModelCandidate`, `resolveRetryModel`, `streamWithModel`, etc.) per the
 * CLI's position at the top of the slice DAG. ADR-0059's
 * "slash dispatch MUST NOT invoke the LLM" invariant applied to the surface-
 * only Tier-2 set; `/retry-with` is a SESSION-time command (it needs the live
 * transcript) and is excluded from that surface invariant by design.
 */

import {
  type Message,
  type ModelCandidate,
  NoAlternateModelError,
  resolveRetryModel,
  type StreamEvent,
  type StreamInput,
  streamWithModel,
} from "@/llm"
import { errMessage } from "@/shared"
import type { AgentEvent } from "@/stream"
import type { SlashCommand, SlashContext } from "./slash-commands"

/**
 * Session-time state required by `/retry-with`. Injected by the surface (a
 * future REPL or session loop) onto its {@link SlashContext.retry} field.
 *
 *  - `candidates` — ordered list of `{ id, port }`. Empty / absent ⇒ no-op.
 *  - `currentModelId` — id of the model that produced the most-recent turn.
 *    Used as the `current` argument to `resolveRetryModel`.
 *  - `messages` — the live transcript. The handler MUTATES this array by
 *    popping the trailing assistant message (matched by `Message.id`) before
 *    re-streaming. The surface owns the array; we mutate in place so any
 *    persistent session store points at the same updated list.
 *  - `signal` — AbortSignal honored across the re-stream. Optional; absent ⇒
 *    no cancellation seam.
 *  - `streamInput` — the {@link StreamInput} (system / tools / message
 *    snapshot) used for the prior turn. Re-streamed as-is against the chosen
 *    candidate. The surface re-builds the messages array AFTER the assistant
 *    pop if it wants the model to see the popped state.
 *  - `onEvent` — called once per `StreamEvent` yielded by the re-stream
 *    (including the leading `stream_reset`). Errors thrown by the consumer
 *    propagate (the task spec: "ANY error in the new stream surfaces
 *    normally"). Async returns are awaited so back-pressure works.
 */
export interface RetryWithSessionState {
  readonly candidates: readonly ModelCandidate[]
  readonly currentModelId: string
  /** Mutable: the trailing assistant message is dropped in place on a
   *  successful swap. */
  readonly messages: Message[]
  readonly streamInput: StreamInput
  readonly signal?: AbortSignal | undefined
  readonly onEvent: (ev: StreamEvent) => void | Promise<void>
  /** RFC02-3 (A8) — optional model-route transition sink. When wired, this
   *  operator caller PROJECTS its OWN `model_route_changed` AgentEvent the moment
   *  the swap is resolved (BEFORE re-streaming): `routeKind:"operator_retry"`,
   *  reason `operator_requested` (explicit `/retry-with <id>`) or
   *  `operator_escalation` (no-arg next-in-list). This is the caller-owned route
   *  observation — NOT the `StreamEvent` stream `onEvent` carries. Default-OFF:
   *  absent ⇒ no event emitted ⇒ byte-identical (the swap behavior itself is
   *  unchanged). The operator caller OWNS the reason; `streamWithModel` never
   *  infers it (it does not know `from`). */
  readonly onModelReroute?: (ev: AgentEvent) => void
  /** Injected clock for the transition's `at` timestamp (determinism seam). No
   *  bare `Date.now()` in the emit path. Absent ⇒ `Date.now`. */
  readonly now?: () => number
}

/** Parsed `/retry-with` argv. Pure value object so the parser stays
 *  testable in isolation from the dispatch. */
export interface RetryWithArgs {
  readonly requested: string | undefined
}

/** Parse `/retry-with` arguments. Accepts zero args (escalate) or exactly one
 *  positional `<model-id>`. Throws on shape errors so the dispatch surface can
 *  print a user-visible message. */
export const parseRetryWithArgs = (args: readonly string[]): RetryWithArgs => {
  if (args.length === 0) return { requested: undefined }
  if (args.length > 1) {
    throw new Error(
      `/retry-with: expected at most one argument (model id); got ${String(args.length)}`,
    )
  }
  const requested = args[0]
  if (requested === undefined || requested.length === 0) {
    throw new Error("/retry-with: model id cannot be empty")
  }
  return { requested }
}

/** Drop the LAST assistant message from `messages` (keyed by `Message.id` when
 *  present, falling back to "last by role" for legacy id-less messages). The
 *  array is mutated in place. Returns the dropped message, or `undefined` if
 *  none was found (no assistant turn to retry). */
export const dropLastAssistantMessage = (messages: Message[]): Message | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m !== undefined && m.role === "assistant") {
      messages.splice(i, 1)
      return m
    }
  }
  return undefined
}

const formatCandidateList = (candidates: readonly ModelCandidate[]): string =>
  candidates.length === 0 ? "(none)" : candidates.map((c) => c.id).join(", ")

/** RFC02-3 (A8) — project the operator-owned `model_route_changed` transition
 *  onto the session's `onModelReroute` sink. No-op when the sink is absent
 *  (default-OFF ⇒ byte-identical). The reason is caller-owned: an explicit
 *  `/retry-with <id>` (`wasRequested`) is `operator_requested`; a no-arg
 *  next-in-list swap is `operator_escalation`. Extracted so the dispatch stays
 *  under the cognitive-complexity budget. */
const emitOperatorRouteTransition = (
  state: RetryWithSessionState,
  toModel: string,
  wasRequested: boolean,
): void => {
  if (state.onModelReroute === undefined) return
  const now = state.now ?? Date.now
  state.onModelReroute({
    type: "model_route_changed",
    fromModel: state.currentModelId,
    toModel,
    reason: wasRequested ? "operator_requested" : "operator_escalation",
    routeKind: "operator_retry",
    at: now(),
  })
}

/**
 * The slash command itself. Mirrors the table-driven shape of the five Tier-2
 * commands; the SESSION state arrives via {@link SlashContext.retry}. With no
 * session state OR empty candidates ⇒ user-visible "no model candidates
 * configured" + return 1 (NEVER silently succeeds when unconfigured).
 */
export const retryWithCmd: SlashCommand = {
  name: "/retry-with",
  describe: "Re-stream the last assistant turn against an alternate model",
  async run(args, ctx) {
    // Parse first so a shape error doesn't depend on session state.
    let parsed: RetryWithArgs
    try {
      parsed = parseRetryWithArgs(args)
    } catch (e) {
      ctx.err(`${errMessage(e)}\n`)
      return 1
    }

    // #16 — when no candidates are configured, surface the EXACT activation
    // requirement instead of a dead-end notice (Agent-B ticket-16, option (b)):
    // `/retry-with` needs a model set, so name the knob + format so the user can
    // act. Read-only path (the transcript is never touched). The byte-prefix
    // "no model candidates configured" is preserved so existing assertions hold.
    const RETRY_HINT =
      "no model candidates configured — set QUANTA_RETRY_MODELS=<id,id,…> to enable /retry-with\n"
    const state = ctx.retry
    if (state === undefined) {
      ctx.out(RETRY_HINT)
      return 1
    }
    if (state.candidates.length === 0) {
      ctx.out(RETRY_HINT)
      return 1
    }

    // Resolve the alternate. NoAlternateModelError is the only QuantaError this
    // path raises by design — surface it with a clear message and DO NOT crash.
    let chosen: ModelCandidate
    try {
      chosen = resolveRetryModel({
        current: state.currentModelId,
        candidates: state.candidates,
        ...(parsed.requested !== undefined ? { requested: parsed.requested } : {}),
      })
    } catch (e) {
      if (e instanceof NoAlternateModelError) {
        ctx.err(
          `no alternate model available; configured: ${formatCandidateList(state.candidates)}\n`,
        )
        return 1
      }
      throw e
    }

    // RFC02-3 (A8) — project the operator-owned route transition BEFORE the
    // re-stream (helper below; keeps this dispatch under the complexity budget).
    emitOperatorRouteTransition(state, chosen.id, parsed.requested !== undefined)

    // Drop the prior assistant message BEFORE re-streaming so the re-stream
    // doesn't observe a half-replaced transcript.
    dropLastAssistantMessage(state.messages)

    // Re-stream. The leading `stream_reset` tombstone is emitted by
    // streamWithModel — propagate every event (including stream_reset) to the
    // consumer. ANY error in the new stream surfaces normally (we do NOT
    // swallow). Cooperative cancel: if the signal aborts mid-loop, the for-
    // await rejection bubbles up to the caller.
    for await (const ev of streamWithModel(chosen, state.streamInput)) {
      if (state.signal?.aborted) {
        // Cooperative: stop forwarding events and surface the abort reason.
        throw state.signal.reason instanceof Error
          ? state.signal.reason
          : new Error("retry-with: aborted")
      }
      await state.onEvent(ev)
    }

    ctx.out(`re-streamed against ${chosen.id}\n`)
    return 0
  },
}
