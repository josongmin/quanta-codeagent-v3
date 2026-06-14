/**
 * Thread-follower co-control DISPATCHER (T02) — the live FIRE-verb apply seam.
 *
 * Binds the pure protocol ({@link planFollowerVerb}) to the host's EXISTING
 * lease-safe mechanics via injected sinks. A transport (the web/ide daemon frame
 * decoder, or the CLI follower path) calls {@link FollowerCoControlDispatcher.dispatch};
 * it never reaches mutable state itself — the sinks do (pushUserMessage /
 * pushCancel / the inbound-mode ref).
 *
 * SCOPE — FIRE verbs only (steer-turn / interrupt-turn / set-queue-mode), which
 * apply IMMEDIATELY:
 *   - steer → inject into the lease holder's running turn (never a 2nd writer).
 *   - interrupt → the lease-bypass cancel.
 *   - set-queue-mode → the inbound-mode ref.
 *
 * The APPROVAL RELAY (the request/response/**timeout** verb) is NOT handled here
 * — it has its own production home, {@link createFollowerApprovalCoordinator}
 * (the timeout/stale discipline + a `respond` sink bound to the host approval
 * resolver, where the LIVE HARD_DENY re-check lives). An approval verb routed to
 * {@link dispatch} is rejected (it must ride the coordinator), so a stale or
 * unchecked decision can never slip through this immediate path.
 *
 * DEFAULT-OFF: the transport only constructs + feeds this when
 * `isFollowerCoControlEnabled(env)` (the QUANTA_THIN_CLIENT_DISPATCH gate) holds.
 */
import type { InboundMode } from "../inbound-mode"
import { type FollowerVerb, planFollowerVerb } from "./types"

/** The host effects the dispatcher drives — each is an EXISTING lease-safe path:
 *  inject → §steer weave; interrupt → lease-bypass cancel; setQueueMode → the
 *  inbound-mode ref. */
export interface FollowerCoControlSinks {
  /** Push a steer message into the lease holder's running turn (NOT a 2nd writer). */
  inject(text: string): void
  /** Abort the active turn (the lease-bypass cancel). */
  interrupt(reason: string): void
  /** Mutate the session inbound-mode ref (queue/weave/interrupt). */
  setQueueMode(mode: InboundMode): void
}

/** Outcome of a FIRE-verb dispatch. */
export type FollowerDispatchOutcome =
  | { readonly kind: "applied"; readonly verb: FollowerVerb["kind"] }
  | { readonly kind: "rejected"; readonly reason: string }

export interface FollowerCoControlDeps {
  readonly sinks: FollowerCoControlSinks
  /** Plan context (HARD_DENY oracle for the rejected approval arm — optional;
   *  the FIRE verbs need none). */
  readonly plan?: Parameters<typeof planFollowerVerb>[1]
}

/**
 * Live follower FIRE-verb dispatcher. One instance per session/thread. NO-THROW
 * (a malformed verb collapses to `rejected`); performs no I/O of its own.
 */
export class FollowerCoControlDispatcher {
  readonly #sinks: FollowerCoControlSinks
  readonly #plan: Parameters<typeof planFollowerVerb>[1]

  constructor(deps: FollowerCoControlDeps) {
    this.#sinks = deps.sinks
    this.#plan = deps.plan ?? {}
  }

  /**
   * Apply a FIRE verb (steer-turn / interrupt-turn / set-queue-mode) immediately.
   * An APPROVAL verb is rejected — relays MUST ride
   * {@link createFollowerApprovalCoordinator} so the timeout/stale + resolver
   * HARD_DENY guards apply.
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
        return { kind: "rejected", reason: "approval decisions must use the approval coordinator" }
    }
  }
}
