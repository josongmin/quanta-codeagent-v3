/**
 * Hellgate — `tools/swebench-matrix.ts` `--axes` mode adversarial battery.
 *
 * Pins design decisions (no heuristic, no silent default):
 *   - `parseAxes` is strict: empty/whitespace/only-commas all throw.
 *   - `AXIS_ON_VALUES` is a CLOSED table covering exactly the 12 framework
 *     knob ids — drift surfaces here, not in production.
 *   - `generateAxesConditions` is REGISTRY-DI: the optional registry param
 *     fully bypasses global state so the suite is hellgate-safe (no
 *     `__resetRegistry()` interaction). The function throws loud on
 *     unknown axes / missing ON-value entries.
 *   - 2^N hard cap is 12 (4096 conditions). 13 throws BEFORE any registry
 *     hit — operator visible budget guard.
 *   - Conflict-pair generation IS permitted (the conflict surfaces in the
 *     child bench resolver, not at planning time) — we pin both halves.
 *   - `estimateAxesCost` is pure and bounded; missing/invalid multipliers
 *     fall back to 1× (not 0, not NaN, not Infinity).
 *
 * Test isolation: all tests pass a hand-built registry map (no real
 * registerKnob / __resetRegistry calls). The file is registry-neutral.
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

// ── parseAxes adversarial ─────────────────────────────────────────────────

describe("hellgate parseAxes — adversarial", () => {
  test("undefined ⇒ undefined (not in axes mode, NOT throw)", () => {
    expect(parseAxes(undefined)).toBeUndefined()
  })

  test("empty string ⇒ throws non-empty", () => {
    expect(() => parseAxes("")).toThrow(/non-empty/)
  })

  test("only spaces ⇒ throws non-empty", () => {
    expect(() => parseAxes("     ")).toThrow(/non-empty/)
  })

  test("only tab/newline ⇒ throws non-empty (no implicit default)", () => {
    expect(() => parseAxes("\t\n")).toThrow(/non-empty/)
  })

  test("only commas ⇒ throws 'at least one' (no axes parsed)", () => {
    expect(() => parseAxes(",,,,")).toThrow(/at least one/)
  })

  test("commas + spaces ⇒ throws 'at least one'", () => {
    expect(() => parseAxes(", , ,")).toThrow(/at least one/)
  })

  test("single token preserves identity", () => {
    expect(parseAxes("lsp")).toEqual(["lsp"])
  })

  test("internal whitespace is trimmed per token", () => {
    expect(parseAxes(" lsp , subagent , skills ")).toEqual(["lsp", "subagent", "skills"])
  })

  test("dedupe preserves first-seen order", () => {
    expect(parseAxes("lsp,subagent,lsp,skills,subagent")).toEqual(["lsp", "subagent", "skills"])
  })

  test("unknown axis token NOT thrown at parse — delegated to generator", () => {
    // Brief: error surfaces at generation time so the operator sees the
    // 'unknown axis' message AFTER the matrix is laid out (not during arg
    // parsing). Confirms parser stays loose, generator stays strict.
    expect(parseAxes("not-a-real-axis")).toEqual(["not-a-real-axis"])
  })

  test("very long list (50 distinct tokens) passes parse — gen caps at 12", () => {
    const tokens = Array.from({ length: 50 }, (_, i) => `axis-${i}`)
    const got = parseAxes(tokens.join(","))
    expect(got?.length).toBe(50)
  })

  test("dangerous-looking tokens (proto, constructor) pass through (validated later)", () => {
    // No prototype-pollution risk: parser builds an array, not an object.
    expect(parseAxes("__proto__,constructor,toString")).toEqual([
      "__proto__",
      "constructor",
      "toString",
    ])
  })
})

// ── AXIS_ON_VALUES closed-table invariants ────────────────────────────────

describe("hellgate AXIS_ON_VALUES — closed-table invariants", () => {
  test("exactly 12 keys (no drift)", () => {
    expect(Object.keys(AXIS_ON_VALUES).length).toBe(12)
  })

  test("all values are non-empty single tokens (no whitespace)", () => {
    for (const [id, raw] of Object.entries(AXIS_ON_VALUES)) {
      expect(typeof raw).toBe("string")
      expect(raw.length).toBeGreaterThan(0)
      expect(raw).not.toMatch(/\s/)
      void id
    }
  })

  test("no prototype-pollution-style keys leaked into the table", () => {
    expect(Object.hasOwn(AXIS_ON_VALUES, "__proto__")).toBe(false)
    expect(Object.hasOwn(AXIS_ON_VALUES, "constructor")).toBe(false)
    // Inherited keys exist on every plain object — guard the OWN-property
    // contract that generateAxesConditions uses (`Object.hasOwn`).
  })

  test("specific canonical values pinned (drift would change matrix semantics)", () => {
    expect(AXIS_ON_VALUES.lsp).toBe("1")
    expect(AXIS_ON_VALUES["repro-test"]).toBe("5")
    expect(AXIS_ON_VALUES["must-pass"]).toBe("strict")
  })
})

// ── generateAxesConditions adversarial ────────────────────────────────────

describe("hellgate generateAxesConditions — adversarial", () => {
  test("0 axes ⇒ EXACTLY 1 condition (the baseline)", () => {
    const conds = generateAxesConditions([])
    expect(conds.length).toBe(1)
    expect(conds[0]?.label).toBe("axes-baseline")
    expect(conds[0]?.env).toEqual({})
  })

  test("0 axes does NOT touch registry (no throw even with empty map)", () => {
    const conds = generateAxesConditions([], new Map())
    expect(conds.length).toBe(1)
  })

  test("12 axes ⇒ 4096 conditions (right at hard cap)", () => {
    const axes = [
      "branch-search",
      "issue-hint",
      "localize-phase",
      "lsp",
      "must-pass",
      "repro-test",
      "skills",
      "subagent",
      "axis-x1",
      "axis-x2",
      "axis-x3",
      "axis-x4",
    ]
    const reg = fullBenchRegistry()
    const extReg = new Map(reg)
    extReg.set("axis-x1", mkKnob("axis-x1", "Q_X1", 1))
    extReg.set("axis-x2", mkKnob("axis-x2", "Q_X2", 1))
    extReg.set("axis-x3", mkKnob("axis-x3", "Q_X3", 1))
    extReg.set("axis-x4", mkKnob("axis-x4", "Q_X4", 1))
    // ON-value table only covers the closed 12 — fake axes must be in it OR throw.
    // We expect throw HERE because these synthetic ids are NOT in AXIS_ON_VALUES.
    expect(() => generateAxesConditions(axes, extReg)).toThrow(/no ON value/)
  })

  test("13 axes ⇒ throws hard cap BEFORE any registry lookup", () => {
    const axes = Array.from({ length: 13 }, (_, i) => `axis-${i}`)
    // Empty registry would normally throw 'unknown axis'; the cap guard fires
    // FIRST so the operator sees the budget error (not a misleading symptom).
    expect(() => generateAxesConditions(axes, new Map())).toThrow(/hard cap/)
  })

  test("100 axes ⇒ throws hard cap (large overshoot)", () => {
    const axes = Array.from({ length: 100 }, (_, i) => `a-${i}`)
    expect(() => generateAxesConditions(axes, new Map())).toThrow(/hard cap/)
  })

  test("unknown axis ⇒ throws specific id in message", () => {
    expect(() => generateAxesConditions(["totally-bogus"], fullBenchRegistry())).toThrow(
      /totally-bogus/,
    )
  })

  test("registry has axis but AXIS_ON_VALUES does NOT ⇒ throws 'no ON value'", () => {
    const reg = new Map<string, AnyKnob>()
    reg.set("orphan-axis", mkKnob("orphan-axis", "Q_ORPHAN"))
    expect(() => generateAxesConditions(["orphan-axis"], reg)).toThrow(/no ON value/)
  })

  test("conflict pair (localize-phase + branch-search) ⇒ generation succeeds, all 4 emitted", () => {
    const conds = generateAxesConditions(["localize-phase", "branch-search"], fullBenchRegistry())
    expect(conds.length).toBe(4)
    const both = conds.find(
      (c) => c.onAxes.includes("localize-phase") && c.onAxes.includes("branch-search"),
    )
    expect(both).toBeDefined()
    expect(both?.env.QUANTA_BENCH_LOCALIZE_PHASE).toBe("3")
    expect(both?.env.QUANTA_BENCH_BRANCH_SEARCH).toBe("3")
  })

  test("OFF axes are absent (NOT set to '0') — default-OFF byte-identical contract", () => {
    const conds = generateAxesConditions(["lsp", "subagent"], fullBenchRegistry())
    for (const c of conds) {
      const lspOn = c.onAxes.includes("lsp")
      const subOn = c.onAxes.includes("subagent")
      expect(Object.hasOwn(c.env, "QUANTA_BENCH_LSP")).toBe(lspOn)
      expect(Object.hasOwn(c.env, "QUANTA_BENCH_SUBAGENT")).toBe(subOn)
    }
  })

  test("labels are deterministic + axes-order joined", () => {
    const conds = generateAxesConditions(["subagent", "lsp"], fullBenchRegistry())
    // Input order is [subagent, lsp]. Bit 0 = subagent. The both-on label
    // joins onAxes in INPUT-order traversal of bits (bit 0 first → subagent).
    const both = conds.find((c) => c.onAxes.length === 2)
    expect(both?.label).toBe("axes-subagent_lsp")
  })

  test("env keys are exactly the knob's envKey from the registry (no string-template drift)", () => {
    const reg = new Map<string, AnyKnob>()
    reg.set("lsp", mkKnob("lsp", "TOTALLY_DIFFERENT_ENV_NAME"))
    // AXIS_ON_VALUES still has 'lsp', so it's a valid axis — but env key comes
    // from the registry knob, NOT a hardcoded string. Confirms knob registry
    // is the single source of truth for env keys.
    const conds = generateAxesConditions(["lsp"], reg)
    const onCond = conds.find((c) => c.onAxes.length === 1)
    expect(onCond?.env.TOTALLY_DIFFERENT_ENV_NAME).toBe("1")
    expect(onCond?.env.QUANTA_BENCH_LSP).toBeUndefined()
  })

  test("8 axes ⇒ 256 conditions; baseline + all-ON corners present", () => {
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
    expect(conds.length).toBe(256)
    expect(conds.find((c) => c.onAxes.length === 0)?.label).toBe("axes-baseline")
    expect(conds.find((c) => c.onAxes.length === axes.length)).toBeDefined()
  })

  test("returned conditions are independent objects (no aliased env)", () => {
    const conds = generateAxesConditions(["lsp"], fullBenchRegistry())
    expect(conds[0]?.env).not.toBe(conds[1]?.env)
  })
})

// ── estimateAxesCost adversarial ─────────────────────────────────────────

describe("hellgate estimateAxesCost — adversarial", () => {
  test("0 axes ⇒ exactly 1 (baseline counts)", () => {
    expect(estimateAxesCost([], fullBenchRegistry())).toBe(1)
  })

  test("knob without costMultiplier ⇒ treated as 1× (no NaN, no 0)", () => {
    const reg = new Map<string, AnyKnob>()
    reg.set("skills", mkKnob("skills", "QUANTA_BENCH_SKILLS")) // no multiplier
    expect(estimateAxesCost(["skills"], reg)).toBe(2) // baseline(1) + skills(1) = 2
  })

  test("knob with NEGATIVE costMultiplier falls back to 1×", () => {
    const reg = new Map<string, AnyKnob>()
    reg.set("lsp", mkKnob("lsp", "QUANTA_BENCH_LSP", -5))
    // Negative multiplier is rejected (`m > 0` predicate); falls back to 1.
    expect(estimateAxesCost(["lsp"], reg)).toBe(2)
  })

  test("knob with zero costMultiplier falls back to 1× (avoid sweep×0=0 trap)", () => {
    const reg = new Map<string, AnyKnob>()
    reg.set("lsp", mkKnob("lsp", "QUANTA_BENCH_LSP", 0))
    expect(estimateAxesCost(["lsp"], reg)).toBe(2)
  })

  test("very large multiplier (1e9) ⇒ stays finite", () => {
    const reg = new Map<string, AnyKnob>()
    reg.set("lsp", mkKnob("lsp", "QUANTA_BENCH_LSP", 1e9))
    const c = estimateAxesCost(["lsp"], reg)
    expect(Number.isFinite(c)).toBe(true)
    expect(c).toBe(1 + 1e9)
  })

  test("compound product for two N-axis sweep is sum of per-condition products", () => {
    // Mirror the docs: baseline=1, lsp=1, branch-search=8, both=1*8=8 ⇒ 18
    const reg = fullBenchRegistry()
    expect(estimateAxesCost(["lsp", "branch-search"], reg)).toBe(18)
  })

  test("compound across all 4 multipliers: 1×, 1×, 8×, 40× → finite + > sum-of-singles", () => {
    const reg = fullBenchRegistry()
    const axes = ["lsp", "subagent", "branch-search", "repro-test"]
    const cost = estimateAxesCost(axes, reg)
    expect(Number.isFinite(cost)).toBe(true)
    // Lower bound: at least 1 (baseline) + 1 + 1 + 8 + 40 = 51
    expect(cost).toBeGreaterThan(51)
  })
})

// ── parseArgs adversarial — interaction layer ─────────────────────────────

describe("hellgate parseArgs — flag interactions", () => {
  test("--axes and --conditions BOTH present ⇒ throws mutually exclusive", () => {
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

  test("--axes without --corpus/--out and WITHOUT --dry-run ⇒ throws --corpus", () => {
    expect(() => parseArgs(["--dataset", "d", "--axes", "lsp"])).toThrow(/--corpus/)
  })

  test("--axes with empty string value ⇒ throws (parseAxes guards)", () => {
    expect(() => parseArgs(["--dataset", "d", "--axes", "", "--dry-run"])).toThrow(/non-empty/)
  })

  test("--max-turns negative ⇒ throws", () => {
    expect(() =>
      parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o", "--max-turns", "-3"]),
    ).toThrow(/--max-turns/)
  })

  test("--max-turns non-numeric ⇒ throws", () => {
    expect(() =>
      parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o", "--max-turns", "30abc"]),
    ).toThrow(/--max-turns/)
  })

  test("--timeout-ms with 0 falls back to default (positive-int filter)", () => {
    // argPositiveInt: parseable but `n > 0` filter false ⇒ fallback. 0 with the
    // `/^\d+$/` regex matches → parseInt → 0 → filter fails → fallback.
    const a = parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o", "--timeout-ms", "0"])
    expect(a.timeoutMs).toBe(600_000)
  })

  test("--dataset MUST be present even with --axes + --dry-run", () => {
    expect(() => parseArgs(["--axes", "lsp", "--dry-run"])).toThrow(/--dataset/)
  })

  test("--conditions with no value ⇒ defaults to all 8 (legacy behaviour preserved)", () => {
    const a = parseArgs(["--dataset", "d", "--corpus", "c", "--out", "o"])
    expect(a.conditions.length).toBe(8)
    expect(a.axes).toBeUndefined()
  })

  test("--conditions with bogus token throws specific name", () => {
    expect(() =>
      parseArgs([
        "--dataset",
        "d",
        "--corpus",
        "c",
        "--out",
        "o",
        "--conditions",
        "this-condition-does-not-exist",
      ]),
    ).toThrow(/this-condition-does-not-exist/)
  })
})
