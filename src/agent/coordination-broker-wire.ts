/**
 * Capability B (multi-agent coordination) — composition-root wire that adapts a
 * spawning LEADER's HITL authority into the {@link GateEscalationBroker} the
 * admissibility gate consults on a worker's SOFT permission denial.
 *
 * The gate (security SSOT) stays decoupled: it knows only the duck-typed
 * `escalate(req) => {approved}` method. THIS file is the only place `@/agent`
 * touches `@/subagent/coordination`'s broker, threading the REAL security model
 * through the live path:
 *
 *   1. worker emits an escalation `request` (audit/transport) — `from=workerId`,
 *      `to=leaderId`, fresh `correlationId`.
 *   2. the LEADER authority (`leaderDecide`, wrapping the parent agent's
 *      HITL/onConfirm) produces the {@link EscalationDecision} — the worker does
 *      NOT author it.
 *   3. the leader's `response` is serialized via `buildDecisionResponse` and
 *      emitted `from=leaderId`.
 *   4. the worker applies it via `applyDecisionResponse(..., {leaderId})` — the
 *      load-bearing check `from === leaderId` means a worker can NEVER self-grant.
 *
 * SECURITY: the grant authority is `leaderDecide`, injected by the composition
 * root — the worker cannot make it approve, and `applyDecisionResponse` pins
 * `leaderId`. HARD_DENY never reaches here (the gate excludes it before calling
 * `escalate`). Determinism: the correlation-id source is injected (no
 * `Math.random` / `Date.now` in this module). NO-THROW: a throwing
 * `leaderDecide` / mailbox propagates to the gate, which fail-closes to denied.
 */

import {
  applyDecisionResponse,
  buildDecisionResponse,
  type EscalationDecision,
  type EscalationRequest,
} from "@/subagent/coordination"
import type { GateEscalationBroker } from "./admissibility-gate"

/** The leader's decision authority — wraps the parent agent's HITL/onConfirm.
 *  Owned by the LEADER (the worker never sees it). Sync or async. */
export type LeaderEscalationDecider = (
  req: EscalationRequest,
) => EscalationDecision | Promise<EscalationDecision>

/** The minimal mailbox surface the wire uses for the audit/transport trail.
 *  A structural subset of the real `MailboxPort` (`send` + optional `ack`). The
 *  escalation decision is made IN-PROCESS by `leaderDecide`; these two rows are
 *  a pure audit trail that nobody reads. `send` returns the stored message so
 *  the wire can {@link BrokerWireMailbox.ack} it: an un-acked (undelivered) row
 *  lingers in the bounded shared mailbox and — because eviction prefers
 *  DELIVERED rows — can crowd out legitimate sibling↔sibling mail under
 *  sustained soft-denials. Acking marks the audit rows delivered so they evict
 *  FIRST, keeping the mailbox budget for real traffic. */
export interface BrokerWireMailbox {
  send(init: {
    from: string
    to: string
    kind: "request" | "response" | "broadcast"
    body: string
    correlationId?: string
  }): { readonly id?: string } | undefined
  /** Mark an audit row delivered (so it is evicted before real mail). Optional —
   *  a fake mailbox may omit it; the wire only acks when both `ack` + an id exist. */
  ack?(messageId: string): unknown
}

export interface LeaderHitlBrokerDeps {
  /** This worker's stable mailbox id (`config.mailboxAgentId`). */
  readonly workerId: string
  /** The spawning leader's stable mailbox id (`config.mailboxParentId`). */
  readonly leaderId: string
  /** The leader's HITL authority — the ONLY thing that can widen the worker. */
  readonly leaderDecide: LeaderEscalationDecider
  /** Audit/transport sink. Absent ⇒ the round-trip still validates in-memory
   *  (no observable mailbox rows); the decision authority is unchanged. */
  readonly mailbox?: BrokerWireMailbox
  /** Injected correlation-id source (determinism — NOT `Math.random`). Called
   *  once per escalation. */
  readonly nextCorrelationId: () => string
}

/**
 * Build the {@link GateEscalationBroker} for a worker subagent. The composition
 * root injects this onto `config.admissibility.coordinationBroker` ONLY when
 * `QUANTA_TEAM_BROKER` is on and the worker has a leader + authority.
 */
export const buildLeaderHitlBroker = (deps: LeaderHitlBrokerDeps): GateEscalationBroker => ({
  async escalate(req) {
    const correlationId = deps.nextCorrelationId()

    // Emit an audit row + immediately ack it (mark delivered) so the bounded
    // shared mailbox evicts these dead audit cells before any real sibling mail.
    const auditSend = (init: {
      from: string
      to: string
      kind: "request" | "response"
      body: string
      correlationId: string
    }): void => {
      const sent = deps.mailbox?.send(init)
      const id = (sent as { readonly id?: string } | undefined)?.id
      if (id !== undefined && deps.mailbox?.ack) deps.mailbox.ack(id)
    }

    // 1. worker → leader request (audit/transport).
    auditSend({
      from: deps.workerId,
      to: deps.leaderId,
      kind: "request",
      body: JSON.stringify(req),
      correlationId,
    })

    // 2. LEADER authority decides (the worker does not author this).
    const decision = await deps.leaderDecide(req)

    // 3. serialize the leader's response (from = leaderId) — audit/transport.
    const response = buildDecisionResponse(
      { from: deps.workerId, to: deps.leaderId, kind: "request", body: "", correlationId },
      decision,
    )
    auditSend({
      from: deps.leaderId,
      to: deps.workerId,
      kind: "response",
      body: response.body,
      correlationId,
    })

    // 4. worker validates the LEADER-authored response (from === leaderId).
    //    SECURITY: a worker-authored / mis-correlated / non-leader response is
    //    rejected here, so the gate only admits on a genuine leader grant.
    const applied = applyDecisionResponse(
      {
        from: deps.leaderId,
        to: deps.workerId,
        kind: "response",
        body: response.body,
        correlationId,
      },
      correlationId,
      { leaderId: deps.leaderId },
    )

    if (applied?.approved === true) return { approved: true }
    return {
      approved: false,
      reason:
        applied !== undefined && applied.approved === false ? applied.reason : "leader denied",
    }
  },
})
