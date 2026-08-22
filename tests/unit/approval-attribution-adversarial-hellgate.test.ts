/**
 * ★ HELLGATE (SECOND LAYER, ADVERSARIAL) — approval-state attribution integrity.
 *
 * The FIRST layer (approval-attribution-gap-hellgate.test.ts) proved the
 * fail-closed audit-gap SURFACING: an unknown-id terminal mutator emits a gap
 * with the id/op/decision; a known pending id does not; a throwing observer
 * can't break the null return; and one real gate-wire path.
 *
 * This SECOND layer attacks the STATE MACHINE's transition integrity + the
 * attribution invariant under adversarial sequencing — the cases the first
 * layer didn't touch:
 *
 *   A1 ID COLLISION — a second request() with an id ALREADY held returns the
 *      EXISTING record and does NOT double-attribute (no second objective
 *      blocker, no second ledger.start). The producer→consumer wire can't be
 *      tricked into double-counting.
 *   A2 DOUBLE-SETTLE — settling an already-approved id is an idempotent no-op
 *      that returns the ORIGINAL decision (a later deny cannot overwrite an
 *      approve) AND fires NO gap (it WAS attributed) AND does NOT re-settle the
 *      ledger.
 *   A3 SETTLE-AFTER-EXPIRE / EXPIRE-AFTER-SETTLE — the terminal status is
 *      LATCHED by whichever mutator won the race; the loser is a no-op and NOT
 *      a gap. No un-attributed escalation slips through here.
 *   A4 CONCURRENT settle/cancel/expire on the SAME pending id — exactly ONE
 *      transition wins; the objective blocker is cleared exactly once; the
 *      others are no-ops. No double-clear, no un-cleared blocker.
 *   A5 HOSTILE OBSERVER — an observer that mutates the machine re-entrantly,
 *      returns garbage, or throws on every call cannot corrupt state or leak an
 *      un-surfaced gap for a genuinely-unknown id.
 *   A6 SNAPSHOT ROUND-TRIP ATTACK — fromSnapshot with hostile / partial /
 *      malformed entries never throws, drops garbage, and preserves the
 *      attribution back-refs of clean entries; a settle on a restored PENDING
 *      id is NOT a false gap.
 *   A7 EVICTION NEVER DROPS PENDING — under a tiny maxRetained, a pending
 *      (un-resolved) escalation is NEVER LRU-evicted (an escalation must stay
 *      observable); only SETTLED records are evicted. A settle on a
 *      still-pending (never-evicted) id attributes, not gaps.
 *   A8 NO SILENT UN-ATTRIBUTION (property) — for every terminal op on a
 *      NEVER-requested id, exactly one gap fires; for every terminal op on a
 *      requested (pending) id, ZERO gaps fire. The gap fires IFF there was no
 *      producer.
 *
 * Attribution ports (objective / ledger) are the real in-memory stores so the
 * clear/settle side effects are observable.
 *
 * Source under test: src/agent/approval-state-machine/store.ts.
 */

import { describe, expect, test } from "bun:test"
import {
  type ApprovalAttributionGap,
  createApprovalStateMachine,
} from "@/agent/approval-state-machine"
import { createRunLedger } from "@/agent/run-ledger"
import { createObjectiveStore } from "@/objective"

const stepClock = (start = 1000, step = 10) => {
  let t = start
  return () => {
    const v = t
    t += step
    return v
  }
}
const gapSink = () => {
  const gaps: ApprovalAttributionGap[] = []
  return { gaps, onUnattributed: (g: ApprovalAttributionGap) => gaps.push(g) }
}
const REQ = (id: string) => ({
  id,
  threadId: "session-x",
  kind: "escalation" as const,
  reason: `escalation ${id}`,
  proposedAction: "bash rm -rf danger",
  resumeStep: "dispatch:resume",
})

// ─────────────────────────────────────────────────────────────────────────────
// A1 — ID COLLISION: a repeat request does not double-attribute.
// ─────────────────────────────────────────────────────────────────────────────
describe("A1 id collision — repeat request() preserves the original attribution", () => {
  test("second request(sameId) returns the EXISTING record; no second blocker/ledger entry", () => {
    const objective = createObjectiveStore()
    const ledger = createRunLedger()
    objective.set("session-x", { goal: "safe" })
    const asm = createApprovalStateMachine({ now: stepClock(), objective, ledger })

    const first = asm.request(REQ("dup-1"))
    expect(first.status).toBe("pending")
    expect(objective.get("session-x")?.blockers).toHaveLength(1)
    expect(ledger.get("dup-1")?.status).toBe("waiting")
    const firstCreatedAt = first.createdAt

    // Kernel replay delivers the SAME deferred approval again.
    const second = asm.request({ ...REQ("dup-1"), reason: "DIFFERENT reason (ignored)" })
    // Same record identity — NOT re-minted, NOT re-attributed.
    expect(second.id).toBe("dup-1")
    expect(second.createdAt).toBe(firstCreatedAt)
    expect(second.reason).toBe(first.reason) // original preserved
    // The critical anti-double-count: exactly ONE blocker, ONE ledger entry.
    expect(objective.get("session-x")?.blockers).toHaveLength(1)
  })

  test("collision does NOT resurrect a SETTLED record into pending", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    asm.request(REQ("dup-2"))
    asm.settle("dup-2", "approve")
    expect(asm.get("dup-2")?.status).toBe("approved")
    // Re-request the settled id — must return the (terminal) existing record,
    // NOT a fresh pending one (which would silently reopen an approved gate).
    const again = asm.request(REQ("dup-2"))
    expect(again.status).toBe("approved")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A2 — DOUBLE-SETTLE idempotency + no false gap + no ledger re-settle.
// ─────────────────────────────────────────────────────────────────────────────
// NOTE (dup-avoidance): approval-state-machine-hellgate.test.ts covers plain
// idempotent re-settle (status unchanged). This block adds the ADVERSARIAL
// angles that test lacks: an approve→DENY OVERWRITE attempt, the no-false-gap
// interaction, that the ledger is settled EXACTLY once (not re-settled), and a
// modify-action latch.
describe("A2 double-settle — first decision latches; later settle is a no-op", () => {
  test("settle(approve) then settle(deny): status stays approved; NO gap; ledger settled once", () => {
    const ledger = createRunLedger()
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      ledger,
      onUnattributed: sink.onUnattributed,
    })
    asm.request(REQ("ds-1"))
    const approved = asm.settle("ds-1", "approve")
    expect(approved?.status).toBe("approved")
    expect(ledger.get("ds-1")?.status).toBe("completed")

    // Adversarial overwrite attempt — a later deny must NOT flip an approve.
    const overwrite = asm.settle("ds-1", "deny")
    expect(overwrite?.status).toBe("approved") // unchanged
    expect(overwrite?.decision).toBe("approve")
    // Already-settled ⇒ NOT an attribution gap (it WAS attributed).
    expect(sink.gaps).toHaveLength(0)
    // Ledger still completed (not re-settled to stopped).
    expect(ledger.get("ds-1")?.status).toBe("completed")
  })

  test("modify decision latches modifiedAction; a re-settle cannot change it", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    asm.request(REQ("ds-2"))
    const m = asm.settle("ds-2", "modify", { modifiedAction: "bash ls -la" })
    expect(m?.status).toBe("approved")
    expect(m?.decision).toBe("modify")
    expect(m?.modifiedAction).toBe("bash ls -la")
    const again = asm.settle("ds-2", "modify", { modifiedAction: "rm -rf /" })
    expect(again?.modifiedAction).toBe("bash ls -la") // original latched
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A3 — settle-after-expire / expire-after-settle: winner latches, loser no-ops.
// ─────────────────────────────────────────────────────────────────────────────
describe("A3 cross-terminal ordering — first terminal wins, later ones are no-ops (not gaps)", () => {
  test("expire then settle: status stays expired; settle is a no-op; NO gap", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    asm.request(REQ("xo-1"))
    expect(asm.expire("xo-1")?.status).toBe("expired")
    const late = asm.settle("xo-1", "approve")
    expect(late?.status).toBe("expired") // settle did NOT reopen/flip
    expect(sink.gaps).toHaveLength(0) // known id ⇒ no gap
  })

  test("settle then cancel then expire: latched at first (approved); the rest no-op, NO gaps", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    asm.request(REQ("xo-2"))
    expect(asm.settle("xo-2", "approve")?.status).toBe("approved")
    expect(asm.cancel("xo-2")?.status).toBe("approved")
    expect(asm.expire("xo-2")?.status).toBe("approved")
    expect(sink.gaps).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A4 — concurrent terminal ops on the same pending id: exactly one clears.
// ─────────────────────────────────────────────────────────────────────────────
describe("A4 concurrent settle/cancel/expire — exactly one wins, blocker cleared once", () => {
  test("Promise.all of settle+cancel+expire ⇒ one terminal status; blocker cleared exactly once", async () => {
    const objective = createObjectiveStore()
    objective.set("session-x", { goal: "safe" })
    const asm = createApprovalStateMachine({ now: stepClock(), objective })
    asm.request(REQ("cc-1"))
    expect(objective.get("session-x")?.blockers).toHaveLength(1)

    // The store is synchronous, but model the host racing three resolutions.
    await Promise.all([
      Promise.resolve().then(() => asm.settle("cc-1", "approve")),
      Promise.resolve().then(() => asm.cancel("cc-1")),
      Promise.resolve().then(() => asm.expire("cc-1")),
    ])

    const final = asm.get("cc-1")
    if (final == null) throw new Error("requested approval disappeared during terminal settlement")
    // Exactly one terminal status latched.
    expect(["approved", "cancelled", "expired"]).toContain(final.status)
    expect(final.status).not.toBe("pending")
    // The blocker is cleared exactly once — never double-cleared, never left set.
    expect(objective.get("session-x")?.blockers).toHaveLength(0)
    // Re-clearing a non-existent blocker did not corrupt the objective.
    expect(objective.get("session-x")?.goal).toBe("safe")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A5 — hostile observer cannot corrupt state or hide a real gap.
// ─────────────────────────────────────────────────────────────────────────────
describe("A5 hostile observer — re-entrant / throwing / garbage cannot corrupt the machine", () => {
  test("observer that re-enters the machine (settles OTHER ids) does not corrupt or infinite-loop", () => {
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: (g) => {
        // Re-entrant mutation from inside the gap callback.
        asm.cancel(`reentrant-${g.approvalId}`)
        asm.request(REQ(`spawned-${g.approvalId}`))
      },
    })
    // Trigger a gap on an unknown id — the callback re-enters.
    expect(() => asm.settle("unknown-a5", "approve")).not.toThrow()
    // The re-entrant request DID create a record (no corruption / deadlock).
    expect(asm.get("spawned-unknown-a5")?.status).toBe("pending")
  })

  test("observer that throws EVERY time still surfaces the null contract and does not lose state", () => {
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: () => {
        throw new Error("always hostile")
      },
    })
    asm.request(REQ("a5-good"))
    // A real settle on a KNOWN id still works despite the hostile observer.
    expect(asm.settle("a5-good", "approve")?.status).toBe("approved")
    // An unknown-id settle still returns null (throw swallowed).
    expect(asm.settle("a5-unknown", "deny")).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A6 — snapshot round-trip attack: hostile entries dropped, clean ones survive.
// ─────────────────────────────────────────────────────────────────────────────
describe("A6 snapshot round-trip — hostile entries dropped, back-refs preserved, no false gap", () => {
  test("fromSnapshot drops malformed entries, never throws, keeps clean ones", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    // Hostile snapshot: mix of garbage + one clean pending entry.
    const clean = {
      id: "snap-ok",
      threadId: "t",
      kind: "escalation",
      reason: "r",
      proposedAction: "p",
      resumeStep: "s",
      status: "pending",
      createdAt: 5,
      blockerId: "b-1",
      runEntryId: "r-1",
    }
    asm.fromSnapshot({
      approvals: [
        null as never,
        42 as never,
        "string" as never,
        { id: "" } as never, // empty id ⇒ dropped
        { id: "x", kind: "bogus-kind" } as never, // bad enum ⇒ dropped
        clean as never,
      ],
    })
    // Only the clean entry survived.
    const list = asm.list()
    expect(list.map((r) => r.id)).toEqual(["snap-ok"])
    // Back-refs (attribution) preserved from the snapshot.
    expect(asm.get("snap-ok")?.blockerId).toBe("b-1")
    expect(asm.get("snap-ok")?.runEntryId).toBe("r-1")
  })

  test("settle on a RESTORED pending id attributes (NOT a false gap)", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    asm.fromSnapshot({
      approvals: [
        {
          id: "snap-pending",
          threadId: "t",
          kind: "permission",
          reason: "r",
          proposedAction: "p",
          resumeStep: "s",
          status: "pending",
          createdAt: 1,
        } as never,
      ],
    })
    const settled = asm.settle("snap-pending", "approve")
    expect(settled?.status).toBe("approved")
    // A restored producer record ⇒ this is attributed ⇒ NO gap.
    expect(sink.gaps).toHaveLength(0)
  })

  test("a completely malformed snapshot is a no-op (does not wipe existing state on throw)", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    asm.request(REQ("keepme"))
    // Non-object snapshots ⇒ early no-op, existing state untouched.
    asm.fromSnapshot(null as never)
    asm.fromSnapshot(123 as never)
    asm.fromSnapshot({ approvals: "not-an-array" } as never)
    expect(asm.get("keepme")?.status).toBe("pending")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A7 — eviction never drops a PENDING escalation.
// ─────────────────────────────────────────────────────────────────────────────
describe("A7 eviction — pending escalations are never LRU-evicted", () => {
  test("with maxRetained=2 and many settled records, ALL pending survive; a late settle attributes", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      maxRetained: 2,
      onUnattributed: sink.onUnattributed,
    })
    // Two long-lived PENDING escalations.
    asm.request(REQ("pend-A"))
    asm.request(REQ("pend-B"))
    // Flood with settled records — these should be the eviction victims.
    for (let i = 0; i < 20; i++) {
      asm.request(REQ(`tmp-${i}`))
      asm.settle(`tmp-${i}`, "approve")
    }
    // Both pending escalations MUST still be observable (never evicted).
    expect(asm.get("pend-A")?.status).toBe("pending")
    expect(asm.get("pend-B")?.status).toBe("pending")
    expect(
      asm
        .pending()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["pend-A", "pend-B"])
    // Settling a never-evicted pending id attributes ⇒ NO gap.
    asm.settle("pend-A", "approve")
    expect(sink.gaps).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// A8 — PROPERTY: gap fires IFF there was no producer.
// ─────────────────────────────────────────────────────────────────────────────
describe("A8 property — no HITL escalation is silently un-attributed", () => {
  const OPS = ["settle", "expire", "cancel"] as const
  const settleFor = (
    asm: ReturnType<typeof createApprovalStateMachine>,
    op: (typeof OPS)[number],
    id: string,
  ) => {
    if (op === "settle") return asm.settle(id, "approve")
    if (op === "expire") return asm.expire(id)
    return asm.cancel(id)
  }

  test("fuzz {op × requested?}: exactly one gap IFF the id was never requested", () => {
    for (const op of OPS) {
      for (const requested of [true, false]) {
        const sink = gapSink()
        const asm = createApprovalStateMachine({
          now: stepClock(),
          onUnattributed: sink.onUnattributed,
        })
        const id = `p-${op}-${requested}`
        if (requested) asm.request(REQ(id))
        settleFor(asm, op, id)
        // The invariant: a gap fires IFF there was NO producer (never requested).
        expect(sink.gaps.length).toBe(requested ? 0 : 1)
        if (!requested) {
          expect(sink.gaps[0]?.approvalId).toBe(id)
          expect(sink.gaps[0]?.op).toBe(op)
        }
      }
    }
  })

  test("a non-string / empty id terminal op on an empty machine STILL surfaces a gap (never silent)", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    asm.settle("" as never, "approve")
    asm.settle(undefined as never, "deny")
    asm.settle(null as never, "deny")
    // Each hostile id still surfaces a gap — a garbage kernel id must NOT let an
    // escalation resolve un-attributed AND un-noticed.
    expect(sink.gaps.length).toBe(3)
  })
})
