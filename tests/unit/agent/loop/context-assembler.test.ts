/**
 * ALBB-20 #12 — turnContextMutator observability.
 *
 * Red-on-injection: `config.turnContextMutator(turn, turnInput)` USED to be
 * called UNCAUGHT; a throwing mutator crashed context assembly. This asserts
 * `applyTurnContextMutator` mirrors the sibling `injectIdeContext`: on throw it
 * emits a stream `error` and FALLS BACK to the un-mutated input. Delete the
 * wrap ⇒ the throw escapes and this goes red.
 */

import { describe, expect, test } from "bun:test"
import { applyTurnContextMutator, resolveObjectiveThunk } from "@/agent/loop/context-assembler"
import type { TurnContextInput } from "@/agent/prompt"
import type { AgentConfig } from "@/agent/types"
import { createObjectiveStore } from "@/objective"
import type { AgentEvent } from "@/stream"
import { ToolRegistry } from "@/tool"

const baseConfig = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    llm: { stream: async function* () {} },
    registry: new ToolRegistry([]),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const turnInput = (): TurnContextInput =>
  ({
    baseMessages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    cwd: "/tmp",
    planMode: false,
  }) as TurnContextInput

describe("context-assembler #12 turnContextMutator observability", () => {
  test("a throwing mutator emits error + falls back to un-mutated input", () => {
    const emitted: AgentEvent[] = []
    const base = turnInput()
    const cfg = baseConfig({
      stream: { emit: (e) => emitted.push(e) },
      turnContextMutator: () => {
        throw new Error("mutator boom")
      },
    })

    const out = applyTurnContextMutator(cfg, 1, base)

    // Fell back to the ORIGINAL, un-mutated input.
    expect(out).toBe(base)
    const err = emitted.find((e) => e.type === "error")
    expect(err).toBeDefined()
    if (err?.type === "error") {
      expect(err.message).toContain("turn-context mutator failed")
      expect(err.message).toContain("mutator boom")
    }
  })

  test("a well-behaved mutator's output is used; absent mutator is byte-identical", () => {
    const base = turnInput()
    const mutated = { ...base, cwd: "/mutated" } as TurnContextInput
    const withMutator = baseConfig({ turnContextMutator: () => mutated })
    expect(applyTurnContextMutator(withMutator, 1, base)).toBe(mutated)

    const noMutator = baseConfig({})
    expect(applyTurnContextMutator(noMutator, 1, base)).toBe(base)
  })
})

describe("C2b — loop wires the LIVE objective-visibility thunk (gated like objective_*)", () => {
  test("config.objective + sessionId ⇒ a LIVE thunk reading the SAME authority", () => {
    const port = createObjectiveStore()
    port.create("SESS", { goal: "close the visibility gap" })
    const thunk = resolveObjectiveThunk(baseConfig({ objective: port, sessionId: "SESS" }))
    expect(thunk).toBeDefined()
    expect(thunk?.()).toEqual({ goal: "close the visibility gap", status: "active" })
    // LIVE: a pause on the authority is reflected on the NEXT thunk read (not a
    // construction-time snapshot).
    port.setExplicitStatus("SESS", "paused")
    expect(thunk?.()?.status).toBe("paused")
  })

  test("gated: no objective authority ⇒ NO thunk (field omitted ⇒ byte-identical)", () => {
    expect(resolveObjectiveThunk(baseConfig({ sessionId: "SESS" }))).toBeUndefined()
  })

  test("gated: no sessionId ⇒ NO thunk (thread identity must be session-bound)", () => {
    const port = createObjectiveStore()
    port.create("SESS", { goal: "orphaned" })
    expect(resolveObjectiveThunk(baseConfig({ objective: port }))).toBeUndefined()
  })

  test("absence-gated: authority present but no goal for the thread ⇒ thunk returns undefined", () => {
    const port = createObjectiveStore() // no goal set for SESS
    const thunk = resolveObjectiveThunk(baseConfig({ objective: port, sessionId: "SESS" }))
    expect(thunk).toBeDefined()
    expect(thunk?.()).toBeUndefined()
  })
})
