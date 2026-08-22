/**
 * WS2 (RFC jul-18 §4.2) — the `@/agent`-side child control endpoint + its
 * bounded steer-submission surface.
 *
 * This is the ONLY module that reaches into a child's PRIVATE control state —
 * its {@link SubagentTurnGate} and its `activeTurnRef` — and re-exposes it as a
 * closed set of TYPED commands (wake / interrupt / steer). The
 * `TurnWakeRegistry` stores the resulting {@link SubagentControlEndpoint} but
 * never sees the mutable state: no `ActiveTurnState`, `ConversationActionSurface`,
 * or `AbortController` handle escapes the closure (RFC §4.2, §10).
 *
 * The steer path DELEGATES to the existing {@link steer} authority for the
 * admission-relevant checks (active turn? expected-turn match?) — it does NOT
 * reimplement steer policy and does NOT call the void-returning
 * `pushUserMessage()` and infer success. On admission it retains the
 * {@link SubagentSteerSubmission} — `deliveryId` + one immutable
 * {@link PeerEnvelope} — on a bounded FIFO so the loop (WS3) can finalize or
 * queue-fallback the exact request without a second payload registry.
 *
 * The bounded queue NEVER silently drops or grows without bound: at capacity
 * {@link ChildControlSurface.submitSteer} returns `queue_full`.
 */

import type { SubagentTurnGate } from "@/subagent"
import { type ActiveTurnState, type SteerConfig, type SteerRequest, steer } from "./steering"
import type {
  InterruptControlOutcome,
  SteerSubmitOutcome,
  SubagentControlEndpoint,
  SubagentSteerSubmission,
  WakeControlOutcome,
} from "./subagent-delivery/ports"

/** The child's active-turn holder — the loop OWNS `.current` (writes a fresh
 *  header per turn). The endpoint only READS it (through this immutable view)
 *  to derive the steer admission decision; it never mutates it. */
export interface ActiveTurnRefView {
  readonly current: ActiveTurnState
}

/**
 * The child-side bounded steer-submission surface. Distinct from the generic
 * {@link import("./conversation-action-surface").ConversationActionSurface}
 * FIFO: this one carries `deliveryId` + the immutable {@link PeerEnvelope} on
 * each queued entry (retention for the loop's finalize/fallback) and enforces a
 * hard capacity bound. `submitSteer` returns the typed
 * {@link SteerSubmitOutcome}; the loop drains applied entries via
 * {@link drainSteers}.
 */
export interface ChildControlSurface {
  /** Bounded typed admission. Delegates the active-turn / expected-turn checks
   *  to the {@link steer} authority; on `accepted` enqueues the submission FIFO
   *  (retaining its `deliveryId` + envelope). Returns `queue_full` at capacity —
   *  never silently drops, never grows past `capacity`. */
  submitSteer(submission: SubagentSteerSubmission, state: ActiveTurnState): SteerSubmitOutcome
  /** Drain the admitted submissions in FIFO order (the loop consumes these at
   *  the safe point). Empties the queue. */
  drainSteers(): readonly SubagentSteerSubmission[]
  /** Number of admitted-but-undrained submissions (observability + bound proof). */
  pendingSteers(): number
}

/** Build the bounded child steer surface. `capacity` is the hard FIFO bound
 *  (must be a positive integer); `steerConfig` is the surface's steer policy
 *  (max input bytes), reused verbatim by the {@link steer} authority. */
export const createChildControlSurface = (opts: {
  readonly steerConfig: SteerConfig
  readonly capacity: number
}): ChildControlSurface => {
  const { steerConfig, capacity } = opts
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(
      `createChildControlSurface: capacity must be a positive integer (got ${capacity})`,
    )
  }
  // FIFO of admitted submissions. Single-threaded (JS event loop) so no locking;
  // the head is drained by the loop, the tail appended by `submitSteer`.
  const queue: SubagentSteerSubmission[] = []

  const admissionSteerRequest = (
    submission: SubagentSteerSubmission,
    expectedTurnId: string,
  ): SteerRequest => ({
    expectedTurnId,
    // The envelope body is the (already-sanitized) payload; `steer()` re-checks
    // emptiness/size, but the ADMISSION decision here only consults the
    // active-turn / expected-turn arms (the loop runs the full policy later).
    input: submission.envelope.formattedBody,
    submittedAt: 0,
  })

  return {
    submitSteer(submission: SubagentSteerSubmission, state: ActiveTurnState): SteerSubmitOutcome {
      // Steer inherently targets "the current turn": an OMITTED (empty) expected
      // turn id resolves to the live turn (defense-in-depth — the controller
      // resolves it too). No live turn at all ⇒ `no_active_turn` WITHOUT calling
      // the steer authority, whose `assertRequestShape` THROWS on an empty id
      // (the HIGH-1 seam bug). A non-empty id is honored verbatim (mismatch ⇒
      // `turn_mismatch`).
      const effectiveTurnId =
        submission.expectedTurnId.length > 0 ? submission.expectedTurnId : state.currentTurn?.turnId
      if (effectiveTurnId === undefined) return "no_active_turn"
      // Delegate to the steer authority for the two admission-relevant arms.
      // A steerable, matching turn ⇒ `accepted`; then bound-check the FIFO.
      const outcome = steer(admissionSteerRequest(submission, effectiveTurnId), state, steerConfig)
      if (outcome.kind === "rejected") {
        // Only the two ADMISSION arms map to a typed submit rejection. Any other
        // rejection (non-steerable / interrupted / size) still ADMITS to the
        // bounded queue: the loop finalizes it as a degrade with the precise
        // reason from the retained envelope (RFC §4.3 — one payload, loop
        // finalizes). Collapsing those into `no_active_turn`/`turn_mismatch`
        // here would be a wrong-reason lie, so we do NOT.
        if (outcome.reason === "no_active_turn") return "no_active_turn"
        if (outcome.reason === "expected_turn_mismatch") return "turn_mismatch"
      }
      // Bounded admission: refuse at capacity rather than grow / drop silently.
      if (queue.length >= capacity) return "queue_full"
      queue.push(submission)
      return "accepted"
    },
    drainSteers(): readonly SubagentSteerSubmission[] {
      return queue.splice(0, queue.length)
    },
    pendingSteers(): number {
      return queue.length
    },
  }
}

/**
 * Build the typed control endpoint over a child's PRIVATE state. The returned
 * object exposes ONLY the closed command set — no reference to the gate,
 * surface, or turn-ref escapes as an enumerable property.
 *
 *   - `wake()` — the caller-supplied idle/busy wake (identical to the legacy
 *     gate-backed waker), returning the {@link WakeControlOutcome}.
 *   - `interrupt()` — maps the gate's state to the closed
 *     {@link InterruptControlOutcome}: unarmed ⇒ `not_armed`; parked (idle) ⇒
 *     `woke_idle`; busy + already-interrupted ⇒ `already_interrupted` (no
 *     double-abort); busy + not-yet-interrupted ⇒ `interrupted_active` (aborts
 *     the in-flight turn).
 *   - `steer(submission)` — reads the child's `activeTurnRef` and delegates to
 *     the bounded {@link ChildControlSurface.submitSteer}.
 */
export const createChildControlEndpoint = (deps: {
  readonly gate: SubagentTurnGate
  readonly surface: ChildControlSurface
  readonly activeTurnRef: ActiveTurnRefView
  readonly mailboxLabel: string
  /** The idle/busy wake, identical to the legacy gate-backed waker. Injected
   *  (rather than captured) so a `followup`-reason wake and the endpoint's
   *  `wake()` are the SAME single seam. */
  readonly wake: (reason: string) => WakeControlOutcome
}): SubagentControlEndpoint => {
  const { gate, surface, activeTurnRef, mailboxLabel } = deps
  return {
    mailboxLabel,
    wake(): WakeControlOutcome {
      // A plain (non-interrupt) wake — idle→woke / busy→queued (the gate never
      // returns "no-receiver"; that is the registry's own absence sentinel).
      return deps.wake("followup")
    },
    interrupt(): InterruptControlOutcome {
      // No turn has been entered yet ⇒ nothing in flight AND nothing parked.
      if (!gate.isArmed() && !gate.isParked()) return "not_armed"
      // Parked (idle) ⇒ interrupt is a plain wake that releases the park.
      if (gate.isParked()) {
        gate.wake("interrupt")
        return "woke_idle"
      }
      // Busy (armed, mid-turn). A repeat interrupt must NOT re-abort / re-capture
      // — the first already fired and recorded the pending resume.
      if (gate.wasInterrupted()) return "already_interrupted"
      gate.wake("interrupt") // aborts the in-flight turn's per-turn controller
      return "interrupted_active"
    },
    steer(submission: SubagentSteerSubmission): SteerSubmitOutcome {
      // Read the child's CURRENT turn state (the loop owns the writes) and hand
      // the admission decision to the bounded surface. The endpoint never
      // mutates the ref and never exposes it.
      return surface.submitSteer(submission, activeTurnRef.current)
    },
    currentTurnId(): string | undefined {
      // A typed READ of the live turn id (no mutable state escapes) so the
      // controller can resolve an omitted `expectedTurnId` to "the current turn".
      return activeTurnRef.current.currentTurn?.turnId
    },
  }
}
