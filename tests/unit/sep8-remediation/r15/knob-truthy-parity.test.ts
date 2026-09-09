import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { knobsForReport, resolveBenchKnobs } from "@/runner/batch/eval/knobs-bench"
import "@/runner/knobs/knobs"
import { __resetRuntimeConfig, gateOn, isTruthyToken, runtimeConfig } from "@/shared"

describe("E-KNOB-01 boolean vocabulary parity", () => {
  test("source parsers delegate to isTruthyToken and have no local ENABLING set", () => {
    for (const file of ["read-outline.ts", "test-runner.ts"]) {
      const src = readFileSync(join(process.cwd(), "src/runner/knobs/knobs", file), "utf8")
      expect(src).toContain("isTruthyToken")
      expect(src).not.toContain("ENABLING")
    }
  })

  test("canonical tokens match runtimeConfig gate and bench report", () => {
    const truthy = ["1", "on", "true", "yes", " YES "] as const
    const falsy = ["0", "off", "false", "no"] as const
    for (const raw of truthy) {
      expect(isTruthyToken(raw)).toBe(true)
    }
    for (const raw of falsy) {
      expect(isTruthyToken(raw)).toBe(false)
    }
    expect(isTruthyToken("maybe")).toBe(false)

    const prevOutline = process.env.QUANTA_READ_OUTLINE
    const prevRunner = process.env.QUANTA_TEST_RUNNER
    try {
      process.env.QUANTA_READ_OUTLINE = "yes"
      process.env.QUANTA_TEST_RUNNER = "yes"
      __resetRuntimeConfig()
      expect(runtimeConfig().readOutline).toBe(true)
      expect(runtimeConfig().testRunner).toBe(true)
      expect(gateOn({ QUANTA_READ_OUTLINE: "yes" }, "QUANTA_READ_OUTLINE")).toBe(true)

      const state = resolveBenchKnobs({
        envVars: { QUANTA_READ_OUTLINE: "yes", QUANTA_TEST_RUNNER: "yes" },
      })
      const report = knobsForReport(state)
      expect(report["read-outline"]?.value).toBe(true)
      expect(report["test-runner"]?.value).toBe(true)
    } finally {
      if (prevOutline === undefined) delete process.env.QUANTA_READ_OUTLINE
      else process.env.QUANTA_READ_OUTLINE = prevOutline
      if (prevRunner === undefined) delete process.env.QUANTA_TEST_RUNNER
      else process.env.QUANTA_TEST_RUNNER = prevRunner
      __resetRuntimeConfig()
    }
  })

  test("removing yes from the knob parser would drop it from the bench report rail", () => {
    const src = readFileSync(join(process.cwd(), "src/runner/knobs/knobs/read-outline.ts"), "utf8")
    expect(src).toContain("isTruthyToken(raw)")
    const mutated = src.replace(
      "isTruthyToken(raw) ? true : undefined",
      'new Set(["1", "on", "true"]).has((raw ?? "").trim().toLowerCase()) ? true : undefined',
    )
    expect(mutated).not.toBe(src)
    expect(mutated).not.toContain("isTruthyToken(raw)")
    const legacyParse = (raw: string | undefined): true | undefined =>
      new Set(["1", "on", "true"]).has((raw ?? "").trim().toLowerCase()) ? true : undefined
    expect(legacyParse("yes")).toBeUndefined()
    const state = resolveBenchKnobs({ envVars: { QUANTA_READ_OUTLINE: "yes" } })
    expect(knobsForReport(state)["read-outline"]?.display).toBe("on")
    expect(knobsForReport(state)["read-outline"]?.value).toBe(true)
    expect(knobsForReport(state)["read-outline"]?.value).not.toBe(legacyParse("yes") === true)
  })
})
