/**
 * FIX M9 (jul-2) — a proactive compaction that keeps THROWING must inform the
 * thrash breaker.
 *
 * `maybeCompact`'s proactive `try { compactIfNeeded } catch` used to emit a raw
 * `error` event and `return {abort:false}` WITHOUT touching the breaker. So a
 * summarizer that keeps throwing (a transient LLM error while over threshold)
 * never accrued a no-progress strike ⇒ the futility breaker (`CompactionBreaker`)
 * never tripped in EXACTLY the failure mode it exists for. The reactive sibling
 * (recovery-executor) is fail-CLOSED by contrast.
 *
 * Fix: in the catch, `breaker?.recordProactive(before, before)` (a no-progress
 * record — identical to the existing `no_boundary` branch) and emit a
 * `"proactive-failed"` recovery detail. We KEEP `return {abort:false}` (proactive
 * runs pre-sampling; the reactive PTL path is the correct fail-closed backstop —
 * there is no hardWindow concept here).
 *
 *   §1  a summarizer that throws N times (N = the proactive no-progress cap)
 *       ⇒ `breaker.check().abort === true` (RED before the fix: never trips) AND
 *       a `recovery` event with the `proactive-failed` detail is emitted.
 *   §2  a SINGLE throw accrues exactly one strike (not yet at the cap ⇒ no abort),
 *       proving the record is per-failure (RED-on-injection: revert the record
 *       ⇒ strikes stay 0).
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import { CompactionBreaker, DEFAULT_COMPACTION_BREAKER_CAPS } from "../../compaction-breaker"
import type { AgentConfig } from "../../types"
import { maybeCompact } from "../compaction-wire"

/** A summarizer LLM that ALWAYS throws mid-stream — models a transient provider
 *  error while over threshold (the mode the breaker exists to escape). */
const throwingLlm: LLMPort = {
  model: "throwing-summarizer",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      // Throw before yielding anything — `summarizeWith` propagates it and
      // `compactIfNeeded` rethrows into `maybeCompact`'s catch.
      throw new Error("transient-summarizer-boom")
      // biome-ignore lint/correctness/noUnreachable: generator shape only.
      yield { type: "text_delta", delta: "" }
    }
    return gen()
  },
}

type Emitted = { type: string; reason?: string; detail?: string; message?: string }

const makeConfig = (events: Emitted[]): AgentConfig =>
  ({
    system: "sys",
    llm: throwingLlm,
    stream: { emit: (e: Emitted) => events.push(e) },
    // thresholdTokens:1 ⇒ always over threshold; keepRecentTurns:1 ⇒ a boundary
    // exists in a multi-turn transcript ⇒ the summarize path is actually reached
    // (not short-circuited by no_boundary).
    compaction: { summarizerLlm: throwingLlm, keepRecentTurns: 1, thresholdTokens: 1 },
  }) as unknown as AgentConfig

/** A transcript with a real summarizable boundary so `compactIfNeeded` reaches
 *  `summarizeWith` (which then throws) rather than returning `no_boundary`. */
const seedMessages = (): Message[] =>
  Array.from({ length: 6 }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `turn ${i} ${"x".repeat(200)}` }],
  }))

const noopReset = (): void => {}

describe("maybeCompact — proactive throw feeds the thrash breaker (FIX M9)", () => {
  test("§1 N consecutive throws ⇒ breaker trips + proactive-failed recovery", async () => {
    const cap = DEFAULT_COMPACTION_BREAKER_CAPS.maxNoProgressProactive
    const breaker = new CompactionBreaker()
    const events: Emitted[] = []
    const config = makeConfig(events)

    for (let i = 0; i < cap; i++) {
      const wm = createWorkingMemory(seedMessages())
      // Each call: breaker.check() at the top is still below the cap (i < cap),
      // the summarize throws, the catch records a no-progress strike.
      const verdict = await maybeCompact({
        config,
        system: "sys",
        wm,
        breaker,
        archive: undefined,
        turn: i,
        bgController: undefined,
        resetClassifier: noopReset,
        tokenBaselineBox: undefined,
      })
      // Proactive path never fail-closes: each call returns {abort:false}.
      expect(verdict.abort).toBe(false)
    }

    // After `cap` no-progress strikes the breaker is now tripped.
    expect(breaker.strikes.proactive).toBe(cap)
    expect(breaker.check().abort).toBe(true)

    // The failure was surfaced as a recovery event with the dedicated detail.
    const recoveries = events.filter((e) => e.type === "recovery")
    expect(recoveries.some((e) => e.detail === "proactive-failed")).toBe(true)
    // And the raw error event is still emitted (observability preserved).
    expect(events.some((e) => e.type === "error")).toBe(true)
  })

  test("§2 a SINGLE throw accrues exactly one strike, no abort yet", async () => {
    const breaker = new CompactionBreaker()
    const events: Emitted[] = []
    const config = makeConfig(events)
    const wm = createWorkingMemory(seedMessages())

    const verdict = await maybeCompact({
      config,
      system: "sys",
      wm,
      breaker,
      archive: undefined,
      turn: 0,
      bgController: undefined,
      resetClassifier: noopReset,
      tokenBaselineBox: undefined,
    })

    expect(verdict.abort).toBe(false)
    // Exactly one strike — the load-bearing assertion. RED-on-injection: revert
    // the `recordProactive(before, before)` in the catch ⇒ this reads 0.
    expect(breaker.strikes.proactive).toBe(1)
    // One strike is below the cap (3) ⇒ not yet tripped.
    expect(breaker.check().abort).toBe(false)
  })
})
