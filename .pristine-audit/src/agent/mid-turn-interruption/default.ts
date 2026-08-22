/**
 * Mid-turn user interruption — DEFAULT POLICY + CAPTURE FACADE (ADR-0177).
 *
 * See `./types.ts` for the surface contract. This module ships:
 *   - `defaultInterruptionPolicy()` — explicit `mode` token wins; unknown
 *     modes fall back to `"queue"` (defensive — typing should never get
 *     dropped).
 *   - `alwaysQueuePolicy` / `alwaysCancelPolicy` — testing stocks.
 *   - `defaultMidTurnCapture({planQueue, policy, threadId, now?, hash?})` —
 *     wires policy decisions through a `PlanQueueStore` (ADR-0128).
 *
 * NO-THROW invariant: every method on the returned `MidTurnCapture` swallows
 * internal errors and returns a safe fallback. Specifically:
 *   - `capture(...)`: a thrown policy or a thrown `planQueue.enqueue` collapses
 *     into `{action:"queue", reason:"policy-error" | "enqueue-error"}`.
 *   - `drainForTurn(...)`: a thrown `planQueue.drain` returns `[]`.
 *   - `peek()`: a thrown `planQueue.peek` returns `[]`.
 *
 * Plane-clean: imports only `@/agent/plan-queue` types + sibling `./types`.
 * Zero `@/agent/loop` / `@/llm` / `@/tool`.
 */

import type { FollowUp, PausedReason, PlanQueueStore } from "@/agent/plan-queue"
import type {
  InterruptionDecision,
  InterruptionMode,
  InterruptionPolicy,
  MidTurnCancelCause,
  MidTurnCapture,
  MidTurnInput,
} from "./types"

const QUEUE_REASON = "mode-queue"
const CANCEL_REASON_REPLACE = "mode-cancel-replace"
const CANCEL_REASON_AMEND = "mode-cancel-amend"
const UNKNOWN_MODE_REASON = "unknown-mode-defensive-queue"
const POLICY_ERROR_REASON = "policy-error"
const ENQUEUE_ERROR_REASON = "enqueue-error"

/** Stock metadata key for the mid-turn mode — observability surfaces can
 *  filter on this to count cancel-vs-queue traffic without re-deriving. */
const METADATA_MODE_KEY = "midTurnMode"

/** Decide based ONLY on the explicit `mode` token. Defensive default to
 *  `"queue"` for unknown values (typing-while-streaming should never be
 *  silently dropped — even if a future enum widening leaks). */
const decideByMode = (mode: InterruptionMode | string): InterruptionDecision => {
  switch (mode) {
    case "queue":
      return { action: "queue", reason: QUEUE_REASON }
    case "cancel-and-replace":
      return { action: "cancel", reason: CANCEL_REASON_REPLACE }
    case "cancel-and-amend":
      return { action: "cancel", reason: CANCEL_REASON_AMEND }
    default:
      return { action: "queue", reason: UNKNOWN_MODE_REASON }
  }
}

export const defaultInterruptionPolicy = (): InterruptionPolicy => ({
  decide: (input, _ctx) => decideByMode(input.mode),
})

export const alwaysQueuePolicy: InterruptionPolicy = {
  decide: () => ({ action: "queue", reason: "force-queue" }),
}

export const alwaysCancelPolicy: InterruptionPolicy = {
  decide: () => ({ action: "cancel", reason: "force-cancel" }),
}

export interface MidTurnCaptureOpts {
  /** Optional plan-queue wiring (ADR-0128). When OMITTED, capture is a
   *  pure decision oracle: it returns the policy decision but does NOT
   *  persist the input. `drainForTurn` / `peek` return `[]`. */
  readonly planQueue?: PlanQueueStore
  /** Policy port. Default `defaultInterruptionPolicy()`. */
  readonly policy?: InterruptionPolicy
  /** Owning thread id — required so the capture knows which plan-queue
   *  partition to address. */
  readonly threadId: string
  /** Injected clock; tests pin it. Default `Date.now`. */
  readonly now?: () => number
  /** Reserved for future symmetry with PlanQueueStoreOpts.hash — not used
   *  today (PlanQueue hashes internally on enqueue). Kept on the opts
   *  surface so a future swap stays binary-compatible. */
  readonly hash?: (text: string) => string
}

/** Compute the `pausedReason` we tag onto the FollowUp. Today we have
 *  exactly one signal — the input arrived while a turn was in flight —
 *  so we stamp `tool_in_flight`. Future expansion (subagent_running etc.)
 *  can come from `ctx` once the CLI loop exposes finer-grain pause states. */
const inferPausedReason = (_input: MidTurnInput): PausedReason => "tool_in_flight"

/** Compute effective `cancelCause`. For cancel-* modes, default to
 *  `"user-abort"` if the caller did not specify. For queue mode the
 *  field is omitted entirely (exactOptional — never `undefined`). */
const resolveCancelCause = (input: MidTurnInput): MidTurnCancelCause | undefined => {
  if (input.mode === "queue") return undefined
  return input.cancelCause ?? "user-abort"
}

/** Build the `metadata` payload stamped onto the FollowUp. We always
 *  include `midTurnMode`; cancel-* modes additionally include the
 *  resolved `cancelCause` so a future replay strategy can distinguish
 *  "this was a cancel-and-replace" from "this was a typed-ahead queue". */
const buildMetadata = (input: MidTurnInput): Record<string, string> => {
  const meta: Record<string, string> = { [METADATA_MODE_KEY]: input.mode }
  const cause = resolveCancelCause(input)
  if (cause !== undefined) meta.cancelCause = cause
  return meta
}

/** Reverse map a `FollowUp` snapshot back to a `MidTurnInput`. Used by
 *  `drainForTurn` / `peek`. The `mode` and `cancelCause` come out of
 *  metadata — when missing (unlikely but defensive) we fall back to
 *  `"queue"`. */
const followUpToMidTurnInput = (fu: FollowUp): MidTurnInput => {
  const rawMode = fu.metadata[METADATA_MODE_KEY]
  const mode: InterruptionMode =
    rawMode === "cancel-and-replace" || rawMode === "cancel-and-amend" || rawMode === "queue"
      ? rawMode
      : "queue"
  const rawCause = fu.metadata.cancelCause
  const cancelCause: MidTurnCancelCause | undefined =
    rawCause === "user-abort" ? "user-abort" : undefined
  const base: Omit<MidTurnInput, "cancelCause"> = {
    text: fu.text,
    receivedAtMs: fu.enqueuedAtMs,
    mode,
    observedTurnIndex: fu.arrivedDuringTurn,
  }
  if (cancelCause !== undefined && mode !== "queue") {
    return { ...base, cancelCause }
  }
  return base
}

export const defaultMidTurnCapture = (opts: MidTurnCaptureOpts): MidTurnCapture => {
  const policy = opts.policy ?? defaultInterruptionPolicy()
  const planQueue = opts.planQueue
  const threadId = opts.threadId

  return {
    async capture(input) {
      let decision: InterruptionDecision
      try {
        decision = policy.decide(input, {
          turnIndex: input.observedTurnIndex,
          stillStreaming: true,
        })
      } catch {
        // NO-THROW: a buggy policy MUST NOT crash the input loop.
        // Default to queue so typing isn't silently dropped.
        return { action: "queue", reason: POLICY_ERROR_REASON }
      }

      if (planQueue !== undefined) {
        try {
          // Mark urgent when caller asked for cancel-and-amend — the user
          // is explicitly drawing attention to "this fixes my last
          // request". cancel-and-replace is also user-attention, but the
          // text BECOMES the next user turn (replace) rather than amending
          // a prior one, so urgent only fires for amend.
          const urgent = input.mode === "cancel-and-amend"
          planQueue.enqueue({
            threadId,
            text: input.text,
            source: "user_keystroke",
            pausedReason: inferPausedReason(input),
            arrivedDuringTurn: input.observedTurnIndex,
            urgent,
            metadata: buildMetadata(input),
          })
        } catch {
          // NO-THROW: even if the plan-queue blows up, we still surface
          // the decision so the CLI can fire cancel (cancel-mode) or
          // notify the user (queue-mode).
          return { action: decision.action, reason: ENQUEUE_ERROR_REASON }
        }
      }

      return decision
    },

    async drainForTurn(turnIndex) {
      if (planQueue === undefined) return []
      try {
        const drained = planQueue.drain(threadId, turnIndex)
        return drained.map(followUpToMidTurnInput)
      } catch {
        return []
      }
    },

    peek() {
      if (planQueue === undefined) return []
      try {
        const snapshot = planQueue.peek(threadId)
        return snapshot.map(followUpToMidTurnInput)
      } catch {
        return []
      }
    },
  }
}
