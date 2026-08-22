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

import type {
  DeliveryIdFactory,
  InterruptControlOutcome,
  SteerSubmitOutcome,
  SubagentControlEndpoint,
  SubagentControlRegistry,
  SubagentDeliveryOutcome,
  SubagentDeliveryPort,
  SubagentDeliveryReceipt,
  SubagentDeliveryRequest,
  SubagentSteerFinalizationPort,
  WakeControlOutcome,
} from "./ports"
import { type DeliveryDegradeReason, steerRejectionToDelivery } from "./types"

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
  /** The reused peer formatter (RFC §4.5) — redact → escape → untrusted provenance
   *  — for the DIRECT-to-model steer injection. */
  readonly formatPeer: PeerFormatter
  /** RFC §4.5 "one sanitizer, ALL modes" — the secret redactor applied to EVERY
   *  body the controller places in the MAILBOX (queue / interrupt / all steer
   *  fallbacks). The mailbox drain's own redactor is wired only under
   *  `QUANTA_TEAM_PEER_MSG`, and the manual `subagent_read_messages` never redacts,
   *  so redacting at the enqueue boundary makes a peer secret drain-independent
   *  (hellaudit — a secret in a queued/fallback body must never reach the child
   *  model raw). Default identity ⇒ byte-identical when unwired. Idempotent, so a
   *  later drain-redactor re-pass is harmless. */
  readonly redact?: (body: string) => string
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
  /** WS4 — the shared retention store. When present, an ACCEPTED steer's address
   *  + sanitized body are retained here (keyed by `deliveryId`) so the loop's
   *  {@link createSubagentSteerFinalization} port can perform the ONE mailbox
   *  fallback from the retained envelope without a second payload registry
   *  (RFC §4.3). Absent ⇒ WS3 behavior (accepted with no retention wired). */
  readonly steerRetention?: SteerRetentionStore
}

const DEFAULT_MAX_BODY_BYTES = 8192

// ─────────────────────────────────────────────────────────────────────────────
// WS4 (RFC jul-18 §3.5, §4.3) — steer RETENTION + the loop's finalization port.
//
// An accepted steer is admission-only: the controller returns `accepted` and the
// PAYLOAD is retained here (keyed by `deliveryId`) so the loop can later close it
// EXACTLY ONCE — `finalizeApplied` (consumed at the safe point), `finalizeFallback`
// (late reject / interrupt supersession / budget exhaustion ⇒ the ONE mailbox
// fallback from the retained envelope), or `finalizeCancelled` (session teardown).
//
// Retention is a plain data map (RFC §4.3 — "keeps pending actions as data, avoids
// callback-bearing queue entries and a second payload registry"). The mailbox
// mutation stays in ONE owner (the mailbox send port). A finalize on an already-
// closed or never-admitted id is INERT (a stale callback must never double-emit a
// receipt or double-send a mailbox copy — RFC §5.8–5.9, DoD #5).
// ─────────────────────────────────────────────────────────────────────────────

/** The retained address+body for an accepted steer — the minimum the ONE mailbox
 *  fallback needs (`from`/`to`/`body`, plus optional correlation). The `body` is
 *  the ALREADY-sanitized peer string (the same `formattedBody` the steer action
 *  carries) so a fallback re-send never re-mangles or re-trusts the payload. */
export interface RetainedSteer {
  readonly from: string
  readonly to: string
  readonly body: string
  readonly correlationId?: string
}

/** A monotonic single-slot-per-delivery retention store shared by the controller
 *  (registers at admission) and the finalization port (claim/commit at close).
 *  The finalizer observes the payload before committing deletion so adapter
 *  failure can still terminate with a correlated typed receipt. */
export interface SteerRetentionStore {
  retain(deliveryId: string, entry: RetainedSteer): void
  /** Atomically moves a pending slot to `claimed`. A duplicate/re-entrant claim
   *  returns undefined, preventing a second mailbox send or receipt. */
  claim(deliveryId: string): RetainedSteer | undefined
  /** Removes a previously claimed slot after its terminal result is known. */
  commit(deliveryId: string): boolean
  has(deliveryId: string): boolean
  size(): number
}

export const makeSteerRetentionStore = (): SteerRetentionStore => {
  type Slot =
    | { readonly state: "pending"; readonly entry: RetainedSteer }
    | { readonly state: "claimed"; readonly entry: RetainedSteer }
  const map = new Map<string, Slot>()
  return {
    retain(deliveryId, entry): void {
      map.set(deliveryId, { state: "pending", entry })
    },
    claim(deliveryId): RetainedSteer | undefined {
      const slot = map.get(deliveryId)
      if (slot?.state !== "pending") return undefined
      map.set(deliveryId, { state: "claimed", entry: slot.entry })
      return slot.entry
    },
    commit(deliveryId): boolean {
      const slot = map.get(deliveryId)
      return slot?.state === "claimed" ? map.delete(deliveryId) : false
    },
    has(deliveryId): boolean {
      return map.has(deliveryId)
    },
    size(): number {
      return map.size
    },
  }
}

export interface SteerFinalizationDeps {
  readonly store: SteerRetentionStore
  readonly mailbox: DeliveryMailboxPort
  /** Where a correlated final {@link SubagentDeliveryReceipt} is delivered (the
   *  host wires the tool-result / observability sink). */
  readonly onReceipt: (receipt: SubagentDeliveryReceipt) => void
  /** Optional observability hook for a broken receipt adapter. It is diagnostic
   *  only: neither it nor `onReceipt` may alter delivery/finalization behavior. */
  readonly onReceiptError?: (error: unknown) => void
}

/**
 * Build the loop's {@link SubagentSteerFinalizationPort} (RFC §4.3). Each accepted
 * delivery terminates in EXACTLY ONE receipt:
 *   - `finalizeApplied`   ⇒ one `applied` receipt; NO mailbox copy (the model saw
 *                            the injection at the safe point — RFC §3.4).
 *   - `finalizeFallback`  ⇒ the ONE mailbox fallback from the retained envelope +
 *                            one `degraded` receipt with the typed reason.
 *   - `finalizeCancelled` ⇒ one `cancelled` receipt; NO mailbox copy.
 *   - a throwing mailbox adapter ⇒ one terminal `failed(mailbox_error)` receipt.
 * The slot is committed exactly once after the terminal outcome is known. A
 * stale/duplicate finalize is inert (no second receipt, no second send).
 */
export const createSubagentSteerFinalization = (
  deps: SteerFinalizationDeps,
): SubagentSteerFinalizationPort => {
  const { store, mailbox, onReceipt, onReceiptError } = deps
  const emitReceipt = (receipt: SubagentDeliveryReceipt): void => {
    try {
      onReceipt(receipt)
    } catch (error) {
      // A UI/telemetry adapter is observational. Report it when possible, but
      // never let either diagnostic sink poison the child loop or duplicate a
      // delivery that has already reached its terminal state.
      try {
        onReceiptError?.(error)
      } catch {
        // Last-resort containment: there is no lower delivery authority to call.
      }
    }
  }
  return {
    finalizeApplied(deliveryId, targetTurnId): void {
      // The retained payload was consumed by the model at the safe point — DROP
      // it (no mailbox copy) and emit the correlated applied receipt.
      if (store.claim(deliveryId) === undefined) return
      store.commit(deliveryId)
      emitReceipt({ deliveryId, kind: "applied", effectiveMode: "steer", targetTurnId })
    },
    finalizeFallback(deliveryId, reason): void {
      const retained = store.claim(deliveryId)
      if (retained === undefined) return // stale / never-admitted ⇒ inert
      let msg: { readonly id: string }
      try {
        msg = mailbox.send({
          from: retained.from,
          to: retained.to,
          kind: "request",
          body: retained.body,
          ...(retained.correlationId !== undefined
            ? { correlationId: retained.correlationId }
            : {}),
        })
      } catch {
        store.commit(deliveryId)
        emitReceipt({ deliveryId, kind: "failed", reason: "mailbox_error" })
        return
      }
      store.commit(deliveryId)
      emitReceipt({
        deliveryId,
        kind: "degraded",
        effectiveMode: "queue",
        reason,
        effect: "queued",
        messageId: msg.id,
      })
    },
    finalizeCancelled(deliveryId, reason): void {
      if (store.claim(deliveryId) === undefined) return
      store.commit(deliveryId)
      emitReceipt({ deliveryId, kind: "cancelled", reason })
    },
  }
}

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

/** WS4 — retain an ACCEPTED steer's address + sanitized body into the shared
 *  retention store (when wired) so the loop's finalization port can perform the
 *  ONE mailbox fallback from the retained envelope (RFC §4.3). The `body` is the
 *  SAME `formattedBody` the steer action carries, so a fallback never re-mangles
 *  or re-trusts the payload. No-op when no retention store is wired. */
const retainAcceptedSteer = (
  deps: SubagentDeliveryControllerDeps,
  req: SubagentDeliveryRequest,
  label: string | undefined,
  deliveryId: string,
  rawBody: string,
): void => {
  // Retain the RAW (unformatted) body: a `finalizeFallback` re-enqueues this into
  // the mailbox, and the mailbox DRAIN applies the peer formatter exactly once
  // (same as the queue path's raw `enqueue`). Hellaudit R3-MED-1: retaining the
  // already-`[teammate …]`-wrapped body double-wrapped it on the fallback drain.
  deps.steerRetention?.retain(deliveryId, {
    from: req.from,
    to: label ?? deps.control.labelOf(req.targetTaskId) ?? req.targetTaskId,
    // Redacted-but-unwrapped: a later `finalizeFallback` enqueues this and the
    // mailbox drain wraps it ONCE (R3-MED-1), while the secret is already scrubbed
    // (RFC §4.5, drain-independent). `redact` is idempotent.
    body: redactBody(deps, rawBody),
    ...(req.correlationId !== undefined ? { correlationId: req.correlationId } : {}),
  })
}

/** Enqueue the payload once and return its message id (the ONE mailbox mutation
 *  on any queue/degrade path). Resolves the delivery address to the child's
 *  mailbox label (task id → `root/N`); falls back to the task id when no label is
 *  bound. Module-level so the three mode handlers share one impl (SE size gate). */
/** RFC §4.5 — scrub secrets from a body bound for the MAILBOX (drain-independent;
 *  see {@link SubagentDeliveryControllerDeps.redact}). Identity when unwired. */
const redactBody = (deps: SubagentDeliveryControllerDeps, body: string): string =>
  deps.redact ? deps.redact(body) : body

const enqueue = (
  deps: SubagentDeliveryControllerDeps,
  req: SubagentDeliveryRequest,
  label: string | undefined,
): string => {
  const to = label ?? deps.control.labelOf(req.targetTaskId) ?? req.targetTaskId
  const msg = deps.mailbox.send({
    from: req.from,
    to,
    kind: "request",
    body: redactBody(deps, req.body),
    ...(req.correlationId !== undefined ? { correlationId: req.correlationId } : {}),
  })
  return msg.id
}

/** Queue delivery: send once, then (ensure-turn only) wake. Passive never wakes.
 *  A missing endpoint / no-receiver on ensure-turn is a typed retained-payload
 *  degrade, never a reject (delivery already occurred). */
const doQueue = (
  deps: SubagentDeliveryControllerDeps,
  req: SubagentDeliveryRequest,
  endpoint: SubagentControlEndpoint | undefined,
  label: string | undefined,
): SubagentDeliveryOutcome => {
  const deliveryId = deps.newDeliveryId()
  const messageId = enqueue(deps, req, label)
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

/** The `applied/interrupt` outcome arm — the SAME literal shape for every
 *  interrupt effect that guarantees a turn WILL run (`interrupted_active` /
 *  `woke_idle` / `not_armed`). */
const interruptApplied = (
  deliveryId: string,
  messageId: string,
  targetTurnId: string,
): SubagentDeliveryOutcome => ({
  kind: "applied",
  deliveryId,
  requestedMode: "interrupt",
  effectiveMode: "interrupt",
  effect: "interrupted",
  messageId,
  targetTurnId,
})

const doInterrupt = (
  deps: SubagentDeliveryControllerDeps,
  req: SubagentDeliveryRequest,
  endpoint: SubagentControlEndpoint | undefined,
  label: string | undefined,
): SubagentDeliveryOutcome => {
  const deliveryId = deps.newDeliveryId()
  // RFC §3.4 — enqueue FIRST, then fire the per-turn abort. If control fails, the
  // queued payload is recoverable and the outcome is a typed degrade.
  const messageId = enqueue(deps, req, label)
  if (endpoint === undefined) {
    return degradeOutcome(deliveryId, "interrupt", "control_unavailable", "queued", messageId)
  }
  const outcome: InterruptControlOutcome = endpoint.interrupt()
  const turnId = req.expectedTurnId ?? ""
  switch (outcome) {
    case "interrupted_active":
      return interruptApplied(deliveryId, messageId, turnId)
    case "already_interrupted":
      // A prior interrupt already aborted; this one shares the pending resume and
      // queues in FIFO order. Typed degrade (RFC §5.5).
      return degradeOutcome(deliveryId, "interrupt", "already_interrupted", "queued", messageId)
    case "woke_idle":
      // Nothing was in flight to abort; the fresh turn drains the queued payload —
      // an interrupt of an idle child collapses to queue+ensure-turn and a turn
      // WILL run, so this is `applied`, not a degrade (RFC §3.1).
      return interruptApplied(deliveryId, messageId, turnId)
    case "not_armed":
      // The child has entered no turn yet (nothing armed, nothing parked) — it is
      // mid-spawn. Delivery is still guaranteed WITHOUT a wake: a freshly-spawned
      // child runs turn 1 (armTurn → run → only THEN can it park), and the payload
      // (enqueued above, RFC §3.4) is drained at that turn's top. Same §3.1 idle
      // collapse as woke_idle — a turn WILL run and consume the message.
      return interruptApplied(deliveryId, messageId, turnId)
  }
}

const doSteer = (
  deps: SubagentDeliveryControllerDeps,
  req: SubagentDeliveryRequest,
  endpoint: SubagentControlEndpoint | undefined,
  label: string | undefined,
): SubagentDeliveryOutcome => {
  const deliveryId = deps.newDeliveryId()
  // The `steerEnabled` gate (mode_disabled) fired earlier in `deliver`; reaching
  // here means steer is wired. No control endpoint for a running target ⇒ one
  // mailbox fallback + typed `control_unavailable` degrade (RFC §5.3) — the
  // payload is retained, never a reject.
  if (endpoint === undefined) {
    const messageId = enqueue(deps, req, label)
    return degradeOutcome(deliveryId, "steer", "control_unavailable", "queued", messageId)
  }
  // Resolve the target turn. `expectedTurnId` is honored when the caller supplies
  // it (a specific turn); steer inherently means "the current turn", so an OMITTED
  // id resolves to the child's live turn via the endpoint's typed read. A truly
  // absent active turn ⇒ ONE mailbox fallback + `no_active_turn` degrade (never an
  // empty-string submission into the throwing steer authority — HIGH-1 fix).
  const resolvedTurnId = req.expectedTurnId ?? endpoint.currentTurnId()
  if (resolvedTurnId === undefined) {
    const messageId = enqueue(deps, req, label)
    return degradeOutcome(deliveryId, "steer", "no_active_turn", "queued", messageId)
  }
  // Build the SANITIZED envelope (RFC §4.5) — a raw teammate body may never be
  // injected as a trusted string.
  const submission = {
    deliveryId,
    envelope: {
      from: req.from,
      formattedBody: deps.formatPeer(req.from, "request", req.body),
      ...(req.correlationId !== undefined ? { correlationId: req.correlationId } : {}),
    },
    expectedTurnId: resolvedTurnId,
  }
  const outcome: SteerSubmitOutcome = endpoint.steer(submission)
  if (outcome === "accepted") {
    // Admission only — NO mailbox copy (RFC §3.4). The correlated applied /
    // degraded receipt arrives later from the loop's safe point (WS4 seam:
    // `deps.finalization`). RETAIN the address + sanitized body so a later
    // `finalizeFallback` can perform the ONE mailbox fallback (RFC §4.3).
    retainAcceptedSteer(deps, req, label, deliveryId, req.body)
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
  const messageId = enqueue(deps, req, label)
  const reason = steerSubmitToDegrade(outcome)
  return degradeOutcome(deliveryId, "steer", reason, "queued", messageId)
}

/** Validate + resolve the target BEFORE any mutation (RFC §3.2, §5.1–5.2). Returns
 *  a `rejected` outcome (never a mutation), or `{ endpoint, label }` to apply. */
const admitDelivery = (
  deps: SubagentDeliveryControllerDeps,
  req: SubagentDeliveryRequest,
  maxBytes: number,
):
  | { readonly rejected: SubagentDeliveryOutcome }
  | {
      readonly endpoint: SubagentControlEndpoint | undefined
      readonly label: string | undefined
    } => {
  if (typeof req.body !== "string" || req.body.length === 0) {
    return { rejected: { kind: "rejected", reason: "invalid_input" } }
  }
  if (byteLength(req.body) > maxBytes) {
    return { rejected: { kind: "rejected", reason: "invalid_input" } }
  }
  // Steer gate — reject mode_disabled BEFORE target lookup / mutation (RFC §9:
  // gate OFF ⇒ mode_disabled, never a silent queue).
  if (req.mode === "steer" && !deps.steerEnabled) {
    return { rejected: { kind: "rejected", reason: "mode_disabled" } }
  }
  const target = deps.resolveTarget(req.targetTaskId)
  switch (target.kind) {
    case "unknown":
      return { rejected: { kind: "rejected", reason: "target_unknown" } }
    case "settled":
      return { rejected: { kind: "rejected", reason: "target_settled" } }
    case "ownership_denied":
      return { rejected: { kind: "rejected", reason: "ownership_denied" } }
    case "self":
      return { rejected: { kind: "rejected", reason: "self_target" } }
    case "running":
      return { endpoint: deps.control.endpointFor(req.targetTaskId), label: target.mailboxLabel }
  }
}

export const createSubagentDeliveryController = (
  deps: SubagentDeliveryControllerDeps,
): SubagentDeliveryPort => {
  const maxBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  return {
    deliver(req: SubagentDeliveryRequest): SubagentDeliveryOutcome {
      const admission = admitDelivery(deps, req, maxBytes)
      if ("rejected" in admission) return admission.rejected
      const { endpoint, label } = admission
      // Apply EXACTLY ONE effect for the requested mode.
      switch (req.mode) {
        case "queue":
          return doQueue(deps, req, endpoint, label)
        case "interrupt":
          return doInterrupt(deps, req, endpoint, label)
        case "steer":
          return doSteer(deps, req, endpoint, label)
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
