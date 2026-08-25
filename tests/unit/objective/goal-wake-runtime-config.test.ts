import { describe, expect, test } from "bun:test"
import { runtimeConfigFromEnv } from "@/shared"

describe("goal wake runtime policy knobs", () => {
  test("goal continuation and measured budget enforcement default ON", () => {
    const config = runtimeConfigFromEnv({})
    expect(config.goalContinuationEnforce).toBe(true)
    expect(config.objectiveBudgetEnforce).toBe(true)
  })

  test("QUANTA_GOAL=0 opts out unless an internal override is explicit", () => {
    const optedOut = runtimeConfigFromEnv({ QUANTA_GOAL: "0" })
    expect(optedOut.goalContinuationEnforce).toBe(false)
    expect(optedOut.objectiveBudgetEnforce).toBe(false)

    const overridden = runtimeConfigFromEnv({
      QUANTA_GOAL: "0",
      QUANTA_GOAL_ENFORCE: "1",
      QUANTA_OBJECTIVE_BUDGET_ENFORCE: "true",
    })
    expect(overridden.goalContinuationEnforce).toBe(true)
    expect(overridden.objectiveBudgetEnforce).toBe(true)
  })

  test("quiet window clamps to the 15 second production floor", () => {
    expect(runtimeConfigFromEnv({ QUANTA_GOAL_QUIET_MS: "1" }).goalQuietMs).toBe(15_000)
    expect(runtimeConfigFromEnv({ QUANTA_GOAL_QUIET_MS: "45000" }).goalQuietMs).toBe(45_000)
  })

  test("backoff and autonomous-turn cap have bounded defaults and overrides", () => {
    const defaults = runtimeConfigFromEnv({})
    expect(defaults.goalMaxBackoffMs).toBe(900_000)
    expect(defaults.goalMaxAutonomousTurns).toBe(20)
    const configured = runtimeConfigFromEnv({
      QUANTA_GOAL_MAX_BACKOFF_MS: "120000",
      QUANTA_GOAL_MAX_AUTONOMOUS_TURNS: "7",
    })
    expect(configured.goalMaxBackoffMs).toBe(120_000)
    expect(configured.goalMaxAutonomousTurns).toBe(7)
  })
})
