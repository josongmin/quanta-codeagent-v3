/**
 * ALBB-24 / ALBB-08 — behavioral hellgate for the proactive-compaction STRIKE
 * seam (`applyProactiveResult`, `src/agent/loop/compaction-wire.ts:469-478`).
 *
 * `applyProactiveResult` is module-private, so this gate drives it through its
 * public entry `maybeCompact` (the same rig the sibling THROW-branch test uses,
 * `src/agent/loop/__tests__/proactive-compact-failure-breaker.test.ts`). That
 * sibling pins the CATCH branch; THIS gate closes the distinct RESULT branch —
 * the `else if (UNPRODUCTIVE_PROACTIVE_REASONS.has(result.reason))` strike — which
 * has no direct test today.
 *
 * ALBB-08 widened the strike guard from `no_boundary` only to the SSOT set
 * `UNPRODUCTIVE_PROACTIVE_REASONS = {no_boundary, empty_summary}`. Before that
 * fix an `empty_summary` proactive result (summarizer returned "") freed nothing
 * yet accrued NO strike, so a summarizer stuck returning "" over threshold never
 * tripped the futility breaker — the exact fail-open the M9 throw-fix closed for
 * the catch branch. This gate proves BOTH reasons now strike.
 *
 *   §1 no_boundary  — over threshold, nothing summarizable ⇒ recordProactive
 *                     (before, before) ⇒ strikes.proactive === 1.
 *   §2 empty_summary — over threshold, a real boundary, summarizer returns "" ⇒
 *                     recordProactive(before, before) ⇒ strikes.proactive === 1.
 *   §3 PAIRED CONTROL (productive) — a summarizer that returns real text ⇒
 *                     compaction fires: strikes.proactive resets to 0, a
 *                     `compaction_event` is emitted, and the archive gets one entry.
 *
 * MUTATION pin: revert the strike at `compaction-wire.ts:477`
 * (`breaker?.recordProactive(before, before)`) OR narrow the guard back to
 * `result.reason === "no_boundary"` ⇒ §1 and/or §2 read `strikes.proactive === 0`
 * ⇒ RED.
 *
 * Scope: TEST-ONLY. No production behavior is changed.
 */

import { describe, expect, test } from "bun:test"
import { CompactionBreaker } from "@/agent/compaction-breaker"
import { UNPRODUCTIVE_PROACTIVE_REASONS } from "@/agent/compaction"
import { maybeCompact } from "@/agent/loop/compaction-wire"
import type { ConversationSummaryArchive } from "@/agent/conversation-summary-archive"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"

type Emitted = { type: string; reason?: string; detail?: string; kind?: string }

/** A summarizer LLM whose produced text is caller-controlled. `""` ⇒ the
 *  `empty_summary` reason; real text ⇒ a productive compaction. Streams a
 *  well-formed message so `assembleFromEvents` succeeds (only the CONTENT
 *  distinguishes the cases, not a throw — the throw branch is the sibling test). */
const summarizerLlm = (text: string): LLMPort => ({
  model: "fake-summarizer",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      if (text !== "") yield { type: "text_delta", delta: text }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
})

const makeConfig = (
  events: Emitted[],
  keepRecentTurns: number,
  summaryText: string,
  compactionEvents?: Emitted[],
): AgentConfig =>
  ({
    system: "sys",
    llm: summarizerLlm(summaryText),
    stream: { emit: (e: Emitted) => events.push(e) },
    // The compaction_event fires through the dedicated `compactionEventEmit`
    // port (NOT `stream.emit`); capture it when the caller wants to observe it.
    ...(compactionEvents !== undefined
      ? { compactionEventEmit: (e: Emitted) => compactionEvents.push(e) }
      : {}),
    // thresholdTokens:1 ⇒ always over threshold ⇒ the proactive path is entered.
    compaction: {
      summarizerLlm: summarizerLlm(summaryText),
      keepRecentTurns,
      thresholdTokens: 1,
    },
  }) as unknown as AgentConfig

/** Alternating user/assistant turns, each big enough that estimateTokens
 *  (chars/4) is comfortably > 0 (so `recordProactive(before, before)` is a
 *  no-progress strike, not the `before <= 0` progress fast-path). */
const seedMessages = (turns: number): Message[] =>
  Array.from({ length: turns }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: [{ type: "text" as const, text: `turn ${i} ${"x".repeat(200)}` }],
  }))

const noopReset = (): void => {}

const runOnce = async (
  config: AgentConfig,
  breaker: CompactionBreaker,
  messages: Message[],
  archive?: ConversationSummaryArchive,
) => {
  const wm = createWorkingMemory(messages)
  const verdict = await maybeCompact({
    config,
    system: "sys",
    wm,
    breaker,
    archive,
    turn: 0,
    bgController: undefined,
    resetClassifier: noopReset,
    tokenBaselineBox: undefined,
  })
  return { verdict, wm }
}

describe("ALBB-24 / ALBB-08 — applyProactiveResult strike seam (result branch)", () => {
  // Guard the SSOT this fix pivots on so the test travels with intent: the
  // widened set must contain BOTH reasons (a re-narrowing to no_boundary-only
  // fails here too, not just the behavioral §2 below).
  test("UNPRODUCTIVE_PROACTIVE_REASONS SSOT contains no_boundary AND empty_summary", () => {
    expect(UNPRODUCTIVE_PROACTIVE_REASONS.has("no_boundary")).toBe(true)
    expect(UNPRODUCTIVE_PROACTIVE_REASONS.has("empty_summary")).toBe(true)
    // benign reasons are excluded (host-chosen wait / under budget)
    expect(UNPRODUCTIVE_PROACTIVE_REASONS.has("deferred")).toBe(false)
    expect(UNPRODUCTIVE_PROACTIVE_REASONS.has("under_threshold")).toBe(false)
  })

  test("§1 no_boundary ⇒ exactly one proactive strike, no compaction event", async () => {
    const events: Emitted[] = []
    const compactionEvents: Emitted[] = []
    // keepRecentTurns large + few turns ⇒ findBoundary <= 0 ⇒ reason no_boundary.
    const config = makeConfig(events, 10, "unused", compactionEvents)
    const breaker = new CompactionBreaker()

    const { verdict } = await runOnce(config, breaker, seedMessages(3))

    // Proactive path never fail-closes.
    expect(verdict.abort).toBe(false)
    // Load-bearing: the no-progress strike landed. Mutation pin: revert the
    // recordProactive at compaction-wire.ts:477 ⇒ reads 0 ⇒ RED.
    expect(breaker.strikes.proactive).toBe(1)
    // A no-op result emits NO compaction_event (nothing was compacted).
    expect(compactionEvents.length).toBe(0)
  })

  test("§2 empty_summary ⇒ exactly one proactive strike (the ALBB-08 widening)", async () => {
    const events: Emitted[] = []
    const compactionEvents: Emitted[] = []
    // keepRecentTurns:1 + 6 turns ⇒ a real boundary ⇒ summarizer runs and
    // returns "" ⇒ reason empty_summary.
    const config = makeConfig(events, 1, "", compactionEvents)
    const breaker = new CompactionBreaker()

    const { verdict, wm } = await runOnce(config, breaker, seedMessages(6))

    expect(verdict.abort).toBe(false)
    // THE ALBB-08 pin: empty_summary now strikes. Before the widening (guard
    // was `reason === "no_boundary"` only) this read 0 ⇒ RED.
    expect(breaker.strikes.proactive).toBe(1)
    // empty_summary keeps the full transcript (never installs an empty summary).
    expect(wm.snapshot().length).toBe(6)
    expect(compactionEvents.length).toBe(0)
  })

  test("§3 PAIRED CONTROL — a productive compaction resets strikes + emits the event", async () => {
    const events: Emitted[] = []
    const compactionEvents: Emitted[] = []
    // Real summary text + a boundary ⇒ compacted:true.
    const config = makeConfig(events, 1, "dense recap of the task and decisions", compactionEvents)
    const breaker = new CompactionBreaker()
    const archive: ConversationSummaryArchive = { summaries: [] }

    // Pre-load a strike so the reset is observable (was 1 → productive → 0).
    breaker.recordProactive(100, 100)
    expect(breaker.strikes.proactive).toBe(1)

    const { verdict, wm } = await runOnce(config, breaker, seedMessages(6), archive)

    expect(verdict.abort).toBe(false)
    // Productive ⇒ recordProactive(before, after) with a real `after` ⇒ the
    // no-progress counter RESETS (the classifier-productive path, not a strike).
    expect(breaker.strikes.proactive).toBe(0)
    // The compaction actually fired: a compaction_event was emitted through the
    // dedicated port with the proactive/context_limit shape…
    expect(compactionEvents.length).toBe(1)
    expect(compactionEvents[0]?.kind).toBe("compaction_event")
    // …a context_compacted stream event fired (archive-append side)…
    expect(events.some((e) => e.type === "context_compacted")).toBe(true)
    // …the transcript was replaced with [summary, ...suffix] (shorter)…
    expect(wm.snapshot().length).toBeLessThan(6)
    // …and the archive got exactly one appended summary.
    expect(archive.summaries.length).toBe(1)
  })
})
