/**
 * Closeout-critic gate (P12 — jun-7 gap-other-agent).
 *
 * Two layers under test:
 *   1. the pure helper `runCloseoutCritic` — OFF short-circuit, port-absent
 *      fail-open, verdict rendering, throwing-critic fail-open.
 *   2. the loop seam in `applyAction` (recovery-executor) — knob OFF ⇒ no
 *      critic invocation + turn completes byte-identical; port-absent + ON ⇒
 *      fail-open completion; a "denied" verdict ⇒ surfaced on the EXISTING
 *      `recovery`/`closeout` event WITHOUT blocking the completion.
 */
import { describe, expect, test } from "bun:test"
import {
  type CloseoutCritic,
  type CloseoutCriticConfig,
  runCloseoutCritic,
} from "@/agent/closeout-critic"
import { applyAction } from "@/agent/loop/recovery-executor"
import type { AssembledMessage, RecoveryAction } from "@/agent/recovery"
import type { ToolHistoryEntry } from "@/agent/session-resources"
import { createToolChoiceTurnState } from "@/agent/tool-choice"
import type { TurnSession, TurnState } from "@/agent/turn-context"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { createWorkingMemory } from "@/memory"

const textMessage = (text: string): AssembledMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const completedAction: RecoveryAction = { do: "completed" }

/** Capture stream events the loop emits. */
const captureStream = (): { events: StreamEvent[]; emit: (e: StreamEvent) => void } => {
  const events: StreamEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const recoveryEvents = (events: StreamEvent[]): Extract<StreamEvent, { type: "recovery" }>[] =>
  events.filter((e): e is Extract<StreamEvent, { type: "recovery" }> => e.type === "recovery")

/** Minimal session/state pair that drives `applyAction`'s completed path. Only
 *  the fields `applyAction` + `maybeRunCloseoutCritic` read are populated. */
const driveCompleted = async (
  closeoutCritic: CloseoutCriticConfig | undefined,
  opts: { history?: ToolHistoryEntry[]; message?: AssembledMessage } = {},
): Promise<{ events: StreamEvent[]; result: Awaited<ReturnType<typeof applyAction>> }> => {
  const stream = captureStream()
  const message = opts.message ?? textMessage("final answer")
  const config = {
    stream: { emit: stream.emit },
    signal: new AbortController().signal,
    ...(closeoutCritic !== undefined ? { closeoutCritic } : {}),
  } as unknown as AgentConfig
  const wm = createWorkingMemory()
  const session = { config, guards: [] } as unknown as TurnSession
  const state = {
    wm,
    toolChoiceState: createToolChoiceTurnState(),
  } as unknown as TurnState
  const result = await applyAction(
    session,
    state,
    completedAction,
    { message, stopReason: "end_turn", resultBlocks: message.content },
    { blocks: [] } as never,
    opts.history ?? [],
  )
  return { events: stream.events, result }
}

describe("runCloseoutCritic — pure helper", () => {
  test("cfg undefined ⇒ undefined (OFF, no await)", async () => {
    expect(await runCloseoutCritic(undefined, { finalText: "x" })).toBeUndefined()
  })

  test("enabled !== true ⇒ undefined even with a critic present", async () => {
    let called = false
    const critic: CloseoutCritic = async () => {
      called = true
      return { outcome: "approved", rationale: "ok" }
    }
    const out = await runCloseoutCritic({ enabled: false, critic }, { finalText: "x" })
    expect(out).toBeUndefined()
    expect(called).toBe(false)
  })

  test("port absent + enabled ⇒ undefined (fail-open skip)", async () => {
    expect(await runCloseoutCritic({ enabled: true }, { finalText: "x" })).toBeUndefined()
  })

  test("approved verdict ⇒ critic: detail", async () => {
    const critic: CloseoutCritic = async () => ({ outcome: "approved", rationale: "looks good" })
    const out = await runCloseoutCritic({ enabled: true, critic }, { finalText: "x" })
    expect(out?.detail).toBe("critic:approved: looks good")
  })

  test("denied verdict with risk ⇒ rendered detail", async () => {
    const critic: CloseoutCritic = async () => ({
      outcome: "denied",
      rationale: "missing tests",
      riskLevel: "high",
    })
    const out = await runCloseoutCritic({ enabled: true, critic }, { finalText: "x" })
    expect(out?.detail).toBe("critic:denied risk=high: missing tests")
  })

  test("throwing critic ⇒ fail-open observation, never rethrows", async () => {
    const critic: CloseoutCritic = async () => {
      throw new Error("reviewer exploded")
    }
    const out = await runCloseoutCritic({ enabled: true, critic }, { finalText: "x" })
    expect(out?.detail).toBe("critic:unavailable: reviewer exploded")
  })

  test("non-Error throw ⇒ stringified, still fail-open", async () => {
    const critic: CloseoutCritic = async () => {
      throw "boom"
    }
    const out = await runCloseoutCritic({ enabled: true, critic }, { finalText: "x" })
    expect(out?.detail).toBe("critic:unavailable: boom")
  })

  test("request carries finalText + name-only history + signal", async () => {
    let seen: Parameters<CloseoutCritic>[0] | undefined
    const critic: CloseoutCritic = async (req) => {
      seen = req
      return { outcome: "approved", rationale: "r" }
    }
    const signal = new AbortController().signal
    await runCloseoutCritic(
      { enabled: true, critic },
      { finalText: "draft", history: [{ name: "read" }], signal },
    )
    expect(seen?.finalText).toBe("draft")
    expect(seen?.history).toEqual([{ name: "read" }])
    expect(seen?.signal).toBe(signal)
  })
})

describe("applyAction — closeout-critic loop seam", () => {
  test("knob OFF (no closeoutCritic) ⇒ no critic call, turn completes, no recovery event", async () => {
    const { events, result } = await driveCompleted(undefined)
    expect(result).toEqual({
      done: true,
      result: { kind: "completed", message: textMessage("final answer") },
    })
    expect(recoveryEvents(events)).toEqual([])
  })

  test("enabled:false ⇒ critic never invoked, byte-identical completion", async () => {
    let called = false
    const critic: CloseoutCritic = async () => {
      called = true
      return { outcome: "approved", rationale: "x" }
    }
    const { events, result } = await driveCompleted({ enabled: false, critic })
    expect(called).toBe(false)
    expect(result.done).toBe(true)
    expect(recoveryEvents(events)).toEqual([])
  })

  test("port absent + knob ON ⇒ fail-open, completes, no recovery event, no throw", async () => {
    const { events, result } = await driveCompleted({ enabled: true })
    expect(result).toEqual({
      done: true,
      result: { kind: "completed", message: textMessage("final answer") },
    })
    expect(recoveryEvents(events)).toEqual([])
  })

  test("approved verdict surfaces a closeout recovery event, still completes", async () => {
    const critic: CloseoutCritic = async () => ({ outcome: "approved", rationale: "ship it" })
    const { events, result } = await driveCompleted({ enabled: true, critic })
    expect(result.result.kind).toBe("completed")
    const recs = recoveryEvents(events)
    expect(recs).toHaveLength(1)
    expect(recs[0]?.reason).toBe("closeout")
    expect(recs[0]?.detail).toBe("critic:approved: ship it")
  })

  test("DENIED verdict is advisory — surfaces as data, does NOT block completion", async () => {
    const critic: CloseoutCritic = async () => ({
      outcome: "denied",
      rationale: "claims unverified",
      riskLevel: "high",
    })
    const { events, result } = await driveCompleted({ enabled: true, critic })
    // CRUX: a denial NEVER blocks — the turn still seals completed.
    expect(result.result.kind).toBe("completed")
    const recs = recoveryEvents(events)
    expect(recs[0]?.reason).toBe("closeout")
    expect(recs[0]?.detail).toBe("critic:denied risk=high: claims unverified")
  })

  test("throwing critic ⇒ completion still sealed, error surfaced as data, loop never crashes", async () => {
    const critic: CloseoutCritic = async () => {
      throw new Error("kaboom")
    }
    const { events, result } = await driveCompleted({ enabled: true, critic })
    expect(result.result.kind).toBe("completed")
    expect(recoveryEvents(events)[0]?.detail).toBe("critic:unavailable: kaboom")
  })

  test("critic receives the draft visible text + name-only tool history", async () => {
    let seen: Parameters<CloseoutCritic>[0] | undefined
    const critic: CloseoutCritic = async (req) => {
      seen = req
      return { outcome: "approved", rationale: "r" }
    }
    await driveCompleted(
      { enabled: true, critic },
      {
        message: textMessage("my draft"),
        history: [
          { name: "read", arg: "secret.ts", ok: true },
          { name: "bash", output: "..." },
        ],
      },
    )
    expect(seen?.finalText).toBe("my draft")
    // Structural name-only projection — no arg/ok/output leakage.
    expect(seen?.history).toEqual([{ name: "read" }, { name: "bash" }])
  })
})
