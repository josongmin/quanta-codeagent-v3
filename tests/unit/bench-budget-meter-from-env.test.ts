/**
 * HELLGATE — bench batch budget meter (baseline dials + opt-in cost caps).
 *
 * The bench harness builds its config via `buildConfig`, not the host
 * `assembleAgentConfig`, so the batch preset dials never reached a SWE-bench
 * instance directly. `benchBudgetMeterFromEnv` now mints the canonical batch
 * dials by default, while cost dials stay operator-opt-in via env.
 */
import { describe, expect, test } from "bun:test"
import { BUDGET_PRESETS } from "@/agent"
import { benchBudgetMeterFromEnv } from "../../src/runner/batch/eval/driver"

describe("HELLGATE — bench batch budget meter", () => {
  test("env unset ⇒ batch baseline dials, but NO default cost cap", () => {
    const meter = benchBudgetMeterFromEnv({})
    expect(meter.dials.maxTurns).toBe(BUDGET_PRESETS.batch.maxTurns)
    expect(meter.dials.maxWallClockMs).toBe(BUDGET_PRESETS.batch.maxWallClockMs)
    expect(meter.dials.maxModelCalls).toBe(BUDGET_PRESETS.batch.maxModelCalls)
    expect(meter.dials.maxToolCalls).toBe(BUDGET_PRESETS.batch.maxToolCalls)
    expect(meter.dials.maxShellCommands).toBe(BUDGET_PRESETS.batch.maxShellCommands)
    expect(meter.dials.maxTestRuns).toBe(BUDGET_PRESETS.batch.maxTestRuns)
    expect(meter.dials.maxCostUsd).toBeUndefined()
  })

  test("valid cap ⇒ an ENFORCING meter (cost over cap trips checkExhausted)", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: "1" })
    meter.tick("cost_usd", 2.5) // $2.5 > $1 cap
    const ex = meter.checkExhausted()
    expect(ex.exhausted).toBe(true)
    expect(ex.kind).toBe("cost_usd")
    expect(ex.budget).toBe(1)
  })

  test("fractional cap is honored", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: "0.50" })
    meter.tick("cost_usd", 0.6)
    expect(meter.checkExhausted().exhausted).toBe(true)
  })

  test("under-cap spend does NOT trip", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: "5" })
    meter.tick("cost_usd", 4.99)
    expect(meter.checkExhausted().exhausted).toBe(false)
  })

  test("garbage / non-positive cost env leaves the batch baseline intact", () => {
    for (const bad of ["0", "-1", "abc", "", "  "]) {
      const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_USD: bad })
      expect(meter.dials.maxTurns).toBe(BUDGET_PRESETS.batch.maxTurns)
      expect(meter.dials.maxCostUsd).toBeUndefined()
    }
  })

  test("L3 per-turn cap (QUANTA_BENCH_MAX_COST_PER_TURN_USD) trips on a runaway turn", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_PER_TURN_USD: "0.5" })
    meter.tick("turn")
    meter.tick("cost_usd", 0.6) // one turn > $0.5
    expect(meter.checkExhausted().kind).toBe("cost_per_turn")
  })

  test("per-turn cap ONLY still preserves the batch baseline", () => {
    const meter = benchBudgetMeterFromEnv({ QUANTA_BENCH_MAX_COST_PER_TURN_USD: "2" })
    expect(meter.dials.maxTurns).toBe(BUDGET_PRESETS.batch.maxTurns)
    expect(meter.dials.maxCostPerTurnUsd).toBe(2)
  })

  test("both caps set ⇒ both dials present", () => {
    const meter = benchBudgetMeterFromEnv({
      QUANTA_BENCH_MAX_COST_USD: "5",
      QUANTA_BENCH_MAX_COST_PER_TURN_USD: "1",
    })
    expect(meter.dials.maxCostUsd).toBe(5)
    expect(meter.dials.maxCostPerTurnUsd).toBe(1)
  })
})
