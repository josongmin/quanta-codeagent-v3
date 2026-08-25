import { describe, expect, test } from "bun:test"
import { runtimeConfigFromEnv } from "@/shared"

describe("QUANTA_GOAL_JUDGE", () => {
  test("defaults off and accepts only the two named modes", () => {
    expect(runtimeConfigFromEnv({}).goalJudgeMode).toBe("off")
    expect(runtimeConfigFromEnv({ QUANTA_GOAL_JUDGE: "shadow" }).goalJudgeMode).toBe("shadow")
    expect(runtimeConfigFromEnv({ QUANTA_GOAL_JUDGE: "reject" }).goalJudgeMode).toBe("reject")
    expect(runtimeConfigFromEnv({ QUANTA_GOAL_JUDGE: "1" }).goalJudgeMode).toBe("off")
  })
})
