/**
 * Peer teammate messaging — team-scoped mailbox decorator (RFC jun-6, DELTA #2).
 *
 * A pure DECORATOR over the EXISTING {@link MailboxPort} (NOT a new store — the
 * audit-H per-recipient delivery cursor, LRU, per-sender quota, and snapshot
 * are load-bearing and stay UNTOUCHED). It adds ONE thing: a delivery-time
 * membership gate at `send`:
 *
 *   - a DIRECT `send({from,to})` to a DIFFERENT team is DROPPED before enqueue
 *     (the cross-team deny) — it never reaches the victim's delivery cursor, so
 *     a cross-team peer can't even place a forged `response` into a victim's
 *     correlationId stream. The dropped message is returned UNDELIVERED (it is
 *     never stored) so the caller still gets a `MailboxMessage` (port contract),
 *     but `pendingFor(to)` is unaffected.
 *   - a BROADCAST `to:"*"` is FANNED OUT to the SENDER'S OWN TEAM ROSTER only
 *     (one direct `send` per same-team member), never the whole session. A
 *     sender with no team broadcasts to no one (un-teamed ⇒ no bus).
 *
 * `read`/`peek`/`ack`/`list`/`pendingFor`/`toSnapshot`/`fromSnapshot` delegate
 * UNCHANGED — a recipient only ever sees mail addressed to it, and cross-team
 * mail was never enqueued for it.
 *
 * SLICE FENCE: this file imports ONLY the sibling `./types` (typed port) — it
 * takes the membership gate as a DUCK-TYPED port (`TeamMembershipGate`) so the
 * slice does NOT import `@/subagent`. The host passes the `TeamRegistryPort`
 * (which structurally satisfies the gate). NO-THROW: a throwing gate degrades to
 * "deny" (fail-closed) so a hostile/buggy registry can never widen delivery.
 */

import type { MailboxMessage, MailboxPort } from "./types"

/** The slice of `TeamRegistryPort` the decorator needs (duck-typed so the
 *  mailbox slice never imports `@/subagent`). `TeamRegistryPort` satisfies it. */
export interface TeamMembershipGate {
  /** Are `a` and `b` in the SAME team? Cross-team / un-teamed ⇒ false. */
  sameTeam(a: string, b: string): boolean
  /** The members of the team `agentId` belongs to (for broadcast fan-out).
   *  Includes `agentId` itself; the underlying store never delivers to self. */
  membersOf(agentId: string): readonly string[]
}

const BROADCAST = "*"

/** A best-effort UNDELIVERED message for a denied/dropped `send` so the port
 *  contract (always returns a `MailboxMessage`) holds without enqueuing. */
const droppedMessage = (init: {
  from: string
  to: string
  kind: MailboxMessage["kind"]
  body: string
  correlationId?: string
}): MailboxMessage =>
  Object.freeze({
    id: "msg_cross-team-denied",
    from: init.from,
    to: init.to,
    kind: init.kind,
    body: init.body,
    sentAt: 0,
    ...(init.correlationId !== undefined ? { correlationId: init.correlationId } : {}),
  })

/** Fan a broadcast out to the sender's OWN team roster only (one direct `send`
 *  per same-team member, never the whole session). No same-team peers ⇒ nothing
 *  enqueued; returns the last enqueued message or an undelivered stand-in.
 *  Module-level so the port's `send` stays under the cognitive-complexity cap. */
const fanOutBroadcast = (
  inner: MailboxPort,
  roster: readonly string[],
  from: string,
  init: Parameters<MailboxPort["send"]>[0],
): MailboxMessage => {
  let last: MailboxMessage | null = null
  for (const member of roster) {
    if (member === from) continue // store never delivers to self anyway
    last = inner.send({ ...init, to: member })
  }
  return last ?? droppedMessage({ ...init, from, to: BROADCAST })
}

/**
 * Wrap `inner` so cross-team `send`s are denied before enqueue and broadcasts
 * are scoped to the sender's own team. Every other method delegates unchanged.
 *
 * An empty / non-string `from`/`to` falls through to the cross-team deny
 * (fail-closed) rather than the inner port — a malformed address can't widen.
 */
export const teamScopedMailbox = (inner: MailboxPort, gate: TeamMembershipGate): MailboxPort => {
  const sameTeamSafe = (a: string, b: string): boolean => {
    try {
      return gate.sameTeam(a, b) === true
    } catch {
      return false // fail-closed: a throwing gate denies (never widens)
    }
  }
  const membersSafe = (agentId: string): readonly string[] => {
    try {
      const m = gate.membersOf(agentId)
      return Array.isArray(m) ? m : []
    } catch {
      return []
    }
  }

  return {
    send(init): MailboxMessage {
      const from = typeof init?.from === "string" ? init.from : ""
      const to = typeof init?.to === "string" ? init.to : ""
      // Broadcast: fan out to the sender's OWN team roster only (never session).
      if (to === BROADCAST) return fanOutBroadcast(inner, membersSafe(from), from, init)
      // Direct: deny cross-team BEFORE enqueue (never reaches victim's cursor).
      if (!sameTeamSafe(from, to)) return droppedMessage({ ...init, from, to })
      return inner.send(init)
    },

    read(agentId, opts): readonly MailboxMessage[] {
      return inner.read(agentId, opts)
    },
    peek(agentId, opts): readonly MailboxMessage[] {
      return inner.peek(agentId, opts)
    },
    ack(messageId): MailboxMessage | null {
      return inner.ack(messageId)
    },
    list(filter): readonly MailboxMessage[] {
      return inner.list(filter)
    },
    pendingFor(agentId): number {
      return inner.pendingFor(agentId)
    },
    toSnapshot() {
      return inner.toSnapshot()
    },
    fromSnapshot(snap): void {
      inner.fromSnapshot(snap)
    },
  }
}
