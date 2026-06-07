import { describe, expect, test } from "bun:test"
import type { InboundDecision } from "@/agent/inbound-mode"
import type { ActiveTurnState } from "@/agent/steering"
import {
  dispatchInbound,
  handleInboundLine,
  type InboundSinks,
} from "@/apps/cli/repl/inbound-dispatch"

// §steer — inbound DISPATCH hellgate. `dispatchInbound` maps a pure
// `InboundDecision` onto the CLI's three side-effect sinks (enqueue / weave /
// interrupt) and returns a human ack. Pins: queue→enqueue, weave→weave,
// interrupt→interrupt+enqueue(replacement so the msg runs after the abort),
// queue_fallback→enqueue (NEVER lost), rejected→no sink touched.

const recordingSinks = () => {
  const calls: string[] = []
  const sinks: InboundSinks = {
    enqueue: (t) => calls.push(`enqueue:${t}`),
    weave: (t) => calls.push(`weave:${t}`),
    interrupt: (r) => calls.push(`interrupt:${r}`),
  }
  return { sinks, calls }
}

describe("inbound dispatch", () => {
  test("queue → enqueue only", () => {
    const { sinks, calls } = recordingSinks()
    const ack = dispatchInbound({ kind: "queue", text: "hi" }, sinks)
    expect(calls).toEqual(["enqueue:hi"])
    expect(ack.kind).toBe("queued")
  })

  test("weave → weave only (carries injection content)", () => {
    const { sinks, calls } = recordingSinks()
    const dec: InboundDecision = {
      kind: "weave",
      injection: { role: "user", content: "tweak", injectedAt: 1, injectedDuringTurnId: "t1" },
    }
    const ack = dispatchInbound(dec, sinks)
    expect(calls).toEqual(["weave:tweak"])
    expect(ack.kind).toBe("woven")
  })

  test("interrupt → interrupt(reason) THEN enqueue(replacement) so it runs after abort", () => {
    const { sinks, calls } = recordingSinks()
    const ack = dispatchInbound({ kind: "interrupt", text: "do X instead" }, sinks)
    // ordering: abort first, then the replacement is queued to run next.
    expect(calls[0]?.startsWith("interrupt:")).toBe(true)
    expect(calls).toContain("enqueue:do X instead")
    expect(ack.kind).toBe("interrupting")
  })

  test("queue_fallback → enqueue (message never lost) + ack names the degrade", () => {
    const { sinks, calls } = recordingSinks()
    const ack = dispatchInbound(
      { kind: "queue_fallback", text: "msg", from: "weave", reason: "no_active_turn" },
      sinks,
    )
    expect(calls).toEqual(["enqueue:msg"])
    expect(ack.kind).toBe("queued_fallback")
    expect(ack.message).toContain("weave")
    expect(ack.message).toContain("no_active_turn")
  })

  test("rejected → NO sink touched", () => {
    const { sinks, calls } = recordingSinks()
    const ack = dispatchInbound({ kind: "rejected", reason: "empty_input" }, sinks)
    expect(calls).toEqual([])
    expect(ack.kind).toBe("ignored")
  })
})

describe("handleInboundLine (route + dispatch composition)", () => {
  const CONFIG = { maxInputBytes: 1000 }
  const activeMain: ActiveTurnState = {
    currentTurn: { turnId: "t1", kind: "main", startedAt: 1, threadId: "x" },
    isInterrupted: false,
  }
  const noTurn: ActiveTurnState = { currentTurn: null, isInterrupted: false }

  test("queue mode → queued ack + enqueue", () => {
    const { sinks, calls } = recordingSinks()
    const ack = handleInboundLine({
      line: "hi",
      mode: "queue",
      state: noTurn,
      config: CONFIG,
      now: 1,
      sinks,
    })
    expect(ack.kind).toBe("queued")
    expect(calls).toEqual(["enqueue:hi"])
  })

  test("weave mode + active turn → woven ack + weave sink", () => {
    const { sinks, calls } = recordingSinks()
    const ack = handleInboundLine({
      line: "tweak",
      mode: "weave",
      state: activeMain,
      config: CONFIG,
      now: 1,
      sinks,
    })
    expect(ack.kind).toBe("woven")
    expect(calls).toEqual(["weave:tweak"])
  })

  test("weave mode + no active turn → queued_fallback + enqueue (not lost)", () => {
    const { sinks, calls } = recordingSinks()
    const ack = handleInboundLine({
      line: "m",
      mode: "weave",
      state: noTurn,
      config: CONFIG,
      now: 1,
      sinks,
    })
    expect(ack.kind).toBe("queued_fallback")
    expect(calls).toEqual(["enqueue:m"])
  })

  test("interrupt mode + active turn → interrupting + interrupt&enqueue", () => {
    const { sinks, calls } = recordingSinks()
    const ack = handleInboundLine({
      line: "stop",
      mode: "interrupt",
      state: activeMain,
      config: CONFIG,
      now: 1,
      sinks,
    })
    expect(ack.kind).toBe("interrupting")
    expect(calls[0]?.startsWith("interrupt:")).toBe(true)
    expect(calls).toContain("enqueue:stop")
  })

  test("empty line → ignored, nothing enqueued", () => {
    const { sinks, calls } = recordingSinks()
    const ack = handleInboundLine({
      line: "  ",
      mode: "queue",
      state: noTurn,
      config: CONFIG,
      now: 1,
      sinks,
    })
    expect(ack.kind).toBe("ignored")
    expect(calls).toEqual([])
  })
})
