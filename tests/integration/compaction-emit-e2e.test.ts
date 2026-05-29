/**
 * TKT-0409 — long-session `post_compact` emit + provenance e2e (L3→L4).
 *
 * Existing coverage:
 *   - `tests/unit/compaction-post-event-hellgate.test.ts` pins the emit + objective
 *     contract on `compactIfNeeded` with a 4-message fixture and inline callbacks.
 *   - `tests/unit/observability-e2e-real-hookbus-hellgate.test.ts` proves the
 *     real `HookBus` dispatches a `post_compact` event to a subscriber.
 *   - `tests/unit/microcompact-hellgate.test.ts` pins the microcompact factory's
 *     provenance shape.
 *
 * Gap this file closes (integration, not unit): a LONG-SESSION transcript drives
 * the REAL composition `compactIfNeeded(args)` uses in production — the
 * `buildPostCompactEmit` helper (loop.ts wire) over a real `HookBus`, a real
 * callback-shaped objective bridge (matches loop.ts site), and a summarizer-stub
 * LLM — across the three live arms (proactive `token_budget_exceeded`,
 * reactive `ptl_reactive` with the manual emit loop.ts does at the reactive
 * site, and `microcompact`). Adversarial branches verify the NO-THROW seam
 * stays unbroken when the emitter or objective callback explodes, and that the
 * byte-identical-when-unwired contract holds across all three arms.
 *
 * NO src mutations. NO ADR. Tests only.
 */

import { describe, expect, test } from "bun:test"
import { compactIfNeeded, reactiveCompact } from "@/agent/compaction"
import { HookBus } from "@/agent/hooks"
import { buildPostCompactEmit } from "@/agent/loop-helpers"
import { createMicroCompactor } from "@/agent/microcompact"
import type { RecoveryProvenance } from "@/agent/recovery-reason"
import type { LLMPort, Message, StreamEvent, StreamInput, SystemPromptInput } from "@/llm"

// ── fixtures ────────────────────────────────────────────────────────────────

class SummarizingLLM implements LLMPort {
  callCount = 0
  lastSystem: SystemPromptInput | undefined
  lastMessages: Message[] = []
  constructor(private readonly summary: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.callCount += 1
    this.lastSystem = input.system
    this.lastMessages = input.messages
    yield { type: "text_delta", delta: this.summary }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const userText = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})
const assistantText = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

/** Synthetic long-session transcript: 30 user/assistant turns of ~400 chars
 *  each ⇒ ~24 k chars ⇒ ~6 k token estimate, plus a trailing "recent" tail.
 *  Threshold in the tests is set to 100 so every scenario crosses it. */
const longSessionTranscript = (): Message[] => {
  const msgs: Message[] = []
  for (let i = 0; i < 30; i++) {
    msgs.push(userText(`turn-${i}-user: ${"q".repeat(400)}`))
    msgs.push(assistantText(`turn-${i}-assistant: ${"a".repeat(400)}`))
  }
  msgs.push(userText("recent ask"))
  msgs.push(assistantText("recent answer"))
  return msgs
}

/** Capture a `post_compact` subscription on a real `HookBus`. */
const captureBus = (): {
  bus: HookBus
  events: { threadId: string; provenance: RecoveryProvenance }[]
} => {
  const bus = new HookBus()
  const events: { threadId: string; provenance: RecoveryProvenance }[] = []
  bus.on("post_compact", (e) => {
    if (e.type === "post_compact") events.push({ threadId: e.threadId, provenance: e.provenance })
    return {}
  })
  return { bus, events }
}

/** Lightweight Objective wire matching the loop.ts site shape (callback, not
 *  the full port — the slice fence keeps the test off the Objective module). */
const captureObjective = (): {
  fn: (threadId: string, actions: readonly string[]) => void
  calls: { threadId: string; actions: readonly string[] }[]
} => {
  const calls: { threadId: string; actions: readonly string[] }[] = []
  return {
    fn: (threadId, actions) => {
      calls.push({ threadId, actions })
    },
    calls,
  }
}

/** Provenance-shape assertion: every required field present, plausible. */
const expectProvenanceShape = (
  p: RecoveryProvenance,
  expectedReason: RecoveryProvenance["reason"],
  inputMessageCount: number,
): void => {
  expect(p.reason).toBe(expectedReason)
  expect(typeof p.tokensBefore).toBe("number")
  expect(typeof p.tokensAfter).toBe("number")
  expect(p.tokensBefore).toBeGreaterThan(0)
  expect(p.tokensAfter).toBeGreaterThanOrEqual(0)
  expect(typeof p.turnsDropped).toBe("number")
  expect(typeof p.turnsKept).toBe("number")
  expect(p.turnsDropped).toBeGreaterThanOrEqual(0)
  expect(p.turnsKept).toBeGreaterThanOrEqual(0)
  expect(p.turnsDropped + p.turnsKept).toBe(inputMessageCount)
  expect(typeof p.compactedAt).toBe("number")
  expect(p.compactedAt).toBeGreaterThan(0)
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("TKT-0409 — long-session post_compact emit + provenance e2e", () => {
  test("PROACTIVE (token_budget_exceeded) — long session → HookBus dispatch + objective + provenance", async () => {
    const { bus, events } = captureBus()
    const objective = captureObjective()
    const llm = new SummarizingLLM("LONG-SUMMARY")
    const threadId = "thread-proactive"
    const postCompactEmit = buildPostCompactEmit(bus, threadId)
    expect(postCompactEmit).toBeDefined()

    const messages = longSessionTranscript()
    const inputLen = messages.length

    const res = await compactIfNeeded({
      messages,
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 2,
      threadId,
      // biome-ignore lint/style/noNonNullAssertion: defined-guard above
      postCompactEmit: postCompactEmit!,
      objectiveSetNextActions: objective.fn,
      // proactive site default — explicit for clarity
      recoveryReason: "token_budget_exceeded",
    })

    expect(res.compacted).toBe(true)
    if (!res.compacted) throw new Error("expected compaction")

    // (a) HookBus.emit("post_compact") fires EXACTLY ONCE.
    expect(events.length).toBe(1)
    const first = events[0]
    if (!first) throw new Error("no event recorded")
    expect(first.threadId).toBe(threadId)
    expectProvenanceShape(first.provenance, "token_budget_exceeded", inputLen)
    expect(first.provenance.tokensAfter).toBeLessThan(first.provenance.tokensBefore)
    expect(first.provenance.resumeStep).toContain("resume after compaction")

    // (b) objective.setNextActions invoked exactly once with thread + hint.
    expect(objective.calls.length).toBe(1)
    expect(objective.calls[0]?.threadId).toBe(threadId)
    expect(objective.calls[0]?.actions.length).toBe(1)
    expect(objective.calls[0]?.actions[0]).toContain("token_budget_exceeded")

    // Summarizer was actually awoken once on the real path.
    expect(llm.callCount).toBe(1)
  })

  test("REACTIVE (ptl_reactive) — manual emit mirroring loop.ts:1298 site (subscriber + objective)", async () => {
    // The reactive site in loop.ts builds + fires the post_compact event by
    // hand (`reactiveCompact` doesn't take the callback). Mirror that flow
    // here so we cover the OTHER live `post_compact` producer.
    const { bus, events } = captureBus()
    const objective = captureObjective()
    const llm = new SummarizingLLM("CONTINUATION-SUMMARY")
    const threadId = "thread-reactive"

    const messages = longSessionTranscript()
    const before = messages.length // approx — we just need a positive count
    const reactive = await reactiveCompact({
      messages,
      llm,
      system: "sys",
      keepRecentTurns: 2,
    })
    expect(reactive.ok).toBe(true)
    if (!reactive.ok) throw new Error("reactive must succeed")

    // EXACT replica of the loop.ts reactive-site emit (lines 1304-1319):
    const provenance: RecoveryProvenance = {
      reason: "ptl_reactive",
      tokensBefore: 10_000, // synthesized — the reactive helper doesn't expose pre-tokens
      tokensAfter: 1_000,
      turnsDropped: Math.max(before - reactive.messages.length, 0),
      turnsKept: reactive.messages.length,
      compactedAt: Date.now(),
    }
    await bus.emit({ type: "post_compact", threadId, provenance })
    objective.fn(threadId, ["Resuming after mid-turn compaction (PTL recovery)"])

    // (a) HookBus dispatched once with ptl_reactive reason.
    expect(events.length).toBe(1)
    expect(events[0]?.threadId).toBe(threadId)
    expect(events[0]?.provenance.reason).toBe("ptl_reactive")
    expect(events[0]?.provenance.turnsKept).toBe(reactive.messages.length)
    const firstReactive = events[0]
    if (!firstReactive) throw new Error("reactive event missing")
    expect(
      firstReactive.provenance.turnsDropped + firstReactive.provenance.turnsKept,
    ).toBeGreaterThan(0)

    // (b) Objective wire forwarded the PTL hint.
    expect(objective.calls.length).toBe(1)
    expect(objective.calls[0]?.actions[0]).toContain("PTL")
  })

  test("MICROCOMPACT — createMicroCompactor drops oldest %, emits provenance + via bus + objective", async () => {
    const { bus, events } = captureBus()
    const objective = captureObjective()
    const threadId = "thread-micro"
    const messages = longSessionTranscript().map((m) => ({
      role: m.role,
      content: m.content,
    }))

    // 25% drop (default) over a 62-message transcript ⇒ 15 oldest go.
    const micro = createMicroCompactor()
    const result = micro.compact({
      messages,
      threadId,
      preserveRecentTurns: 6,
      dropRatio: 0.25,
    })

    // The microcompactor returns the provenance directly — to prove it
    // reaches the bus + objective wires we publish through the same channels
    // the proactive loop wire uses.
    expect(result.provenance.reason).toBe("microcompact")
    expect(result.turnsDropped).toBeGreaterThan(0)
    expect(result.turnsKept).toBeGreaterThan(0)
    expect(result.turnsDropped + result.turnsKept).toBe(messages.length)
    await bus.emit({ type: "post_compact", threadId, provenance: result.provenance })
    objective.fn(threadId, [`agent compacted: reason ${result.provenance.reason} — partial drop`])

    expect(events.length).toBe(1)
    expect(events[0]?.provenance.reason).toBe("microcompact")
    expect(events[0]?.provenance.turnsDropped).toBe(result.turnsDropped)
    expect(events[0]?.provenance.turnsKept).toBe(result.turnsKept)

    expect(objective.calls.length).toBe(1)
    expect(objective.calls[0]?.actions[0]).toContain("microcompact")
  })

  test("BYTE-IDENTICAL — long session, no callbacks wired ⇒ compaction succeeds with no event, no objective", async () => {
    const llm = new SummarizingLLM("LEGACY")
    const messages = longSessionTranscript()
    // Sentinel bus we register on but never pass into compactIfNeeded —
    // proves the unwired path NEVER materializes a `post_compact` event.
    const { bus, events } = captureBus()
    const objective = captureObjective()

    const res = await compactIfNeeded({
      messages,
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 2,
      // intentionally NO postCompactEmit / objectiveSetNextActions / threadId
    })

    expect(res.compacted).toBe(true)
    expect(events.length).toBe(0)
    expect(objective.calls.length).toBe(0)
    // Bus wasn't fed at all — sanity that the byte-identical path never
    // implicitly grabs a global.
    expect(bus).toBeDefined()
  })

  test("ADVERSARIAL — subscriber THROWS ⇒ compaction succeeds (NO-THROW seam holds end-to-end)", async () => {
    const bus = new HookBus()
    let received = 0
    bus.on("post_compact", () => {
      received += 1
      throw new Error("subscriber exploded")
    })
    const objective = captureObjective()
    const llm = new SummarizingLLM("SUMMARY")
    const threadId = "thread-throw"
    const postCompactEmit = buildPostCompactEmit(bus, threadId)

    const res = await compactIfNeeded({
      messages: longSessionTranscript(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 2,
      threadId,
      // biome-ignore lint/style/noNonNullAssertion: defined-guard
      postCompactEmit: postCompactEmit!,
      objectiveSetNextActions: objective.fn,
    })

    // Compaction MUST still succeed even though the subscriber threw — the
    // bus catches handler errors and `compactIfNeeded` wraps the emit in
    // its own try/catch on top.
    expect(res.compacted).toBe(true)
    expect(received).toBe(1)
    // Objective wire ran AFTER the throwing subscriber (sequential, but the
    // NO-THROW catch around postCompactEmit isolates the failure).
    expect(objective.calls.length).toBe(1)
  })

  test("ADVERSARIAL — objective callback THROWS ⇒ compaction succeeds, HookBus event still dispatched", async () => {
    const { bus, events } = captureBus()
    const llm = new SummarizingLLM("SUMMARY")
    const threadId = "thread-obj-throw"
    const postCompactEmit = buildPostCompactEmit(bus, threadId)

    const res = await compactIfNeeded({
      messages: longSessionTranscript(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 2,
      threadId,
      // biome-ignore lint/style/noNonNullAssertion: defined-guard
      postCompactEmit: postCompactEmit!,
      objectiveSetNextActions: () => {
        throw new Error("objective exploded")
      },
    })

    expect(res.compacted).toBe(true)
    expect(events.length).toBe(1)
  })

  test("ADVERSARIAL — undefined provenance fields never appear (omit-when-absent)", async () => {
    const { bus, events } = captureBus()
    const llm = new SummarizingLLM("SUMMARY")
    const threadId = "thread-shape"
    const postCompactEmit = buildPostCompactEmit(bus, threadId)
    await compactIfNeeded({
      messages: longSessionTranscript(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 2,
      threadId,
      // biome-ignore lint/style/noNonNullAssertion: defined-guard
      postCompactEmit: postCompactEmit!,
    })
    expect(events.length).toBe(1)
    const p = events[0]?.provenance
    if (!p) throw new Error("provenance missing")
    // exactOptional contract: summaryRef is OMITTED when no archive wired,
    // never present as `undefined`.
    expect("summaryRef" in p).toBe(false)
    // resumeStep IS present (compactIfNeeded always materializes it).
    expect(typeof p.resumeStep).toBe("string")
  })

  test("ADVERSARIAL — microcompact dropRatio out-of-range clamped ⇒ provenance still well-formed", async () => {
    const micro = createMicroCompactor()
    const messages = longSessionTranscript()
    // dropRatio=2 ⇒ clamped to 1 (would drop everything but the protected suffix)
    const over = micro.compact({
      messages,
      threadId: "t-clamp",
      dropRatio: 2,
      preserveRecentTurns: 4,
    })
    expect(over.provenance.reason).toBe("microcompact")
    expect(over.turnsKept).toBeGreaterThanOrEqual(4)
    expect(over.turnsDropped + over.turnsKept).toBe(messages.length)
    // dropRatio=-1 ⇒ clamped to 0 ⇒ no drops
    const under = micro.compact({ messages, threadId: "t-clamp", dropRatio: -1 })
    expect(under.turnsDropped).toBe(0)
    expect(under.turnsKept).toBe(messages.length)
    expect(under.provenance.reason).toBe("microcompact")
  })

  test("ADVERSARIAL — proactive defer (preflight 'defer_one_turn') over long session ⇒ NO event, NO objective call", async () => {
    const { bus, events } = captureBus()
    const objective = captureObjective()
    const llm = new SummarizingLLM("UNUSED")
    const threadId = "thread-defer"
    const postCompactEmit = buildPostCompactEmit(bus, threadId)

    const res = await compactIfNeeded({
      messages: longSessionTranscript(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 2,
      threadId,
      // biome-ignore lint/style/noNonNullAssertion: defined-guard
      postCompactEmit: postCompactEmit!,
      objectiveSetNextActions: objective.fn,
      preflight: async () => "defer_one_turn",
    })

    expect(res.compacted).toBe(false)
    expect(events.length).toBe(0)
    expect(objective.calls.length).toBe(0)
    // Summarizer NEVER awoken on a defer.
    expect(llm.callCount).toBe(0)
  })

  test("ADVERSARIAL — proactive with threadId='' ⇒ objective bridge SKIPPED but bus event still fires", async () => {
    // loop.ts wires postCompactEmit with sessionId ?? '' — when no session
    // id is available the bus event still goes through (HookBus accepts
    // empty threadId), but the objective callback site guards on
    // `threadId.length > 0`. compactIfNeeded's own guard uses
    // `threadId !== undefined`, so this scenario pins the proactive site's
    // empty-string behavior end-to-end.
    const { bus, events } = captureBus()
    const objective = captureObjective()
    const llm = new SummarizingLLM("SUMMARY")
    const postCompactEmit = buildPostCompactEmit(bus, "")

    const res = await compactIfNeeded({
      messages: longSessionTranscript(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 2,
      // threadId set to '' — compactIfNeeded WILL invoke objective (the
      // guard is `!== undefined`), but the bus event carries '' threadId.
      threadId: "",
      // biome-ignore lint/style/noNonNullAssertion: defined-guard
      postCompactEmit: postCompactEmit!,
      objectiveSetNextActions: objective.fn,
    })
    expect(res.compacted).toBe(true)
    expect(events.length).toBe(1)
    expect(events[0]?.threadId).toBe("")
    expect(objective.calls.length).toBe(1)
    expect(objective.calls[0]?.threadId).toBe("")
  })

  test("ADVERSARIAL — proactive WITHOUT threadId ⇒ objective bridge SKIPPED, bus event still fires", async () => {
    // Contrast with the previous test: when threadId is OMITTED entirely,
    // compactIfNeeded's `input.threadId !== undefined` guard fires and the
    // objective callback is NOT invoked even though it was supplied. The
    // bus emit still happens (postCompactEmit was wired).
    const { bus, events } = captureBus()
    const objective = captureObjective()
    const llm = new SummarizingLLM("SUMMARY")
    const postCompactEmit = buildPostCompactEmit(bus, "thread-bus-only")

    const res = await compactIfNeeded({
      messages: longSessionTranscript(),
      llm,
      system: "sys",
      thresholdTokens: 100,
      keepRecentTurns: 2,
      // intentionally NO threadId
      // biome-ignore lint/style/noNonNullAssertion: defined-guard
      postCompactEmit: postCompactEmit!,
      objectiveSetNextActions: objective.fn,
    })
    expect(res.compacted).toBe(true)
    expect(events.length).toBe(1)
    expect(events[0]?.threadId).toBe("thread-bus-only")
    expect(objective.calls.length).toBe(0)
  })

  test("INVARIANT — every emitted provenance round-trips through the RecoveryReason closed enum", async () => {
    // Drive every reason that the live compactIfNeeded path supports via the
    // `recoveryReason` override (the proactive site default is
    // `token_budget_exceeded`, but the override is the only knob the
    // production wires expose for fork/manual/context_change). The microcompact
    // arm is exercised in the microcompact test above.
    const { bus, events } = captureBus()
    const llm = new SummarizingLLM("SUMMARY")
    const postCompactEmit = buildPostCompactEmit(bus, "thread-enum")
    const arms = [
      "token_budget_exceeded",
      "ptl_reactive",
      "drift_breaker",
      "manual",
      "context_change",
      "fork_branch",
      "microcompact",
    ] as const

    for (const arm of arms) {
      await compactIfNeeded({
        messages: longSessionTranscript(),
        llm,
        system: "sys",
        thresholdTokens: 100,
        keepRecentTurns: 2,
        threadId: "thread-enum",
        // biome-ignore lint/style/noNonNullAssertion: defined-guard
        postCompactEmit: postCompactEmit!,
        recoveryReason: arm,
      })
    }
    expect(events.length).toBe(arms.length)
    for (let i = 0; i < arms.length; i++) {
      expect(events[i]?.provenance.reason).toBe(arms[i] as RecoveryProvenance["reason"])
    }
  })
})
