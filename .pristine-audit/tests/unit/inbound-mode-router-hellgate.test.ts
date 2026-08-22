import { describe, expect, test } from "bun:test"
import { ALL_INBOUND_MODES, type InboundMode, routeInbound } from "@/agent/inbound-mode"
import type { ActiveTurnState } from "@/agent/steering"
import type { TurnHeader, TurnKind } from "@/agent/turn-kind"

// §steer — inbound message-delivery ROUTER hellgate. Three modes for how a
// fired user message is handled while a turn is in flight:
//   queue     — enqueue → runs as the NEXT turn (FIFO follow-up)
//   weave     — inject into the CURRENT in-flight turn (Claude-IDE live blend)
//   interrupt — abort the current turn + resubmit this message fresh (Codex barge-in)
// routeInbound is the PURE decision. Load-bearing invariants pinned here:
//   - a weave/interrupt that CANNOT apply mid-turn falls back to queue (NEVER lost),
//   - reuses steer() steerability (review/compact non-steerable, turn-id, interrupted),
//   - empty/oversized input is rejected uniformly across modes.

const CONFIG = { maxInputBytes: 1000 }
const NOW = 1_000_000

const header = (turnId: string, kind: TurnKind): TurnHeader => ({
  turnId,
  kind,
  startedAt: 1,
  threadId: "t",
})

const activeMain: ActiveTurnState = { currentTurn: header("turn-1", "main"), isInterrupted: false }
const noTurn: ActiveTurnState = { currentTurn: null, isInterrupted: false }
const interrupted: ActiveTurnState = {
  currentTurn: header("turn-1", "main"),
  isInterrupted: true,
}
const reviewTurn: ActiveTurnState = {
  currentTurn: header("turn-1", "review"),
  isInterrupted: false,
}

const route = (mode: InboundMode, input: string, state: ActiveTurnState, expectedTurnId?: string) =>
  routeInbound({
    mode,
    input,
    state,
    config: CONFIG,
    now: NOW,
    ...(expectedTurnId !== undefined ? { expectedTurnId } : {}),
  })

describe("inbound router — taxonomy", () => {
  test("ALL_INBOUND_MODES is exactly the closed set", () => {
    expect([...ALL_INBOUND_MODES].sort()).toEqual(["interrupt", "queue", "weave"])
  })
})

describe("inbound router — input validation (all modes)", () => {
  test("empty input ⇒ rejected empty_input", () => {
    for (const m of ALL_INBOUND_MODES) {
      const d = route(m, "   ", activeMain)
      expect(d.kind).toBe("rejected")
      expect(d.kind === "rejected" && d.reason).toBe("empty_input")
    }
  })

  test("oversized input is NEVER lost — preserved per mode (no hard reject)", () => {
    const big = "x".repeat(1001) // > maxInputBytes (1000)
    // queue: enqueued as-is (next turn has no inject-size limit).
    expect(route("queue", big, activeMain).kind).toBe("queue")
    // weave: too big to inject mid-turn ⇒ steer rejects input_too_large ⇒ queued.
    const w = route("weave", big, activeMain)
    expect(w.kind).toBe("queue_fallback")
    expect(w.kind === "queue_fallback" && w.reason).toBe("input_too_large")
    // interrupt: aborts + the (big) replacement runs as the next turn.
    expect(route("interrupt", big, activeMain).kind).toBe("interrupt")
  })
})

describe("inbound router — queue mode", () => {
  test("queue always enqueues regardless of turn state", () => {
    for (const st of [activeMain, noTurn, interrupted, reviewTurn]) {
      const d = route("queue", "hello", st)
      expect(d.kind).toBe("queue")
      expect(d.kind === "queue" && d.text).toBe("hello")
    }
  })
})

describe("inbound router — weave mode", () => {
  test("active main turn ⇒ weave with a correct injection", () => {
    const d = route("weave", "tweak the plan", activeMain)
    expect(d.kind).toBe("weave")
    if (d.kind !== "weave") throw new Error("expected weave")
    expect(d.injection.content).toBe("tweak the plan")
    expect(d.injection.role).toBe("user")
    expect(d.injection.injectedDuringTurnId).toBe("turn-1")
    expect(d.injection.injectedAt).toBe(NOW)
  })

  test("no active turn ⇒ queue_fallback(no_active_turn) — message NOT lost", () => {
    const d = route("weave", "msg", noTurn)
    expect(d.kind).toBe("queue_fallback")
    if (d.kind !== "queue_fallback") throw new Error("expected fallback")
    expect(d.from).toBe("weave")
    expect(d.reason).toBe("no_active_turn")
    expect(d.text).toBe("msg")
  })

  test("non-steerable (review) turn ⇒ queue_fallback (not woven into a review turn)", () => {
    const d = route("weave", "msg", reviewTurn)
    expect(d.kind).toBe("queue_fallback")
    expect(d.kind === "queue_fallback" && d.from).toBe("weave")
  })

  test("interrupted turn ⇒ queue_fallback(interrupted)", () => {
    const d = route("weave", "msg", interrupted)
    expect(d.kind).toBe("queue_fallback")
    expect(d.kind === "queue_fallback" && d.reason).toBe("interrupted")
  })

  test("explicit expectedTurnId mismatch ⇒ queue_fallback(expected_turn_mismatch)", () => {
    const d = route("weave", "msg", activeMain, "STALE-turn-id")
    expect(d.kind).toBe("queue_fallback")
    expect(d.kind === "queue_fallback" && d.reason).toBe("expected_turn_mismatch")
  })

  test("matching explicit expectedTurnId ⇒ weave accepted", () => {
    const d = route("weave", "msg", activeMain, "turn-1")
    expect(d.kind).toBe("weave")
  })
})

describe("inbound router — interrupt mode", () => {
  test("active turn ⇒ interrupt carrying the replacement text", () => {
    const d = route("interrupt", "STOP do this instead", activeMain)
    expect(d.kind).toBe("interrupt")
    expect(d.kind === "interrupt" && d.text).toBe("STOP do this instead")
  })

  test("no active turn ⇒ queue_fallback (nothing to interrupt, message kept)", () => {
    const d = route("interrupt", "msg", noTurn)
    expect(d.kind).toBe("queue_fallback")
    if (d.kind !== "queue_fallback") throw new Error("expected fallback")
    expect(d.from).toBe("interrupt")
    expect(d.text).toBe("msg")
  })

  test("already-interrupted turn ⇒ queue_fallback (no double interrupt)", () => {
    const d = route("interrupt", "msg", interrupted)
    expect(d.kind).toBe("queue_fallback")
    expect(d.kind === "queue_fallback" && d.from).toBe("interrupt")
  })
})
