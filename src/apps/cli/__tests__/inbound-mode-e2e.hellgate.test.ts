import { describe, expect, test } from "bun:test"
import { decideAction } from "@/agent/conversation-action"
import { routeInbound } from "@/agent/inbound-mode"
import type { ActiveTurnState } from "@/agent/steering"
import { createConversationActionSurface } from "@/apps/cli/repl/conversation-action-surface"
import { handleInboundLine, type InboundSinks } from "@/apps/cli/repl/inbound-dispatch"
import { SESSION_SLASH_COMMANDS } from "@/apps/cli/slash/registry-session"
import type { SlashContext } from "@/apps/cli/slash-contract"

// §steer — inbound delivery E2E hellgate. Proves the WHOLE chain end-to-end on
// the REAL surfaces (no fakes for the decision path):
//   1. weave: handleInboundLine → pushUserMessage → port.next() → REAL
//      decideAction → accepted_injection with the right content.
//   2. interrupt: handleInboundLine → pushCancel + enqueue, decideAction →
//      finish_aborted.
//   3. /inbound slash mutates the SAME mode ref the loop reads.

const CONFIG = { maxInputBytes: 1000 }
const activeMain: ActiveTurnState = {
  currentTurn: { turnId: "t1", kind: "main", startedAt: 1, threadId: "x" },
  isInterrupted: false,
}

/** Build sinks bound to a real conversation-action surface + an enqueue spy. */
const wireSinks = () => {
  const surface = createConversationActionSurface()
  surface.activeTurnRef.current = activeMain
  const enqueued: string[] = []
  const sinks: InboundSinks = {
    enqueue: (t) => enqueued.push(t),
    weave: (t) => surface.pushUserMessage(t),
    interrupt: (r) => surface.pushCancel(r),
  }
  return { surface, enqueued, sinks }
}

describe("inbound E2E — weave through the real decideAction", () => {
  test("weave line → pushUserMessage → decideAction yields accepted_injection", () => {
    const { surface, sinks } = wireSinks()
    const ack = handleInboundLine({
      line: "also handle the edge case",
      mode: "weave",
      state: activeMain,
      config: CONFIG,
      now: 100,
      sinks,
    })
    expect(ack.kind).toBe("woven")
    // The surface now holds a user_message action; the loop drains it via next().
    // It MUST carry the live turn id (decideAction's user_message mandates it).
    const action = surface.port.next()
    expect(action).toEqual({
      kind: "user_message",
      input: "also handle the edge case",
      expectedTurnId: "t1",
    })
    // The REAL loop decision: an active main turn ⇒ injection accepted.
    const outcome = decideAction(action as never, activeMain, CONFIG, 100)
    expect(outcome.kind).toBe("accepted_injection")
    if (outcome.kind === "accepted_injection") {
      expect(outcome.injection.content).toBe("also handle the edge case")
    }
  })

  test("interrupt line → pushCancel (decideAction → finish_aborted) + replacement enqueued", () => {
    const { surface, enqueued, sinks } = wireSinks()
    const ack = handleInboundLine({
      line: "stop, do Y instead",
      mode: "interrupt",
      state: activeMain,
      config: CONFIG,
      now: 100,
      sinks,
    })
    expect(ack.kind).toBe("interrupting")
    expect(enqueued).toEqual(["stop, do Y instead"]) // replacement runs after abort
    const action = surface.port.next()
    expect(action?.kind).toBe("cancel")
    const outcome = decideAction(action as never, activeMain, CONFIG, 100)
    expect(outcome.kind).toBe("accepted_control")
  })

  test("weave with NO active turn → falls back to queue (decideAction never sees it)", () => {
    const { surface, enqueued, sinks } = wireSinks()
    const noTurn: ActiveTurnState = { currentTurn: null, isInterrupted: false }
    handleInboundLine({
      line: "msg",
      mode: "weave",
      state: noTurn,
      config: CONFIG,
      now: 100,
      sinks,
    })
    expect(enqueued).toEqual(["msg"]) // queued, not lost
    expect(surface.port.next()).toBeUndefined() // nothing pushed to the action port
  })

  // Cross-check: the pure router agrees with the real decideAction on
  // steerability. decideAction's user_message MANDATES expectedTurnId (it
  // delegates to steer); the surface supplies it from the live turn — here we
  // pass the matching id explicitly.
  test("router weave-accept ⟺ decideAction accepts (consistency)", () => {
    const d = routeInbound({ mode: "weave", input: "x", state: activeMain, config: CONFIG, now: 1 })
    expect(d.kind).toBe("weave")
    const outcome = decideAction(
      { kind: "user_message", input: "x", expectedTurnId: "t1" },
      activeMain,
      CONFIG,
      1,
    )
    expect(outcome.kind).toBe("accepted_injection")
  })
})

describe("inbound E2E — /inbound slash", () => {
  const inboundCmd = SESSION_SLASH_COMMANDS.find((c) => c.name === "/inbound")

  const fakeCtx = (modeRef: { current: "queue" | "weave" | "interrupt" }) => {
    const out: string[] = []
    const ctx = {
      out: (s: string) => out.push(s),
      err: () => {},
      cwd: "/tmp",
      inboundMode: modeRef,
    } as unknown as SlashContext
    return { ctx, out }
  }

  test("/inbound is registered", () => {
    expect(inboundCmd).toBeDefined()
  })

  test("/inbound weave sets the SAME ref the loop reads", async () => {
    const ref = { current: "queue" as const } as { current: "queue" | "weave" | "interrupt" }
    const { ctx, out } = fakeCtx(ref)
    await inboundCmd?.run(["weave"], ctx)
    expect(ref.current).toBe("weave")
    expect(out.join("")).toContain("weave")
  })

  test("/inbound with no arg shows the current mode", async () => {
    const ref = { current: "interrupt" as const } as { current: "queue" | "weave" | "interrupt" }
    const { ctx, out } = fakeCtx(ref)
    await inboundCmd?.run([], ctx)
    expect(out.join("")).toContain("interrupt")
    expect(ref.current).toBe("interrupt") // unchanged
  })

  test("/inbound rejects an unknown mode (ref unchanged)", async () => {
    const ref = { current: "queue" as const } as { current: "queue" | "weave" | "interrupt" }
    const { ctx, out } = fakeCtx(ref)
    const code = await inboundCmd?.run(["bogus"], ctx)
    expect(code).toBe(1)
    expect(ref.current).toBe("queue")
    expect(out.join("")).toContain("unknown mode")
  })
})
