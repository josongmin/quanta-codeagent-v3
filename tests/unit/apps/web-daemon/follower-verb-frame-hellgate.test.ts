/**
 * ★ HELLGATE — web-daemon follower-verb frame → dispatcher → real surface.
 *
 * Proves the WEB 2nd-client transport byte-path end-to-end with the REAL
 * collaborators: a `followerVerb` WS frame string → `peekFollowerVerb` (the
 * connection-layer decode) → `FollowerCoControlDispatcher` (real) → real
 * `createConversationActionSurface` → real `decideAction`. A web follower's
 * steer lands as an INJECTION into the lease holder's running turn — the jun-09
 * CLI↔web parity gap, closed for the inbound side.
 *
 * Also pins the decoder's fail-safe contract: a non-follower / malformed frame
 * returns null (falls through to the session bridge, byte-identical).
 */
import { describe, expect, test } from "bun:test"
import { decideAction } from "@/agent/conversation-action"
import type { InboundMode } from "@/agent/inbound-mode"
import type { SteerConfig } from "@/agent/steering"
import { FollowerCoControlDispatcher, type FollowerCoControlSinks } from "@/agent/thread-follower"
import { peekFollowerVerb } from "@/apps/web-daemon/follower-verb-frame"
import { createConversationActionSurface } from "../../../../src/apps/cli/repl/conversation-action-surface"

const CFG: SteerConfig = { maxInputBytes: 10_000 }
const frame = (verb: unknown) => JSON.stringify({ kind: "followerVerb", verb })

describe("peekFollowerVerb — decode contract", () => {
  test("a well-formed followerVerb frame ⇒ the inner verb", () => {
    expect(peekFollowerVerb(frame({ kind: "steer-turn", text: "hi" }))).toEqual({
      kind: "steer-turn",
      text: "hi",
    })
  })
  test("non-follower frames / garbage ⇒ null (fall through to the bridge)", () => {
    for (const raw of [
      JSON.stringify({ kind: "planInputAnswer", promptId: "p" }),
      JSON.stringify({ kind: "followerVerb" }), // no verb
      JSON.stringify({ kind: "followerVerb", verb: 42 }),
      JSON.stringify({ kind: "followerVerb", verb: { noKind: true } }),
      JSON.stringify([1, 2, 3]),
      "not json {",
      "null",
    ]) {
      expect(peekFollowerVerb(raw)).toBeNull()
    }
  })
})

describe("web follower frame → dispatcher → real conversation-action surface", () => {
  const wire = () => {
    const surface = createConversationActionSurface()
    surface.activeTurnRef.current = {
      currentTurn: { turnId: "turn-1", kind: "main", startedAt: 0, threadId: "t1" },
      isInterrupted: false,
    }
    const inbound: { current: InboundMode } = { current: "queue" }
    const sinks: FollowerCoControlSinks = {
      inject: (t) => surface.pushUserMessage(t),
      interrupt: (r) => surface.pushCancel(r),
      setQueueMode: (m) => {
        inbound.current = m
      },
      relayApproval: () => {
        throw new Error("approvals ride approval.respond, not the frame")
      },
    }
    return { surface, inbound, d: new FollowerCoControlDispatcher({ sinks, plan: {} }) }
  }

  test("a web follower steer frame INJECTS into the lease holder's running turn", () => {
    const { surface, d } = wire()
    const verb = peekFollowerVerb(frame({ kind: "steer-turn", text: "prefer v2" }))
    expect(verb).not.toBeNull()
    if (verb === null) throw new Error("unreachable")
    expect(d.dispatch(verb).kind).toBe("applied")
    const action = surface.port.next()
    if (action?.kind !== "user_message") throw new Error("unreachable")
    expect(decideAction(action, surface.activeTurnRef.current, CFG, 100).kind).toBe(
      "accepted_injection",
    )
  })

  test("a web follower set-queue-mode frame mutates the inbound ref", () => {
    const { inbound, d } = wire()
    const verb = peekFollowerVerb(frame({ kind: "set-queue-mode", mode: "weave" }))
    if (verb === null) throw new Error("unreachable")
    expect(d.dispatch(verb).kind).toBe("applied")
    expect(inbound.current).toBe("weave")
  })

  test("an approval-decision frame is rejected by dispatch (must ride approval.respond)", () => {
    const { d } = wire()
    const verb = peekFollowerVerb(
      frame({ kind: "command-approval-decision", approvalId: "a", decision: "approve" }),
    )
    if (verb === null) throw new Error("unreachable")
    expect(d.dispatch(verb).kind).toBe("rejected")
  })
})
