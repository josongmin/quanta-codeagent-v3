/**
 * ★ HELLGATE — DOF-40 observability-wire: route the approval SM's fail-closed
 * attribution-gap producer (`onUnattributed`) to a REAL observability consumer.
 *
 * BACKGROUND (the seam-only → wired gap this leaf closes). The approval state
 * machine (`createApprovalStateMachine`) accepts an optional `onUnattributed`
 * sink and ALREADY emits a fail-closed `ApprovalAttributionGap` when a terminal
 * mutator (`settle` / `expire` / `cancel`) hits an `approvalId` it holds no
 * pending record for (a producer never `request(id)`ed it ⇒ the resolution
 * attributes NOTHING). But the composition root that BUILDS the SM
 * (`wireObservability` → `constructHandleParts`) did NOT pass `onUnattributed`,
 * so every such gap was SILENTLY DROPPED — the producer fired into `undefined`.
 *
 * This battery pins the wiring END-TO-END through the REAL SM build path:
 *
 *   ON  — a gap driven through `handle.approvalStateMachine` (the SM the wire
 *         actually built) REACHES two real consumers:
 *           (1) the process `logger.warn` structured floor (always), and
 *           (2) the optional `onApprovalGap` operator observer (when supplied).
 *   FLOOR — even with NO `onApprovalGap`, the logger floor fires (a real
 *         consumer either way — NEVER a dead wire / silent drop).
 *   REAL-SINK — the logger floor genuinely reaches the stderr terminal port
 *         (captured via `setTerminalIo`) — not a no-op.
 *   RED-ON-INJECTION — the gap must arrive VIA the wire's routing, driven
 *         through the wire-built SM (not a hand-rolled SM).
 *   OFF — gate unset ⇒ NO approvalStateMachine on the handle ⇒ no gap channel
 *         at all; paired control vs the ON handle.
 *   NO-THROW — a hostile `onApprovalGap` cannot break the SM's null-return.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { __resetTerminalIo, setTerminalIo } from "@/../src/shared/terminal-io"
import {
  type ApprovalAttributionGap,
  type ObservabilityWireHandle,
  wireObservability,
} from "@/agent/observability-wire"
import { logger } from "@/shared"

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

const stepClock = (start = 5000, step = 7) => {
  let t = start
  return () => {
    const v = t
    t += step
    return v
  }
}

const gapSink = () => {
  const gaps: ApprovalAttributionGap[] = []
  return { gaps, onApprovalGap: (g: ApprovalAttributionGap) => gaps.push(g) }
}

/** Wire the observability handle with the gate ON (so the SM is really built)
 *  plus an optional gap observer. `now` is injected so the gap's `at` is
 *  deterministic. No hookBus / repoRoot ⇒ attribution + shadowVerify inert,
 *  but the approvalStateMachine slot is populated (that is what we drive). */
const wireOn = (onApprovalGap?: (g: ApprovalAttributionGap) => void): ObservabilityWireHandle =>
  wireObservability({
    enabled: true,
    now: stepClock(),
    ...(onApprovalGap !== undefined ? { onApprovalGap } : {}),
  })

let warnSpy: ReturnType<typeof spyOn> | undefined

/** Extract the `logger.warn` calls whose message names the approval-gap floor.
 *  Typed so the mock-call tuples don't leak `any` into the filter. */
const gapWarns = (): Array<readonly unknown[]> => {
  const calls = (warnSpy?.mock.calls ?? []) as ReadonlyArray<readonly unknown[]>
  return calls.filter((c) => String(c[0]).includes("approval-gap"))
}

beforeEach(() => {
  warnSpy = spyOn(logger, "warn")
})

afterEach(() => {
  warnSpy?.mockRestore()
  warnSpy = undefined
  __resetTerminalIo()
})

/* ================================================================== */
/* A. ON — gap reaches BOTH real consumers through the wire-built SM  */
/* ================================================================== */

describe("A. gap driven through the wire-built SM reaches the real consumer", () => {
  test("A1 unknown-id settle ⇒ observer receives gap AND logger.warn fired (structured)", () => {
    const sink = gapSink()
    const h = wireOn(sink.onApprovalGap)
    expect(h.approvalStateMachine).toBeDefined()

    // Drive the gap through the SM the WIRE built (not a hand-rolled one).
    const out = h.approvalStateMachine?.settle("kernel-never-requested", "approve")
    expect(out).toBeNull() // contract unchanged: no phantom record minted

    // (2) operator observer — the gap surfaced with id + op + decision.
    expect(sink.gaps).toHaveLength(1)
    expect(sink.gaps[0]).toMatchObject({
      approvalId: "kernel-never-requested",
      op: "settle",
      decision: "approve",
    })
    expect(typeof sink.gaps[0]?.at).toBe("number")

    // (1) logger floor — a structured warn carrying the gap fields fired.
    expect(gapWarns()).toHaveLength(1)
    // Structured meta (2nd arg) carries the approvalId/op/decision.
    expect(gapWarns()[0]?.[1]).toMatchObject({
      approvalId: "kernel-never-requested",
      op: "settle",
      decision: "approve",
    })
  })

  test("A2 expire + cancel gaps also route through (per-op, no decision)", () => {
    const sink = gapSink()
    const h = wireOn(sink.onApprovalGap)
    h.approvalStateMachine?.expire("gone-e")
    h.approvalStateMachine?.cancel("gone-c")
    expect(sink.gaps.map((g) => [g.approvalId, g.op])).toEqual([
      ["gone-e", "expire"],
      ["gone-c", "cancel"],
    ])
    expect("decision" in (sink.gaps[0] ?? {})).toBe(false)
    // Logger floor fired once per gap.
    expect(gapWarns()).toHaveLength(2)
  })

  test("A3 NO false gap: a real producer request(id) then settle attributes ⇒ zero gap, zero gap-log", () => {
    const sink = gapSink()
    const h = wireOn(sink.onApprovalGap)
    const asm = h.approvalStateMachine
    asm?.request({
      id: "real-1",
      threadId: "t",
      kind: "escalation",
      reason: "needs decision",
      proposedAction: "bash rm -rf x",
      resumeStep: "resume",
    })
    const settled = asm?.settle("real-1", "approve")
    expect(settled?.status).toBe("approved")
    expect(sink.gaps).toHaveLength(0)
    expect(gapWarns()).toHaveLength(0)
  })
})

/* ================================================================== */
/* B. FLOOR — logger fires even with NO observer                       */
/* ================================================================== */

describe("B. logger floor is a REAL consumer even without an observer", () => {
  test("B1 gate ON, NO onApprovalGap ⇒ gap still reaches logger.warn (never a silent drop)", () => {
    const h = wireOn() // no observer
    expect(h.approvalStateMachine).toBeDefined()
    h.approvalStateMachine?.settle("orphan", "deny")
    expect(gapWarns()).toHaveLength(1)
    expect(gapWarns()[0]?.[1]).toMatchObject({
      approvalId: "orphan",
      op: "settle",
      decision: "deny",
    })
  })

  test("B2 REAL-SINK: the floor genuinely reaches the stderr terminal port (not a no-op)", () => {
    // Prove the logger floor is not swallowed: capture the actual stderr sink.
    // (spyOn proves the call; this proves it reaches a real writer.)
    warnSpy?.mockRestore() // let the real logger run so it hits writeStderr
    warnSpy = undefined
    const prevRate = process.env.QUANTA_LOG_RATE_LIMIT
    process.env.QUANTA_LOG_RATE_LIMIT = "off"
    const chunks: string[] = []
    setTerminalIo({ stdout: () => {}, stderr: (c) => chunks.push(c) })
    try {
      const h = wireOn()
      h.approvalStateMachine?.settle("sink-orphan", "approve")
    } finally {
      if (prevRate === undefined) delete process.env.QUANTA_LOG_RATE_LIMIT
      else process.env.QUANTA_LOG_RATE_LIMIT = prevRate
    }
    const joined = chunks.join("")
    expect(joined).toContain("approval-gap")
    expect(joined).toContain("sink-orphan")
    // re-arm the spy so afterEach's mockRestore is harmless
    warnSpy = spyOn(logger, "warn")
  })
})

/* ================================================================== */
/* C. OFF byte-identical — no SM ⇒ no gap channel (paired control)     */
/* ================================================================== */

describe("C. gate OFF ⇒ SM absent ⇒ no gap channel at all", () => {
  test("C1 default-OFF ⇒ approvalStateMachine undefined; observer never fires", () => {
    const sink = gapSink()
    // Even with an observer passed, gate OFF ⇒ no SM is built ⇒ no wiring.
    const h = wireObservability({ onApprovalGap: sink.onApprovalGap })
    expect(h.approvalStateMachine).toBeUndefined()
    // No SM to drive ⇒ zero gaps, zero gap-logs (byte-identical legacy).
    expect(sink.gaps).toHaveLength(0)
    expect(gapWarns()).toHaveLength(0)
    // degraded stays empty (a gap is NOT a wiring breakage).
    expect(h.degraded).toEqual([])
  })

  test("C2 PAIRED CONTROL: ON handle fires a gap; OFF handle has no SM to fire one", () => {
    const onSink = gapSink()
    const on = wireOn(onSink.onApprovalGap)
    const off = wireObservability({ onApprovalGap: gapSink().onApprovalGap })

    on.approvalStateMachine?.settle("paired", "approve")
    // OFF: no SM ⇒ optional chain no-ops (undefined?.settle()).
    off.approvalStateMachine?.settle("paired", "approve")

    // The ONLY divergence: ON surfaced 1 gap; OFF surfaced 0 (no channel).
    expect(onSink.gaps).toHaveLength(1)
    expect(off.approvalStateMachine).toBeUndefined()
  })

  test("C3 gap is NOT recorded in the frozen `degraded` report (runtime ≠ wiring failure)", () => {
    // A gap fires AFTER wireObservability returns. It must NOT retroactively
    // appear in `handle.degraded` (which is frozen at return + scoped to
    // construct-time breakages) — nor throw by pushing to a frozen array.
    const h = wireOn()
    expect(() => h.approvalStateMachine?.settle("late", "approve")).not.toThrow()
    expect(h.degraded).toEqual([])
    expect(Object.isFrozen(h.degraded)).toBe(true)
  })
})

/* ================================================================== */
/* D. Robustness                                                       */
/* ================================================================== */

describe("D. robustness", () => {
  test("D1 a THROWING onApprovalGap cannot break the SM null-return", () => {
    const h = wireOn(() => {
      throw new Error("hostile gap observer")
    })
    expect(() => {
      const out = h.approvalStateMachine?.settle("boom", "approve")
      expect(out).toBeNull()
    }).not.toThrow()
    // The logger floor still fired (the throw was isolated to the observer fan).
    // ≥1: the primary gap warn (observer-fail warn is a bonus but not required).
    expect(gapWarns().length).toBeGreaterThanOrEqual(1)
  })

  test("D2 idempotent re-settle of a KNOWN id is NOT a gap (was attributed)", () => {
    const sink = gapSink()
    const h = wireOn(sink.onApprovalGap)
    const asm = h.approvalStateMachine
    asm?.request({
      id: "known",
      threadId: "t",
      kind: "permission",
      reason: "x",
      proposedAction: "y",
      resumeStep: "z",
    })
    asm?.settle("known", "approve")
    asm?.settle("known", "deny") // idempotent no-op on terminal record
    expect(sink.gaps).toHaveLength(0)
  })
})
