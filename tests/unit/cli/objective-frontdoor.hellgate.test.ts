import { describe, expect, test } from "bun:test"
import { goalCmd } from "@/apps/cli/slash/goal-cmd"
import { buildGoalControl, objectiveCmd } from "@/apps/cli/slash/objective"
import { buildSessionSlashCommands } from "@/apps/cli/slash/registry-session"
import { buildSurfaceSlashCommands } from "@/apps/cli/slash/registry-surface"
import type { SlashCommand, SlashContext } from "@/apps/cli/slash-contract"
import { applyGoalPreset, createObjectiveAuthority } from "@/objective"

const withGoalEnv = <T>(value: string | undefined, fn: () => T): T => {
  const prior = process.env.QUANTA_GOAL
  if (value === undefined) delete process.env.QUANTA_GOAL
  else process.env.QUANTA_GOAL = value
  try {
    return fn()
  } finally {
    if (prior === undefined) delete process.env.QUANTA_GOAL
    else process.env.QUANTA_GOAL = prior
  }
}

const names = (): string[] =>
  [
    ...buildSessionSlashCommands(),
    ...buildSurfaceSlashCommands((): readonly SlashCommand[] => []),
  ].map((command) => command.name)

describe("QUANTA_GOAL public gate", () => {
  test("unset exposes /goal and its deprecated /objective alias by default", () => {
    withGoalEnv(undefined, () => {
      expect(names()).toContain("/goal")
      expect(names()).toContain("/objective")
    })
  })
  test("explicit off removes both commands from discovery", () => {
    withGoalEnv("0", () => {
      expect(names()).not.toContain("/goal")
      expect(names()).not.toContain("/objective")
    })
  })
  test("preset seeds only unset internal gates", () => {
    const env: NodeJS.ProcessEnv = { QUANTA_GOAL: "1", QUANTA_GOAL_ENFORCE: "0" }
    applyGoalPreset(env, true)
    expect(env.QUANTA_OBJECTIVE_TOOLS).toBe("1")
    expect(env.QUANTA_OBJECTIVE_BUDGET_ENFORCE).toBe("1")
    expect(env.QUANTA_GOAL_ENFORCE).toBe("0")
  })
})

describe("/objective delegates to the same control", () => {
  test("pause produces the same authority transition as /goal", async () => {
    const authority = createObjectiveAuthority({})
    const control = buildGoalControl(authority, "t")
    const output: string[] = []
    const ctx: SlashContext = {
      cwd: "/tmp",
      out: (text) => output.push(text),
      err: (text) => output.push(text),
      objectiveEditor: control,
    }
    await goalCmd.run(["one"], ctx)
    expect(await objectiveCmd.run(["pause"], ctx)).toBe(0)
    expect(authority.get("t")?.status).toBe("paused")
    expect(await goalCmd.run(["resume"], ctx)).toBe(0)
    expect(await goalCmd.run(["pause"], ctx)).toBe(0)
    expect(authority.get("t")?.status).toBe("paused")
  })
})
