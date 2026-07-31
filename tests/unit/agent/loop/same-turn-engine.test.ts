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
import type { BgSummaryPayload } from "@/agent/compaction"
import { BackgroundSummarizationController } from "@/agent/compaction/background"
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
      wm: createWorkingMemory<Message>([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
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

  test("a stream abort cancels an armed background summarizer before it can do late work", async () => {
    const ctrl = new AbortController()
    let releaseSummarizer: (() => void) | undefined
    let lateSummarizerWork = 0
    const bgCompaction = new BackgroundSummarizationController<BgSummaryPayload>(
      async ({ cancel }) => {
        await new Promise<void>((resolve) => {
          releaseSummarizer = resolve
        })
        // This models the expensive provider action after the async boundary.
        // A stream-aborted turn must flip this token first, so no late work runs.
        if (!cancel.aborted) lateSummarizerWork += 1
        return {
          ok: true,
          value: { summary: [], resultingTokens: 0, summarizedPrefixLen: 0 },
        }
      },
      () => 0,
      {
        startAtUnusedTokens: 1,
        startAtUnusedPercent: 0,
        persistUnusedTokens: 0,
        persistUnusedPercent: 0,
      },
    )
    // Arm the real controller before the stream begins. This is deliberately
    // independent of proactive compaction: the regression is the early stream
    // exit that bypassed the normal turn-boundary reconciliation path.
    expect(bgCompaction.maybeStart({ usedTokens: 100, limitTokens: 100 })).toBe(true)

    const registry = new ToolRegistry([])
    const config = {
      llm: {
        stream: async function* () {
          ctrl.abort()
          throw new Error("provider observed abort")
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
    } as unknown as AgentConfig
    const session: TurnSession = {
      config,
      specs: registry.specs(),
      guards: [],
      bgCompaction,
    }
    const state: TurnState = {
      wm: createWorkingMemory<Message>([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
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
    expect(bgCompaction.hasPendingPass()).toBe(true)

    releaseSummarizer?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(lateSummarizerWork).toBe(0)
  })
})
