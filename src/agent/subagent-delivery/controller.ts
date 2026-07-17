/**
 * WS3 (RFC jul-18 §4.3) — the single decide/apply delivery controller.
 *
 * ONE owner of the "caller intent → child effective behavior" decision. It
 * validates input and target, resolves task-id → endpoint + mailbox label, and
 * applies EXACTLY ONE of: mailbox enqueue, per-turn interrupt, or steer
 * submission (RFC §3.4). It returns the closed {@link SubagentDeliveryOutcome}
 * taxonomy — no boolean `ok`; every runtime downgrade is a typed `degraded`,
 * never a silent success (RFC §3.3, §11.9).
 *
 * INVARIANTS enforced here:
 *   - every reject happens BEFORE any mailbox/control mutation (RFC §5.1–5.2);
 *   - a payload retained in the mailbox but not woken/steered is `degraded`,
 *     NOT `rejected`, because delivery already occurred (RFC §3.3);
 *   - `forceStop()` is NEVER called — interrupt is per-turn only (RFC §1.1);
 *   - the steer path submits the SANITIZED {@link PeerEnvelope} (via the reused
 *     peer formatter, RFC §4.5) and, on success, enqueues NO mailbox copy
 *     (RFC §3.4). The FULL safe-point finalization + receipts are WS4 — this
 *     module leaves a clean {@link SubagentSteerFinalizationPort} seam and does
 *     not drain the loop.
 *
 * It does NOT own mailbox retention, child lifetime, UI rendering, or
 * environment parsing (RFC §4.3). The registry/lineage/self checks are injected
 * as a narrow {@link resolveTarget} closure so the controller stays a pure
 * decide/apply leaf (the host closes over the concrete `TaskRegistry` + owners
 * ledger + requester lineage).
 */

import { type DeliveryDegradeReason, steerRejectionToDelivery } from "./types"
import type {
  DeliveryIdFactory,
  InterruptControlOutcome,
  SteerSubmitOutcome,
  SubagentControlEndpoint,
  SubagentControlRegistry,
  SubagentDeliveryOutcome,
  SubagentDeliveryPort,
  SubagentDeliveryRequest,
  SubagentSteerFinalizationPort,
  WakeControlOutcome,
} from "./ports"

/** Narrow mailbox send port. Returns the minted message's `id` so the controller
 *  can stamp `messageId` on the outcome. The real `MailboxPort.send` returns a
 *  `MailboxMessage` (which has `id`), so it satisfies this structurally. */
export interface DeliveryMailboxPort {
  send(init: {
    from: string
    to: string
    kind: "request" | "response" | "broadcast"
    body: string
    correlationId?: string
  }): { readonly id: string }
}

/**
 * Result of resolving a target task id, computed BEFORE any mutation. The host
 * closes over the concrete registry + owners ledger + requester lineage +
 * own-task-id so the controller never imports `@/subagent` internals and stays a
 * pure decide/apply leaf. `running` additionally surfaces the resolved mailbox
 * label (task-id → `root/N`), so the controller does not consult the registry a
 * second time.
 */
export type TargetResolution =
  | { readonly kind: "unknown" }
  | { readonly kind: "settled" }
  | { readonly kind: "ownership_denied" }
  | { readonly kind: "self" }
  | { readonly kind: "running"; readonly mailboxLabel?: string }

/** The peer sanitizer/formatter (RFC §4.5) — the SAME `formatPeerBody` the
 *  mailbox slice exports (redact → escape → untrusted provenance). Injected so
 *  this slice never re-implements redaction. */
export type PeerFormatter = (
  from: string,
  kind: "request" | "response" | "broadcast",
  body: string,
) => string

export interface SubagentDeliveryControllerDeps {
  /** Typed control registry (endpointFor / labelOf). */
  readonly control: SubagentControlRegistry
  readonly mailbox: DeliveryMailboxPort
  /** The reused peer formatter (RFC §4.5). */
  readonly formatPeer: PeerFormatter
  /** Validate target running-state + lineage + self BEFORE mutation. */
  readonly resolveTarget: (targetTaskId: string) => TargetResolution
  readonly newDeliveryId: DeliveryIdFactory
  /** When false, `mode:"steer"` is rejected as `mode_disabled` (WS4/steer gate
   *  not wired) — NEVER a silent queue (RFC §9). */
  readonly steerEnabled: boolean
  /** Max accepted body bytes; an oversized body is `invalid_input` (defaults to
   *  the `followup_task` 8 KB schema cap). */
  readonly maxBodyBytes?: number
  /** WS4 seam — the loop's finalization port. Present ⇒ the controller can be
   *  handed to the loop so an accepted steer is finalized/queue-fallback'd
   *  exactly once. WS3 only STORES it (does not drain); WS4 wires the safe-point
   *  drain that calls it. */
  readonly finalization?: SubagentSteerFinalizationPort
}

const DEFAULT_MAX_BODY_BYTES = 8192

/** A queue-mode `applied` outcome (queued | woke). */
const applyOutcome = (
  deliveryId: string,
  effect: "queued" | "woke",
  messageId: string,
): SubagentDeliveryOutcome => ({
  kind: "applied",
  deliveryId,
  requestedMode: "queue",
  effectiveMode: "queue",
  effect,
  messageId,
})

/** A retained-payload `degraded` outcome (live-mode downgrade OR a queue whose
 *  child could not be woken — RFC §5.3). */
const degradeOutcome = (
  deliveryId: string,
  requestedMode: "queue" | "steer" | "interrupt",
  reason: DeliveryDegradeReason,
  effect: "queued" | "woke",
  messageId: string,
): SubagentDeliveryOutcome => ({
  kind: "degraded",
  deliveryId,
  requestedMode,
  effectiveMode: "queue",
  effect,
  reason,
  messageId,
})

/** Map an endpoint wake outcome onto the queue `effect` + optional degrade. A
 *  `no-receiver` (endpoint present but no live waker) is an ensure-turn degrade
 *  (`no_waker`); `woke`/`queued` are the ordinary applied effects. */
const wakeToEffect = (w: WakeControlOutcome): "queued" | "woke" | "no_waker" =>
  w === "woke" ? "woke" : w === "queued" ? "queued" : "no_waker"

export const createSubagentDeliveryController = (
  deps: SubagentDeliveryControllerDeps,
): SubagentDeliveryPort => {
  const maxBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  /** Enqueue the payload once and return its message id (the ONE mailbox
   *  mutation on any queue/degrade path). Resolves the delivery address to the
   *  child's mailbox label (task id → `root/N`); falls back to the task id when
   *  no label is bound. */
  const enqueue = (req: SubagentDeliveryRequest, label: string | undefined): string => {
    const to = label ?? deps.control.labelOf(req.targetTaskId) ?? req.targetTaskId
    const msg = deps.mailbox.send({
      from: req.from,
      to,
      kind: "request",
      body: req.body,
      ...(req.correlationId !== undefined ? { correlationId: req.correlationId } : {}),
    })
    return msg.id
  }

  /** Queue delivery: send once, then (ensure-turn only) wake. Passive never
   *  wakes. A missing endpoint / no-receiver on ensure-turn is a typed
   *  retained-payload degrade, never a reject (delivery already occurred). */
  const doQueue = (
    req: SubagentDeliveryRequest,
    endpoint: SubagentControlEndpoint | undefined,
    label: string | undefined,
  ): SubagentDeliveryOutcome => {
    const deliveryId = deps.newDeliveryId()
    const messageId = enqueue(req, label)
    if (req.activation === "passive") return applyOutcome(deliveryId, "queued", messageId)
    // ensure-turn: a follow-up guarantees an eligible child gets a turn.
    if (endpoint === undefined) {
      // Running but no control endpoint registered — payload retained, but we
      // cannot schedule a turn. Typed degrade (RFC §5.3), NOT a reject.
      return degradeOutcome(deliveryId, "queue", "control_unavailable", "queued", messageId)
    }
    const effect = wakeToEffect(endpoint.wake())
    if (effect === "no_waker") {
      return degradeOutcome(deliveryId, "queue", "no_waker", "queued", messageId)
    }
    return applyOutcome(deliveryId, effect, messageId)
  }

  const doInterrupt = (
    req: SubagentDeliveryRequest,
    endpoint: SubagentControlEndpoint | undefined,
    label: string | undefined,
  ): SubagentDeliveryOutcome => {
    const deliveryId = deps.newDeliveryId()
    // RFC §3.4 — enqueue FIRST, then fire the per-turn abort. If control fails,
    // the queued payload is recoverable and the outcome is a typed degrade.
    const messageId = enqueue(req, label)
    if (endpoint === undefined) {
      return degradeOutcome(deliveryId, "interrupt", "control_unavailable", "queued", messageId)
    }
    const outcome: InterruptControlOutcome = endpoint.interrupt()
    switch (outcome) {
      case "interrupted_active":
        return {
          kind: "applied",
          deliveryId,
          requestedMode: "interrupt",
          effectiveMode: "interrupt",
          effect: "interrupted",
          messageId,
          targetTurnId: req.expectedTurnId ?? "",
        }
      case "already_interrupted":
        // A prior interrupt already aborted; this one shares the pending resume
        // and queues in FIFO order. Typed degrade (RFC §5.5).
        return degradeOutcome(deliveryId, "interrupt", "already_interrupted", "queued", messageId)
      case "woke_idle":
        // Nothing was in flight to abort; the fresh turn drains the queued
        // payload — an interrupt of an idle child collapses to queue+ensure-turn
        // and a turn WILL run, so this is `applied`, not a degrade (RFC §3.1).
        return {
          kind: "applied",
          deliveryId,
          requestedMode: "interrupt",
          effectiveMode: "interrupt",
          effect: "interrupted",
          messageId,
          targetTurnId: req.expectedTurnId ?? "",
        }
      case "not_armed":
        // The child has entered no turn yet (nothing armed, nothing parked); the
        // payload is queued and a turn runs once the loop parks — same collapse
        // as woke_idle (a turn WILL run). Applied; the interrupt-applied arm's
        // effect literal is always "interrupted".
        return {
          kind: "applied",
          deliveryId,
          requestedMode: "interrupt",
          effectiveMode: "interrupt",
          effect: "interrupted",
          messageId,
          targetTurnId: req.expectedTurnId ?? "",
        }
    }
  }

  const doSteer = (
    req: SubagentDeliveryRequest,
    endpoint: SubagentControlEndpoint | undefined,
    label: string | undefined,
  ): SubagentDeliveryOutcome => {
    const deliveryId = deps.newDeliveryId()
    // Gate: steer capability not wired ⇒ reject mode_disabled BEFORE any mutation
    // (RFC §9 — never a silent queue). The controller-level `steerEnabled` guard
    // fires earlier (in `deliver`); this is the endpoint-absent fallback path.
    if (endpoint === undefined) {
      const messageId = enqueue(req, label)
      return degradeOutcome(deliveryId, "steer", "control_unavailable", "queued", messageId)
    }
    // Build the SANITIZED envelope (RFC §4.5) — a raw teammate body may never be
    // injected as a trusted string. `expectedTurnId` is honored for steer; when
    // the caller omitted it there is no active turn to target ⇒ the endpoint's
    // steer authority returns `no_active_turn` and we fall back.
    const submission = {
      deliveryId,
      envelope: {
        from: req.from,
        formattedBody: deps.formatPeer(req.from, "request", req.body),
        ...(req.correlationId !== undefined ? { correlationId: req.correlationId } : {}),
      },
      expectedTurnId: req.expectedTurnId ?? "",
    }
    const outcome: SteerSubmitOutcome = endpoint.steer(submission)
    if (outcome === "accepted") {
      // Admission only — NO mailbox copy (RFC §3.4). The correlated applied /
      // degraded receipt arrives later from the loop's safe point (WS4 seam:
      // `deps.finalization`).
      return {
        kind: "accepted",
        deliveryId,
        requestedMode: "steer",
        effect: "steer_pending",
        targetTurnId: submission.expectedTurnId,
      }
    }
    // Rejected admission ⇒ one mailbox fallback + a typed degrade, using the SSOT
    // bridge for the steer-authority reasons (RFC §7 — no second fallback table).
    const messageId = enqueue(req, label)
    const reason = steerSubmitToDegrade(outcome)
    return degradeOutcome(deliveryId, "steer", reason, "queued", messageId)
  }

  return {
    deliver(req: SubagentDeliveryRequest): SubagentDeliveryOutcome {
      // 1) Input validation BEFORE any lookup/mutation (RFC §3.2).
      if (typeof req.body !== "string" || req.body.length === 0) {
        return { kind: "rejected", reason: "invalid_input" }
      }
      if (byteLength(req.body) > maxBytes) {
        return { kind: "rejected", reason: "invalid_input" }
      }
      // 2) Steer gate — reject mode_disabled BEFORE target lookup / mutation
      //    (RFC §9: gate OFF ⇒ mode_disabled, never a silent queue).
      if (req.mode === "steer" && !deps.steerEnabled) {
        return { kind: "rejected", reason: "mode_disabled" }
      }
      // 3) Target validation BEFORE any mutation (RFC §5.1–5.2).
      const target = deps.resolveTarget(req.targetTaskId)
      switch (target.kind) {
        case "unknown":
          return { kind: "rejected", reason: "target_unknown" }
        case "settled":
          return { kind: "rejected", reason: "target_settled" }
        case "ownership_denied":
          return { kind: "rejected", reason: "ownership_denied" }
        case "self":
          return { kind: "rejected", reason: "self_target" }
        case "running":
          break
      }
      // 4) Resolve endpoint + label, then apply EXACTLY ONE effect.
      const endpoint = deps.control.endpointFor(req.targetTaskId)
      const label = target.mailboxLabel
      switch (req.mode) {
        case "queue":
          return doQueue(req, endpoint, label)
        case "interrupt":
          return doInterrupt(req, endpoint, label)
        case "steer":
          return doSteer(req, endpoint, label)
      }
    },
  }
}

/** Map a steer-submission rejection to its delivery degrade reason. `queue_full`
 *  is a submission-surface concept (bounded admission) that maps to
 *  `action_queue_full`; the three turn/steerability rejections route through the
 *  SSOT {@link steerRejectionToDelivery} bridge (RFC §7). `no_active_turn` /
 *  `turn_mismatch` are the two typed submit rejections the endpoint surfaces. */
const steerSubmitToDegrade = (
  outcome: Exclude<SteerSubmitOutcome, "accepted">,
): DeliveryDegradeReason => {
  switch (outcome) {
    case "no_active_turn": {
      const mapped = steerRejectionToDelivery("no_active_turn")
      // The bridge cannot return the invalid_input sentinel for this arm.
      return mapped === "invalid_input" ? "no_active_turn" : mapped
    }
    case "turn_mismatch": {
      const mapped = steerRejectionToDelivery("expected_turn_mismatch")
      return mapped === "invalid_input" ? "expected_turn_mismatch" : mapped
    }
    case "queue_full":
      return "action_queue_full"
  }
}

/** UTF-8 byte length without allocating a Buffer for the common ASCII path. */
const byteLength = (s: string): number => {
  // Fast path: pure ASCII ⇒ length is byte length.
  let ascii = true
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) {
      ascii = false
      break
    }
  }
  return ascii ? s.length : new TextEncoder().encode(s).length
}
