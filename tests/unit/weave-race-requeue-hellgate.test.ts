import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { pollConversationAction } from "@/agent/loop/control-poll"
import type { ActiveTurnState } from "@/agent/steering"

// §11.5 (ticket-08a) — a weave (`user_message`) that misses its target turn (the
// turn ended between keypress and poll ⇒ `expected_turn_mismatch`) was SILENTLY
// DROPPED. It must instead re-route via injection so a non-empty steering
// message is never lost. `empty_input` / `interrupted` stay drop+error.

const activeMain: ActiveTurnState = {
  currentTurn: { turnId: "LIVE", kind: "main", startedAt: 1, threadId: "x" },
  isInterrupted: false,
}

const cfgWith = (
  action: Record<string, unknown> | undefined,
  turn: ActiveTurnState = activeMain,
): { cfg: AgentConfig; errors: string[] } => {
  const errors: string[] = []
  let served = false
  const cfg = {
    stream: {
      emit: (e: { type: string; message?: string }) => {
        if (e.type === "error" && e.message) errors.push(e.message)
      },
    },
    activeTurnRef: { current: turn },
    conversationActionPort: {
      next: () => {
        if (served) return undefined
        served = true
        return action
      },
    },
  } as unknown as AgentConfig
  return { cfg, errors }
}

describe("weave-race re-queue (08a)", () => {
  test("user_message with a STALE expectedTurnId ⇒ re-injected, NOT dropped", async () => {
    const { cfg, errors } = cfgWith({
      kind: "user_message",
      input: "also check the logs",
      expectedTurnId: "ENDED_TURN", // != "LIVE" ⇒ expected_turn_mismatch
    })
    const outcome = await pollConversationAction(cfg, undefined)
    expect(outcome.kind).toBe("injection")
    if (outcome.kind !== "injection") throw new Error("expected injection")
    const text = outcome.message.content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(text).toBe("also check the logs")
    expect(errors).toHaveLength(0) // re-routed, not an error-drop
  })

  test("user_message with NO active turn ⇒ re-injected (lands next turn)", async () => {
    const { cfg } = cfgWith(
      { kind: "user_message", input: "queued steer", expectedTurnId: "X" },
      { currentTurn: null, isInterrupted: false },
    )
    const outcome = await pollConversationAction(cfg, undefined)
    expect(outcome.kind).toBe("injection")
  })

  test("EMPTY user_message ⇒ still drop+error (nothing to preserve)", async () => {
    const { cfg, errors } = cfgWith({
      kind: "user_message",
      input: "   ",
      expectedTurnId: "ENDED_TURN",
    })
    const outcome = await pollConversationAction(cfg, undefined)
    expect(outcome.kind).toBe("continue")
    expect(errors.length).toBeGreaterThan(0)
  })

  test("interrupted turn ⇒ user_message NOT re-injected (deliberate unwind)", async () => {
    const { cfg, errors } = cfgWith(
      { kind: "user_message", input: "stop steering me", expectedTurnId: "LIVE" },
      { currentTurn: activeMain.currentTurn, isInterrupted: true },
    )
    const outcome = await pollConversationAction(cfg, undefined)
    expect(outcome.kind).toBe("continue")
    expect(errors.length).toBeGreaterThan(0)
  })
})
