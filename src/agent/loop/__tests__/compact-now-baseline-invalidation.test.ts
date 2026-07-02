/**
 * FIX 4 (jul-2) — `/summarize-now` (compactNowOnDemand) MUST invalidate the
 * per-session token-baseline box.
 *
 * `compactNowOnDemand` shrinks the transcript prefix via `wm.replace(...)`. Every
 * OTHER replace site clears the D5 token baseline (the proactive path in
 * compaction-wire, the reactive path in recovery-executor) because a baseline
 * measured against the OLD prefix is stale: its `measuredAtMessageCount` index no
 * longer maps onto the new transcript. Before this fix `compactNowOnDemand` did
 * NOT invalidate — so once the transcript regrew past the stale index the
 * `triggerTokenCount` out-of-range fail-safe stopped firing and a later turn
 * compacted prematurely (the D5 bug shrink-invalidation was built to prevent).
 *
 *   §1  after a shrinking on-demand compaction, the box's `current` is cleared.
 *   §2  RED-on-injection: a STALE (large) baseline that would over-trigger before
 *       the fix reads back as the plain chars/4 estimate after invalidation.
 *   §3  no box wired ⇒ still compacts, no throw (byte-identical opt-out).
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import {
  type TokenBaselineBoxState,
  triggerTokenCount,
} from "../../compaction"
import { compactNowOnDemand } from "../compaction-wire"
import type { AgentConfig } from "../../types"

/** A summarizer LLM whose single text_delta becomes the summary — enough for
 *  `compactIfNeeded(force:true)` to fold the prefix and SHRINK the transcript. */
const summarizerLlm: LLMPort = {
  model: "summarizer",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: "condensed history" }
    }
    return gen()
  },
}

/** Minimal AgentConfig for the on-demand summarize path. `keepRecentTurns:1`
 *  forces a boundary so a multi-message transcript actually folds. */
const makeConfig = (): AgentConfig =>
  ({
    system: "sys",
    llm: summarizerLlm,
    stream: { emit() {} },
    compaction: { summarizerLlm, keepRecentTurns: 1, thresholdTokens: 1 },
  }) as unknown as AgentConfig

/** A transcript long enough that folding all-but-1 turn strictly shrinks it. */
const seedMessages = (): Message[] =>
  Array.from({ length: 6 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `turn ${i} ${"x".repeat(200)}` }],
  }))

describe("compactNowOnDemand — token-baseline invalidation (FIX 4)", () => {
  test("§1 a shrinking on-demand summarize CLEARS the baseline box", async () => {
    const wm = createWorkingMemory(seedMessages())
    const lenBefore = wm.snapshot().length
    // An ACTIVE baseline measured against the OLD (fat) prefix.
    const box: TokenBaselineBoxState = {
      current: { measuredInputTokens: 999_999, measuredAtMessageCount: lenBefore },
      sendCount: lenBefore,
    }

    const compacted = await compactNowOnDemand(makeConfig(), wm, box)

    expect(compacted).toBe(true)
    expect(wm.snapshot().length).toBeLessThan(lenBefore) // genuinely shrank
    // The load-bearing assertion: the stale baseline was invalidated.
    expect(box.current).toBeUndefined()
  })

  test("§2 stale baseline no longer over-triggers once invalidated (RED-on-injection)", async () => {
    const wm = createWorkingMemory(seedMessages())
    const lenBefore = wm.snapshot().length
    const box: TokenBaselineBoxState = {
      current: { measuredInputTokens: 999_999, measuredAtMessageCount: lenBefore },
      sendCount: lenBefore,
    }

    await compactNowOnDemand(makeConfig(), wm, box)

    // With the stale baseline cleared, the trigger count for the (now small)
    // transcript is the plain chars/4 estimate — NOT the 999_999 that would have
    // forced a premature compaction on the tiny post-summarize transcript.
    const snap = [...wm.snapshot()]
    const trigger = triggerTokenCount(snap, box.current)
    expect(trigger).toBeLessThan(999_999)
  })

  test("§3 no box wired ⇒ compacts, no throw (byte-identical opt-out)", async () => {
    const wm = createWorkingMemory(seedMessages())
    const lenBefore = wm.snapshot().length
    const compacted = await compactNowOnDemand(makeConfig(), wm)
    expect(compacted).toBe(true)
    expect(wm.snapshot().length).toBeLessThan(lenBefore)
  })

  test("control: a NON-shrinking compaction (no boundary) leaves the box untouched", async () => {
    // A single indivisible turn ⇒ `compactIfNeeded` finds no boundary ⇒ no-op,
    // no replace ⇒ the baseline must NOT be cleared (invalidation is shrink-gated).
    const wm = createWorkingMemory<Message>([
      { role: "user", content: [{ type: "text", text: `only ${"x".repeat(500)}` }] },
    ])
    const box: TokenBaselineBoxState = {
      current: { measuredInputTokens: 123, measuredAtMessageCount: 1 },
      sendCount: 1,
    }
    const compacted = await compactNowOnDemand(makeConfig(), wm, box)
    expect(compacted).toBe(false)
    expect(box.current).toBeDefined() // untouched — nothing shrank
  })
})
