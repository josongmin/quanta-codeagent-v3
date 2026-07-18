/**
 * Frozen port/endpoint contracts for the subagent-delivery campaign (RFC jul-18
 * §4.2–4.4). These interfaces are the interface-first boundary: WS2 (control
 * endpoint), WS3 (controller), and WS4 (steer) build against them concurrently.
 * They expose TYPED commands only — no mutable `ActiveTurnState`,
 * `ConversationActionSurface`, or `AbortController` handle escapes to callers
 * (RFC §4.2, §10).
 */

import type {
  SubagentDeliveryOutcome,
  SubagentDeliveryReceipt,
  SubagentDeliveryRequest,
} from "./types"

/** Result of the endpoint's typed interrupt command (RFC §4.2). Closed set —
 *  never a free-form reason string. */
export type InterruptControlOutcome =
  | "woke_idle"
  | "interrupted_active"
  | "already_interrupted"
  | "not_armed"

/** Result of submitting a steer to the child surface (RFC §4.2). The endpoint
 *  must NOT call the existing void `pushUserMessage()` and infer success. */
export type SteerSubmitOutcome = "accepted" | "no_active_turn" | "turn_mismatch" | "queue_full"

/** Result of the endpoint's typed wake command. Mirrors the existing
 *  {@link import("../../subagent/turn-wake").WakeOutcome}. */
export type WakeControlOutcome = "woke" | "queued" | "no-receiver"

/** One immutable, already-sanitized untrusted peer envelope carried with a steer
 *  submission. Retained on the queued conversation action so the loop can
 *  finalize or queue-fallback the exact request without a second payload
 *  registry (RFC §4.2, §4.3). */
export interface PeerEnvelope {
  readonly from: string
  /** Sanitized + escaped + untrusted-provenance-stamped body (RFC §4.5). */
  readonly formattedBody: string
  readonly correlationId?: string
}

/** A steer submission handed to the child control surface (RFC §4.2). */
export interface SubagentSteerSubmission {
  readonly deliveryId: string
  readonly envelope: PeerEnvelope
  readonly expectedTurnId: string
}

/**
 * The sanctioned per-child control endpoint (RFC §4.2). Registered ONE per
 * running child under its `req.taskId`; unregistered by the disposer before the
 * task record settles. A stale disposer cannot remove a newer endpoint for the
 * same task id.
 */
export interface SubagentControlEndpoint {
  readonly mailboxLabel: string
  wake(): WakeControlOutcome
  interrupt(): InterruptControlOutcome
  steer(submission: SubagentSteerSubmission): SteerSubmitOutcome
  /** The child's CURRENT active turn id (a typed READ — no mutable state escapes),
   *  or `undefined` when no turn is in flight. Steer inherently targets "the
   *  current turn": when a caller omits `expectedTurnId` the controller resolves it
   *  from here rather than submitting an empty id into the throwing steer authority. */
  currentTurnId(): string | undefined
}

/**
 * The typed control registry that replaces `TurnWakeRegistry` (RFC §4.2 — a
 * REPLACEMENT, not a parallel registry). Preserves task-id → mailbox-label
 * mapping and last-writer-safe disposal.
 */
export interface SubagentControlRegistry {
  register(taskId: string, endpoint: SubagentControlEndpoint): () => void
  endpointFor(taskId: string): SubagentControlEndpoint | undefined
  labelOf(taskId: string): string | undefined
}

/**
 * Narrow port the `followup_task` tool consumes (RFC §4.4). The tool no longer
 * performs mailbox-send + wake sequencing itself; it hands intent to the
 * controller and renders the closed outcome.
 */
export interface SubagentDeliveryPort {
  deliver(req: SubagentDeliveryRequest): SubagentDeliveryOutcome
}

/**
 * The loop's narrow finalization port (RFC §4.3). An applied steer emits a
 * receipt; late policy rejection, interrupt supersession, or same-turn budget
 * exhaustion asks the controller to perform the ONE mailbox fallback from the
 * action's immutable envelope and emit the final receipt. Keeps pending actions
 * as data — no callback-bearing queue entries, no second payload registry.
 */
export interface SubagentSteerFinalizationPort {
  /** The loop consumed the steer at the safe point. */
  finalizeApplied(deliveryId: string, targetTurnId: string): void
  /** The loop could not apply it; controller performs the single queue fallback
   *  from the retained envelope and emits the correlated degraded receipt. */
  finalizeFallback(deliveryId: string, reason: import("./types").DeliveryDegradeReason): void
  /** Target settled / session aborted before consumption. */
  finalizeCancelled(deliveryId: string, reason: "target_settled" | "session_aborted"): void
}

/** A monotonic id factory the controller injects (RFC §3.3). Tests use a
 *  deterministic factory; production reuses the repo crypto id posture. */
export type DeliveryIdFactory = () => string

export type { SubagentDeliveryOutcome, SubagentDeliveryReceipt, SubagentDeliveryRequest }
