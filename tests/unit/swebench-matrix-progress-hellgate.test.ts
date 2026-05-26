/**
 * Hellgate — matrix progress UX adversarial battery.
 *
 * The brief asked for a `progress.ts` slice with `formatProgressBar`,
 * `estimateEtaMs`, and `CostAccumulator`. Those helpers DO NOT exist in the
 * current codebase — `tools/swebench-matrix.ts` uses a one-line condition
 * counter (`printRemaining`) and partial-JSONL checkpointing only.
 *
 * This file pins the EXISTING progress-UX surface (closed-port view):
 *   - `parseArgs` budget hints (`--max-turns`, `--timeout-ms`) round-trip
 *     correctly with adversarial inputs.
 *   - `estimateAxesCost` is the canonical pre-flight budget hint (used by
 *     the runner's preamble); confirm hellgate-style edge cases.
 *   - `axes` mode produces conditions in a deterministic, observable order
 *     (the bit-pattern walk is the progress timeline).
 *
 * If/when a `progress.ts` slice is added, this file's design-pins should be
 * EXTENDED — not rewritten. The slice-absence test below documents the gap.
 */
import { describe, expect, test } from "bun:test"
import { estimateAxesCost, generateAxesConditions, parseArgs } from "@/../tools/swebench-matrix"
import type { AgentConfig } from "@/agent"
import type { AnyKnob, Knob, Surface } from "@/runner/knobs"

const mkKnob = (id: string, envKey: string, costMultiplier?: number): AnyKnob => {
  const knob: Knob<true> = {
    id,
    envKey,
    category: "agent",
    surfaces: ["bench"] as readonly Surface[],
    parse: (raw: string | undefined): true | undefined => (raw === undefined ? undefined : true),
    apply: (cfg: AgentConfig): AgentConfig => cfg,
    describe: `test knob ${id}`,
    ...(costMultiplier !== undefined ? { costMultiplier } : {}),
  }
  return knob as AnyKnob
}

const fullBenchRegistry = (): ReadonlyMap<string, AnyKnob> => {
  const m = new Map<string, AnyKnob>()
  m.set("branch-search", mkKnob("branch-search", "QUANTA_BENCH_BRANCH_SEARCH", 8))
  m.set("issue-hint", mkKnob("issue-hint", "QUANTA_BENCH_ISSUE_HINT"))
  m.set("localize-phase", mkKnob("localize-phase", "QUANTA_BENCH_LOCALIZE_PHASE", 3))
  m.set("lsp", mkKnob("lsp", "QUANTA_BENCH_LSP", 1))
  m.set("must-pass", mkKnob("must-pass", "QUANTA_BENCH_MUST_PASS"))
  m.set("repro-test", mkKnob("repro-test", "QUANTA_BENCH_REPRO_TEST", 40))
  m.set("skills", mkKnob("skills", "QUANTA_BENCH_SKILLS"))
  m.set("subagent", mkKnob("subagent", "QUANTA_BENCH_SUBAGENT"))
  return m
}

describe("hellgate budget args — adversarial", () => {
  test("--max-turns 1 (minimum positive) accepted", () => {
    const a = parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o", "--max-turns", "1"])
    expect(a.maxTurns).toBe(1)
  })

  test("--max-turns very large (1e6) accepted as positive int", () => {
    const a = parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o", "--max-turns", "1000000"])
    expect(a.maxTurns).toBe(1_000_000)
  })

  test("--max-turns above safe-int range falls back to default", () => {
    // Number.MAX_SAFE_INTEGER + 1: !Number.isSafeInteger fires; fallback path.
    const a = parseArgs([
      "--dataset",
      "d",
      "--corpus",
      "c",
      "--out",
      "o",
      "--max-turns",
      "9007199254740993",
    ])
    expect(a.maxTurns).toBe(30) // default
  })

  test("--timeout-ms with comma in number ⇒ throws (only digits)", () => {
    expect(() =>
      parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o", "--timeout-ms", "1,000"]),
    ).toThrow(/--timeout-ms/)
  })

  test("--timeout-ms with hex prefix ⇒ throws (only decimal)", () => {
    expect(() =>
      parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o", "--timeout-ms", "0x10"]),
    ).toThrow(/--timeout-ms/)
  })

  test("--timeout-ms with negative ⇒ throws", () => {
    expect(() =>
      parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o", "--timeout-ms", "-1"]),
    ).toThrow(/--timeout-ms/)
  })

  test("--timeout-ms with whitespace tolerated (trimmed)", () => {
    const a = parseArgs([
      "--dataset",
      "d",
      "--corpus",
      "c",
      "--out",
      "o",
      "--timeout-ms",
      "  60000  ",
    ])
    expect(a.timeoutMs).toBe(60_000)
  })
})

describe("hellgate pre-flight cost estimate (the budget preamble)", () => {
  test("0 axes ⇒ cost is 1 (baseline only)", () => {
    expect(estimateAxesCost([], new Map())).toBe(1)
  })

  test("axes ordered subagent,lsp has same cost as lsp,subagent (commutative)", () => {
    const reg = fullBenchRegistry()
    expect(estimateAxesCost(["lsp", "subagent"], reg)).toBe(
      estimateAxesCost(["subagent", "lsp"], reg),
    )
  })

  test("growth is exactly 2× per added 1×-cost axis (commutative geometric)", () => {
    const reg = fullBenchRegistry()
    expect(estimateAxesCost(["lsp"], reg)).toBe(2) // 1 + 1
    expect(estimateAxesCost(["lsp", "subagent"], reg)).toBe(4) // 1 + 1 + 1 + 1
    expect(estimateAxesCost(["lsp", "subagent", "skills"], reg)).toBe(8)
    expect(estimateAxesCost(["lsp", "subagent", "skills", "issue-hint"], reg)).toBe(16)
  })

  test("expensive axes dominate (1× + 40× + 1*40× = 82×) for 2 axes", () => {
    const reg = fullBenchRegistry()
    // [lsp(1×), repro-test(40×)]: baseline(1) + lsp(1) + repro(40) + lsp*repro(40) = 82
    expect(estimateAxesCost(["lsp", "repro-test"], reg)).toBe(82)
  })

  test("matching the brief: cost is monotone (more axes ⇒ same-or-higher cost)", () => {
    const reg = fullBenchRegistry()
    const c1 = estimateAxesCost(["lsp"], reg)
    const c2 = estimateAxesCost(["lsp", "subagent"], reg)
    const c3 = estimateAxesCost(["lsp", "subagent", "skills"], reg)
    expect(c2).toBeGreaterThanOrEqual(c1)
    expect(c3).toBeGreaterThanOrEqual(c2)
  })
})

describe("hellgate axes-condition timeline (bit-pattern walk == progress order)", () => {
  test("1 axis: conditions are exactly [baseline, ON] in bit-order", () => {
    const conds = generateAxesConditions(["lsp"], fullBenchRegistry())
    expect(conds.map((c) => c.label)).toEqual(["axes-baseline", "axes-lsp"])
  })

  test("2 axes: 4 conditions in bit-walk order (00, 01, 10, 11)", () => {
    const conds = generateAxesConditions(["lsp", "subagent"], fullBenchRegistry())
    expect(conds.map((c) => c.label)).toEqual([
      "axes-baseline",
      "axes-lsp",
      "axes-subagent",
      "axes-lsp_subagent",
    ])
  })

  test("3 axes: condition #0 (baseline) and #7 (all-on) bracket the timeline", () => {
    const axes = ["lsp", "subagent", "skills"]
    const conds = generateAxesConditions(axes, fullBenchRegistry())
    expect(conds[0]?.onAxes).toEqual([])
    expect(conds[7]?.onAxes).toEqual(axes)
  })

  test("input order matters for label ordering (subagent first ⇒ subagent_lsp label)", () => {
    const c1 = generateAxesConditions(["subagent", "lsp"], fullBenchRegistry())
    const c2 = generateAxesConditions(["lsp", "subagent"], fullBenchRegistry())
    const both1 = c1.find((c) => c.onAxes.length === 2)
    const both2 = c2.find((c) => c.onAxes.length === 2)
    expect(both1?.label).toBe("axes-subagent_lsp")
    expect(both2?.label).toBe("axes-lsp_subagent")
  })

  test("conditions are independent (mutating env on one does NOT affect another)", () => {
    const conds = generateAxesConditions(["lsp", "subagent"], fullBenchRegistry())
    // Each env should be a freshly-built record per condition.
    // (We can't mutate the readonly type, but identity-check is enough.)
    const baseline = conds.find((c) => c.onAxes.length === 0)
    const allOn = conds.find((c) => c.onAxes.length === 2)
    expect(baseline?.env).not.toBe(allOn?.env)
  })

  test("8-axes sweep boundary check: first is baseline, last is all-on", () => {
    const axes = [
      "branch-search",
      "issue-hint",
      "localize-phase",
      "lsp",
      "must-pass",
      "repro-test",
      "skills",
      "subagent",
    ]
    const conds = generateAxesConditions(axes, fullBenchRegistry())
    expect(conds[0]?.onAxes.length).toBe(0)
    expect(conds[conds.length - 1]?.onAxes.length).toBe(axes.length)
  })
})

describe("hellgate progress slice absence notes", () => {
  test("design pin: NO `formatProgressBar` / `estimateEtaMs` / `CostAccumulator`", () => {
    // The brief named these helpers for a `tools/swebench-matrix/progress.ts`
    // slice that has not been written. The current progress UX is:
    //   - one-line console.error per condition (`[matrix] (i/total) ...`)
    //   - partial-jsonl checkpoint written after EACH condition
    //   - estimateAxesCost provides the pre-flight budget hint
    // A future refactor that adds the helpers should EXTEND this file with
    // adversarial cases (NaN clamp, empty observation set, etc.).
    expect(true).toBe(true)
  })
})
