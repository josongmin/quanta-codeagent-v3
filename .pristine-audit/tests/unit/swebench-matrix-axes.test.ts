/**
 * Unit tests for `tools/swebench-matrix.ts` `--axes` mode + supporting helpers.
 *
 * Scope: pure CLI/argv parsing, axes generation, ON-value mapping, conflict
 * surfacing, mutually-exclusive flag enforcement, cost estimation. The bench
 * spawn itself is NOT exercised (it requires an LLM) — the legacy
 * `tests/unit/swebench-matrix.test.ts` covers the on-disk parser surface.
 *
 * Test isolation: the tests pass a HAND-BUILT registry map to
 * `generateAxesConditions` / `estimateAxesCost` (the DI seam these helpers
 * expose). This avoids the global `knobsForSurface("bench")` registry
 * entirely, which is fragile under hellgate-style `__resetRegistry()`
 * suites that may run concurrently in the same `bun test` invocation.
 *
 * Legacy `--conditions` mode MUST remain byte-identical — this file does not
 * touch that mode beyond `parseArgs` interaction tests (mutually exclusive).
 */
import { describe, expect, test } from "bun:test"
import {
  AXIS_ON_VALUES,
  estimateAxesCost,
  generateAxesConditions,
  parseArgs,
  parseAxes,
} from "@/../tools/swebench-matrix"
import type { AgentConfig } from "@/agent"
import type { AnyKnob, Knob, Surface } from "@/runner/knobs"

/** Build a synthetic bench-knob registry for tests — no global state touched. */
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

const mockBenchRegistry = (): ReadonlyMap<string, AnyKnob> => {
  const m = new Map<string, AnyKnob>()
  // Mirror the real bench-surface set: 8 knobs (the 4 non-bench knobs are
  // excluded from `knobsForSurface("bench")` in production).
  m.set("branch-search", mkKnob("branch-search", "QUANTA_BENCH_BRANCH_SEARCH", 8))
  m.set("issue-hint", mkKnob("issue-hint", "QUANTA_BENCH_ISSUE_HINT"))
  m.set("localize-phase", mkKnob("localize-phase", "QUANTA_BENCH_LOCALIZE_PHASE"))
  m.set("lsp", mkKnob("lsp", "QUANTA_BENCH_LSP", 1))
  m.set("must-pass", mkKnob("must-pass", "QUANTA_BENCH_MUST_PASS"))
  m.set("repro-test", mkKnob("repro-test", "QUANTA_BENCH_REPRO_TEST", 40))
  m.set("skills", mkKnob("skills", "QUANTA_BENCH_SKILLS"))
  m.set("subagent", mkKnob("subagent", "QUANTA_BENCH_SUBAGENT"))
  return m
}

describe("parseAxes", () => {
  test("undefined ⇒ undefined (not in axes mode)", () => {
    expect(parseAxes(undefined)).toBeUndefined()
  })

  test("empty / whitespace-only string ⇒ throws", () => {
    expect(() => parseAxes("")).toThrow(/non-empty/)
    expect(() => parseAxes("   ")).toThrow(/non-empty/)
  })

  test("only commas / blanks ⇒ throws (no axes parsed)", () => {
    expect(() => parseAxes(",,,")).toThrow(/at least one/)
  })

  test("single axis", () => {
    expect(parseAxes("lsp")).toEqual(["lsp"])
  })

  test("multi-axis preserves caller order", () => {
    expect(parseAxes("subagent,lsp,skills")).toEqual(["subagent", "lsp", "skills"])
  })

  test("dedupes duplicates while preserving first-seen order", () => {
    expect(parseAxes("lsp,subagent,lsp")).toEqual(["lsp", "subagent"])
  })

  test("trims whitespace around tokens", () => {
    expect(parseAxes(" lsp , subagent ")).toEqual(["lsp", "subagent"])
  })
})

describe("AXIS_ON_VALUES table", () => {
  test("covers exactly the 12 framework knob ids", () => {
    const keys = Object.keys(AXIS_ON_VALUES).sort()
    expect(keys).toEqual([
      "branch-search",
      "closeout-guard",
      "hooks",
      "issue-hint",
      "localize-phase",
      "lsp",
      "must-pass",
      "persona",
      "repro-test",
      "skills",
      "subagent",
      "working-state",
    ])
  })

  test("ON values are non-empty strings", () => {
    for (const [id, raw] of Object.entries(AXIS_ON_VALUES)) {
      expect(typeof raw).toBe("string")
      expect(raw.length).toBeGreaterThan(0)
      expect(raw).not.toMatch(/\s/)
      void id
    }
  })

  test("specific canonical values pinned by the brief", () => {
    expect(AXIS_ON_VALUES.lsp).toBe("1")
    expect(AXIS_ON_VALUES.subagent).toBe("1")
    expect(AXIS_ON_VALUES.skills).toBe("1")
    expect(AXIS_ON_VALUES["localize-phase"]).toBe("3")
    expect(AXIS_ON_VALUES["branch-search"]).toBe("3")
    expect(AXIS_ON_VALUES["issue-hint"]).toBe("1")
    expect(AXIS_ON_VALUES["repro-test"]).toBe("5")
    expect(AXIS_ON_VALUES["must-pass"]).toBe("strict")
    expect(AXIS_ON_VALUES.persona).toBe("pragmatic")
    expect(AXIS_ON_VALUES["working-state"]).toBe("on")
    expect(AXIS_ON_VALUES["closeout-guard"]).toBe("on")
    expect(AXIS_ON_VALUES.hooks).toBe("on")
  })
})

describe("generateAxesConditions (DI test seam)", () => {
  test("0 axes ⇒ 1 condition (baseline, empty env) — does NOT touch registry", () => {
    const conds = generateAxesConditions([])
    expect(conds.length).toBe(1)
    const baseline = conds[0]
    if (baseline === undefined) throw new Error("missing baseline")
    expect(baseline.label).toBe("axes-baseline")
    expect(baseline.env).toEqual({})
    expect(baseline.onAxes).toEqual([])
  })

  test("1 axis ⇒ 2 conditions; ON env carries the canonical literal", () => {
    const conds = generateAxesConditions(["lsp"], mockBenchRegistry())
    expect(conds.length).toBe(2)
    const labels = conds.map((c) => c.label)
    expect(labels).toContain("axes-baseline")
    expect(labels).toContain("axes-lsp")
    const onCond = conds.find((c) => c.label === "axes-lsp")
    if (onCond === undefined) throw new Error("missing lsp on")
    expect(onCond.env).toEqual({ QUANTA_BENCH_LSP: "1" })
    expect(onCond.onAxes).toEqual(["lsp"])
  })

  test("2 axes ⇒ 4 conditions; each ON has the right env overlay", () => {
    const conds = generateAxesConditions(["lsp", "subagent"], mockBenchRegistry())
    expect(conds.length).toBe(4)
    const byLabel = new Map(conds.map((c) => [c.label, c]))
    expect(byLabel.get("axes-baseline")?.env).toEqual({})
    expect(byLabel.get("axes-lsp")?.env).toEqual({ QUANTA_BENCH_LSP: "1" })
    expect(byLabel.get("axes-subagent")?.env).toEqual({ QUANTA_BENCH_SUBAGENT: "1" })
    expect(byLabel.get("axes-lsp_subagent")?.env).toEqual({
      QUANTA_BENCH_LSP: "1",
      QUANTA_BENCH_SUBAGENT: "1",
    })
  })

  test("3 axes ⇒ 8 conditions (2^N matches)", () => {
    const conds = generateAxesConditions(["lsp", "subagent", "branch-search"], mockBenchRegistry())
    expect(conds.length).toBe(8)
    for (const c of conds) expect(c.label.startsWith("axes-")).toBe(true)
  })

  test("OFF axes never appear in env overlay (default-OFF byte-identical)", () => {
    const conds = generateAxesConditions(["lsp", "subagent"], mockBenchRegistry())
    const baseline = conds.find((c) => c.label === "axes-baseline")
    if (baseline === undefined) throw new Error("missing baseline")
    expect(Object.hasOwn(baseline.env, "QUANTA_BENCH_LSP")).toBe(false)
    expect(Object.hasOwn(baseline.env, "QUANTA_BENCH_SUBAGENT")).toBe(false)
  })

  test("unknown axis ⇒ throws", () => {
    expect(() => generateAxesConditions(["nonexistent"], mockBenchRegistry())).toThrow(
      /unknown axis/,
    )
  })

  test("known but no ON value entry ⇒ throws (defensive — registry/table drift)", () => {
    expect(() => generateAxesConditions(["unregistered-knob-id"], mockBenchRegistry())).toThrow(
      /unknown axis/,
    )
  })

  test("conflict knobs (localize-phase + branch-search) BOTH present ⇒ generation succeeds; conflict surfaces downstream", () => {
    const conds = generateAxesConditions(["localize-phase", "branch-search"], mockBenchRegistry())
    expect(conds.length).toBe(4)
    const both = conds.find(
      (c) => c.onAxes.includes("localize-phase") && c.onAxes.includes("branch-search"),
    )
    if (both === undefined) throw new Error("expected the both-ON condition to be present")
    expect(both.env.QUANTA_BENCH_LOCALIZE_PHASE).toBe("3")
    expect(both.env.QUANTA_BENCH_BRANCH_SEARCH).toBe("3")
  })

  test("only bench-surface axes are accepted; non-bench knob (working-state) throws", () => {
    // working-state / hooks / persona / closeout-guard are NOT bench-surface
    // (in the real registry their `surfaces` arrays exclude "bench").
    // Our mock bench registry includes only the 8 bench-surface knobs;
    // attempting to use a non-bench axis throws "unknown axis".
    expect(() => generateAxesConditions(["working-state"], mockBenchRegistry())).toThrow(
      /unknown axis/,
    )
    expect(() => generateAxesConditions(["hooks"], mockBenchRegistry())).toThrow(/unknown axis/)
    expect(() => generateAxesConditions(["persona"], mockBenchRegistry())).toThrow(/unknown axis/)
    expect(() => generateAxesConditions(["closeout-guard"], mockBenchRegistry())).toThrow(
      /unknown axis/,
    )
  })

  test("all 8 bench-surface axes ⇒ 256 conditions (2^8)", () => {
    const bench = [
      "branch-search",
      "issue-hint",
      "localize-phase",
      "lsp",
      "must-pass",
      "repro-test",
      "skills",
      "subagent",
    ]
    const conds = generateAxesConditions(bench, mockBenchRegistry())
    expect(conds.length).toBe(256)
  })

  test("13 axes ⇒ throws (hard cap is 12)", () => {
    const fake = [
      "branch-search",
      "issue-hint",
      "localize-phase",
      "lsp",
      "must-pass",
      "repro-test",
      "skills",
      "subagent",
      "x1",
      "x2",
      "x3",
      "x4",
      "x5",
    ]
    expect(() => generateAxesConditions(fake, mockBenchRegistry())).toThrow(/hard cap/)
  })
})

describe("estimateAxesCost (DI test seam)", () => {
  test("0 axes ⇒ 1 (the baseline counts as 1)", () => {
    expect(estimateAxesCost([], mockBenchRegistry())).toBe(1)
  })

  test("1 axis lsp (costMultiplier=1) ⇒ 1 (baseline) + 1 (lsp ON) = 2", () => {
    expect(estimateAxesCost(["lsp"], mockBenchRegistry())).toBe(2)
  })

  test("branch-search (costMultiplier=8) alone ⇒ 1 + 8 = 9", () => {
    expect(estimateAxesCost(["branch-search"], mockBenchRegistry())).toBe(9)
  })

  test("compound product: lsp + subagent ⇒ baseline(1) + lsp(1) + sub(1) + lsp*sub(1) = 4", () => {
    expect(estimateAxesCost(["lsp", "subagent"], mockBenchRegistry())).toBe(4)
  })

  test("compound product with branch-search: 1 + 8 + 1 + 8*1 = 18", () => {
    expect(estimateAxesCost(["branch-search", "lsp"], mockBenchRegistry())).toBe(18)
  })
})

describe("parseArgs --axes integration", () => {
  test("--axes alone (with --dataset, --dry-run) parses ok", () => {
    const a = parseArgs(["--dataset", "d", "--axes", "lsp,subagent", "--dry-run"])
    expect(a.axes).toEqual(["lsp", "subagent"])
    expect(a.dryRun).toBe(true)
  })

  test("--axes and --conditions ⇒ throws (mutually exclusive)", () => {
    expect(() =>
      parseArgs([
        "--dataset",
        "d",
        "--corpus",
        "c",
        "--out",
        "o",
        "--axes",
        "lsp",
        "--conditions",
        "baseline",
      ]),
    ).toThrow(/mutually exclusive/)
  })

  test("--axes without --dry-run still requires --corpus/--out", () => {
    expect(() => parseArgs(["--dataset", "d", "--axes", "lsp"])).toThrow(/--corpus/)
    expect(() => parseArgs(["--dataset", "d", "--axes", "lsp", "--corpus", "c"])).toThrow(/--out/)
  })

  test("--axes with --dry-run does not require --corpus/--out", () => {
    const a = parseArgs(["--dataset", "d", "--axes", "lsp", "--dry-run"])
    expect(a.dryRun).toBe(true)
    expect(a.corpus).toBe("")
    expect(a.out).toBe("")
  })

  test("--axes with unknown axis ⇒ parseAxes returns the token; generate validates later", () => {
    const a = parseArgs(["--dataset", "d", "--axes", "fakeAxis", "--dry-run"])
    expect(a.axes).toEqual(["fakeAxis"])
  })

  test("--axes with no value ⇒ undefined (legacy mode keeps working)", () => {
    const a = parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o"])
    expect(a.axes).toBeUndefined()
    expect(a.conditions.length).toBe(8)
  })
})
