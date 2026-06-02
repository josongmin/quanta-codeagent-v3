/**
 * Knob: `task-budget` hellgate — parse / apply / surface-filter / metadata +
 * the env → resolve → applyKnobs → `config.taskBudget` integration.
 *
 * Mirrors `branch-search.test.ts` but hardens the SOFT-budget contract:
 *   1. parse accepts ONLY positive integers; rejects 0 / negative / decimal /
 *      Infinity / NaN / garbage / whitespace ⇒ `undefined` (default-OFF).
 *   2. apply is PURE and sets `config.taskBudget = { tokens: N }` on the
 *      knob's surfaces; off-surface ⇒ config untouched (===-equal).
 *   3. resolve(env) → applyKnobs end-to-end lands the budget on AgentConfig so
 *      the loop can forward it; absent env ⇒ empty map ⇒ config === base.
 */
import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { type AnyKnob, applyKnobs, asAnyKnob, resolveKnobs, type Surface } from "@/runner/knobs"
import { taskBudgetKnob } from "@/runner/knobs/knobs/task-budget"

const baseCfg = (): AgentConfig => ({}) as AgentConfig

describe("task-budget knob — parse (positive integer only)", () => {
  test("positive integer ⇒ { tokens: N }", () => {
    expect(taskBudgetKnob.parse("1")).toEqual({ tokens: 1 })
    expect(taskBudgetKnob.parse("100000")).toEqual({ tokens: 100000 })
    expect(taskBudgetKnob.parse("999999999")).toEqual({ tokens: 999999999 })
  })

  test("leading/trailing whitespace is trimmed then parsed", () => {
    expect(taskBudgetKnob.parse("  50000  ")).toEqual({ tokens: 50000 })
  })

  test("zero ⇒ undefined (no meaningful budget — byte-identical default-OFF)", () => {
    expect(taskBudgetKnob.parse("0")).toBeUndefined()
    expect(taskBudgetKnob.parse("00")).toBeUndefined()
  })

  test("negative ⇒ undefined", () => {
    expect(taskBudgetKnob.parse("-1")).toBeUndefined()
    expect(taskBudgetKnob.parse("-100000")).toBeUndefined()
  })

  test("non-integer / scientific / hex ⇒ undefined", () => {
    expect(taskBudgetKnob.parse("1.5")).toBeUndefined()
    expect(taskBudgetKnob.parse("1e3")).toBeUndefined()
    expect(taskBudgetKnob.parse("0x10")).toBeUndefined()
    expect(taskBudgetKnob.parse("1_000")).toBeUndefined()
  })

  test("Infinity / NaN / garbage / empty / whitespace ⇒ undefined", () => {
    expect(taskBudgetKnob.parse("Infinity")).toBeUndefined()
    expect(taskBudgetKnob.parse("NaN")).toBeUndefined()
    expect(taskBudgetKnob.parse("abc")).toBeUndefined()
    expect(taskBudgetKnob.parse("100abc")).toBeUndefined()
    expect(taskBudgetKnob.parse("1 2")).toBeUndefined()
    expect(taskBudgetKnob.parse("")).toBeUndefined()
    expect(taskBudgetKnob.parse("   ")).toBeUndefined()
    expect(taskBudgetKnob.parse(undefined)).toBeUndefined()
  })
})

describe("task-budget knob — apply (pure, surface-gated)", () => {
  for (const surface of ["cli", "agent-batch", "agent-interactive"] as const) {
    test(`${surface} surface ⇒ cfg.taskBudget set, base not mutated`, () => {
      const v = taskBudgetKnob.parse("80000")
      if (v === undefined) throw new Error("parse should have returned a value")
      const cfg = baseCfg()
      const out = taskBudgetKnob.apply(cfg, v, { surface })
      expect(out.taskBudget).toEqual({ tokens: 80000 })
      // Purity: base config object is untouched (new object returned).
      expect(cfg.taskBudget).toBeUndefined()
      expect(out).not.toBe(cfg)
    })
  }

  for (const surface of ["bench", "ide"] as const) {
    test(`${surface} surface (off-list) ⇒ cfg unchanged (===-equal)`, () => {
      const v = taskBudgetKnob.parse("80000")
      if (v === undefined) throw new Error("parse should have returned a value")
      const cfg = baseCfg()
      const out = taskBudgetKnob.apply(cfg, v, { surface })
      expect(out).toBe(cfg)
      expect(out.taskBudget).toBeUndefined()
    })
  }
})

describe("task-budget knob — metadata", () => {
  test("stable id / env key / category / surfaces / source", () => {
    expect(taskBudgetKnob.id).toBe("task-budget")
    expect(taskBudgetKnob.envKey).toBe("QUANTA_TASK_BUDGET")
    expect(taskBudgetKnob.category).toBe("hint")
    expect([...taskBudgetKnob.surfaces].sort()).toEqual(["agent-batch", "agent-interactive", "cli"])
    // No default ⇒ default-OFF (absent env never activates it).
    expect(taskBudgetKnob.default).toBeUndefined()
    // Soft guidance: no extra trajectories.
    expect(taskBudgetKnob.costMultiplier).toBe(1)
  })
})

describe("task-budget knob — env → resolve → applyKnobs integration", () => {
  // Build a local surface-filtered map from the knob instance directly so this
  // block is independent of the global registry (which other suites reset).
  const surface: Surface = "cli"
  const knobs: ReadonlyMap<string, AnyKnob> = new Map([
    [taskBudgetKnob.id, asAnyKnob(taskBudgetKnob)],
  ])

  test("QUANTA_TASK_BUDGET=120000 ⇒ config.taskBudget = { tokens: 120000 }", () => {
    const values = resolveKnobs({
      surface,
      knobs,
      envVars: { QUANTA_TASK_BUDGET: "120000" } as NodeJS.ProcessEnv,
    })
    const out = applyKnobs(baseCfg(), knobs, values, { surface })
    expect(out.taskBudget).toEqual({ tokens: 120000 })
  })

  test("absent env ⇒ knob inactive ⇒ applyKnobs returns base byte-identical", () => {
    const values = resolveKnobs({ surface, knobs, envVars: {} as NodeJS.ProcessEnv })
    const base = baseCfg()
    const out = applyKnobs(base, knobs, values, { surface })
    expect(out).toBe(base)
    expect(out.taskBudget).toBeUndefined()
  })

  test("QUANTA_TASK_BUDGET=0 ⇒ rejected at parse ⇒ config untouched", () => {
    const values = resolveKnobs({
      surface,
      knobs,
      envVars: { QUANTA_TASK_BUDGET: "0" } as NodeJS.ProcessEnv,
    })
    const base = baseCfg()
    const out = applyKnobs(base, knobs, values, { surface })
    expect(out).toBe(base)
    expect(out.taskBudget).toBeUndefined()
  })
})
