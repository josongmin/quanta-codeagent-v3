/**
 * Phase-1 loop decomposition — turn-gate pure surface (ADR-0437).
 *
 * Pins interrupt vs lifetime-abort classification and per-turn session view
 * construction. Default-OFF: no gate ⇒ byte-identical legacy paths.
 */

import { describe, expect, test } from "bun:test"
import { buildTurnSessionView, classifyTurnAbort } from "@/agent/loop/turn-gate"
import type { TurnSession } from "@/agent/turn-context"
import type { AgentConfig } from "@/agent/types"
import type { StreamPort } from "@/stream"
import { SubagentTurnGate } from "@/subagent"
import { ToolRegistry } from "@/tool"

const stubStream = (): StreamPort => ({ emit: () => {} })

const minimalSession = (overrides?: {
  signal?: AbortSignal
  gate?: SubagentTurnGate
}): TurnSession => {
  const ac = new AbortController()
  const signal = overrides?.signal ?? ac.signal
  const config: AgentConfig = {
    llm: { stream: async function* () {} },
    registry: new ToolRegistry([]),
    stream: stubStream(),
    maxTurns: 1,
    signal,
    ...(overrides?.gate !== undefined ? { subagentTurnGate: overrides.gate } : {}),
  }
  return {
    config,
    specs: config.registry.specs(),
    guards: [],
  }
}

describe("classifyTurnAbort", () => {
  test("no gate ⇒ always aborted (legacy byte-identical)", () => {
    const loop = new AbortController()
    expect(classifyTurnAbort(undefined, loop.signal)).toEqual({ kind: "aborted" })
    loop.abort()
    expect(classifyTurnAbort(undefined, loop.signal)).toEqual({ kind: "aborted" })
  })

  test("gate interrupted + lifetime NOT aborted ⇒ interrupted (park path)", () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    gate.armTurn(loop.signal)
    gate.wake("interrupt")
    expect(gate.wasInterrupted()).toBe(true)
    expect(classifyTurnAbort(gate, loop.signal)).toEqual({ kind: "interrupted" })
  })

  test("gate interrupted + lifetime aborted ⇒ aborted (finish path)", () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    gate.armTurn(loop.signal)
    gate.wake("interrupt")
    loop.abort()
    expect(classifyTurnAbort(gate, loop.signal)).toEqual({ kind: "aborted" })
  })

  test("gate NOT interrupted ⇒ aborted even when lifetime is clean", () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    gate.armTurn(loop.signal)
    expect(gate.wasInterrupted()).toBe(false)
    expect(classifyTurnAbort(gate, loop.signal)).toEqual({ kind: "aborted" })
  })
})

describe("buildTurnSessionView", () => {
  test("no gate ⇒ same session by identity (default-OFF)", () => {
    const session = minimalSession()
    const view = buildTurnSessionView(session)
    expect(view.gate).toBeUndefined()
    expect(view.turnSession).toBe(session)
  })

  test("gate wired ⇒ clones session with per-turn effective signal", () => {
    const gate = new SubagentTurnGate()
    const loop = new AbortController()
    const session = minimalSession({ gate, signal: loop.signal })
    const view = buildTurnSessionView(session)
    expect(view.gate).toBe(gate)
    expect(view.turnSession).not.toBe(session)
    expect(view.turnSession.config.signal).not.toBe(loop.signal)
    // armTurn composes loop + per-turn controller — still live until interrupted
    expect(view.turnSession.config.signal.aborted).toBe(false)
  })
})
