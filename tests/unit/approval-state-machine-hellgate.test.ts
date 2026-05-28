/**
 * ADR-0399 — Approval state machine hellgate.
 *
 * Adversarial battery over the closed `ApprovalStateMachinePort`. This wave is
 * the PORT + STORE layer — wiring into admissibility-gate / request_user_input
 * is held back; this hellgate proves the contract in isolation.
 *
 * Invariants pinned (one or more `it` per row):
 *   - request ⇒ status="pending" + createdAt stamped + id minted
 *   - settle(approve|modify) ⇒ "approved" + settledAt + decision recorded
 *   - settle(deny) ⇒ "denied"
 *   - settle is idempotent (re-settle returns the entry unchanged)
 *   - expire from pending ⇒ "expired"; no-op on already-settled
 *   - cancel from pending ⇒ "cancelled"; no-op on already-settled
 *   - Any mutator on unknown id ⇒ null (no exception)
 *   - Attribution WITH objective+ledger ports populates blockerId+runEntryId
 *     AND clears the blocker / settles the ledger entry on settle/expire/cancel
 *   - Attribution WITHOUT optional ports is a no-op (state still tracks)
 *   - Hostile fakes that throw inside objective.addBlocker / ledger.start /
 *     ledger.touch / objective.clearBlocker / ledger.settle do NOT propagate —
 *     the approval state is authoritative
 *   - Snapshot round-trip (replace-not-merge); malformed snapshot is a no-op
 *   - Multi-thread isolation (list/pending filters)
 *   - NO-THROW on hostile inputs across all methods
 */

import { describe, expect, it } from "bun:test"
import {
  type ApprovalKind,
  type ApprovalSnapshot,
  type ApprovalStateMachinePort,
  createApprovalStateMachine,
} from "@/agent/approval-state-machine"
import type { ObjectivePort } from "@/agent/objective"
import { createObjectiveStore } from "@/agent/objective"
import type { RunLedgerPort } from "@/agent/run-ledger"
import { createRunLedger } from "@/agent/run-ledger"

/** Deterministic monotone clock seam. */
const stepClock = (start = 1000, step = 10) => {
  let t = start
  return () => {
    const v = t
    t += step
    return v
  }
}

/** Convenience: request a pending approval with sensible defaults. */
const ask = (
  asm: ApprovalStateMachinePort,
  over: Partial<{
    threadId: string
    kind: ApprovalKind
    reason: string
    proposedAction: string
    resumeStep: string
    options: readonly string[]
  }> = {},
) =>
  asm.request({
    threadId: over.threadId ?? "thread-A",
    kind: over.kind ?? "permission",
    reason: over.reason ?? "About to run a destructive shell command",
    proposedAction: over.proposedAction ?? "rm -rf node_modules",
    resumeStep: over.resumeStep ?? "Step 3 / 5: clear caches",
    ...(over.options !== undefined ? { options: over.options } : {}),
  })

describe("ADR-0399 approval-state-machine — request shape", () => {
  it("request returns status='pending' with createdAt stamped + minted id", () => {
    const now = stepClock()
    const asm = createApprovalStateMachine({ now })
    const r = ask(asm)
    expect(r.status).toBe("pending")
    expect(r.createdAt).toBe(1000)
    expect(typeof r.id).toBe("string")
    expect(r.id.length).toBeGreaterThan(0)
    expect(r.decision).toBeUndefined()
    expect(r.settledAt).toBeUndefined()
    expect(r.kind).toBe("permission")
    expect(r.reason).toBe("About to run a destructive shell command")
    expect(r.proposedAction).toBe("rm -rf node_modules")
    expect(r.resumeStep).toBe("Step 3 / 5: clear caches")
  })

  it("request mints a fresh id per call", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r1 = ask(asm)
    const r2 = ask(asm)
    expect(r1.id).not.toBe(r2.id)
  })

  it("each kind value is accepted verbatim", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const kinds: ApprovalKind[] = ["permission", "clarification", "escalation"]
    const ids = kinds.map((k) => ask(asm, { kind: k }).id)
    expect(ids.length).toBe(3)
    for (const k of kinds) {
      const r = asm.list({ status: "pending" }).find((x) => x.kind === k)
      expect(r).toBeDefined()
    }
  })

  it("options are carried verbatim when present and clamped to 3", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm, { options: ["a", "b", "c", "d", "e"] })
    expect(r.options).toEqual(["a", "b", "c"])
  })

  it("options omitted when absent (no `options: undefined` field)", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    expect("options" in r).toBe(false)
  })
})

describe("ADR-0399 approval-state-machine — settle transitions", () => {
  it("settle(approve) transitions pending ⇒ approved with settledAt stamped", () => {
    const now = stepClock(100, 5)
    const asm = createApprovalStateMachine({ now })
    const r = ask(asm) // createdAt=100
    const s = asm.settle(r.id, "approve") // settledAt=105
    expect(s?.status).toBe("approved")
    expect(s?.decision).toBe("approve")
    expect(s?.settledAt).toBe(105)
  })

  it("settle(modify) records modifiedAction and ⇒ approved", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    const s = asm.settle(r.id, "modify", { modifiedAction: "rm -rf dist" })
    expect(s?.status).toBe("approved")
    expect(s?.decision).toBe("modify")
    expect(s?.modifiedAction).toBe("rm -rf dist")
  })

  it("settle(deny) transitions pending ⇒ denied", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    const s = asm.settle(r.id, "deny")
    expect(s?.status).toBe("denied")
    expect(s?.decision).toBe("deny")
  })

  it("settle is idempotent — re-settle returns the entry unchanged (no-op)", () => {
    const asm = createApprovalStateMachine({ now: stepClock(0, 5) })
    const r = ask(asm) // 0
    const first = asm.settle(r.id, "approve") // 5
    const firstAt = first?.settledAt
    const second = asm.settle(r.id, "deny") // must NOT overwrite to denied
    expect(second?.status).toBe("approved")
    expect(second?.decision).toBe("approve")
    expect(second?.settledAt).toBe(firstAt) // settledAt not re-bumped
  })

  it("settle of unknown id ⇒ null (no throw)", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    expect(asm.settle("ghost", "approve")).toBeNull()
  })
})

describe("ADR-0399 approval-state-machine — expire / cancel", () => {
  it("expire from pending ⇒ expired with settledAt", () => {
    const asm = createApprovalStateMachine({ now: stepClock(0, 5) })
    const r = ask(asm) // 0
    const e = asm.expire(r.id) // 5
    expect(e?.status).toBe("expired")
    expect(e?.settledAt).toBe(5)
  })

  it("expire on already-settled is a no-op returning the settled record", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    asm.settle(r.id, "approve")
    const e = asm.expire(r.id)
    expect(e?.status).toBe("approved") // unchanged
  })

  it("cancel from pending ⇒ cancelled with settledAt", () => {
    const asm = createApprovalStateMachine({ now: stepClock(0, 5) })
    const r = ask(asm)
    const c = asm.cancel(r.id)
    expect(c?.status).toBe("cancelled")
    expect(c?.settledAt).toBe(5)
  })

  it("cancel on already-settled is a no-op", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    asm.settle(r.id, "deny")
    const c = asm.cancel(r.id)
    expect(c?.status).toBe("denied")
  })

  it("expire / cancel on unknown id ⇒ null", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    expect(asm.expire("ghost")).toBeNull()
    expect(asm.cancel("ghost")).toBeNull()
  })
})

describe("ADR-0399 approval-state-machine — list / pending filters", () => {
  it("pending() returns only pending records", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r1 = ask(asm, { threadId: "A" })
    const r2 = ask(asm, { threadId: "B" })
    const r3 = ask(asm, { threadId: "A" })
    asm.settle(r2.id, "deny")
    asm.cancel(r3.id)
    const pending = asm.pending()
    expect(pending.length).toBe(1)
    expect(pending[0]?.id).toBe(r1.id)
  })

  it("list filters by threadId (multi-thread isolation)", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    ask(asm, { threadId: "A" })
    ask(asm, { threadId: "B" })
    ask(asm, { threadId: "A" })
    expect(asm.list({ threadId: "A" }).length).toBe(2)
    expect(asm.list({ threadId: "B" }).length).toBe(1)
    expect(asm.list({ threadId: "C" }).length).toBe(0)
  })

  it("list composes status ∧ threadId", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const rA1 = ask(asm, { threadId: "A" })
    ask(asm, { threadId: "A" })
    ask(asm, { threadId: "B" })
    asm.settle(rA1.id, "approve")
    expect(asm.list({ status: "pending", threadId: "A" }).length).toBe(1)
    expect(asm.list({ status: "approved", threadId: "A" }).length).toBe(1)
    expect(asm.list({ status: "approved", threadId: "B" }).length).toBe(0)
  })
})

describe("ADR-0399 approval-state-machine — attribution WITH objective + ledger", () => {
  const seed = () => {
    const objective: ObjectivePort = createObjectiveStore({ now: stepClock(0, 1) })
    const ledger: RunLedgerPort = createRunLedger({ now: stepClock(0, 1) })
    objective.set("thread-A", { goal: "ship feature" })
    const asm = createApprovalStateMachine({
      now: stepClock(2000, 1),
      objective,
      ledger,
    })
    return { objective, ledger, asm }
  }

  it("request attributes via Objective.addBlocker — blockerId captured", () => {
    const { objective, asm } = seed()
    const r = ask(asm, { threadId: "thread-A", reason: "needs operator OK" })
    expect(r.blockerId).toBeDefined()
    const obj = objective.get("thread-A")
    expect(obj?.blockers.length).toBe(1)
    expect(obj?.blockers[0]?.id).toBe(r.blockerId ?? "")
    expect(obj?.blockers[0]?.reason).toBe("needs operator OK")
    expect(obj?.blockers[0]?.waitingOn).toBe("user")
  })

  it("request attributes via RunLedger.start + touch — runEntryId captured + status='waiting'", () => {
    const { ledger, asm } = seed()
    const r = ask(asm, { threadId: "thread-A", resumeStep: "Step 7: confirm overwrite" })
    expect(r.runEntryId).toBe(r.id) // we use approvalId as ledger id
    const entry = ledger.get(r.id)
    expect(entry?.status).toBe("waiting")
    expect(entry?.waitingOn).toBe("user")
    expect(entry?.resumeAction).toBe("Step 7: confirm overwrite")
    expect(entry?.kind).toBe("exec")
    expect(entry?.owner).toBe("thread-A")
  })

  it("settle(approve) clears blocker AND settles ledger entry as 'completed'", () => {
    const { objective, ledger, asm } = seed()
    const r = ask(asm, { threadId: "thread-A" })
    expect(objective.get("thread-A")?.blockers.length).toBe(1)
    asm.settle(r.id, "approve")
    expect(objective.get("thread-A")?.blockers.length).toBe(0)
    expect(ledger.get(r.id)?.status).toBe("completed")
  })

  it("settle(modify) clears blocker AND settles ledger entry as 'completed'", () => {
    const { objective, ledger, asm } = seed()
    const r = ask(asm, { threadId: "thread-A" })
    asm.settle(r.id, "modify", { modifiedAction: "rm -rf dist" })
    expect(objective.get("thread-A")?.blockers.length).toBe(0)
    expect(ledger.get(r.id)?.status).toBe("completed")
  })

  it("settle(deny) clears blocker AND settles ledger entry as 'stopped'", () => {
    const { objective, ledger, asm } = seed()
    const r = ask(asm, { threadId: "thread-A" })
    asm.settle(r.id, "deny")
    expect(objective.get("thread-A")?.blockers.length).toBe(0)
    expect(ledger.get(r.id)?.status).toBe("stopped")
  })

  it("expire clears blocker AND settles ledger as 'stopped'", () => {
    const { objective, ledger, asm } = seed()
    const r = ask(asm, { threadId: "thread-A" })
    asm.expire(r.id)
    expect(objective.get("thread-A")?.blockers.length).toBe(0)
    expect(ledger.get(r.id)?.status).toBe("stopped")
  })

  it("cancel clears blocker AND settles ledger as 'stopped'", () => {
    const { objective, ledger, asm } = seed()
    const r = ask(asm, { threadId: "thread-A" })
    asm.cancel(r.id)
    expect(objective.get("thread-A")?.blockers.length).toBe(0)
    expect(ledger.get(r.id)?.status).toBe("stopped")
  })
})

describe("ADR-0399 approval-state-machine — attribution WITHOUT optional ports", () => {
  it("no objective + no ledger ⇒ no blockerId / no runEntryId, state still tracks", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    expect(r.blockerId).toBeUndefined()
    expect(r.runEntryId).toBeUndefined()
    const s = asm.settle(r.id, "approve")
    expect(s?.status).toBe("approved")
    expect(s?.decision).toBe("approve")
  })

  it("only objective supplied ⇒ blockerId set, runEntryId absent", () => {
    const objective = createObjectiveStore({ now: stepClock() })
    objective.set("thread-A", { goal: "x" })
    const asm = createApprovalStateMachine({ now: stepClock(), objective })
    const r = ask(asm, { threadId: "thread-A" })
    expect(r.blockerId).toBeDefined()
    expect(r.runEntryId).toBeUndefined()
    asm.settle(r.id, "approve") // clears blocker even without ledger
    expect(objective.get("thread-A")?.blockers.length).toBe(0)
  })

  it("only ledger supplied ⇒ runEntryId set, blockerId absent", () => {
    const ledger = createRunLedger({ now: stepClock() })
    const asm = createApprovalStateMachine({ now: stepClock(), ledger })
    const r = ask(asm)
    expect(r.runEntryId).toBe(r.id)
    expect(r.blockerId).toBeUndefined()
    asm.settle(r.id, "deny")
    expect(ledger.get(r.id)?.status).toBe("stopped")
  })
})

describe("ADR-0399 approval-state-machine — hostile attribution fakes do NOT propagate", () => {
  /** A hostile ObjectivePort that throws on every mutator. NO method returns
   *  a valid value — used to prove the approval state survives a misbehaving
   *  attribution port. */
  const hostileObjective = (): ObjectivePort => ({
    set: () => {
      throw new Error("set boom")
    },
    get: () => {
      throw new Error("get boom")
    },
    updateStatus: () => {
      throw new Error("updateStatus boom")
    },
    addBlocker: () => {
      throw new Error("addBlocker boom")
    },
    clearBlocker: () => {
      throw new Error("clearBlocker boom")
    },
    setNextActions: () => {
      throw new Error("setNextActions boom")
    },
    markCriterion: () => {
      throw new Error("markCriterion boom")
    },
    recordUsage: () => {
      throw new Error("recordUsage boom")
    },
    list: () => {
      throw new Error("list boom")
    },
    toSnapshot: () => {
      throw new Error("toSnapshot boom")
    },
    fromSnapshot: () => {
      throw new Error("fromSnapshot boom")
    },
  })

  const hostileLedger = (): RunLedgerPort => ({
    start: () => {
      throw new Error("start boom")
    },
    touch: () => {
      throw new Error("touch boom")
    },
    settle: () => {
      throw new Error("settle boom")
    },
    get: () => {
      throw new Error("get boom")
    },
    list: () => {
      throw new Error("list boom")
    },
    running: () => {
      throw new Error("running boom")
    },
    waiting: () => {
      throw new Error("waiting boom")
    },
    toSnapshot: () => {
      throw new Error("snap boom")
    },
    fromSnapshot: () => {
      throw new Error("snap boom")
    },
  })

  it("hostile objective.addBlocker throws ⇒ request still returns valid record, no blockerId", () => {
    const asm = createApprovalStateMachine({
      now: stepClock(),
      objective: hostileObjective(),
    })
    const r = ask(asm)
    expect(r.status).toBe("pending")
    expect(r.blockerId).toBeUndefined()
  })

  it("hostile ledger.start/touch throw ⇒ request still returns valid record, no runEntryId", () => {
    const asm = createApprovalStateMachine({ now: stepClock(), ledger: hostileLedger() })
    const r = ask(asm)
    expect(r.status).toBe("pending")
    expect(r.runEntryId).toBeUndefined()
  })

  it("hostile clearBlocker/settle throw on settle ⇒ approval state still transitions", () => {
    const asm = createApprovalStateMachine({
      now: stepClock(),
      objective: hostileObjective(),
      ledger: hostileLedger(),
    })
    const r = ask(asm)
    const s = asm.settle(r.id, "approve")
    expect(s?.status).toBe("approved")
    expect(s?.decision).toBe("approve")
  })

  it("hostile ports on expire/cancel do not propagate", () => {
    const asmE = createApprovalStateMachine({
      now: stepClock(),
      objective: hostileObjective(),
      ledger: hostileLedger(),
    })
    const re = ask(asmE)
    expect(asmE.expire(re.id)?.status).toBe("expired")

    const asmC = createApprovalStateMachine({
      now: stepClock(),
      objective: hostileObjective(),
      ledger: hostileLedger(),
    })
    const rc = ask(asmC)
    expect(asmC.cancel(rc.id)?.status).toBe("cancelled")
  })

  it("a throwing clock falls back to a safe stamp (no propagation)", () => {
    const asm = createApprovalStateMachine({
      now: () => {
        throw new Error("clock boom")
      },
    })
    const r = ask(asm)
    expect(r.status).toBe("pending")
    expect(typeof r.createdAt).toBe("number")
  })
})

describe("ADR-0399 approval-state-machine — snapshot round-trip", () => {
  it("toSnapshot + fromSnapshot deep-equal restores the records", () => {
    const asm1 = createApprovalStateMachine({ now: stepClock() })
    const r1 = ask(asm1, { threadId: "A" })
    const r2 = ask(asm1, { threadId: "B" })
    asm1.settle(r2.id, "approve")
    const snap = asm1.toSnapshot()

    const asm2 = createApprovalStateMachine({ now: stepClock() })
    asm2.fromSnapshot(snap)
    expect(asm2.get(r1.id)?.status).toBe("pending")
    expect(asm2.get(r2.id)?.status).toBe("approved")
    expect(asm2.list().length).toBe(2)
  })

  it("fromSnapshot REPLACES (not merges) existing state", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r1 = ask(asm, { threadId: "A" })
    const snap1: ApprovalSnapshot = asm.toSnapshot()

    const r2 = ask(asm, { threadId: "B" })
    expect(asm.list().length).toBe(2)

    asm.fromSnapshot(snap1) // replaces — r2 must be gone
    expect(asm.get(r2.id)).toBeNull()
    expect(asm.get(r1.id)?.status).toBe("pending")
    expect(asm.list().length).toBe(1)
  })

  it("malformed snapshot is a no-op", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    ask(asm)
    const before = asm.list().length
    // @ts-expect-error — hostile input
    asm.fromSnapshot(null)
    // @ts-expect-error — hostile input
    asm.fromSnapshot({ approvals: "not-an-array" })
    // @ts-expect-error — hostile input
    asm.fromSnapshot(42)
    expect(asm.list().length).toBe(before)
  })

  it("malformed entries inside a snapshot are silently dropped", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    const snap = asm.toSnapshot()
    const hostile: ApprovalSnapshot = {
      approvals: [
        ...(snap.approvals as readonly unknown[]),
        // garbage entries — must be dropped, never throw
        null,
        42,
        {},
        { id: "", threadId: "A", kind: "permission", status: "pending" },
      ] as never,
    }
    asm.fromSnapshot(hostile)
    expect(asm.get(r.id)?.id).toBe(r.id)
    expect(asm.list().length).toBe(1)
  })
})

describe("ADR-0399 approval-state-machine — NO-THROW on hostile input", () => {
  it("request with a non-object payload still returns a valid pending record", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    // @ts-expect-error — hostile input
    const r = asm.request(null)
    expect(r.status).toBe("pending")
    expect(r.threadId).toBe("")
  })

  it("request with an unknown kind coerces to 'permission'", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = asm.request({
      threadId: "A",
      // @ts-expect-error — hostile kind
      kind: "WAT",
      reason: "x",
      proposedAction: "y",
      resumeStep: "z",
    })
    expect(r.kind).toBe("permission")
  })

  it("settle with an unknown decision falls back to 'deny'", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    // @ts-expect-error — hostile decision
    const s = asm.settle(r.id, "WAT")
    expect(s?.status).toBe("denied")
    expect(s?.decision).toBe("deny")
  })

  it("get / mutators handle non-string ids (returns null, no throw)", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    // @ts-expect-error — hostile id
    expect(asm.get(null)).toBeNull()
    // @ts-expect-error — hostile id
    expect(asm.settle(undefined, "approve")).toBeNull()
    // @ts-expect-error — hostile id
    expect(asm.expire(42)).toBeNull()
    // @ts-expect-error — hostile id
    expect(asm.cancel({})).toBeNull()
  })

  it("list with malformed filter is treated as no filter (no throw)", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    ask(asm)
    // @ts-expect-error — hostile filter
    const all = asm.list(42)
    expect(all.length).toBe(1)
  })
})

describe("ADR-0399 approval-state-machine — frozen returns", () => {
  it("returned records are frozen (cannot be mutated by a caller)", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    const r = ask(asm)
    expect(Object.isFrozen(r)).toBe(true)
    expect(() => {
      // @ts-expect-error — frozen
      r.status = "approved"
    }).toThrow()
  })

  it("list returns a frozen array", () => {
    const asm = createApprovalStateMachine({ now: stepClock() })
    ask(asm)
    const arr = asm.list()
    expect(Object.isFrozen(arr)).toBe(true)
  })
})
