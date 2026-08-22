/**
 * HELLGATE — bench per-instance cost cap (L0/L2/L3 reach the bench harness),
 * DEFAULT-OFF byte-identical.
 *
 * The bench harness builds its config via `buildConfig`, not the host
 * `assembleAgentConfig`, so the per-run cost caps never reached a SWE-bench
 * instance. `benchBudgetMeterFromEnv` mints a real meter ONLY when an operator
 * opts into a cost ceiling (`QUANTA_BENCH_MAX_COST_USD` /
 * `QUANTA_BENCH_MAX_COST_PER_TURN_USD`); absent any cap it returns `undefined`
 * ⇒ no meter ⇒ byte-identical (the bench loop acquires NO always-on
 * turn/wallclock/consecutive-failure caps that could abort a hard instance
 * mid-solve and confound the measurement). When a cap IS opted in, the meter
 * also carries the canonical batch dials so the capped run is fully bounded.
 */
import { describe, expect, test } from "bun:test"
import { BUDGET_PRESETS } from "@/agent"
import { benchBudgetMeterFromEnv } from "../../src/runner/batch/eval/driver"

describe("HELLGATE — bench per-instance cost cap (default-OFF)", () => {
  test("env unset ⇒ undefined (byte-identical default-OFF: NO always-on dials)", () => {
    // REGRESSION GUARD: minting a meter here would silently impose batch
    // maxTurns/maxWallClockMs/maxConsecutiveFailures/call caps on EVERY bench
    // run, aborting legitimate hard-instance repair trajectories as real misses.
    expect(benchBudgetMeterFromEnv({})).toBeUndefined()
  })

  test("garbage / non-positive cost env ⇒ undefined (no-heuristics, no silent default)", () => {
    for (const bad of ["0", "-1", "abc", "", "  "]) {
      expect(benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: bad })).toBeUndefined()
    }
  })

  test("valid cap ⇒ an ENFORCING meter (cost over cap trips checkExhausted)", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: "1" })
    expect(meter).toBeDefined()
    meter?.tick("cost_usd", 2.5) // $2.5 > $1 cap
    const ex = meter?.checkExhausted()
    expect(ex?.exhausted).toBe(true)
    expect(ex?.kind).toBe("cost_usd")
    expect(ex?.budget).toBe(1)
  })

  test("opting into a cap ALSO bounds the run with the canonical batch dials", () => {
    // Once a meter exists (operator opt-in), it should be fully bounded — but the
    // preset's default dollar cap is stripped (only the explicit cost env caps cost).
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: "5" })
    expect(meter?.dials.maxTurns).toBe(BUDGET_PRESETS.batch.maxTurns)
    expect(meter?.dials.maxWallClockMs).toBe(BUDGET_PRESETS.batch.maxWallClockMs)
    expect(meter?.dials.maxConsecutiveFailures).toBe(BUDGET_PRESETS.batch.maxConsecutiveFailures)
    expect(meter?.dials.maxCostUsd).toBe(5) // operator value, NOT the preset default
  })

  test("fractional cap is honored", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: "0.50" })
    meter?.tick("cost_usd", 0.6)
    expect(meter?.checkExhausted().exhausted).toBe(true)
  })

  test("under-cap spend does NOT trip", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: "5" })
    meter?.tick("cost_usd", 4.99)
    expect(meter?.checkExhausted().exhausted).toBe(false)
  })

  test("L3 per-turn cap (QUANTA_BENCH_MAX_COST_PER_TURN_USD) trips on a runaway turn", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_PER_TURN_USD: "0.5" })
    expect(meter).toBeDefined()
    meter?.tick("turn")
    meter?.tick("cost_usd", 0.6) // one turn > $0.5
    expect(meter?.checkExhausted().kind).toBe("cost_per_turn")
  })

  test("per-turn cap ONLY (no cumulative) still mints a meter", () => {
    expect(benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_PER_TURN_USD: "2" })).toBeDefined()
  })

  test("both caps set ⇒ both dials present", () => {
    const meter = benchBudgetMeterFromEnv({
      QUANTA_BENCH_MAX_COST_USD: "5",
      QUANTA_BENCH_MAX_COST_PER_TURN_USD: "1",
    })
    expect(meter?.dials.maxCostUsd).toBe(5)
    expect(meter?.dials.maxCostPerTurnUsd).toBe(1)
  })
})
