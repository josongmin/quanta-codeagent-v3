import { describe, expect, test } from "bun:test"
import { runtimeConfigFromEnv } from "@/shared"

describe("QUANTA_GOAL_JUDGE", () => {
  test("defaults off, accepts shadow, and the retired reject parses to off (GOAL-02)", () => {
    expect(runtimeConfigFromEnv({}).goalJudgeMode).toBe("off")
    expect(runtimeConfigFromEnv({ QUANTA_GOAL_JUDGE: "shadow" }).goalJudgeMode).toBe("shadow")
    // GOAL-02: an LLM verdict has no admission power; `reject` is not a mode.
    expect(runtimeConfigFromEnv({ QUANTA_GOAL_JUDGE: "reject" }).goalJudgeMode).toBe("off")
    expect(runtimeConfigFromEnv({ QUANTA_GOAL_JUDGE: "1" }).goalJudgeMode).toBe("off")
  })
})
