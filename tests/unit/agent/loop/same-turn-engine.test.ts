/**
 * ALBB-20 #14 — post-prepareTurnContext abort re-check.
 *
 * Red-on-injection: abort was checked at the TOP of the loop (before
 * `prepareTurnContext`) but NOT re-checked after prep completes. Since prep
 * awaits provider work (ideContext snapshot, effort classifier, compaction),
 * an abort that lands DURING prep would only surface AFTER a full stream turn
 * ran. This drives `runTurn` with an `ideContextProvider.snapshot` that aborts
 * the signal mid-prep and asserts `llm.stream` is NEVER entered and the turn
 * resolves `aborted`. Delete the re-check ⇒ `llm.stream` is called ⇒ red.
 */

import { describe, expect, test } from "bun:test"
import { runTurn } from "@/agent/loop/same-turn-engine"
import { freshRecovery } from "@/agent/recovery"
import type { TurnSession, TurnState } from "@/agent/turn-context"
import type { AgentConfig } from "@/agent/types"
import type { Message } from "@/llm"
import { createWorkingMemory } from "@/memory"
import { ToolRegistry } from "@/tool"

describe("same-turn-engine #14 post-prep abort recheck", () => {
  test("an abort DURING prepareTurnContext short-circuits before streamConsume", async () => {
    const ctrl = new AbortController()
    let streamCalled = false
    const registry = new ToolRegistry([])
    const config = {
      llm: {
        stream: async function* () {
          streamCalled = true
        },
      },
      registry,
      stream: { emit: () => {} },
      permission: { mode: "default" },
      messages: [],
      system: "",
      cwd: "/tmp",
      maxTurns: 1,
      signal: ctrl.signal,
      // The abort lands DURING prep: injectIdeContext awaits snapshot(), which
      // fires the abort. prepareTurnContext then returns with signal.aborted.
      ideContextProvider: {
        snapshot: async () => {
          ctrl.abort()
          return {}
        },
      },
    } as unknown as AgentConfig

    const session: TurnSession = {
      config,
      specs: registry.specs(),
      guards: [],
    }
    const state: TurnState = {
      wm: createWorkingMemory<Message>([
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ]),
      rec: freshRecovery(),
      breaker: undefined,
      toolHistory: undefined,
      workingState: undefined,
      collector: undefined,
      toolChoiceState: {} as TurnState["toolChoiceState"],
      citations: [],
      onRedaction: () => {},
      onTurnTiming: undefined,
    }

    const result = await runTurn(1, session, state)

    expect(result.kind).toBe("aborted")
    expect(streamCalled).toBe(false)
  })
})
