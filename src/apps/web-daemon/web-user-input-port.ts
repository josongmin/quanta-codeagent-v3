/**
 * QUANTA_WEB_AGENT_STATE — web-daemon side of the OUT-OF-BAND INBOUND channel.
 *
 * The mirror of the agent-state OUTBOUND tap. The agent-state source ships the 9
 * agent-state observations TO the browser; this port lets the browser ANSWER the
 * one observation the agent is BLOCKED on — a `plan_user_input_requested` prompt
 * raised by the `request_user_input` tool (ADR-0097). Without it, the web surface
 * can SEE a paused agent (the `AgentStatePanel` renders the passive prompt) but
 * cannot reply, so the agent waits forever for an input it can never receive.
 *
 * Architecture (decided, ADR-0097 sister): this is NOT a kernel `SessionCommand`
 * — the kernel reducer + its drift contract stay UNTOUCHED. The answer rides an
 * out-of-band JSON frame (`{kind:"planInputAnswer",…}`) the server peeks BEFORE
 * the session bridge, exactly as the agent-state frames ride out-of-band.
 *
 * Gate: `QUANTA_WEB_AGENT_STATE` (the SAME gate as the agent-state source — you
 * can only answer a prompt you can SEE). Gate OFF ⇒ the composition root never
 * mints this port ⇒ `AgentConfig.userInputPort` is absent ⇒ the
 * `request_user_input` tool is NOT registered ⇒ byte-identical (the agent cannot
 * ask on web, exactly as before).
 *
 * LOAD-BEARING INVARIANT — no leaked resolver, no hung agent:
 *   - A pending request MUST resolve exactly once. `resolve()` deletes the entry
 *     BEFORE invoking it, so a double-resolve (or a resolve racing a `cancelAll`)
 *     is a no-op (returns false). The awaited promise settles once.
 *   - On disconnect the server calls `cancelAll()`, which resolves EVERY pending
 *     request with `{decision:"cancelled"}` — so the agent's `await` never hangs
 *     past the socket's life. After `cancelAll()` the pending map is empty.
 *   - A half-built port that can ASK but never RESOLVE would hang the agent
 *     forever — worse than not building it. Hence: fully wired or not wired.
 *
 * NO-THROW: `deps.capture` is wrapped in try/catch at every call site so a
 * throwing sink can never break the request/resolve lifecycle (and thus never
 * strand the agent's pending promise).
 *
 * Slice fence: this module lives in `@/apps/web-daemon` and imports only the
 * `@/protocol/agent-state` observation shape + the `@/tool` requester type. It
 * never imports `@/agent/loop`; the composition root is the only bridge.
 */

import type { AgentStateObservation, PlanInputChoiceDetail } from "@/protocol/agent-state"
import type { UserInputOutcome, UserInputRequester } from "@/tool"

/**
 * UUX-2-17 — the daemon-local request shape: the `@/tool` requester contract
 * plus an OPTIONAL `choiceDetails` a rich caller (the web ask_user port) can
 * attach so option descriptions reach the browser chips. A function accepting
 * this WIDER request stays assignable to {@link UserInputRequester} (the extra
 * field is optional), so the `AgentConfig.userInputPort` wiring is unchanged.
 */
export type WebUserInputRequest = Parameters<UserInputRequester>[0] & {
  readonly choiceDetails?: readonly PlanInputChoiceDetail[]
}

export type WebUserInputRequester = (req: WebUserInputRequest) => Promise<UserInputOutcome>

/**
 * The handle the composition root wires: `port` goes onto
 * `AgentConfig.userInputPort`; `resolve` is called by the server when a
 * `planInputAnswer` frame arrives; `cancelAll` on disconnect; `pendingCount`
 * for observability + the hellgate's no-leak assertion.
 */
export interface WebUserInputPortHandle {
  /** The requester the `request_user_input` tool invokes. Emits a
   *  `plan_user_input_requested` observation + parks a pending resolver.
   *  Accepts the widened {@link WebUserInputRequest} (UUX-2-17) — still
   *  assignable wherever a plain {@link UserInputRequester} is expected. */
  readonly port: WebUserInputRequester
  /** Resolve a pending request by `promptId`. Returns `false` (no-op) when the
   *  id is unknown OR already resolved (double-resolve guard). */
  resolve(promptId: string, outcome: UserInputOutcome): boolean
  /** Resolve EVERY pending request with `{decision:"cancelled"}`. After this
   *  call the pending map is empty (no leaked resolver). Idempotent. */
  cancelAll(): void
  /** How many requests are currently awaiting an answer. */
  pendingCount(): number
}

export interface WebUserInputPortDeps {
  /** Fan an out-of-band agent-state observation to the browser (the same sink
   *  the agent-state source captures into). NO-THROW: wrapped at every call. */
  readonly capture: (ev: AgentStateObservation) => void
}

/**
 * Create the web user-input port. One per daemon facade (the composition root
 * mints it alongside the agent-state source, gated on the same flag).
 */
export const createWebUserInputPort = (deps: WebUserInputPortDeps): WebUserInputPortHandle => {
  // promptId → the resolver for the awaiting `port()` promise.
  const pending = new Map<string, (o: UserInputOutcome) => void>()

  /** Emit one observation through the sink, swallowing any throw (a hostile /
   *  dead sink must never strand the agent's pending promise). */
  const safeCapture = (ev: AgentStateObservation): void => {
    try {
      deps.capture(ev)
    } catch {
      // NO-THROW: the request/resolve lifecycle must survive a throwing sink.
    }
  }

  /** Map a CLOSED `UserInputOutcome` to its `plan_user_input_resolved`
   *  observation (the 2-arm union mirrors the agent-state variant exactly). */
  const resolvedObservation = (
    promptId: string,
    outcome: UserInputOutcome,
  ): AgentStateObservation =>
    outcome.decision === "answer"
      ? {
          type: "plan_user_input_resolved",
          promptId,
          decision: "answer",
          text: outcome.text,
        }
      : { type: "plan_user_input_resolved", promptId, decision: "cancelled" }

  const port: WebUserInputRequester = (req) => {
    // Surface the prompt to the browser FIRST so a connected panel renders the
    // answer affordance before we park the resolver.
    safeCapture({
      type: "plan_user_input_requested",
      promptId: req.promptId,
      prompt: req.prompt,
      ...(req.choices !== undefined ? { choices: req.choices } : {}),
      // UUX-2-17 — thread the rich chip detail through; absent ⇒ observation
      // byte-identical to the pre-fix shape.
      ...(req.choiceDetails !== undefined ? { choiceDetails: req.choiceDetails } : {}),
    })
    return new Promise<UserInputOutcome>((res) => {
      pending.set(req.promptId, (o) => {
        // Mirror the resolution back to the browser so the panel clears its
        // pending card (and any other connection sees the resolve).
        safeCapture(resolvedObservation(req.promptId, o))
        res(o)
      })
    })
  }

  const resolve = (promptId: string, outcome: UserInputOutcome): boolean => {
    const r = pending.get(promptId)
    if (r === undefined) return false
    // Delete BEFORE invoking ⇒ a re-entrant / racing second resolve finds no
    // entry and is a no-op (the promise settles exactly once).
    pending.delete(promptId)
    r(outcome)
    return true
  }

  const cancelAll = (): void => {
    // Snapshot the entries, clear the map FIRST, then settle each — so a
    // resolver that (defensively) re-enters `resolve`/`cancelAll` finds an empty
    // map. After this method returns the map is guaranteed empty (no leak).
    const entries = [...pending.values()]
    pending.clear()
    for (const r of entries) {
      r({ decision: "cancelled" })
    }
  }

  return {
    port,
    resolve,
    cancelAll,
    pendingCount: () => pending.size,
  }
}
