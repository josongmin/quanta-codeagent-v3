/**
 * ADR-0539 residual — the localize-phase gate must emit a `decision` OBSERVE
 * event at its DENY point, so a run's trajectory stream records the CAUSE of a
 * blocked mutating tool (previously only the synthetic tool_result EFFECT was
 * visible, with no recorded reason).
 *
 * RED-ON-INJECTION: these tests fail if the `config.stream.emit(event)` line in
 * `consultLocalizePhase` (src/agent/dispatch/preflight-consults.ts) is removed —
 * the active-guard cases lose their `decision` line. The guard-OFF case pins
 * byte-identical silence (no event, so an accidental unconditional emit is also
 * caught).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent/types"
import type { ToolUseBlock } from "@/llm"
import type { AgentEvent } from "@/stream"
import { consultLocalizePhase } from "../../src/agent/dispatch/preflight-consults"

/** A capturing StreamPort — records every AgentEvent the consult emits. */
const captureStream = (): { events: AgentEvent[]; emit: (e: AgentEvent) => void } => {
  const events: AgentEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

/** Minimal AgentConfig carrying only the fields `consultLocalizePhase` reads:
 *  `run`, `localizePhase`, `localizePhaseState`, `stream`. Everything else is
 *  never touched on this code path. */
const makeConfig = (opts: {
  stream: { emit: (e: AgentEvent) => void }
  phase1Turns?: number
  turn: number
  runTurn?: number
}): AgentConfig =>
  ({
    stream: { emit: opts.stream.emit },
    run: opts.runTurn === undefined ? undefined : { runId: "r1", turn: opts.runTurn },
    ...(opts.phase1Turns === undefined ? {} : { localizePhase: { phase1Turns: opts.phase1Turns } }),
    localizePhaseState: { turn: opts.turn },
  }) as unknown as AgentConfig

const editCall = (id: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "edit",
  input: { path: "models.py", diff: "..." },
})

const decisions = (events: AgentEvent[]): Extract<AgentEvent, { type: "decision" }>[] =>
  events.filter((e): e is Extract<AgentEvent, { type: "decision" }> => e.type === "decision")

describe("localize-phase gate — decision OBSERVE emit (ADR-0539 residual)", () => {
  test("ACTIVE guard + denied mutating tool ⇒ exactly one decision{kind:rule,outcome:deny,ruleId} on stream", () => {
    const stream = captureStream()
    // Guard ACTIVE (phase1Turns=3) and we are IN phase (turn 0 < 3), so `edit` is denied.
    const config = makeConfig({ stream, phase1Turns: 3, turn: 0, runTurn: 5 })

    const result = consultLocalizePhase(editCall("call-1"), config)

    // Behavior unchanged: still a deny DispatchResult (the ADD is observability-only).
    expect(result).not.toBeNull()

    const ds = decisions(stream.events)
    expect(ds).toHaveLength(1)
    const d = ds[0]
    expect(d?.kind).toBe("rule")
    expect(d?.outcome).toBe("deny")
    // ruleId is the phase-gate rule identity — the SAME code the deny reason stamps.
    expect(d?.ruleId).toBe("localize-phase-blocked")
    // toolCallId pairs the cause line to the effect's tool_result.
    expect(d?.toolCallId).toBe("call-1")
    // turn tracks the run context turn.
    expect(d?.turn).toBe(5)
    // metadata carries only the (public) tool name — no input body.
    expect(d?.metadata).toEqual({ tool: "edit" })
  })

  test("guard OFF (no phase1Turns) ⇒ NO decision event (byte-identical silence)", () => {
    const stream = captureStream()
    // No localizePhase config at all ⇒ decision returns {block:false} ⇒ early return.
    const config = makeConfig({ stream, turn: 0, runTurn: 5 })

    const result = consultLocalizePhase(editCall("call-1"), config)

    expect(result).toBeNull()
    expect(stream.events).toHaveLength(0)
  })

  test("guard ACTIVE but tool is NON-mutating (read) ⇒ NO decision event (pass-through)", () => {
    const stream = captureStream()
    const config = makeConfig({ stream, phase1Turns: 3, turn: 0, runTurn: 5 })

    const readCall: ToolUseBlock = { type: "tool_use", id: "c", name: "read", input: { path: "x" } }
    const result = consultLocalizePhase(readCall, config)

    expect(result).toBeNull()
    expect(decisions(stream.events)).toHaveLength(0)
  })

  test("guard ACTIVE but PHASE 2 (turn >= phase1Turns) ⇒ NO decision event (pass-through)", () => {
    const stream = captureStream()
    // turn 3 >= phase1Turns 3 ⇒ Phase 2, edit passes through.
    const config = makeConfig({ stream, phase1Turns: 3, turn: 3, runTurn: 5 })

    const result = consultLocalizePhase(editCall("call-1"), config)

    expect(result).toBeNull()
    expect(decisions(stream.events)).toHaveLength(0)
  })

  test("PER-DENY: two blocked mutating calls in the same turn ⇒ two decision events (no dedupe)", () => {
    const stream = captureStream()
    const config = makeConfig({ stream, phase1Turns: 3, turn: 0, runTurn: 5 })

    consultLocalizePhase(editCall("call-1"), config)
    consultLocalizePhase(editCall("call-2"), config)

    const ds = decisions(stream.events)
    expect(ds).toHaveLength(2)
    expect(ds.map((d) => d.toolCallId)).toEqual(["call-1", "call-2"])
  })

  test("missing run context ⇒ decision still emitted with turn fallback 0", () => {
    const stream = captureStream()
    const config = makeConfig({ stream, phase1Turns: 3, turn: 0 })

    consultLocalizePhase(editCall("call-1"), config)

    const ds = decisions(stream.events)
    expect(ds).toHaveLength(1)
    expect(ds[0]?.turn).toBe(0)
  })
})
