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
  /** Originating session. Optional so existing promptId-only callers stay valid. */
  readonly sessionId?: string
  /** Originating turn. `cancelTurn` matches this identity only. */
  readonly turnId?: string
  /** Originating abort. Abort settles THIS request; other turns stay pending. */
  readonly signal?: AbortSignal
}

export type WebUserInputRequester = (req: WebUserInputRequest) => Promise<UserInputOutcome>

export interface WebUserInputPendingIdentity {
  readonly promptId: string
  readonly sessionId?: string
  readonly turnId?: string
}

/**
 * The handle the composition root wires: `port` goes onto
 * `AgentConfig.userInputPort`; `resolve` is called by the server when a
 * `planInputAnswer` frame arrives; `cancelAll` on disconnect; `cancelTurn`
 * on turn abort; `pendingCount` for observability + the hellgate's no-leak
 * assertion.
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
   *  call the pending map is empty (no leaked resolver). Idempotent.
   *  Socket-close cleanup ONLY — turn abort must call {@link cancelTurn}. */
  cancelAll(): void
  /** Settle pending requests for one turn. Other turns stay. Returns how many
   *  requests were cancelled. */
  cancelTurn(turnId: string): number
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
  type Pending = {
    readonly settle: (o: UserInputOutcome) => void
    readonly identity: WebUserInputPendingIdentity
    readonly signal?: AbortSignal
    abortListener?: (() => void) | undefined
  }
  const pending = new Map<string, Pending>()

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

  const detachAbort = (entry: Pending): void => {
    if (entry.abortListener !== undefined && entry.signal !== undefined) {
      entry.signal.removeEventListener("abort", entry.abortListener)
      entry.abortListener = undefined
    }
  }

  const resolve = (promptId: string, outcome: UserInputOutcome): boolean => {
    const entry = pending.get(promptId)
    if (entry === undefined) return false
    // Delete BEFORE invoking ⇒ a re-entrant / racing second resolve finds no
    // entry and is a no-op (the promise settles exactly once).
    pending.delete(promptId)
    detachAbort(entry)
    entry.settle(outcome)
    return true
  }

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
    if (req.signal?.aborted) {
      const cancelled: UserInputOutcome = { decision: "cancelled" }
      safeCapture(resolvedObservation(req.promptId, cancelled))
      return Promise.resolve(cancelled)
    }
    return new Promise<UserInputOutcome>((res) => {
      const identity: WebUserInputPendingIdentity = {
        promptId: req.promptId,
        ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
        ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
      }
      const entry: Pending = {
        settle: (o) => {
          safeCapture(resolvedObservation(req.promptId, o))
          res(o)
        },
        identity,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      }
      if (req.signal !== undefined) {
        const onAbort = (): void => {
          resolve(req.promptId, { decision: "cancelled" })
        }
        entry.abortListener = onAbort
        req.signal.addEventListener("abort", onAbort, { once: true })
      }
      pending.set(req.promptId, entry)
    })
  }

  const cancelAll = (): void => {
    // Snapshot the entries, clear the map FIRST, then settle each — so a
    // resolver that (defensively) re-enters `resolve`/`cancelAll` finds an empty
    // map. After this method returns the map is guaranteed empty (no leak).
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) {
      detachAbort(entry)
      entry.settle({ decision: "cancelled" })
    }
  }

  const cancelTurn = (turnId: string): number => {
    let n = 0
    for (const [promptId, entry] of [...pending.entries()]) {
      if (entry.identity.turnId !== turnId) continue
      if (resolve(promptId, { decision: "cancelled" })) n += 1
    }
    return n
  }

  return {
    port,
    resolve,
    cancelAll,
    cancelTurn,
    pendingCount: () => pending.size,
  }
}
