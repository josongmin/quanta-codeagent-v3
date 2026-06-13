/**
 * Hellgate — thread-follower co-control protocol (T02).
 *
 * A FOLLOWER (auxiliary client) co-controls ONE live thread via timeout-bounded
 * verbs. Two pure cores under test:
 *
 *   A. `planFollowerVerb(verb, ctx)` — maps a follower verb onto an EXISTING
 *      lease-safe effect (inject / interrupt / approval-relay / queue-mode-set).
 *      NO-THROW; invalid ⇒ `rejected`. SECURITY: a relay-APPROVE of a HARD_DENY
 *      command is rejected fail-closed at the relay boundary (UC3).
 *
 *   B. `FollowerVerbTracker` — the request/response/**timeout** discipline. A
 *      response that lands after the deadline is STALE and never applied; the
 *      defined fallback owns the decision (UC4 — no stale-decision relay).
 *
 * RED-on-injection: the dangerous-command relay-approve test FAILS if the guard
 * is removed (the effect would become `approval-relay` instead of `rejected`).
 */
import { describe, expect, test } from "bun:test"
import { invertInboundModeOnce } from "@/agent/inbound-mode"
import {
  ALL_FOLLOWER_VERB_KINDS,
  type FollowerEffect,
  type FollowerPlanContext,
  type FollowerVerb,
  FollowerVerbTracker,
  isFollowerCoControlEnabled,
  planFollowerVerb,
} from "@/agent/thread-follower"
import type { ToolAction } from "@/permission"
import { hardDenyReason } from "@/permission"

const noCtx: FollowerPlanContext = {}

const isRejected = (e: FollowerEffect): e is Extract<FollowerEffect, { kind: "rejected" }> =>
  e.kind === "rejected"

describe("planFollowerVerb — verb→effect happy path", () => {
  test("steer-turn ⇒ inject (the §steer lease-safe path)", () => {
    expect(planFollowerVerb({ kind: "steer-turn", text: "use the v2 API" }, noCtx)).toEqual({
      kind: "inject",
      text: "use the v2 API",
    })
  })

  test("interrupt-turn ⇒ interrupt with reason", () => {
    expect(planFollowerVerb({ kind: "interrupt-turn", reason: "wrong file" }, noCtx)).toEqual({
      kind: "interrupt",
      reason: "wrong file",
    })
  })

  test("command-approval-decision deny ⇒ approval-relay (always safe)", () => {
    expect(
      planFollowerVerb(
        { kind: "command-approval-decision", approvalId: "a1", decision: "deny" },
        noCtx,
      ),
    ).toEqual({ kind: "approval-relay", approvalId: "a1", decision: "deny" })
  })

  test("deny carries a corrective steer when present", () => {
    expect(
      planFollowerVerb(
        {
          kind: "command-approval-decision",
          approvalId: "a1",
          decision: "deny",
          steer: "try the read tool",
        },
        noCtx,
      ),
    ).toEqual({
      kind: "approval-relay",
      approvalId: "a1",
      decision: "deny",
      steer: "try the read tool",
    })
  })

  test("approve DROPS a stray steer (steer is deny-only, mirrors ApprovalRespondCommand)", () => {
    expect(
      planFollowerVerb(
        {
          kind: "command-approval-decision",
          approvalId: "a1",
          decision: "approve",
          steer: "noise",
        },
        noCtx,
      ),
    ).toEqual({ kind: "approval-relay", approvalId: "a1", decision: "approve" })
  })

  test("set-queue-mode ⇒ queue-mode-set", () => {
    expect(planFollowerVerb({ kind: "set-queue-mode", mode: "weave" }, noCtx)).toEqual({
      kind: "queue-mode-set",
      mode: "weave",
    })
  })
})

describe("planFollowerVerb — rejections (fail-closed, NO-THROW)", () => {
  test("empty steer text ⇒ rejected, not injected", () => {
    expect(planFollowerVerb({ kind: "steer-turn", text: "   " }, noCtx).kind).toBe("rejected")
  })
  test("empty interrupt reason ⇒ rejected", () => {
    expect(planFollowerVerb({ kind: "interrupt-turn", reason: "" }, noCtx).kind).toBe("rejected")
  })
  test("empty approvalId ⇒ rejected", () => {
    expect(
      planFollowerVerb(
        { kind: "command-approval-decision", approvalId: "", decision: "approve" },
        noCtx,
      ).kind,
    ).toBe("rejected")
  })
  test("unknown queue mode ⇒ rejected", () => {
    expect(planFollowerVerb({ kind: "set-queue-mode", mode: "turbo" as never }, noCtx).kind).toBe(
      "rejected",
    )
  })
  test("garbage shapes never throw ⇒ rejected", () => {
    for (const junk of [null, undefined, 42, "steer-turn", {}, { kind: 7 }, { kind: "nope" }]) {
      const e = planFollowerVerb(junk as never, noCtx)
      expect(e.kind).toBe("rejected")
    }
  })
})

/* ----------------------------------------------------------------------------
 * UC3 — HARD_DENY fail-closed at the relay boundary (the SECURITY core).
 * Uses the REAL `@/permission` hardDenyReason oracle (not a stub) so the test
 * proves the actual denylist, not a re-implementation.
 * -------------------------------------------------------------------------- */
const dangerous: ToolAction = {
  tool: "bash",
  input: { command: "rm -rf /" },
  isReadOnly: false,
  shellCommand: "rm -rf /",
}
const benign: ToolAction = {
  tool: "bash",
  input: { command: "ls -la" },
  isReadOnly: true,
  shellCommand: "ls -la",
}

describe("UC3 — relay-approve HARD_DENY re-check (red-on-injection)", () => {
  const realGuardCtx: FollowerPlanContext = {
    hardDenyReason,
    resolveProposedAction: (id) => (id === "danger" ? dangerous : id === "ok" ? benign : undefined),
  }

  test("relay-APPROVE of a dangerous command ⇒ REJECTED (the guard)", () => {
    const e = planFollowerVerb(
      { kind: "command-approval-decision", approvalId: "danger", decision: "approve" },
      realGuardCtx,
    )
    // If the HARD_DENY guard were removed this would be `approval-relay` ⇒ RED.
    expect(isRejected(e)).toBe(true)
    if (isRejected(e)) expect(e.reason).toContain("relay-approve blocked")
  })

  test("relay-APPROVE of a benign command ⇒ forwards", () => {
    expect(
      planFollowerVerb(
        { kind: "command-approval-decision", approvalId: "ok", decision: "approve" },
        realGuardCtx,
      ),
    ).toEqual({ kind: "approval-relay", approvalId: "ok", decision: "approve" })
  })

  test("relay-DENY of a dangerous command ⇒ forwards (denying is always safe)", () => {
    expect(
      planFollowerVerb(
        { kind: "command-approval-decision", approvalId: "danger", decision: "deny" },
        realGuardCtx,
      ).kind,
    ).toBe("approval-relay")
  })

  test("guard only re-checks when BOTH resolver+oracle wired (no oracle ⇒ forwards)", () => {
    // Without the oracle the planner cannot re-check; it forwards (a surface that
    // never wired the gate). This documents the seam — NOT a bypass, because the
    // composition root ALWAYS wires the real oracle.
    expect(
      planFollowerVerb(
        { kind: "command-approval-decision", approvalId: "danger", decision: "approve" },
        { resolveProposedAction: () => dangerous },
      ).kind,
    ).toBe("approval-relay")
  })
})

describe("exhaustiveness + gate", () => {
  test("ALL_FOLLOWER_VERB_KINDS covers every verb kind & is frozen", () => {
    expect([...ALL_FOLLOWER_VERB_KINDS].sort()).toEqual(
      ["command-approval-decision", "interrupt-turn", "set-queue-mode", "steer-turn"].sort(),
    )
    expect(Object.isFrozen(ALL_FOLLOWER_VERB_KINDS)).toBe(true)
  })
  test("isFollowerCoControlEnabled reuses QUANTA_THIN_CLIENT_DISPATCH (default-OFF)", () => {
    expect(isFollowerCoControlEnabled({})).toBe(false)
    expect(isFollowerCoControlEnabled({ QUANTA_THIN_CLIENT_DISPATCH: "on" })).toBe(true)
    expect(isFollowerCoControlEnabled({ QUANTA_THIN_CLIENT_DISPATCH: "off" })).toBe(false)
  })
})

/* ----------------------------------------------------------------------------
 * UC4 — timeout / stale-decision discipline.
 * -------------------------------------------------------------------------- */
const verb = (text: string): FollowerVerb => ({ kind: "steer-turn", text })

describe("FollowerVerbTracker — request/response in time", () => {
  test("resolve before the deadline ⇒ apply", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("a") })
    const r = t.resolve("v1", 50)
    expect(r).toEqual({ kind: "apply", verb: verb("a") })
  })

  test("resolve AT the deadline ⇒ apply (inclusive)", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("a") })
    expect(t.resolve("v1", 100).kind).toBe("apply")
  })

  test("a verb is applied at most once (replay ⇒ already_resolved)", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("a") })
    expect(t.resolve("v1", 10).kind).toBe("apply")
    expect(t.resolve("v1", 11)).toEqual({ kind: "stale", reason: "already_resolved" })
  })

  test("unknown verbId ⇒ stale unknown_verb", () => {
    const t = new FollowerVerbTracker()
    expect(t.resolve("ghost", 10)).toEqual({ kind: "stale", reason: "unknown_verb" })
  })
})

describe("UC4 — STALE-DECISION guard (the headline invariant)", () => {
  test("response AFTER the deadline ⇒ stale, NEVER applied", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("late") })
    const r = t.resolve("v1", 101)
    expect(r).toEqual({ kind: "stale", reason: "timed_out" })
  })

  test("sweep fires the fallback once; a later resolve is stale", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("x") })
    t.register({ verbId: "v2", issuedAt: 0, deadlineAt: 100, verb: verb("y") })
    const swept = t.sweep(200)
    expect(swept.map((s) => s.verbId).sort()).toEqual(["v1", "v2"])
    // Second sweep surfaces nothing (transition happens once).
    expect(t.sweep(300)).toEqual([])
    // A follower that responds AFTER the fallback fired is ignored.
    expect(t.resolve("v1", 250)).toEqual({ kind: "stale", reason: "timed_out" })
  })

  test("sweep does NOT time out a still-alive verb", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("x") })
    expect(t.sweep(50)).toEqual([])
    expect(t.resolve("v1", 60).kind).toBe("apply")
  })

  test("duplicate register is ignored — cannot reset a deadline", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("first") })
    // A retransmit with a LATER deadline must NOT extend the verb's life.
    expect(
      t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 10_000, verb: verb("second") }),
    ).toBe(false)
    expect(t.resolve("v1", 200)).toEqual({ kind: "stale", reason: "timed_out" })
  })

  test("garbage clock never spuriously times a verb out (fail-safe)", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("x") })
    expect(t.sweep(Number.NaN)).toEqual([])
    expect(t.resolve("v1", Number.POSITIVE_INFINITY).kind).toBe("apply")
  })

  test("pendingCount + prune track lifecycle", () => {
    const t = new FollowerVerbTracker()
    t.register({ verbId: "v1", issuedAt: 0, deadlineAt: 100, verb: verb("x") })
    t.register({ verbId: "v2", issuedAt: 0, deadlineAt: 100, verb: verb("y") })
    expect(t.pendingCount()).toBe(2)
    t.resolve("v1", 10)
    expect(t.pendingCount()).toBe(1)
    expect(t.prune()).toBe(1) // the resolved v1 dropped; v2 still pending
    expect(t.pendingCount()).toBe(1)
  })
})

describe("UC5 — per-message queue-mode invert", () => {
  test("queue ⇄ weave is the headline invert (involutive)", () => {
    expect(invertInboundModeOnce("queue")).toBe("weave")
    expect(invertInboundModeOnce("weave")).toBe("queue")
    expect(invertInboundModeOnce(invertInboundModeOnce("queue"))).toBe("queue")
  })
  test("interrupt inverts to queue (defer the barge-in)", () => {
    expect(invertInboundModeOnce("interrupt")).toBe("queue")
  })
})
