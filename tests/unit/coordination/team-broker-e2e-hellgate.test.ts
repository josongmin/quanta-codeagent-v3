/**
 * Capability B — Leader-broker — E2E HELLGATE over the LIVE wire.
 *
 * Plan: docs/plans/multiagent-coordination.md §2.B + §3 + §5.
 *
 * This exercises the ACTUAL live path the admissibility gate consults on a
 * worker's SOFT permission denial: `buildLeaderHitlBroker`
 * (`@/agent/coordination-broker-wire`) over a REAL `createSubagentMailbox()`.
 * The escalation round-trip (request → leader-decide → response → apply) runs
 * IN-PROCESS within `escalate()`; the mailbox carries only the audit trail. The
 * prior `brokerLoop` mailbox-read-loop was never wired live and was removed
 * (jun-07) — so this battery now proves the mechanism that genuinely runs.
 *
 * Determinism: the mailbox `now` clock + the correlation-id source are injected
 * (no `Date.now()` / `Math.random`).
 */

import { describe, expect, test } from "bun:test"
import { buildLeaderHitlBroker } from "@/agent/coordination-broker-wire"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { applyDecisionResponse, type EscalationRequest } from "@/subagent/coordination/broker"

const LEADER = "leader"
const WORKER = "worker"

/** A monotonic injected clock — never `Date.now()`. */
const makeClock = () => {
  let t = 1000
  return () => ++t
}

/** A deterministic correlation-id source — never `Math.random`. */
const makeCid = () => {
  let n = 0
  return () => `esc-${n++}`
}

const REQ: EscalationRequest = {
  tool: "shell",
  scope: "exec:git push --force",
  reason: "rewrite remote history per user request",
}

describe("broker e2e — live wire over the real mailbox", () => {
  test("blocked worker escalates → leader approves → worker proceeds", async () => {
    const mailbox = createSubagentMailbox({ now: makeClock() })
    const broker = buildLeaderHitlBroker({
      workerId: WORKER,
      leaderId: LEADER,
      leaderDecide: () => ({ approved: true }),
      mailbox,
      nextCorrelationId: makeCid(),
    })

    expect(await broker.escalate(REQ)).toEqual({ approved: true })

    // The audit trail recorded a leader-authored response (`from === LEADER`),
    // and the audit rows were acked (delivered) so they evict before real mail.
    const responses = mailbox.list({ kind: "response" })
    expect(responses).toHaveLength(1)
    expect(responses[0]?.from).toBe(LEADER)
    expect(responses[0]?.deliveredAt).toBeDefined()
  })

  test("deny path → worker stays blocked, reason surfaced", async () => {
    const mailbox = createSubagentMailbox({ now: makeClock() })
    const broker = buildLeaderHitlBroker({
      workerId: WORKER,
      leaderId: LEADER,
      leaderDecide: () => ({ approved: false, reason: "force-push is denied" }),
      mailbox,
      nextCorrelationId: makeCid(),
    })
    expect(await broker.escalate(REQ)).toEqual({ approved: false, reason: "force-push is denied" })
  })

  test("async leader authority (HITL) is awaited", async () => {
    const broker = buildLeaderHitlBroker({
      workerId: WORKER,
      leaderId: LEADER,
      leaderDecide: async () => {
        await Promise.resolve()
        return { approved: true }
      },
      nextCorrelationId: makeCid(),
    })
    expect(await broker.escalate(REQ)).toEqual({ approved: true })
  })

  test("works with NO audit mailbox — the decision authority is unchanged", async () => {
    const broker = buildLeaderHitlBroker({
      workerId: WORKER,
      leaderId: LEADER,
      leaderDecide: () => ({ approved: true }),
      nextCorrelationId: makeCid(),
    })
    expect(await broker.escalate(REQ)).toEqual({ approved: true })
  })

  test("SECURITY — the grant authority is the leader's decider, never the worker", async () => {
    // The worker has no handle on `leaderDecide`; whatever it puts on the wire,
    // only a leader-authored response widens it. A worker-FORGED response
    // (`from === WORKER`) is rejected by the worker-side applier even with a
    // matching correlationId — the e2e expression of "no self-grant".
    const forged = {
      from: WORKER,
      to: WORKER,
      kind: "response" as const,
      body: JSON.stringify({ approved: true }),
      correlationId: "esc-0",
    }
    expect(applyDecisionResponse(forged, "esc-0", { leaderId: LEADER })).toBeUndefined()

    // And the live wire's own grant is gated purely by `leaderDecide`: a denying
    // leader yields denied regardless of what the worker requested.
    const broker = buildLeaderHitlBroker({
      workerId: WORKER,
      leaderId: LEADER,
      leaderDecide: () => ({ approved: false, reason: "policy" }),
      nextCorrelationId: makeCid(),
    })
    expect(await broker.escalate(REQ)).toEqual({ approved: false, reason: "policy" })
  })
})
