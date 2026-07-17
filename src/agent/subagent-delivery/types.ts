/**
 * Canonical subagent-delivery command contract (RFC jul-18 §3.2–3.3).
 *
 * ONE typed path from a caller's intent (`SubagentDeliveryRequest`) to the
 * child's effective behavior (`SubagentDeliveryOutcome` + async
 * `SubagentDeliveryReceipt`). No boolean `ok` may erase the requested/effective
 * distinction; every runtime downgrade is a typed `degraded` outcome, never a
 * successful-looking silent fallback (RFC §3.3, §11.9).
 *
 * SSOT reuse (RFC §7 "no second fallback table"): the steer-overlap degrade
 * reasons are the SAME literals as {@link SteerRejectionReason}; the mapper
 * {@link steerRejectionToDelivery} is the ONLY bridge — this slice never
 * re-derives steer policy.
 */

import type { ActivationPolicy, DeliveryMode } from "@/shared"
import type { SteerRejectionReason } from "../steer-reasons"

/** Whether an idle child is scheduled a fresh turn for this delivery. Re-export
 *  of the shared axis so the delivery contract is importable from one slice. */
export type { ActivationPolicy, DeliveryMode } from "@/shared"

/** Canonical request. `targetTaskId` is ALWAYS the registry task id; only the
 *  controller resolves its mailbox label (RFC §3.2). */
export interface SubagentDeliveryRequest {
  readonly targetTaskId: string
  readonly from: string
  readonly body: string
  readonly mode: DeliveryMode
  readonly activation: ActivationPolicy
  /** Honored for `steer`, optional for `interrupt`; a mismatch NEVER writes into
   *  a different turn (RFC §3.2). */
  readonly expectedTurnId?: string
  readonly correlationId?: string
}

/** Why a live-mode request degraded to queue delivery. The first five literals
 *  are shared verbatim with {@link SteerRejectionReason} (SSOT); the rest are
 *  delivery-only. `superseded_by_interrupt`, `action_queue_full`,
 *  `same_turn_budget_exhausted` arise only in the async steer finalization. */
export type DeliveryDegradeReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "non_steerable_review"
  | "non_steerable_compact"
  | "non_steerable_standalone"
  | "already_interrupted"
  | "superseded_by_interrupt"
  | "action_queue_full"
  | "same_turn_budget_exhausted"
  | "control_unavailable"
  | "no_waker"

/** Why a request was rejected BEFORE any mailbox/control mutation (RFC §5.1–5.2,
 *  §11.8). A reject never retains a payload. */
export type DeliveryRejectReason =
  | "target_unknown"
  | "target_settled"
  | "ownership_denied"
  | "self_target"
  | "invalid_input"
  | "mode_disabled"
  | "internal_control_error"

export const ALL_DELIVERY_DEGRADE_REASONS = [
  "no_active_turn",
  "expected_turn_mismatch",
  "non_steerable_review",
  "non_steerable_compact",
  "non_steerable_standalone",
  "already_interrupted",
  "superseded_by_interrupt",
  "action_queue_full",
  "same_turn_budget_exhausted",
  "control_unavailable",
  "no_waker",
] as const satisfies readonly DeliveryDegradeReason[]

export const ALL_DELIVERY_REJECT_REASONS = [
  "target_unknown",
  "target_settled",
  "ownership_denied",
  "self_target",
  "invalid_input",
  "mode_disabled",
  "internal_control_error",
] as const satisfies readonly DeliveryRejectReason[]

// Two-way drift guards — outer annotation removed so `[number]` is the literal
// tuple; Assert proves every union member is listed. New member → build error.
type _AssertReason<T extends true> = T
export type _DegradeReasonDriftGuard = _AssertReason<
  DeliveryDegradeReason extends (typeof ALL_DELIVERY_DEGRADE_REASONS)[number] ? true : false
>
export type _RejectReasonDriftGuard = _AssertReason<
  DeliveryRejectReason extends (typeof ALL_DELIVERY_REJECT_REASONS)[number] ? true : false
>

/**
 * The ONLY bridge from a steer-authority rejection to a delivery result
 * (RFC §7). `empty_input`/`input_too_large` cannot occur here — the controller
 * validates input and returns an `invalid_input` REJECT before ever calling the
 * steer authority — so they map to the `"invalid_input"` sentinel, which the
 * controller treats as a defensive reject (never a degrade). Total over
 * `SteerRejectionReason` so a new steer reason forces a decision here.
 */
export const steerRejectionToDelivery = (
  r: SteerRejectionReason,
): DeliveryDegradeReason | "invalid_input" => {
  switch (r) {
    case "no_active_turn":
      return "no_active_turn"
    case "expected_turn_mismatch":
      return "expected_turn_mismatch"
    case "non_steerable_review":
      return "non_steerable_review"
    case "non_steerable_compact":
      return "non_steerable_compact"
    case "non_steerable_standalone":
      return "non_steerable_standalone"
    case "interrupted":
      return "already_interrupted"
    case "empty_input":
    case "input_too_large":
      // Pre-validated by the controller as an `invalid_input` reject; unreachable
      // in the live-steer path. Mapped defensively, never surfaced as a degrade.
      return "invalid_input"
  }
}

/** Immediate result the controller returns to the caller tool. `accepted`
 *  (steer) is admission only — a correlated {@link SubagentDeliveryReceipt}
 *  arrives later when the loop consumes or downgrades the action (RFC §3.3). */
export type SubagentDeliveryOutcome =
  | {
      readonly kind: "accepted"
      readonly deliveryId: string
      readonly requestedMode: "steer"
      readonly effect: "steer_pending"
      readonly targetTurnId: string
    }
  | {
      readonly kind: "applied"
      readonly deliveryId: string
      readonly requestedMode: "queue"
      readonly effectiveMode: "queue"
      readonly effect: "queued" | "woke"
      readonly messageId: string
    }
  | {
      readonly kind: "applied"
      readonly deliveryId: string
      readonly requestedMode: "interrupt"
      readonly effectiveMode: "interrupt"
      readonly effect: "interrupted"
      readonly messageId: string
      readonly targetTurnId: string
    }
  | {
      readonly kind: "degraded"
      readonly deliveryId: string
      // WS3: a `queue + ensure-turn` whose payload IS retained but whose child
      // could not be woken (no endpoint / no live waker) is a typed degrade, not
      // a reject — the delivery already occurred (RFC §5.3, §3.3). So `queue` is
      // an admissible requested mode here alongside the live-mode downgrades.
      readonly requestedMode: "queue" | "steer" | "interrupt"
      readonly effectiveMode: "queue"
      readonly effect: "queued" | "woke"
      readonly reason: DeliveryDegradeReason
      readonly messageId: string
    }
  | {
      readonly kind: "rejected"
      readonly reason: DeliveryRejectReason
    }

/** Final receipt for an `accepted` steer, correlated by `deliveryId`. Every
 *  accepted delivery produces EXACTLY ONE of these (RFC §3.3). */
export type SubagentDeliveryReceipt =
  | {
      readonly deliveryId: string
      readonly kind: "applied"
      readonly effectiveMode: "steer"
      readonly targetTurnId: string
    }
  | {
      readonly deliveryId: string
      readonly kind: "degraded"
      readonly effectiveMode: "queue"
      readonly reason: DeliveryDegradeReason
      readonly effect: "queued" | "woke"
      readonly messageId: string
    }
  | {
      readonly deliveryId: string
      readonly kind: "cancelled"
      readonly reason: "target_settled" | "session_aborted"
    }
