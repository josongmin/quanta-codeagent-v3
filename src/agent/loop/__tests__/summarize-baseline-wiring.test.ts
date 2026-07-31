/**
 * FIX 4 wiring (jul-2) — proves the token-baseline box is threaded END-TO-END
 * through the real `syncQueuedTurnInputs` seam to `compactNowOnDemand`, not merely
 * type-compatible. `compact-now-baseline-invalidation.test.ts` pins the
 * invalidation on a DIRECT `compactNowOnDemand(cfg, wm, box)` call; this pins that
 * the `/summarize-now` conversation-action actually DELIVERS that box (the
 * wired-but-inert trap: a param that exists but is never passed at the call site).
 *
 * RED before the wire: `syncQueuedTurnInputs` called `compactNowOnDemand(cfg, wm)`
 * (no third arg) so the box was never invalidated → `box.current` stayed set.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { TokenBaselineBoxState } from "../../compaction"
import type { AgentConfig } from "../../types"
import { syncQueuedTurnInputs } from "../turn-iteration"

const summarizerLlm: LLMPort = {
  model: "summarizer",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: "condensed history" }
    }
    return gen()
  },
}

const seedMessages = (): Message[] =>
  Array.from({ length: 6 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `turn ${i} ${"x".repeat(200)}` }],
  }))

/** A config whose conversation-action port serves a single `summarize` verb. */
const makeConfig = (): AgentConfig =>
  ({
    system: "sys",
    llm: summarizerLlm,
    stream: { emit() {} },
    compaction: { summarizerLlm, keepRecentTurns: 1, thresholdTokens: 1 },
    activeTurnRef: {
      current: {
        currentTurn: { turnId: "t1", kind: "main", startedAt: 1, threadId: "x" },
        isInterrupted: false,
      },
    },
    conversationActionPort: (() => {
      let served = false
      return {
        next: () => {
          if (served) return undefined
          served = true
          return { kind: "summarize" as const }
        },
      }
    })(),
  }) as unknown as AgentConfig

describe("syncQueuedTurnInputs — /summarize-now baseline-box wiring (FIX 4)", () => {
  test("delivers the token-baseline box to compactNowOnDemand ⇒ stale baseline cleared", async () => {
    const wm = createWorkingMemory(seedMessages())
    const lenBefore = wm.snapshot().length
    const box: TokenBaselineBoxState = {
      current: { measuredInputTokens: 999_999, measuredAtMessageCount: lenBefore },
      sendCount: lenBefore,
    }

    const outcome = await syncQueuedTurnInputs({
      cfg: makeConfig(),
      wm,
      sessionId: "s",
      taskRegistry: undefined,
      tokenBaseline: box,
    })

    expect(outcome).toBe("continue")
    expect(wm.snapshot().length).toBeLessThan(lenBefore) // the summarize actually shrank
    // Load-bearing: the box reached compactNowOnDemand through the real seam and
    // was invalidated. Fails (stays 999_999) if the third arg is not threaded.
    expect(box.current).toBeUndefined()
  })

  test("no box wired ⇒ summarize still runs, no throw (byte-identical opt-out)", async () => {
    const wm = createWorkingMemory(seedMessages())
    const lenBefore = wm.snapshot().length
    const outcome = await syncQueuedTurnInputs({
      cfg: makeConfig(),
      wm,
      sessionId: "s",
      taskRegistry: undefined,
      tokenBaseline: undefined,
    })
    expect(outcome).toBe("continue")
    expect(wm.snapshot().length).toBeLessThan(lenBefore)
  })
})
