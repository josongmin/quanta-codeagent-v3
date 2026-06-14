/**
 * ★ HELLGATE — thread-follower FIRE-verb DISPATCHER over REAL collaborators (T02).
 *
 * No mocks of the decision boundary. The dispatcher is fed verbs the way a
 * web/ide follower frame decoder would, and its sinks are bound to the SAME real
 * machinery the host wires: steer/interrupt → real `createConversationActionSurface`
 * → real `decideAction` (proves lease-safe inject into the running turn — never a
 * 2nd writer). The APPROVAL RELAY lives in its own coordinator (see
 * thread-follower-approval-coordinator-hellgate); an approval verb routed to the
 * FIRE dispatcher is rejected.
 *
 *   UC1 steer-turn injects into the lease holder's turn.
 *   UC2 interrupt-turn aborts via the lease-bypass cancel.
 *   UC5 set-queue-mode mutates the inbound-mode ref.
 *   + steer with no active turn drops cleanly (no empty-id enqueue → no crash).
 */
import { describe, expect, test } from "bun:test"
import { decideAction } from "@/agent/conversation-action"
import type { InboundMode } from "@/agent/inbound-mode"
import type { SteerConfig } from "@/agent/steering"
import { FollowerCoControlDispatcher, type FollowerCoControlSinks } from "@/agent/thread-follower"
import { createConversationActionSurface } from "../../src/apps/cli/repl/conversation-action-surface"

const CFG: SteerConfig = { maxInputBytes: 10_000 }
const activeMainTurn = (turnId: string) => ({
  currentTurn: { turnId, kind: "main" as const, startedAt: 0, threadId: "t1" },
  isInterrupted: false,
})

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
    }
    const d = new FollowerCoControlDispatcher({ sinks })
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

  test("steer with NO active turn is DROPPED cleanly (no empty-id enqueue → no loop crash)", () => {
    // Regression (adversarial audit): a follower steer while the session is idle
    // must NOT enqueue a `user_message` with an empty expectedTurnId — that would
    // throw SteerInputInvalidError out of the uncaught pollConversationAction →
    // decideAction path and crash the session. The surface drops it instead.
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = { currentTurn: null, isInterrupted: false }
    const sinks: FollowerCoControlSinks = {
      inject: (t) => surface.pushUserMessage(t),
      interrupt: (r) => surface.pushCancel(r),
      setQueueMode: () => {},
    }
    const d = new FollowerCoControlDispatcher({ sinks })
    expect(d.dispatch({ kind: "steer-turn", text: "while idle" }).kind).toBe("applied")
    expect(surface.port.next()).toBeUndefined()
  })

  test("UC5 set-queue-mode → mutates the inbound-mode ref", () => {
    const { inbound, d } = wire()
    expect(d.dispatch({ kind: "set-queue-mode", mode: "weave" }).kind).toBe("applied")
    expect(inbound.current).toBe("weave")
  })

  test("an approval decision routed to the FIRE path is rejected (must use the coordinator)", () => {
    const { d } = wire()
    const out = d.dispatch({
      kind: "command-approval-decision",
      approvalId: "a",
      decision: "approve",
    })
    expect(out.kind).toBe("rejected")
  })
})
