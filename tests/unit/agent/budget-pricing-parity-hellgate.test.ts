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

describe("RED #2 — spend is attributable to the agent that incurred it", () => {
  test("spend is attributable to the agent that incurred it", () => {
    // A root turn and a subagent turn, same session. Today `UsageEvent` has no
    // field to tell them apart, so this cast documents the shape MR-02 adds —
    // and the snapshot has no per-agent rollup to read it back from.
    const ledger = defaultBudgetLedger()
    ledger.record({ ...event(0), agentId: "root", agentKind: "root" } as UsageEvent)
    ledger.record({ ...event(1), agentId: "child-1", agentKind: "subagent" } as UsageEvent)

    const snap = ledger.snapshot() as ReturnType<typeof ledger.snapshot> & {
      perAgent?: ReadonlyMap<string, { totalCost: number }>
    }
    expect(snap.totalCost).toBe(2 * EVENT_COST) // both events are billed to the session
    // REDs: `perAgent` does not exist — subagent spend cannot be separated out.
    expect(snap.perAgent?.get("child-1")?.totalCost).toBe(EVENT_COST)
    expect(snap.perAgent?.get("root")?.totalCost).toBe(EVENT_COST)
  })

  // PAIRED CONTROL — session-level rollup already works, so the RED above is
  // about the MISSING agent dimension, not about recording at all.
  test("PAIRED CONTROL: session-level rollup already works (must stay green)", () => {
    const ledger = defaultBudgetLedger()
    ledger.record(event(0))
    ledger.record(event(1, { sessionId: "other" }))
    expect(ledger.snapshot().perSession.get("s")?.totalCost).toBe(EVENT_COST)
    expect(ledger.snapshot().perSession.get("other")?.totalCost).toBe(EVENT_COST)
    expect(SONNET_INPUT_PER_M).toBe(3) // the rate this fixture's arithmetic assumes
  })
})
