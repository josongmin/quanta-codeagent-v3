/**
 * MR-00 RED RAIL — budget plane (REDs #2, #7).
 *
 * MEASURED PREMISE (2026-08-30, HEAD 35adaf25).
 *
 * (1) RETENTION EATS THE LEDGER. `BudgetLedger` recomputes every aggregate from
 *     the RETAINED event slice, so eviction does not just forget history — it
 *     REDUCES the reported spend. Measured with `maxEvents: 4` over 10 events of
 *     $3: true spend $30, `snapshot().totalCost` $12.
 *
 *     budget-ledger.ts:55-66 documents this as intentional ("they DECREASE as
 *     events drop. This is intentional"). The plan supersedes that clause:
 *     retention is a MEMORY bound on the event log, and must not be a bound on
 *     the accounting. MR-05 therefore rewrites contract clauses #6/#7 — this
 *     rail is the reason, and the doc comment must be updated with the code.
 *
 * (2) EVICTION DEFEATS THE HARD CEILING. This is the enforcement consequence,
 *     and it is worse than a wrong number. Measured: `maxEvents: 4`, session
 *     hard limit $20, ten $3 events. True spend $30 — over the ceiling — yet
 *     ZERO breaches fire and `hardBreach()` is `undefined`, because the cap is
 *     compared against the shrunken retained total ($12) that never reaches it.
 *     A run that crossed its hard cost ceiling keeps spending.
 *
 *     REACHABILITY, stated honestly: `DEFAULT_MAX_EVENTS` is 10_000, so this
 *     needs a session with >10k usage events — a long autonomous run, which is
 *     exactly the workload a hard cost ceiling exists to protect.
 *
 * (3) NO AGENT ATTRIBUTION. `UsageEvent` carries `sessionId` and an optional
 *     `turnId` and nothing else. There is no field identifying WHICH agent
 *     spent the money, so no snapshot can answer "how much did subagents
 *     cost" — the question RED #2 needs. MR-02 adds provenance to the record
 *     and a per-agent rollup to the snapshot.
 *
 * REVERT/MUTATION POINTS (each must re-RED the named test after MR-02/MR-05):
 *   - recompute aggregates from the retained slice instead of monotonic
 *     counters ⇒ "cumulative spend survives event eviction" REDs.
 *   - compare breach thresholds against the retained total ⇒ "a hard ceiling
 *     still trips when the crossing event has been evicted" REDs.
 *   - drop the provenance field from the recorded event ⇒ "spend is
 *     attributable to the agent that incurred it" REDs.
 */
import { describe, expect, test } from "bun:test"
import { type BudgetLedgerOpts, defaultBudgetLedger, type UsageEvent } from "@/agent/budget-ledger"
import { emitUsage } from "@/agent/loop/emit-helpers"
import { buildChildConfig } from "@/agent/subagent-runner-child-config"
import type { AgentConfig } from "@/agent/types"
import type { StreamEvent as LlmStreamEvent } from "@/llm"

const SONNET_INPUT_PER_M = 3 // $3/M in — one event below is exactly $3.
const EVENT_COST = 3

const event = (i: number, over: Partial<UsageEvent> = {}): UsageEvent => ({
  model: "claude-sonnet-4-6",
  inputTokens: 1_000_000,
  outputTokens: 0,
  sessionId: "s",
  at: 1_700_000_000_000 + i,
  ...over,
})

/** Record `n` identical $3 events and report what the ledger believes. */
const spend = (opts: BudgetLedgerOpts, n: number) => {
  const ledger = defaultBudgetLedger(opts)
  const fired: string[] = []
  for (let i = 0; i < n; i++) {
    for (const b of ledger.record(event(i)).breaches) fired.push(b.kind)
  }
  return { ledger, fired, snapshot: ledger.snapshot(), trueSpend: n * EVENT_COST }
}

describe("RED #7 — retention bounds memory, never the accounting", () => {
  test("cumulative spend survives event eviction", () => {
    const { snapshot, trueSpend } = spend({ maxEvents: 4 }, 10)
    expect(trueSpend).toBe(30) // sanity on the fixture's own arithmetic
    expect(snapshot.events).toBe(4) // eviction DID happen — the test is live
    expect(snapshot.totalCost).toBe(30) // REDs at 12: aggregates shrank with the log
  })

  test("per-model spend survives event eviction", () => {
    const { snapshot } = spend({ maxEvents: 4 }, 10)
    expect(snapshot.perModel.get("claude-sonnet-4-6")?.totalCost).toBe(30)
    expect(snapshot.perModel.get("claude-sonnet-4-6")?.inputTokens).toBe(10_000_000)
  })

  // PAIRED CONTROL — with room for every event the totals are already right.
  // Green today and must stay green: it isolates the RED to eviction, not to
  // pricing or to the fixture.
  test("PAIRED CONTROL: with no eviction the total is already correct (must stay green)", () => {
    const { snapshot, trueSpend } = spend({ maxEvents: 1_000 }, 10)
    expect(snapshot.events).toBe(10) // nothing evicted
    expect(snapshot.totalCost).toBe(trueSpend)
  })

  test("a hard ceiling still trips when the crossing event has been evicted", () => {
    // True spend $30 crosses the $20 ceiling. Retained spend ($12) never does.
    const { fired, ledger } = spend({ maxEvents: 4, policy: { sessionHardLimit: 20 } }, 10)
    expect(fired).toContain("session-hard") // REDs: fired is [] — nothing stopped the run
    expect(ledger.hardBreach()?.kind).toBe("session-hard")
  })

  test("a fired breach reports the TRUE observed spend, not the retained slice", () => {
    // Crossed at event 1 ($6 > $5), so the breach itself fires even under
    // eviction — but `hardBreach()` reconstructs `observed` from the shrunken
    // total, understating what was actually spent ($12 reported vs $30 real).
    const { ledger } = spend({ maxEvents: 4, policy: { sessionHardLimit: 5 } }, 10)
    expect(ledger.hardBreach()?.observed).toBe(30) // REDs at 12
  })

  // PAIRED CONTROL — unbounded retention already reports the true observed
  // spend, proving the RED above is eviction-specific.
  test("PAIRED CONTROL: without eviction the breach observes true spend (must stay green)", () => {
    const { ledger } = spend({ maxEvents: 1_000, policy: { sessionHardLimit: 5 } }, 10)
    expect(ledger.hardBreach()?.observed).toBe(30)
  })
})

describe("A4 — the delegation keeps the ledger's own policies", () => {
  test("an operator rate OVERRIDE still wins through the delegated formula", () => {
    // The delegation projects the RESOLVED pricing (override-merged) into the
    // formula's card; collapsing to the default card would silently discard
    // every operator override.
    const ledger = defaultBudgetLedger({
      pricing: { "claude-sonnet-4-6": { inputPerM: 999, outputPerM: 0 } },
    })
    const { cost } = ledger.record({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 0,
      sessionId: "s",
      at: 1,
    })
    expect(cost).toBeCloseTo(999, 9)
  })

  test("poisoned buckets are scrubbed BEFORE the formula (ledger contract)", () => {
    // Normalization deliberately passes NaN/Infinity through for the
    // authority's reject path; the ledger's contract zeroes them instead —
    // and no non-finite value may reach the shared formula.
    const ledger = defaultBudgetLedger()
    const { cost } = ledger.record({
      model: "claude-sonnet-4-6",
      inputTokens: Number.POSITIVE_INFINITY,
      outputTokens: Number.NaN,
      cacheReadTokens: -5,
      cacheWriteTokens: 100_000, // the one sane bucket still bills ($0.375)
      sessionId: "s",
      at: 1,
    })
    expect(cost).toBeCloseTo(0.375, 9)
    expect(Number.isFinite(ledger.snapshot().totalCost)).toBe(true)
  })

  test("the itemized breakdown maps component-by-component (Σ parts == total)", () => {
    // `totalCost` alone would stay right even if a component were dropped in
    // the mapping — budget_status renders the components, so each one is
    // pinned and their sum must reproduce the total.
    const ledger = defaultBudgetLedger()
    ledger.record({
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 300_000,
      cacheWriteTokens: 100_000,
      sessionId: "s",
      at: 1,
    })
    const b = ledger.snapshot().perModel.get("claude-sonnet-4-6")
    expect(b?.inputCost).toBeCloseTo(3, 9)
    expect(b?.outputCost).toBeCloseTo(3, 9)
    expect(b?.cacheReadCost).toBeCloseTo(0.09, 9)
    expect(b?.cacheWriteCost).toBeCloseTo(0.375, 9)
    expect(
      (b?.inputCost ?? 0) +
        (b?.outputCost ?? 0) +
        (b?.cacheReadCost ?? 0) +
        (b?.cacheWriteCost ?? 0),
    ).toBeCloseTo(b?.totalCost ?? -1, 9)
  })
})

describe("a scoped clear cannot un-bill a scope it was not asked to clear", () => {
  const spendIn = (ledger: ReturnType<typeof defaultBudgetLedger>, session: string, n: number) => {
    for (let i = 0; i < n; i++) ledger.record(event(i, { sessionId: session }))
  }

  test("clearing one session leaves another session's evicted spend on the books", () => {
    // The hazard this closes: with aggregates now lifetime, rebuilding them
    // from the retained survivors — which is what a scoped clear used to do —
    // would silently drop every OTHER scope's evicted spend, putting the loss
    // back in through `clear` after eviction stopped causing it.
    const ledger = defaultBudgetLedger({ maxEvents: 3 })
    spendIn(ledger, "keep", 6) // $18, mostly evicted
    ledger.record(event(99, { sessionId: "drop" })) // $3
    expect(ledger.snapshot().totalCost).toBeCloseTo(21, 9)

    ledger.clear({ session: "drop" })
    expect(ledger.snapshot().perSession.get("keep")?.totalCost).toBeCloseTo(18, 9)
    expect(ledger.snapshot().totalCost).toBeCloseTo(18, 9)
  })

  // PAIRED CONTROL — with nothing evicted the retained log IS the full history,
  // so the exact rebuild still runs and the cleared scope leaves no residue in
  // the cross-scope breakdowns either.
  test("PAIRED CONTROL: with no eviction a scoped clear is exact (must stay green)", () => {
    const ledger = defaultBudgetLedger()
    spendIn(ledger, "keep", 2) // $6
    ledger.record(event(99, { sessionId: "drop" })) // $3
    ledger.clear({ session: "drop" })
    expect(ledger.snapshot().totalCost).toBeCloseTo(6, 9)
    expect(ledger.snapshot().perModel.get("claude-sonnet-4-6")?.totalCost).toBeCloseTo(6, 9)
    expect(ledger.snapshot().perSession.has("drop")).toBe(false)
  })
})

describe("RED #2 — spend is attributable to the agent that incurred it", () => {
  /**
   * SCOPE CORRECTION (recorded deliberately). The first draft demanded a
   * `perAgent` roll-up from the LEDGER. That was the wrong owner. The ledger is
   * the CROSS-RUN accountant: it aggregates by model, session, and UTC day, it
   * persists, and it enforces daily caps. Agent lineage is a within-session
   * concept it deliberately does not model, and bolting it on would have given
   * the codebase two attribution stores to keep in sync — the exact shape of
   * the bug this campaign exists to remove.
   *
   * Attribution lives on the session's usage-accounting authority, and is
   * tested there (`usage-accounting-authority.test.ts`, `byAgent` / `byKind`)
   * and end to end through the shipped `emitUsage`
   * (`usage-accounting-wire-hellgate.test.ts`).
   *
   * What the LEDGER owes is the property that made the missing attribution
   * dangerous in the first place: a subagent's spend must reach it at all, so a
   * run cannot walk past its cost ceiling by doing the spending inside a child.
   * That is what this test holds.
   */
  test("a subagent's spend reaches the cross-run ledger", () => {
    const ledger = defaultBudgetLedger()
    const parent = {
      llm: { stream: async function* () {} },
      registry: { get: () => undefined, specs: () => [], isReadOnly: () => true },
      stream: { emit: () => undefined },
      permission: { mode: "acceptEdits" },
      messages: [],
      system: "t",
      cwd: process.cwd(),
      maxTurns: 1,
      signal: new AbortController().signal,
      sessionId: "s",
      budgetLedger: ledger,
    } as unknown as AgentConfig
    const child = buildChildConfig(parent, { prompt: "x" } as never, process.cwd(), {
      agentId: "child-1",
      parentId: "root",
    } as never)
    expect(child.budgetLedger).toBe(ledger) // shared, not copied

    const usage = (inputTokens: number) =>
      ({
        type: "usage",
        model: "claude-sonnet-4-6",
        inputTokens,
        outputTokens: 0,
      }) as Extract<LlmStreamEvent, { type: "usage" }>
    emitUsage(parent, usage(1_000_000), undefined, undefined, undefined) // $3
    emitUsage(child, usage(1_000_000), undefined, undefined, undefined) // $3

    expect(ledger.snapshot().totalCost).toBeCloseTo(2 * EVENT_COST, 9)
  })

  // PAIRED CONTROL — session-level rollup works, so the test above is about
  // the CHILD reaching the ledger, not about recording at all.
  test("PAIRED CONTROL: session-level rollup already works (must stay green)", () => {
    const ledger = defaultBudgetLedger()
    ledger.record(event(0))
    ledger.record(event(1, { sessionId: "other" }))
    expect(ledger.snapshot().perSession.get("s")?.totalCost).toBe(EVENT_COST)
    expect(ledger.snapshot().perSession.get("other")?.totalCost).toBe(EVENT_COST)
    expect(SONNET_INPUT_PER_M).toBe(3) // the rate this fixture's arithmetic assumes
  })
})
