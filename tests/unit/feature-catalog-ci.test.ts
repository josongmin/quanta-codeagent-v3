import { describe, expect, test } from "bun:test"

import { type FcCiSteps, runFcCi } from "../../tools/feature-catalog/cli"
import type { LoadedFeature } from "../../tools/feature-catalog/schema"

const SNAPSHOT = Object.freeze([]) as readonly LoadedFeature[]

const steps = (calls: string[], failAt?: "validate" | "diff" | "lint"): FcCiSteps => ({
  load: async () => {
    calls.push("load")
    return SNAPSHOT
  },
  validate: async (features) => {
    expect(features).toBe(SNAPSHOT)
    calls.push("validate")
    if (failAt === "validate") throw new Error("validate-red")
  },
  diff: async (features) => {
    expect(features).toBe(SNAPSHOT)
    calls.push("diff")
    if (failAt === "diff") throw new Error("diff-red")
  },
  lint: async (features) => {
    expect(features).toBe(SNAPSHOT)
    calls.push("lint")
    if (failAt === "lint") throw new Error("lint-red")
  },
})

describe("feature catalog CI composite", () => {
  test("loads once and gives the same snapshot to validate → diff → lint", async () => {
    const calls: string[] = []
    await runFcCi(steps(calls))
    expect(calls).toEqual(["load", "validate", "diff", "lint"])
  })

  test("fails fast without obscuring the failing step", async () => {
    for (const [failure, expected] of [
      ["validate", ["load", "validate"]],
      ["diff", ["load", "validate", "diff"]],
      ["lint", ["load", "validate", "diff", "lint"]],
    ] as const) {
      const calls: string[] = []
      await expect(runFcCi(steps(calls, failure))).rejects.toThrow(`${failure}-red`)
      expect(calls).toEqual([...expected])
    }
  })
})
