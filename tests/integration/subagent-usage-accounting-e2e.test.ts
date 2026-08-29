/**
 * MR-00 RED RAIL — subagent usage accounting, driven through the SHIPPED
 * producer (REDs #1, #3, and #4 in situ).
 *
 * This rail drives `emitUsage` — the real fan-out the loop calls — rather than
 * any consumer in isolation. A consumer-only test can pass while the producer
 * never reaches it, which is exactly the failure mode being fixed here.
 *
 * MEASURED PREMISE (2026-08-30, HEAD 35adaf25).
 *
 * (1) ONE EVENT, TWO DOLLAR FIGURES. `emitUsage` prices the event ONCE via
 *     `costUsd` and ticks that into `budgetMeter` — then the ledger sink
 *     re-prices the SAME event with its own provider-blind formula. For an
 *     OpenAI model with cache reads the two disagree inside a single call:
 *     meter $1.60, ledger $2.60. emit-helpers.ts:78-82 asserts the opposite in
 *     a comment — "same SSOT rate card so meter and ledger never disagree".
 *     They share the rate CARD; they do not share the FORMULA. MR-01 makes the
 *     comment true by making it structural.
 *
 * (2) THE CHILD FALLS OUT OF THE COUNTERS. `buildChildConfig` constructs the
 *     child config field by field with no `...parent` spread. `stream` is
 *     inherited, so a subagent's usage events DO surface on the parent stream;
 *     the accounting slots are not, so the counters never see that spend. The
 *     parent's own numbers are therefore correct-looking and too small, which
 *     is worse than missing: measured, the stream carries parent+child while
 *     the meter carries parent only.
 *
 * (3) NO PROVENANCE ON THE WIRE. The `usage` AgentEvent (stream/types.ts:376)
 *     has no agent discriminator, so a surface reading the parent stream cannot
 *     separate root spend from subagent spend even though both arrive on it.
 *     RED #3's "mixing must be detectable" has nothing to key on today.
 *
 * REVERT/MUTATION POINTS (each must re-RED the named test after MR-01/02/03):
 *   - restore a second pricing formula in the ledger sink ⇒ "one usage event
 *     produces one cost figure across every sink" REDs.
 *   - drop the accounting slot from `buildChildConfig`'s child object ⇒ "a
 *     subagent's spend reaches the session's counters" REDs.
 *   - drop provenance from the emitted usage event ⇒ "usage on the parent
 *     stream identifies the agent that incurred it" REDs.
 */
import { describe, expect, test } from "bun:test"
import { BudgetMeter } from "@/agent/budget/meter"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { emitUsage } from "@/agent/loop/emit-helpers"
import { buildChildConfig } from "@/agent/subagent-runner-child-config"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent } from "@/llm"
import { createUsageAccounting } from "@/observability/usage-accounting"
import type { AgentEvent } from "@/stream/types"

type UsageEv = Extract<StreamEvent, { type: "usage" }>

const usage = (over: Partial<UsageEv> = {}): UsageEv =>
  ({
    type: "usage",
    model: "gpt-5.4",
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 400_000,
    ...over,
  }) as UsageEv

/** A parent config wired with BOTH cost sinks plus a capturing stream. */
const makeParent = () => {
  const events: AgentEvent[] = []
  const budgetMeter = new BudgetMeter({})
  const budgetLedger = defaultBudgetLedger()
  const usageAccounting = createUsageAccounting()
  const config = {
    llm: { stream: async function* () {} },
    registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
    stream: { emit: (e: AgentEvent) => void events.push(e) },
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "t",
    cwd: process.cwd(),
    maxTurns: 1,
    signal: new AbortController().signal,
    sessionId: "sess-1",
    budgetMeter,
    budgetLedger,
    usageAccounting,
  } as unknown as AgentConfig
  return { config, events, budgetMeter, budgetLedger, usageAccounting }
}

const emit = (config: AgentConfig, ev: UsageEv) =>
  emitUsage(config, ev, undefined, undefined, undefined)

const round = (n: number) => Math.round(n * 1e6) / 1e6

describe("RED #4 (in situ) — one usage event produces ONE cost figure", () => {
  test("one usage event produces one cost figure across every sink", () => {
    const { config, budgetMeter, budgetLedger } = makeParent()
    emit(config, usage()) // gpt-5.4, 1M input of which 400k are cache reads

    const meterCost = budgetMeter.snapshot().costUsd
    const ledgerCost = budgetLedger.snapshot().totalCost
    expect(meterCost).toBeGreaterThan(0) // both sinks really ran
    expect(ledgerCost).toBeGreaterThan(0)
    // REDs: 1.6 vs 2.6 — the meter carves cached tokens out of input (correct
    // for OpenAI), the ledger adds them on top.
    expect(round(meterCost)).toBe(round(ledgerCost))
  })

  // PAIRED CONTROL — Anthropic pricing is additive on BOTH paths, so the two
  // sinks already agree. Green today, must stay green: it proves the RED is
  // about provider normalization, not about the fan-out or this fixture.
  test("PAIRED CONTROL: an Anthropic event already agrees (must stay green)", () => {
    const { config, budgetMeter, budgetLedger } = makeParent()
    emit(config, usage({ model: "claude-sonnet-4-6" }))
    expect(round(budgetMeter.snapshot().costUsd)).toBe(round(budgetLedger.snapshot().totalCost))
  })
})

describe("RED #1 — a subagent's spend reaches the session's accounting", () => {
  const childOf = (parent: AgentConfig) =>
    buildChildConfig(parent, { prompt: "do a thing" } as never, process.cwd(), {
      agentId: "child-1",
      parentId: "root",
    } as never)

  // PAIRED CONTROL — the stream IS inherited. This is what makes the defect
  // asymmetric rather than a plain "child is unwired": child usage really does
  // arrive on the parent's stream.
  test("PAIRED CONTROL: the child inherits the parent's stream (must stay green)", () => {
    const { config } = makeParent()
    expect(childOf(config).stream).toBe(config.stream)
  })

  test("the child inherits the session's cost accounting, not just the stream", () => {
    const { config } = makeParent()
    expect(childOf(config).usageAccounting).toBe(config.usageAccounting)
  })

  /**
   * SCOPE NOTE. This rail originally asserted the child inherits `budgetMeter`
   * and `budgetLedger`, because at MR-00 those WERE the accounting. MR-02/03
   * moved the session's source of truth to `usageAccounting`, so the
   * requirement — a subagent's spend reaches the session's accounting — is now
   * tested against that authority above, with the same 600-token arithmetic.
   *
   * The legacy meters are NOT retrofitted: they keep their own semantics
   * (per-run caps, cross-run persisted ledger) until MR-05 reconciles them
   * against the authority. The test below holds that remaining gap open rather
   * than letting the re-point quietly retire it.
   */
  test("the per-run meter and cross-run ledger reconcile with the authority", () => {
    const { config, budgetMeter } = makeParent()
    const child = childOf(config)
    emit(config, usage({ inputTokens: 100, cacheReadTokens: 0 }))
    emit(child, usage({ inputTokens: 500, cacheReadTokens: 0 }))

    const authority = config.usageAccounting?.snapshot()
    expect(authority?.freshInputTokens).toBe(600) // the authority already sees both
    // REDs until MR-05: the meter is fed per-config and the child has none.
    expect(budgetMeter.snapshot().inputTokens).toBe(600)
  })

  test("a subagent's spend reaches the session's counters", () => {
    const { config, events } = makeParent()
    const child = childOf(config)

    emit(config, usage({ inputTokens: 100, cacheReadTokens: 0 })) // root turn
    emit(child, usage({ inputTokens: 500, cacheReadTokens: 0 })) // subagent turn

    // Both land on the parent stream — the surface sees the full 600 …
    const streamed = events.filter((e) => e.type === "usage") as ReadonlyArray<UsageEv>
    expect(streamed.map((e) => e.inputTokens)).toEqual([100, 500])
    // … and so does the session's accountant, because the child shares it.
    const snap = config.usageAccounting?.snapshot()
    expect(snap?.freshInputTokens).toBe(600)
    // Split, not just summed — "how much did the subagents cost" is the whole
    // question, and it must be answerable without re-deriving anything.
    expect(snap?.byKind.root.freshInputTokens).toBe(100)
    expect(snap?.byKind.subagent.freshInputTokens).toBe(500)
    expect(snap?.byAgent.get("child-1")?.freshInputTokens).toBe(500)
  })
})

describe("RED #3 — parent and child spend must be separable on one stream", () => {
  test("usage on the parent stream identifies the agent that incurred it", () => {
    const { config, events } = makeParent()
    const child = buildChildConfig(config, { prompt: "x" } as never, process.cwd(), {
      agentId: "child-1",
      parentId: "root",
    } as never)

    emit(config, usage({ inputTokens: 100, cacheReadTokens: 0 }))
    emit(child, usage({ inputTokens: 500, cacheReadTokens: 0 }))

    const streamed = events.filter((e) => e.type === "usage") as ReadonlyArray<UsageEv>
    expect(streamed).toHaveLength(2)
    // REDs: the `usage` event shape has no agent discriminator, so two events
    // that cost different money to different agents are indistinguishable.
    const provenance = streamed.map((e) => (e as { agentId?: string }).agentId)
    expect(provenance).toEqual(["root", "child-1"])
  })
})
