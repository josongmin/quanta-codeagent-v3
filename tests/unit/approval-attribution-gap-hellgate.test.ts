/**
 * ★ HELLGATE — DOF-40 approval-state producer→consumer wire (fail-closed
 * audit-attribution gap).
 *
 * BACKGROUND (verified RED). A HITL escalation resolves through a terminal SM
 * mutator (`settle` / `expire` / `cancel`) keyed by a host/kernel `approvalId`.
 * The consumer wire attributes the resolution to the Objective + Run Ledger
 * ONLY when the machine already holds a PENDING record for that id — i.e. some
 * producer previously called `request(id)`. In the deferred (web/SDK) approval
 * path the host mints an `approvalId` and relays the operator's decision via
 * `resolveApprovalDecision` → `settle(approvalId)`. If NO producer fed the
 * machine a `request(id)` first, `settle` hits an unknown id: pre-DOF-40 it
 * returned `null` SILENTLY — indistinguishable from a benign already-settled
 * no-op — so the audit trail for that escalation was DROPPED with zero signal.
 *
 * This battery pins the fix:
 *   R (RED baseline)  — an unknown-id settle without an observer is swallowed
 *                       (returns null, no throw, no state) — the legacy hole.
 *   ON  — with `onUnattributed` wired, the SAME unknown-id settle SURFACES an
 *         `ApprovalAttributionGap` carrying the id + op + decision (real effect).
 *   OFF — observer absent ⇒ byte-identical: null return, ZERO observer calls,
 *         paired-control against the ON machine.
 *   WIRE — a REAL producer (the gate's deferred `request(id)` bridge) followed
 *          by a host settle attributes correctly and fires NO gap; only a
 *          settle with no matching producer fires the gap.
 */

import { describe, expect, it } from "bun:test"
import { type ApprovalGateRequest, createApprovalGate } from "@/agent/approval-gate-wire"
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

describe("DOF-40 approval attribution gap — fail-closed surfacing", () => {
  it("RED baseline: unknown-id settle WITHOUT an observer is silently swallowed", () => {
    // The legacy hole: no throw, no state, no signal — an un-attributed
    // escalation resolution vanishes.
    const asm = createApprovalStateMachine({ now: stepClock() })
    const out = asm.settle("kernel-id-never-requested", "approve")
    expect(out).toBeNull()
    // Nothing observable distinguishes this from a benign already-settled no-op.
    expect(asm.get("kernel-id-never-requested")).toBeNull()
    expect(asm.list()).toHaveLength(0)
  })

  it("ON: unknown-id settle WITH observer surfaces the gap (id + op + decision)", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    const out = asm.settle("kernel-id-never-requested", "approve")
    // Contract unchanged: still null (no phantom record minted).
    expect(out).toBeNull()
    // Fail-closed: the missing attribution is SURFACED, not swallowed.
    expect(sink.gaps).toHaveLength(1)
    expect(sink.gaps[0]).toMatchObject({
      approvalId: "kernel-id-never-requested",
      op: "settle",
      decision: "approve",
    })
    expect(typeof sink.gaps[0]?.at).toBe("number")
  })

  it("ON: unknown-id settle(deny) reports decision='deny'; unknown decision coerces to deny", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    asm.settle("id-1", "deny")
    // Unknown decision → SM coerces to deny; the gap mirrors the coerced value.
    asm.settle("id-2", "garbage" as never)
    expect(sink.gaps.map((g) => [g.approvalId, g.decision])).toEqual([
      ["id-1", "deny"],
      ["id-2", "deny"],
    ])
  })

  it("ON: unknown-id expire + cancel each surface a gap with the matching op (no decision)", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    asm.expire("gone-1")
    asm.cancel("gone-2")
    expect(sink.gaps).toEqual([
      expect.objectContaining({ approvalId: "gone-1", op: "expire" }),
      expect.objectContaining({ approvalId: "gone-2", op: "cancel" }),
    ])
    // expire/cancel carry NO decision field (exactOptional omit).
    expect("decision" in (sink.gaps[0] ?? {})).toBe(false)
  })

  it("OFF byte-identical (paired control): observer absent ⇒ null + ZERO gaps vs the ON machine's 1", () => {
    const clkOff = stepClock()
    const clkOn = stepClock()
    const sink = gapSink()
    const asmOff = createApprovalStateMachine({ now: clkOff })
    const asmOn = createApprovalStateMachine({ now: clkOn, onUnattributed: sink.onUnattributed })
    // Same call on both machines.
    const outOff = asmOff.settle("phantom", "approve")
    const outOn = asmOn.settle("phantom", "approve")
    // Return contract identical.
    expect(outOff).toBeNull()
    expect(outOn).toBeNull()
    // The ONLY divergence is the surfaced gap: OFF fired zero, ON fired one.
    expect(sink.gaps).toHaveLength(1)
  })

  it("no false gap: a KNOWN pending id settles normally and fires NO gap", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    const r = asm.request({
      id: "known-1",
      threadId: "t",
      kind: "escalation",
      reason: "needs op decision",
      proposedAction: "bash rm -rf x",
      resumeStep: "resume",
    })
    expect(r.status).toBe("pending")
    const settled = asm.settle("known-1", "approve")
    expect(settled?.status).toBe("approved")
    // A real attribution happened ⇒ NO gap.
    expect(sink.gaps).toHaveLength(0)
  })

  it("no false gap on idempotent re-settle: already-settled id is not a gap", () => {
    const sink = gapSink()
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: sink.onUnattributed,
    })
    asm.request({
      id: "known-2",
      threadId: "t",
      kind: "permission",
      reason: "x",
      proposedAction: "y",
      resumeStep: "z",
    })
    asm.settle("known-2", "approve")
    // Re-settle the SAME (now terminal) id — this WAS attributed, so NOT a gap.
    const again = asm.settle("known-2", "deny")
    expect(again?.status).toBe("approved") // idempotent no-op
    expect(sink.gaps).toHaveLength(0)
  })

  it("NO-THROW: a throwing observer cannot break the mutator's null return", () => {
    const asm = createApprovalStateMachine({
      now: stepClock(),
      onUnattributed: () => {
        throw new Error("hostile observer")
      },
    })
    // Must not propagate; still returns null.
    expect(asm.settle("boom", "approve")).toBeNull()
  })

  it("REAL WIRE: gate deferred-producer request(id) then host settle attributes with NO gap; a bare settle with no producer DOES gap", async () => {
    const sink = gapSink()
    const objective = createObjectiveStore()
    const ledger = createRunLedger()
    const asm = createApprovalStateMachine({
      objective,
      ledger,
      onUnattributed: sink.onUnattributed,
    })
    objective.set("session-x", { goal: "finish safely" })
    const gate = createApprovalGate({ approvalSM: asm })

    const req: ApprovalGateRequest = {
      threadId: "session-x",
      kind: "escalation",
      reason: "escalation:bash",
      proposedAction: "bash|rm -rf x",
      resumeStep: "dispatch:call-1",
    }

    // The deferred (web/SDK) producer: the resolver throws a kernel-shaped
    // RuntimeApprovalRequiredError; the gate bridge calls request(kernelId).
    const kernelId = "kernel-approval-777"
    await expect(
      gate.open(req, async () => {
        throw {
          name: "RuntimeApprovalRequiredError",
          approval: { approvalId: kernelId, reason: "r", requestedAt: "now" },
        }
      }),
    ).rejects.toBeDefined()

    // Producer fired ⇒ a real pending SM record + live attribution exists.
    expect(asm.get(kernelId)?.status).toBe("pending")
    expect(ledger.get(kernelId)?.status).toBe("waiting")
    expect(objective.get("session-x")?.blockers).toHaveLength(1)

    // Host relays the operator decision for the SAME kernel id — attributes,
    // NO gap.
    asm.settle(kernelId, "approve")
    expect(asm.get(kernelId)?.status).toBe("approved")
    expect(ledger.get(kernelId)?.status).toBe("completed")
    expect(objective.get("session-x")?.blockers).toHaveLength(0)
    expect(sink.gaps).toHaveLength(0)

    // Contrast: a host settle for an id NO producer ever requested (the exact
    // silent-drop the fix targets) DOES surface a gap.
    asm.settle("orphan-kernel-id", "approve")
    expect(sink.gaps).toEqual([
      expect.objectContaining({
        approvalId: "orphan-kernel-id",
        op: "settle",
        decision: "approve",
      }),
    ])
  })
})
