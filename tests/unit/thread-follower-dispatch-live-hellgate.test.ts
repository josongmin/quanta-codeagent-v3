/**
 * ★ HELLGATE — thread-follower co-control DISPATCHER, end-to-end over REAL
 * collaborators (T02, the "live" closeout).
 *
 * No mocks of the decision/approval boundaries. The dispatcher is fed verbs the
 * way a web/ide follower frame decoder would, and its sinks are bound to the SAME
 * real machinery the host wires:
 *
 *   - steer/interrupt → real `createConversationActionSurface` → real `decideAction`
 *     (proves lease-safe inject into the running turn — never a 2nd writer).
 *   - approval relay  → real `createRuntimeApprovalProtocolController.resolveApproval`
 *     (the `approval.respond` resolver) with the REAL `@/permission` hardDenyReason
 *     + the live action map.
 *
 * Invariants pinned:
 *   UC1 steer-turn injects into the lease holder's turn.
 *   UC2 interrupt-turn aborts via the lease-bypass cancel.
 *   UC3 a relay-APPROVE of a HARD_DENY command is rejected — the resolver sink is
 *       NEVER called, so NO lease is minted (re-prompts). RED-on-injection.
 *   UC4 a relay that lands AFTER the deadline is STALE — dropped, resolver never
 *       called; `sweep` fires the fail-safe DENY fallback for an unanswered approval.
 *   UC5 set-queue-mode mutates the inbound-mode ref.
 */
import { describe, expect, test } from "bun:test"
import { decideAction } from "@/agent/conversation-action"
import type { InboundMode } from "@/agent/inbound-mode"
import type { SteerConfig } from "@/agent/steering"
import { FollowerCoControlDispatcher, type FollowerCoControlSinks } from "@/agent/thread-follower"
import {
  createRuntimeApprovalProtocolController,
  RuntimeApprovalRequiredError,
} from "@/host/runtime/internal/context-binding"
import { hardDenyReason, type ToolAction } from "@/permission"
import { createConversationActionSurface } from "../../src/apps/cli/repl/conversation-action-surface"

const CFG: SteerConfig = { maxInputBytes: 10_000 }
const activeMainTurn = (turnId: string) => ({
  currentTurn: { turnId, kind: "main" as const, startedAt: 0, threadId: "t1" },
  isInterrupted: false,
})

/* ── UC1/UC2/UC5: FIRE verbs over the real conversation-action surface ─────── */
describe("dispatcher FIRE verbs → real conversation-action transport", () => {
  const wire = () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = activeMainTurn("turn-1")
    const inbound: { current: InboundMode } = { current: "queue" }
    const sinks: FollowerCoControlSinks = {
      inject: (t) => surface.pushUserMessage(t),
      interrupt: (r) => surface.pushCancel(r),
      setQueueMode: (m) => {
        inbound.current = m
      },
      relayApproval: () => {
        throw new Error("relayApproval not expected for fire verbs")
      },
    }
    const d = new FollowerCoControlDispatcher({ sinks, plan: {} })
    return { surface, inbound, d }
  }

  test("UC1 steer-turn → injection into the lease holder's running turn", () => {
    const { surface, d } = wire()
    expect(d.dispatch({ kind: "steer-turn", text: "use v2" })).toEqual({
      kind: "applied",
      verb: "steer-turn",
    })
    const action = surface.port.next()
    expect(action?.kind).toBe("user_message")
    if (action?.kind !== "user_message") throw new Error("unreachable")
    const outcome = decideAction(action, surface.activeTurnRef.current, CFG, 100)
    expect(outcome.kind).toBe("accepted_injection")
  })

  test("UC2 interrupt-turn → cancel control via the surface", () => {
    const { surface, d } = wire()
    expect(d.dispatch({ kind: "interrupt-turn", reason: "stop" }).kind).toBe("applied")
    const action = surface.port.next()
    if (action?.kind !== "cancel") throw new Error("unreachable")
    expect(decideAction(action, surface.activeTurnRef.current, CFG, 100).kind).toBe(
      "accepted_control",
    )
  })

  test("UC5 set-queue-mode → mutates the inbound-mode ref", () => {
    const { inbound, d } = wire()
    expect(d.dispatch({ kind: "set-queue-mode", mode: "weave" }).kind).toBe("applied")
    expect(inbound.current).toBe("weave")
  })

  test("an approval decision routed to the FIRE path is rejected (must use relayApproval)", () => {
    const { d } = wire()
    const out = d.dispatch({
      kind: "command-approval-decision",
      approvalId: "a",
      decision: "approve",
    })
    expect(out.kind).toBe("rejected")
  })
})

/* ── UC3/UC4: approval relay over the REAL resolver + timeout discipline ───── */
type Ctrl = ReturnType<typeof createRuntimeApprovalProtocolController>

const makeCtrl = (): { ctrl: Ctrl; slot: { current: (a: ToolAction) => Promise<boolean> } } => {
  const slot = { current: (async () => true) as (a: ToolAction) => Promise<boolean> }
  const base = {
    registry: { extractShellCommand: () => null },
    approvalProtocol: { confirmSlot: slot },
  }
  const ctrl = createRuntimeApprovalProtocolController(
    base as unknown as Parameters<typeof createRuntimeApprovalProtocolController>[0],
  )
  return { ctrl, slot }
}
const bash = (command: string): ToolAction => ({
  tool: "bash",
  input: { command },
  isReadOnly: false,
  shellCommand: command,
})
const requestApproval = async (
  ctrl: Ctrl,
  slot: { current: (a: ToolAction) => Promise<boolean> },
  act: ToolAction,
): Promise<string> => {
  try {
    await ctrl.runWithProtocol(async () => {
      await slot.current(act)
    })
  } catch (e) {
    if (e instanceof RuntimeApprovalRequiredError) return e.approval.approvalId
    throw e
  }
  throw new Error("expected approval")
}

const wireApproval = (ctrl: Ctrl, action: ToolAction) => {
  let relayed = 0
  const sinks: FollowerCoControlSinks = {
    inject: () => {},
    interrupt: () => {},
    setQueueMode: () => {},
    relayApproval: (id, decision, steer) => {
      relayed += 1
      ctrl.resolveApproval(id, decision, steer !== undefined ? { steer } : undefined)
    },
  }
  const d = new FollowerCoControlDispatcher({
    sinks,
    // Real HARD_DENY oracle + the live action behind this approval.
    plan: { hardDenyReason, resolveProposedAction: () => action },
  })
  return { d, relayedCount: () => relayed }
}

describe("dispatcher approval relay → real resolver (UC3 HARD_DENY, UC4 timeout)", () => {
  test("UC3 relay-APPROVE of a HARD_DENY command ⇒ rejected, resolver NEVER called, no lease", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApproval(ctrl, slot, bash("rm -rf /"))
    const { d, relayedCount } = wireApproval(ctrl, bash("rm -rf /"))
    d.openApproval(id, 0, 100)
    const out = d.relayApproval(id, "approve", 50)
    expect(out.kind).toBe("rejected") // plan-level HARD_DENY veto (RED if guard removed)
    expect(relayedCount()).toBe(0) // resolver sink never touched
    // No lease minted ⇒ the dangerous action re-prompts.
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(bash("rm -rf /"))
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })

  test("control: relay-APPROVE of a BENIGN command in time ⇒ applied, lease claimed", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApproval(ctrl, slot, bash("ls"))
    const { d } = wireApproval(ctrl, bash("ls"))
    d.openApproval(id, 0, 100)
    expect(d.relayApproval(id, "approve", 50).kind).toBe("applied")
    let confirmed = false
    await ctrl.runWithProtocol(async () => {
      confirmed = await slot.current(bash("ls"))
    })
    expect(confirmed).toBe(true)
  })

  test("UC4 relay AFTER the deadline ⇒ stale, resolver NEVER called, action re-prompts", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApproval(ctrl, slot, bash("ls"))
    const { d, relayedCount } = wireApproval(ctrl, bash("ls"))
    d.openApproval(id, 0, 100)
    const out = d.relayApproval(id, "approve", 101) // 1ms late
    expect(out).toEqual({ kind: "stale", reason: "timed_out" })
    expect(relayedCount()).toBe(0)
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(bash("ls"))
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })

  test("UC4 sweep fires the fail-safe DENY fallback for an unanswered approval", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApproval(ctrl, slot, bash("ls"))
    const { d, relayedCount } = wireApproval(ctrl, bash("ls"))
    d.openApproval(id, 0, 100)
    const timed = d.sweep(200)
    expect(timed).toEqual([{ approvalId: id, fallback: "deny" }])
    expect(relayedCount()).toBe(1) // a DENY was forwarded to the resolver
    // A follower that responds AFTER the fallback is stale (no double-resolve).
    expect(d.relayApproval(id, "approve", 250).kind).toBe("stale")
    expect(relayedCount()).toBe(1)
    // Deny minted no lease ⇒ re-prompts.
    await expect(
      ctrl.runWithProtocol(async () => {
        await slot.current(bash("ls"))
      }),
    ).rejects.toBeInstanceOf(RuntimeApprovalRequiredError)
  })

  test("pendingApprovals reflects the outstanding-request count", async () => {
    const { ctrl, slot } = makeCtrl()
    const id = await requestApproval(ctrl, slot, bash("ls"))
    const { d } = wireApproval(ctrl, bash("ls"))
    d.openApproval(id, 0, 100)
    expect(d.pendingApprovals()).toBe(1)
    d.relayApproval(id, "deny", 10)
    expect(d.pendingApprovals()).toBe(0)
  })
})
