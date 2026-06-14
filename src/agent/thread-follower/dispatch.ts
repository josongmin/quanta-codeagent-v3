/**
 * Thread-follower co-control DISPATCHER (T02) — the live apply seam.
 *
 * Binds the pure protocol ({@link planFollowerVerb}) + the timeout discipline
 * ({@link FollowerVerbTracker}) to the host's EXISTING lease-safe mechanics via
 * injected sinks. A transport (the web/ide daemon frame decoder, or the CLI
 * follower path) calls this dispatcher; it never reaches mutable state itself —
 * the sinks do (pushUserMessage / pushCancel / inbound-mode ref / resolveApproval).
 *
 * TWO verb classes, two cadences:
 *
 *   - FIRE verbs (steer-turn / interrupt-turn / set-queue-mode) apply IMMEDIATELY
 *     via {@link dispatchFollowerVerb}. There is no outstanding request, so the
 *     tracker is not involved. steer → inject into the lease holder's running
 *     turn (never a second writer); interrupt → the lease-bypass cancel.
 *
 *   - The APPROVAL RELAY is the request/response/**timeout** one. The host mints a
 *     pending approval and {@link FollowerCoControlDispatcher.openApproval}
 *     registers it with a deadline (the "request"). A follower's relayed decision
 *     ({@link FollowerCoControlDispatcher.relayApproval}) is the "response": it is
 *     applied ONLY if it lands before the deadline. A late relay is STALE and
 *     DROPPED — it never reaches `resolveApproval` (UC4: no stale-decision relay).
 *     {@link FollowerCoControlDispatcher.sweep} fires the DEFINED fallback for a
 *     timed-out approval: a fail-safe DENY (the stored fallback verb), so an
 *     unanswered approval closes safely rather than hanging.
 *
 * The HARD_DENY re-check rides the relay through {@link planFollowerVerb} (the
 * composition root injects the real `@/permission` hardDenyReason + the proposed-
 * action resolver), so a relay-approve of a dangerous command is rejected
 * fail-closed BEFORE the sink is touched — defense-in-depth alongside the live
 * re-check at the resolver itself.
 *
 * DEFAULT-OFF: the transport only constructs + feeds this when
 * `isFollowerCoControlEnabled(env)` (the QUANTA_THIN_CLIENT_DISPATCH gate) holds.
 */
import type { InboundMode } from "../inbound-mode"
import { FollowerVerbTracker, type StaleReason } from "./timeout"
import {
  type FollowerApprovalDecision,
  type FollowerPlanContext,
  type FollowerVerb,
  planFollowerVerb,
} from "./types"

/** The host effects the dispatcher drives. Each is the EXISTING lease-safe path:
 *  inject → §steer weave; interrupt → lease-bypass cancel; setQueueMode → the
 *  inbound-mode ref; relayApproval → the approval resolver (`approval.respond`). */
export interface FollowerCoControlSinks {
  /** Push a steer message into the lease holder's running turn (NOT a 2nd writer). */
  inject(text: string): void
  /** Abort the active turn (the lease-bypass cancel). */
  interrupt(reason: string): void
  /** Mutate the session inbound-mode ref (queue/weave/interrupt). */
  setQueueMode(mode: InboundMode): void
  /** Forward an approve/deny to the host approval resolver (the same path a local
   *  `approval.respond` takes; the resolver runs its own HARD_DENY re-check). */
  relayApproval(approvalId: string, decision: FollowerApprovalDecision, steer?: string): void
}

/** Outcome of a FIRE-verb dispatch or an approval relay. */
export type FollowerDispatchOutcome =
  | { readonly kind: "applied"; readonly verb: FollowerVerb["kind"] }
  | { readonly kind: "rejected"; readonly reason: string }
  /** The relay was STALE (timed out / unknown / replayed) — DROPPED, not applied. */
  | { readonly kind: "stale"; readonly reason: StaleReason }

/** A timed-out approval whose fallback fired (surfaced by {@link sweep}). */
export interface FollowerApprovalTimeout {
  readonly approvalId: string
  readonly fallback: "deny"
}

export interface FollowerCoControlDeps {
  readonly sinks: FollowerCoControlSinks
  /** Plan context for the HARD_DENY relay re-check (real oracle + action map). */
  readonly plan: FollowerPlanContext
  /** Injected tracker (one per live thread). Defaults to a fresh instance. */
  readonly tracker?: FollowerVerbTracker
}

const FALLBACK_DENY = (approvalId: string): FollowerVerb => ({
  kind: "command-approval-decision",
  approvalId,
  decision: "deny",
})

/**
 * Live follower co-control dispatcher. One instance per session/thread. NO-THROW
 * on every method (a malformed verb collapses to `rejected`); the clock is
 * injected (no `Date.now()`).
 */
export class FollowerCoControlDispatcher {
  readonly #sinks: FollowerCoControlSinks
  readonly #plan: FollowerPlanContext
  readonly #tracker: FollowerVerbTracker

  constructor(deps: FollowerCoControlDeps) {
    this.#sinks = deps.sinks
    this.#plan = deps.plan
    this.#tracker = deps.tracker ?? new FollowerVerbTracker()
  }

  /**
   * Apply a FIRE verb (steer-turn / interrupt-turn / set-queue-mode) immediately.
   * An APPROVAL verb routed here is rejected — relays MUST go through
   * {@link relayApproval} so the timeout/stale guard applies.
   */
  dispatch(verb: FollowerVerb): FollowerDispatchOutcome {
    const effect = planFollowerVerb(verb, this.#plan)
    if (effect.kind === "rejected") return { kind: "rejected", reason: effect.reason }
    switch (effect.kind) {
      case "inject":
        this.#sinks.inject(effect.text)
        return { kind: "applied", verb: "steer-turn" }
      case "interrupt":
        this.#sinks.interrupt(effect.reason)
        return { kind: "applied", verb: "interrupt-turn" }
      case "queue-mode-set":
        this.#sinks.setQueueMode(effect.mode)
        return { kind: "applied", verb: "set-queue-mode" }
      case "approval-relay":
        // An approval decision MUST ride the timeout-bounded relay path, never the
        // immediate fire path — else a stale decision could be applied.
        return { kind: "rejected", reason: "approval decisions must use relayApproval()" }
    }
  }

  /**
   * Register a freshly-minted pending approval as an outstanding REQUEST with a
   * deadline. A follower has until `deadlineAt` to relay a decision; past it the
   * approval times out and {@link sweep} fires the fail-safe DENY fallback.
   * Idempotent on `approvalId` (a retransmit cannot extend the deadline).
   */
  openApproval(approvalId: string, issuedAt: number, deadlineAt: number): boolean {
    return this.#tracker.register({
      verbId: approvalId,
      issuedAt,
      deadlineAt,
      verb: FALLBACK_DENY(approvalId),
    })
  }

  /**
   * Relay a follower's approve/deny for a pending approval. Applied ONLY if it
   * lands before the deadline AND survives the HARD_DENY re-check. A late/replayed
   * relay is STALE and dropped — it never reaches the resolver (UC3 + UC4).
   */
  relayApproval(
    approvalId: string,
    decision: FollowerApprovalDecision,
    now: number,
    steer?: string,
  ): FollowerDispatchOutcome {
    const timing = this.#tracker.resolve(approvalId, now)
    if (timing.kind === "stale") return { kind: "stale", reason: timing.reason }
    // In time — plan the ACTUAL relayed decision (HARD_DENY re-check on approve).
    const verb: FollowerVerb =
      steer !== undefined
        ? { kind: "command-approval-decision", approvalId, decision, steer }
        : { kind: "command-approval-decision", approvalId, decision }
    const effect = planFollowerVerb(verb, this.#plan)
    if (effect.kind !== "approval-relay") {
      return {
        kind: "rejected",
        reason: effect.kind === "rejected" ? effect.reason : "not a relay",
      }
    }
    this.#sinks.relayApproval(effect.approvalId, effect.decision, effect.steer)
    return { kind: "applied", verb: "command-approval-decision" }
  }

  /**
   * Fire the DEFINED fallback for every approval whose deadline passed without a
   * relay: a fail-safe DENY through the resolver. After this, a late relay for the
   * same approval is stale. Returns the approvals that timed out.
   */
  sweep(now: number): readonly FollowerApprovalTimeout[] {
    const out: FollowerApprovalTimeout[] = []
    for (const timedOut of this.#tracker.sweep(now)) {
      // The stored fallback verb is a DENY; forward it (denying is always safe and
      // needs no HARD_DENY re-check).
      this.#sinks.relayApproval(timedOut.verbId, "deny")
      out.push({ approvalId: timedOut.verbId, fallback: "deny" })
    }
    return out
  }

  /** Outstanding (not-yet-resolved/timed-out) approval count — observability. */
  pendingApprovals(): number {
    return this.#tracker.pendingCount()
  }
}
