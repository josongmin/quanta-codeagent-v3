/**
 * Bench-surface knob wiring tests.
 *
 * Pins the contract that `resolveBenchKnobs` + `applyBenchKnobs` from
 * `src/runner/batch/eval/knobs-bench.ts` correctly:
 *   - report empty `values` / `inactive=[]` / `preset=undefined` when the
 *     registry is empty (the byte-identical pre-knob baseline);
 *   - route the bench env vars (`QUANTA_BENCH_SUBAGENT`, `QUANTA_BENCH_SKILLS`,
 *     `QUANTA_BENCH_LSP`, `QUANTA_BENCH_BRANCH_SEARCH`,
 *     `QUANTA_BENCH_LOCALIZE_PHASE`, `QUANTA_BENCH_ISSUE_HINT`,
 *     `QUANTA_BENCH_REPRO_TEST`, `QUANTA_BENCH_MUST_PASS`) through the framework
 *     when test knobs are registered;
 *   - honor `QUANTA_KNOBS_PRESET` (preset layer);
 *   - flag registered-but-inactive knob ids in `inactive`;
 *   - apply each active knob's `apply` function to the baseline config exactly
 *     once.
 *
 * The framework's own contract (`resolveKnobs` / `applyKnobs` semantics) is
 * unit-tested separately in `tests/unit/runner-knobs-*.test.ts`. This file is
 * the BENCH-SURFACE seam — it pins that `knobs-bench.ts` correctly wraps the
 * framework with the bench-only conventions (envVars-only resolution, no cli/
 * session/config-file layers).
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

/** Register a test knob with a custom env key + apply side-effect. The test
 *  knobs are registered inside individual tests so each test starts from a
 *  clean registry. */
const mkBoolKnob = (
  id: string,
  envKey: string,
  apply: (cfg: AgentConfig) => AgentConfig,
): Knob<true> => ({
  id,
  envKey,
  category: "agent",
  surfaces: BENCH,
  parse: (raw: string | undefined): true | undefined => (raw === "1" ? true : undefined),
  apply: (cfg: AgentConfig, _v: true): AgentConfig => apply(cfg),
  describe: `test knob ${id}`,
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

const envSnapshot = (keys: readonly string[]): Map<string, string | undefined> => {
  const m = new Map<string, string | undefined>()
  for (const k of keys) m.set(k, process.env[k])
  return m
}

const envRestore = (m: Map<string, string | undefined>): void => {
  for (const [k, v] of m) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

const ENV_KEYS = [
  "QUANTA_BENCH_SUBAGENT",
  "QUANTA_BENCH_SKILLS",
  "QUANTA_BENCH_LSP",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_TEST_ONE",
  "QUANTA_BENCH_TEST_TWO",
] as const

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

let savedEnv: Map<string, string | undefined>

beforeEach(() => {
  savedEnv = envSnapshot(ENV_KEYS)
  for (const k of ENV_KEYS) delete process.env[k]
  __resetRegistry()
})

afterEach(() => {
  envRestore(savedEnv)
  __resetRegistry()
})

describe("resolveBenchKnobs — empty-registry baseline (byte-identical contract)", () => {
  test("empty registry ⇒ values empty, inactive [], preset undefined", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual([])
    expect(state.preset).toBeUndefined()
  })

  test("empty registry + bench env vars present ⇒ STILL empty values (no leak through unregistered envKey)", () => {
    // The driver's legacy benchOptIns reads these directly; resolveBenchKnobs
    // must NOT silently echo them as resolved values — they're only resolved
    // when a knob with the matching envKey is registered.
    process.env.QUANTA_BENCH_SUBAGENT = "1"
    process.env.QUANTA_BENCH_SKILLS = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual([])
  })

  test("applyBenchKnobs on empty state ⇒ returns the SAME config reference (byte-identical)", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    const base = baseCfg()
    const out = applyBenchKnobs(base, state, {})
    expect(out).toBe(base) // referential identity — pure no-op
  })
})

describe("resolveBenchKnobs — registered knobs route through framework", () => {
  test("single bool knob ON ⇒ value resolved, source=env, apply runs once", () => {
    let applyCount = 0
    registerKnob(
      mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE", (cfg) => {
        applyCount++
        return { ...cfg, maxTurns: 99 }
      }),
    )
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.values.size).toBe(1)
    expect(state.values.get("test-one")?.value).toBe(true)
    expect(state.values.get("test-one")?.source).toBe("env")
    expect(state.inactive).toEqual([])

    const out = applyBenchKnobs(baseCfg(), state, {})
    expect(out.maxTurns).toBe(99)
    expect(applyCount).toBe(1)
  })

  test("registered knob with NO env var ⇒ flagged inactive, apply skipped", () => {
    let applyCount = 0
    registerKnob(
      mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE", (cfg) => {
        applyCount++
        return cfg
      }),
    )
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.values.size).toBe(0)
    expect(state.inactive).toEqual(["test-one"])

    applyBenchKnobs(baseCfg(), state, {})
    expect(applyCount).toBe(0)
  })

  test("two knobs — one active, one inactive ⇒ resolved size 1, inactive size 1", () => {
    registerKnob(mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE", (cfg) => cfg))
    registerKnob(mkBoolKnob("test-two", "QUANTA_BENCH_TEST_TWO", (cfg) => cfg))
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.values.size).toBe(1)
    expect(state.values.has("test-one")).toBe(true)
    expect(state.inactive).toEqual(["test-two"])
  })

  test("QUANTA_KNOBS_PRESET=baseline ⇒ preset name surfaced (even empty preset)", () => {
    process.env.QUANTA_KNOBS_PRESET = "baseline"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.preset).toBe("baseline")
  })

  test("QUANTA_KNOBS_PRESET=unknown ⇒ preset name surfaced but no preset values (graceful)", () => {
    // The framework silently drops unknown preset names — the resolver still
    // records what the operator requested for telemetry.
    process.env.QUANTA_KNOBS_PRESET = "this-preset-does-not-exist"
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.preset).toBe("this-preset-does-not-exist")
    expect(state.values.size).toBe(0)
  })

  test("QUANTA_KNOBS_PRESET empty string ⇒ treated as unset", () => {
    process.env.QUANTA_KNOBS_PRESET = ""
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(state.preset).toBeUndefined()
  })
})

describe("readKnobValue — typed-guard extractor", () => {
  test("active knob + matching guard ⇒ returns parsed value", () => {
    registerKnob(mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE", (cfg) => cfg))
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    const v = readKnobValue<true>(state, "test-one", (x): x is true => x === true)
    expect(v).toBe(true)
  })

  test("inactive knob ⇒ undefined", () => {
    registerKnob(mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE", (cfg) => cfg))
    const state = resolveBenchKnobs({ envVars: process.env })
    const v = readKnobValue<true>(state, "test-one", (x): x is true => x === true)
    expect(v).toBeUndefined()
  })

  test("active knob + REJECTING guard ⇒ undefined (defensive type pin)", () => {
    registerKnob(mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE", (cfg) => cfg))
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    // Guard rejects true ⇒ result is undefined even though knob is active.
    const v = readKnobValue<"never">(state, "test-one", (x): x is "never" => x === "never")
    expect(v).toBeUndefined()
  })
})

describe("knobsForReport — JSON-serialisable projection", () => {
  test("empty state ⇒ empty object", () => {
    const state = resolveBenchKnobs({ envVars: process.env })
    expect(knobsForReport(state)).toEqual({})
  })

  test("active knob ⇒ projects { value, source } verbatim", () => {
    registerKnob(mkBoolKnob("test-one", "QUANTA_BENCH_TEST_ONE", (cfg) => cfg))
    process.env.QUANTA_BENCH_TEST_ONE = "1"
    const state = resolveBenchKnobs({ envVars: process.env })
    const r = knobsForReport(state)
    expect(r).toEqual({ "test-one": { value: true, unit: undefined, display: "on", source: "env" } })
    // Pure JSON-friendly — round-trip must succeed.
    const roundTrip = JSON.parse(JSON.stringify(r)) as typeof r
    expect(roundTrip).toEqual(r)
  })
})
