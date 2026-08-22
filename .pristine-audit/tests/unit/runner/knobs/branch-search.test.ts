/**
 * Knob: `branch-search` — parse + apply + surface filter.
 *
 * Locks behavior migrated from `parseBenchBranchSearchK` in
 * `src/runner/batch/eval/driver.ts`.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { branchSearchKnob } from "@/runner/knobs/knobs/branch-search"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("branch-search knob — parse", () => {
  test("integer K in [2, 8] ⇒ defaultN=K config block", () => {
    const v2 = branchSearchKnob.parse("2")
    expect(v2?.defaultN).toBe(2)
    expect(v2?.config.defaultN).toBe(2)
    expect(v2?.config.defaultVerifierKinds).toEqual(["tsc"])
    expect(v2?.config.timeoutPerBranchMs).toBe(60_000)
    expect(v2?.config.isolation).toBe("tmpdir")
    expect(branchSearchKnob.parse("8")?.defaultN).toBe(8)
  })

  test("K < 2 (0, 1, -1) ⇒ undefined (1-best ≡ baseline)", () => {
    expect(branchSearchKnob.parse("0")).toBeUndefined()
    expect(branchSearchKnob.parse("1")).toBeUndefined()
    expect(branchSearchKnob.parse("-1")).toBeUndefined()
  })

  test("K > 8 ⇒ undefined (matches slice's zod .max(8))", () => {
    expect(branchSearchKnob.parse("9")).toBeUndefined()
    expect(branchSearchKnob.parse("100")).toBeUndefined()
  })

  test("non-integer / garbage / empty / whitespace ⇒ undefined", () => {
    expect(branchSearchKnob.parse(undefined)).toBeUndefined()
    expect(branchSearchKnob.parse("")).toBeUndefined()
    expect(branchSearchKnob.parse("   ")).toBeUndefined()
    expect(branchSearchKnob.parse("2.5")).toBeUndefined()
    expect(branchSearchKnob.parse("2abc")).toBeUndefined()
    expect(branchSearchKnob.parse("abc")).toBeUndefined()
    expect(branchSearchKnob.parse("1 2")).toBeUndefined()
  })
})

describe("branch-search knob — apply", () => {
  test("bench surface ⇒ cfg.branchSearch set to parsed config", () => {
    const v = branchSearchKnob.parse("4")
    if (v === undefined) throw new Error("parse should have returned a value")
    const out = branchSearchKnob.apply(baseCfg(), v, { surface: "bench" })
    expect(out.branchSearch).toEqual({
      defaultN: 4,
      defaultVerifierKinds: ["tsc"],
      timeoutPerBranchMs: 60_000,
      isolation: "tmpdir",
    })
  })

  test("non-bench surface ⇒ cfg unchanged", () => {
    const v = branchSearchKnob.parse("4")
    if (v === undefined) throw new Error("parse should have returned a value")
    const cfg = baseCfg()
    const out = branchSearchKnob.apply(cfg, v, { surface: "ide" })
    expect(out).toEqual(cfg)
    expect(out.branchSearch).toBeUndefined()
  })
})

describe("branch-search knob — metadata", () => {
  test("conflicts ['localize-phase'] + costMultiplier present", () => {
    expect(branchSearchKnob.id).toBe("branch-search")
    expect(branchSearchKnob.envKey).toBe("QUANTA_BENCH_BRANCH_SEARCH")
    expect(branchSearchKnob.category).toBe("agent")
    expect(branchSearchKnob.conflicts).toEqual(["localize-phase"])
    expect(branchSearchKnob.costMultiplier).toBeGreaterThan(1)
    expect(branchSearchKnob.source).toBe("ADR-0084 / Agentless paper")
  })
})
