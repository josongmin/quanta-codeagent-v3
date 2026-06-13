/**
 * Hellgate — thread-follower verbs over the REAL conversation-action transport.
 *
 * This pierces the genuine machinery a follower steer/interrupt rides on, end to
 * end, with NO mocks of the decision boundary:
 *
 *   follower verb → planFollowerVerb (real) → ConversationActionSurface (real,
 *   `createConversationActionSurface`) → port.next() (real FIFO drain) →
 *   decideAction (real §steer / control decision)
 *
 * It proves the T02 lease-safety invariant the parity audit flagged
 * ([[jun-09-cli-web-parity-plan-and-existing-mechanism]] 🔴): a follower
 * `steer-turn` becomes an INJECTION into the lease holder's running turn — NEVER
 * a second writer. When the turn id has moved on (a new turn started) the steer
 * is REJECTED rather than written into the wrong turn, and with no active turn it
 * degrades cleanly instead of contending on the single-writer lease.
 */
import { describe, expect, test } from "bun:test"
import { decideAction } from "@/agent/conversation-action"
import type { SteerConfig } from "@/agent/steering"
import { planFollowerVerb } from "@/agent/thread-follower"
import { createConversationActionSurface } from "../../../../src/apps/cli/repl/conversation-action-surface"

const CFG: SteerConfig = { maxInputBytes: 10_000 }

const activeMainTurn = (turnId: string) => ({
  currentTurn: { turnId, kind: "main" as const, startedAt: 0, threadId: "thread-1" },
  isInterrupted: false,
})

describe("UC1 — follower steer-turn injects into the running turn (lease-safe)", () => {
  test("steer-turn → inject → pushUserMessage → decideAction accepts an INJECTION", () => {
    const surface = createConversationActionSurface()
    // The loop owns activeTurnRef; simulate the live turn it would have written.
    surface.activeTurnRef.current = activeMainTurn("turn-1")

    // Follower issues the verb; the planner maps it to the lease-safe `inject`.
    const effect = planFollowerVerb({ kind: "steer-turn", text: "prefer the v2 API" }, {})
    expect(effect).toEqual({ kind: "inject", text: "prefer the v2 API" })
    if (effect.kind !== "inject") throw new Error("unreachable")

    // The host applies it via the surface's lease-safe weave push.
    surface.pushUserMessage(effect.text)

    // The loop drains exactly one action per turn-poll.
    const action = surface.port.next()
    expect(action?.kind).toBe("user_message")
    if (action?.kind !== "user_message") throw new Error("unreachable")
    // It captured the LIVE turn id (optimistic concurrency) — not a fabricated one.
    expect(action.expectedTurnId).toBe("turn-1")

    // The REAL decision boundary accepts it as an injection into turn-1.
    const outcome = decideAction(action, surface.activeTurnRef.current, CFG, 100)
    expect(outcome.kind).toBe("accepted_injection")
    // FIFO drained ⇒ nothing left (at-most-once).
    expect(surface.port.next()).toBeUndefined()
  })

  test("steer captured against turn-1 is REJECTED if turn-2 is now live (no wrong-turn write)", () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = activeMainTurn("turn-1")
    surface.pushUserMessage("late steer")
    const action = surface.port.next()
    if (action?.kind !== "user_message") throw new Error("unreachable")
    expect(action.expectedTurnId).toBe("turn-1")

    // The loop advanced to turn-2 before draining. The steer must NOT land on it.
    const outcome = decideAction(action, activeMainTurn("turn-2"), CFG, 200)
    expect(outcome.kind).toBe("rejected")
  })
})

describe("UC2 — follower interrupt-turn aborts via the lease-bypassing cancel", () => {
  test("interrupt-turn → interrupt → pushCancel → decideAction accepts a cancel control", () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = activeMainTurn("turn-1")

    const effect = planFollowerVerb({ kind: "interrupt-turn", reason: "wrong direction" }, {})
    expect(effect).toEqual({ kind: "interrupt", reason: "wrong direction" })
    if (effect.kind !== "interrupt") throw new Error("unreachable")

    surface.pushCancel(effect.reason)
    const action = surface.port.next()
    expect(action?.kind).toBe("cancel")
    if (action?.kind !== "cancel") throw new Error("unreachable")

    const outcome = decideAction(action, surface.activeTurnRef.current, CFG, 100)
    expect(outcome.kind).toBe("accepted_control")
    if (outcome.kind === "accepted_control") expect(outcome.action.kind).toBe("cancel")
  })
})
