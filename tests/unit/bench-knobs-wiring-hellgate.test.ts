/**
 * Hellgate — bench-surface knob wiring adversarial pins.
 *
 * Companion to `bench-knob-wiring.test.ts` (positive contract). This file
 * stresses `resolveBenchKnobs`, `applyBenchKnobs`, `readKnobValue`,
 * `knobsForReport` with adversarial inputs the positive battery does not
 * exercise:
 *   - envVars synonyms (custom map ≠ process.env)
 *   - prototype-pollution surface across the env layer
 *   - mixed-surface knobs (bench + cli) — only bench-surfaces materialise
 *   - corrupted env values (8-bit / NUL / extra-long)
 *   - registry-iteration-order vs id-stability for `inactive`
 *   - apply immutability of base config + ctx shape
 *   - readKnobValue with adversarial guards (throwing / always-true / undefined-shape)
 *   - knobsForReport JSON round-trip with exotic value types
 *
 * The byte-identical fence is the centerpiece: an empty registry + any env
 * shape MUST produce {} values, [] inactive, undefined preset, and
 * `applyBenchKnobs` MUST return the exact same config reference.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import {
  applyBenchKnobs,
  knobsForReport,
  readKnobValue,
  resolveBenchKnobs,
} from "@/runner/batch/eval/knobs-bench"
import {
  __resetRegistry,
  __restoreRegistry,
  __snapshotRegistry,
  type Knob,
  registerKnob,
  type Surface,
} from "@/runner/knobs"
// Side-effect: register all real knobs at module-load so the beforeAll snapshot
// below is COMPLETE regardless of suite file order (otherwise an empty snapshot
// would be restored in afterAll and wipe the registry for sibling files).
import "@/runner/knobs/knobs"

const BENCH: readonly Surface[] = ["bench"]
const CLI_ONLY: readonly Surface[] = ["cli"]
const BOTH: readonly Surface[] = ["bench", "cli"]

const mkBoolKnob = (
  id: string,
  envKey: string,
  surfaces: readonly Surface[],
  apply: (cfg: AgentConfig) => AgentConfig = (c) => c,
): Knob<true> => ({
  id,
  envKey,
  category: "agent",
  surfaces,
  parse: (raw): true | undefined => (raw === "1" ? true : undefined),
  apply: (cfg) => apply(cfg),
  describe: `knob ${id}`,
})

const baseCfg = (): AgentConfig =>
  ({
    llm: {} as never,
    registry: {} as never,
    stream: {} as never,
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    onConfirm: async () => false,
  }) as unknown as AgentConfig

// All env keys touched anywhere in this file — saved + scrubbed in beforeEach
// so the tests are hermetic against ambient export.
const ENV_KEYS = [
  "QUANTA_BENCH_SUBAGENT",
  "QUANTA_BENCH_SKILLS",
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_BRANCH_SEARCH",
  "QUANTA_BENCH_ISSUE_HINT",
  "QUANTA_BENCH_REPRO_TEST",
  "QUANTA_BENCH_MUST_PASS",
  "QUANTA_BENCH_LOCALIZE_PHASE",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_TEST_ONE",
  "QUANTA_BENCH_TEST_TWO",
  "QUANTA_BENCH_TEST_THREE",
  "QUANTA_BENCH_TEST_CLI_ONLY",
] as const

const snap = (): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) m.set(k, process.env[k])
  return m
}
const restore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let saved: Map<string, string | undefined>

// Snapshot the populated global registry once so the per-test `__resetRegistry()`
// churn below cannot leak an EMPTY registry to sibling test files that run after
// this one in the single-process suite (their knob modules are already
// import-cached and will NOT re-fire `registerKnob`). Restore it in `afterAll`.
let registrySnapshot: ReturnType<typeof __snapshotRegistry>
beforeAll(() => {
  registrySnapshot = __snapshotRegistry()
})
afterAll(() => {
  __restoreRegistry(registrySnapshot)
})

beforeEach(() => {
  saved = snap()
  for (const k of ENV_KEYS) delete process.env[k]
  __resetRegistry()
})
afterEach(() => {
  restore(saved)
  __resetRegistry()
})

// ── A. envVars custom-map vs prototype pollution ───────────────────────────────

describe("hellgate — envVars custom-map handling", () => {
  test("custom envVars (NOT process.env) routes through resolveKnobs", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const customEnv: NodeJS.ProcessEnv = { QUANTA_BENCH_TEST_ONE: "1" }
    const state = resolveBenchKnobs({ envVars: customEnv })
    expect(state.values.get("k1")?.value).toBe(true)
    expect(state.values.get("k1")?.source).toBe("env")
  })

  test("empty envVars literal {} ⇒ values empty + inactive includes registered ids", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const state = resolveBenchKnobs({ envVars: {} as NodeJS.ProcessEnv })
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual(["k1"])
  })

  test("envVars carrying __proto__ key does NOT pollute Object.prototype", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const polluted: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv
    Object.assign(polluted, { __proto__: { QUANTA_BENCH_TEST_ONE: "1" } as never })
    polluted.QUANTA_BENCH_TEST_ONE = "1" // proto-route should be ignored, own-prop wins
    const state = resolveBenchKnobs({ envVars: polluted })
    expect(state.values.get("k1")?.value).toBe(true)
    expect(({} as Record<string, unknown>).QUANTA_BENCH_TEST_ONE).toBeUndefined()
  })

  test("envVars carrying numeric-shaped value (string '0') ⇒ knob falls through (parse returns undefined)", () => {
    // Bool-knob convention: "0" is NOT recognised; the layer is skipped so
    // higher layers (preset/default) can still resolve. With no other layer,
    // the knob is inactive.
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "0" } })
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual(["k1"])
  })

  test("envVars value with NUL byte ⇒ parse returns undefined (no crash)", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "\x001" } })
    expect(state.values.size).toBe(0)
  })

  test("envVars value 100KB long ⇒ does NOT throw; bool parse returns undefined", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const big = "a".repeat(100_000)
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: big } })
    expect(state.values.size).toBe(0)
  })

  test("envVars with high-codepoint UTF-8 value ⇒ does NOT throw", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "✓💡🎯" } })
    expect(state.values.size).toBe(0)
  })

  test("envVars value = empty string ⇒ parse returns undefined, knob inactive", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "" } })
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual(["k1"])
  })
})

// ── B. surface filter ──────────────────────────────────────────────────────────

describe("hellgate — surface filter (bench-only)", () => {
  test("knob with surfaces=['cli'] only ⇒ resolveBenchKnobs ignores it entirely", () => {
    registerKnob(mkBoolKnob("kcli", "QUANTA_BENCH_TEST_CLI_ONLY", CLI_ONLY))
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_CLI_ONLY: "1" } })
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual([])
    expect(state.knobs.has("kcli")).toBe(false)
  })

  test("knob with surfaces=['bench','cli'] ⇒ included; both env routes activate", () => {
    registerKnob(mkBoolKnob("kboth", "QUANTA_BENCH_TEST_ONE", BOTH))
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "1" } })
    expect(state.values.size).toBe(1)
    expect(state.knobs.has("kboth")).toBe(true)
  })

  test("mixed registry — 1 bench / 1 cli / 1 both — only bench-side knobs surface", () => {
    registerKnob(mkBoolKnob("kb", "QUANTA_BENCH_TEST_ONE", BENCH))
    registerKnob(mkBoolKnob("kc", "QUANTA_BENCH_TEST_CLI_ONLY", CLI_ONLY))
    registerKnob(mkBoolKnob("kx", "QUANTA_BENCH_TEST_TWO", BOTH))
    const state = resolveBenchKnobs({
      envVars: {
        QUANTA_BENCH_TEST_ONE: "1",
        QUANTA_BENCH_TEST_CLI_ONLY: "1",
        QUANTA_BENCH_TEST_TWO: "1",
      },
    })
    expect(state.knobs.size).toBe(2)
    expect(state.values.size).toBe(2)
    expect(state.values.has("kb")).toBe(true)
    expect(state.values.has("kx")).toBe(true)
    expect(state.values.has("kc")).toBe(false)
  })
})

// ── C. preset env handling ─────────────────────────────────────────────────────

describe("hellgate — QUANTA_KNOBS_PRESET edges", () => {
  test("preset=undefined (deleted) ⇒ state.preset is undefined (NOT null/empty)", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    expect(state.preset).toBeUndefined()
    // preset field is undefined — JSON serialisation drops it.
    const projected = { ...state, preset: state.preset }
    const json = JSON.parse(JSON.stringify({ preset: projected.preset })) as Record<string, unknown>
    expect("preset" in json).toBe(false)
  })

  test("preset='' (empty string) ⇒ treated as unset (state.preset undefined)", () => {
    const state = resolveBenchKnobs({ envVars: { QUANTA_KNOBS_PRESET: "" } })
    expect(state.preset).toBeUndefined()
  })

  test("preset='   ' (whitespace only) ⇒ treated as unset (trimmed → undefined)", () => {
    // The selector now trims and treats whitespace-only as unset, consistent
    // with the empty-string case above — a whitespace preset would be dropped
    // as an unknown preset anyway, so surfacing `undefined` is cleaner than
    // echoing the typo into the telemetry preset field.
    const state = resolveBenchKnobs({ envVars: { QUANTA_KNOBS_PRESET: "   " } })
    expect(state.preset).toBeUndefined()
  })

  test("preset name 1024 chars long ⇒ surfaced verbatim, no crash", () => {
    const long = "z".repeat(1024)
    const state = resolveBenchKnobs({ envVars: { QUANTA_KNOBS_PRESET: long } })
    expect(state.preset).toBe(long)
  })
})

// ── D. applyBenchKnobs — immutability + ctx pass-through ──────────────────────

describe("hellgate — applyBenchKnobs immutability", () => {
  test("empty state + ANY base cfg ⇒ returns the SAME reference (byte-identical)", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    const base = baseCfg()
    const out = applyBenchKnobs(base, state, {})
    expect(out).toBe(base)
  })

  test("active knob — apply returns NEW config but does NOT mutate base", () => {
    registerKnob(
      mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH, (cfg) => ({
        ...cfg,
        maxTurns: 42,
      })),
    )
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "1" } })
    const base = baseCfg()
    const baseSnap = { ...base }
    const out = applyBenchKnobs(base, state, {})
    expect(out).not.toBe(base)
    expect(out.maxTurns).toBe(42)
    // Base config unchanged.
    expect(base.maxTurns).toBe(baseSnap.maxTurns)
  })

  test("apply ctx with instance + sandbox is forwarded through Omit<...,'surface'>", () => {
    let receivedCtx: { surface?: string; instance?: { id?: string }; sandbox?: string } | null =
      null
    const probe: Knob<true> = {
      id: "kctx",
      envKey: "QUANTA_BENCH_TEST_ONE",
      category: "agent",
      surfaces: BENCH,
      parse: (raw): true | undefined => (raw === "1" ? true : undefined),
      apply: (cfg, _v, ctx) => {
        receivedCtx = ctx as never
        return cfg
      },
      describe: "ctx probe",
    }
    registerKnob(probe)
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "1" } })
    const fakeInstance = {
      id: "inst-x",
      repoPath: "/r",
      problemStatement: "p",
      testCmd: "true",
    }
    applyBenchKnobs(baseCfg(), state, { instance: fakeInstance, sandbox: "/sbox" })
    // surface forced to "bench" by applyBenchKnobs.
    expect(receivedCtx).not.toBeNull()
    const ctx = receivedCtx as unknown as {
      surface: string
      instance: { id: string }
      sandbox: string
    }
    expect(ctx.surface).toBe("bench")
    expect(ctx.instance.id).toBe("inst-x")
    expect(ctx.sandbox).toBe("/sbox")
  })

  test("apply ctx absent fields are NOT forwarded (exactOptional contract)", () => {
    let received: { instance?: unknown; sandbox?: unknown } = {}
    const probe: Knob<true> = {
      id: "kctx2",
      envKey: "QUANTA_BENCH_TEST_ONE",
      category: "agent",
      surfaces: BENCH,
      parse: (raw): true | undefined => (raw === "1" ? true : undefined),
      apply: (cfg, _v, ctx) => {
        received = ctx as never
        return cfg
      },
      describe: "ctx probe 2",
    }
    registerKnob(probe)
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "1" } })
    applyBenchKnobs(baseCfg(), state, {})
    expect("instance" in received).toBe(false)
    expect("sandbox" in received).toBe(false)
  })
})

// ── E. readKnobValue — guard adversarial ───────────────────────────────────────

describe("hellgate — readKnobValue guards", () => {
  test("unknown knob id ⇒ undefined (no throw)", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    const v = readKnobValue<true>(state, "does-not-exist", (x): x is true => x === true)
    expect(v).toBeUndefined()
  })

  test("guard that always returns true ⇒ returns the actual value", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "1" } })
    const v = readKnobValue<unknown>(state, "k1", (_x): _x is unknown => true)
    expect(v).toBe(true)
  })

  test("guard that always throws ⇒ exception propagates (caller decides)", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_ONE: "1" } })
    expect(() =>
      readKnobValue<true>(state, "k1", ((): never => {
        throw new Error("boom")
      }) as never),
    ).toThrow("boom")
  })
})

// ── F. knobsForReport — JSON projection ───────────────────────────────────────

describe("hellgate — knobsForReport JSON discipline", () => {
  test("empty state ⇒ empty object literal (NOT Map, NOT array)", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    const out = knobsForReport(state)
    expect(out).toEqual({})
    expect(Array.isArray(out)).toBe(false)
    expect(out instanceof Map).toBe(false)
  })

  test("nested-object value round-trips through JSON", () => {
    const nested: Knob<{ samples: number; mode: string }> = {
      id: "knested",
      envKey: "QUANTA_BENCH_TEST_TWO",
      category: "tool",
      surfaces: BENCH,
      parse: (raw) => (raw === "x" ? { samples: 5, mode: "deep" } : undefined),
      apply: (cfg) => cfg,
      describe: "nested",
    }
    registerKnob(nested)
    const state = resolveBenchKnobs({ envVars: { QUANTA_BENCH_TEST_TWO: "x" } })
    const out = knobsForReport(state)
    const round = JSON.parse(JSON.stringify(out)) as typeof out
    expect(round).toEqual(out)
    expect((out.knested?.value as { samples: number }).samples).toBe(5)
  })

  test("output entries preserve registry iteration order (deterministic for diffs)", () => {
    registerKnob(mkBoolKnob("a", "QUANTA_BENCH_TEST_ONE", BENCH))
    registerKnob(mkBoolKnob("b", "QUANTA_BENCH_TEST_TWO", BENCH))
    registerKnob(mkBoolKnob("c", "QUANTA_BENCH_TEST_THREE", BENCH))
    const state = resolveBenchKnobs({
      envVars: {
        QUANTA_BENCH_TEST_ONE: "1",
        QUANTA_BENCH_TEST_TWO: "1",
        QUANTA_BENCH_TEST_THREE: "1",
      },
    })
    const out = knobsForReport(state)
    expect(Object.keys(out)).toEqual(["a", "b", "c"])
  })
})

// ── G. inactive list — adversarial size + ordering ─────────────────────────────

describe("hellgate — inactive list discipline", () => {
  test("100 registered knobs, none with env ⇒ inactive lists ALL 100 in registry order", () => {
    const ids: string[] = []
    for (let i = 0; i < 100; i++) {
      const id = `mass-${i.toString().padStart(3, "0")}`
      ids.push(id)
      registerKnob(mkBoolKnob(id, `QUANTA_BENCH_MASS_${i}`, BENCH))
    }
    const state = resolveBenchKnobs({ envVars: {} })
    expect(state.inactive.length).toBe(100)
    expect([...state.inactive]).toEqual(ids)
  })

  test("inactive returned is a fresh array (not the framework's internal)", () => {
    registerKnob(mkBoolKnob("k1", "QUANTA_BENCH_TEST_ONE", BENCH))
    const state = resolveBenchKnobs({ envVars: {} })
    // The contract is `readonly string[]` — mutating it should be caught by
    // TS, but at runtime the returned array is our own (built per call).
    expect(state.inactive.length).toBe(1)
    // Calling twice ⇒ independent arrays (not aliased).
    const state2 = resolveBenchKnobs({ envVars: {} })
    expect(state2.inactive).not.toBe(state.inactive)
    expect(state2.inactive).toEqual([...state.inactive])
  })
})

// ── H. byte-identical fence — the centerpiece ──────────────────────────────────

describe("hellgate — byte-identical fence", () => {
  test("empty env + empty registry ⇒ everything is the safe-baseline shape", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual([])
    expect(state.preset).toBeUndefined()
    expect(state.knobs.size).toBe(0)
    expect(knobsForReport(state)).toEqual({})
    const base = baseCfg()
    expect(applyBenchKnobs(base, state, {})).toBe(base)
  })

  test("non-empty env keys + empty registry ⇒ STILL safe-baseline (registry is gate)", () => {
    const state = resolveBenchKnobs({
      envVars: {
        QUANTA_BENCH_TEST_ONE: "1",
        QUANTA_BENCH_TEST_TWO: "1",
        QUANTA_KNOBS_PRESET: "anything",
      },
    })
    // Preset surfaces (resolver records it for telemetry), but VALUES are empty.
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual([])
    expect(state.preset).toBe("anything")
    expect(knobsForReport(state)).toEqual({})
    const base = baseCfg()
    expect(applyBenchKnobs(base, state, {})).toBe(base)
  })
})
