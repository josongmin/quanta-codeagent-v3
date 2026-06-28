/**
 * HELLGATE — bench per-instance cost cap (L0/L2 reach the bench harness).
 *
 * The bench harness builds its config via `buildConfig`, not the host
 * `assembleAgentConfig`, so the per-run `maxCostUsd` cost cap never reached a
 * SWE-bench instance. `benchBudgetMeterFromEnv` mints a real cost-capped meter
 * from `QUANTA_BENCH_MAX_COST_USD` (operator-supplied, no default), and
 * `buildConfig` threads it into `config.budgetMeter` so emitUsage's cost tick +
 * the turn-epilogue checkExhausted engage. Absent env ⇒ undefined (byte-identical).
 */
import { describe, expect, test } from "bun:test"
import { benchBudgetMeterFromEnv } from "../../src/runner/batch/eval/driver"

describe("HELLGATE — bench per-instance cost cap", () => {
  test("env unset ⇒ undefined (byte-identical default-OFF)", () => {
    expect(benchBudgetMeterFromEnv({})).toBeUndefined()
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

  test("garbage / non-positive ⇒ undefined (no-heuristics, no silent default)", () => {
    for (const bad of ["0", "-1", "abc", "", "  "]) {
      expect(benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: bad })).toBeUndefined()
    }
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
