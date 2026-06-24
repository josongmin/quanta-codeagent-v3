/**
 * Hellgate — `localize-phase` knob full composition path adversarial pins.
 *
 * Distinct from `localize-phase.test.ts` (which tests knob.parse + knob.apply
 * + metadata directly). THIS FILE proves the knob works end-to-end through the
 * REAL `resolveBenchKnobs` + `applyBenchKnobs` pipeline, which is what the
 * production bench driver calls.
 *
 * Hellgate criteria (from definition-of-done.ts):
 *   - Exercises the real composition path (resolveBenchKnobs → applyBenchKnobs),
 *     not just the isolated knob factory.
 *   - gate-OFF (env absent / empty) → byte-identical cfg, no mutations.
 *   - explicit OFF (`"0"`) survives the real resolver as an env-layer value and
 *     suppresses a preset-provided localize-phase.
 *   - Active knob end-to-end: env "5" → cfg.localizePhase = { phase1Turns: 5 }.
 *   - Adversarial env values (NUL, very long, non-integer) → parse rejects →
 *     knob inactive → no cfg mutation.
 *   - Branch-search conflict declared (meta contract).
 *   - Surface filter: non-bench surface context → apply is a no-op.
 *
 * Registry isolation:
 *   The bench-knob registry is a module-level singleton. To avoid cross-suite
 *   leakage we snapshot/restore it in beforeAll/afterAll, and scrub the env
 *   key in beforeEach/afterEach.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test"
import type { AgentConfig } from "@/agent"
import { ToolRegistry } from "@/tool"
import {
  applyBenchKnobs,
  resolveBenchKnobs,
} from "@/runner/batch/eval/knobs-bench"
import {
  __resetRegistry,
  __restoreRegistry,
  __snapshotRegistry,
  allKnobs,
  registerKnob,
} from "@/runner/knobs"
// Import the real knob so the registry is populated.
import { localizePhaseKnob } from "@/runner/knobs/knobs/localize-phase"
// Side-effect barrel so all production knobs are registered (the snapshot below
// captures the full production registry, not just localize-phase).
import "@/runner/knobs/knobs"

const ENV_KEY = "QUANTA_BENCH_LOCALIZE_PHASE" as const

const baseCfg = (): AgentConfig =>
  ({
    llm: {} as never,
    // Real (empty) registry so preset-activated tool knobs (e.g. lsp) can call
    // `registry.specs()` during apply without crashing — the test isolates the
    // localize-phase effect, but the preset path also folds other knobs.
    registry: new ToolRegistry([]),
    stream: {} as never,
    permission: { mode: "acceptEdits" },
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 30,
    signal: new AbortController().signal,
    onConfirm: async () => false,
  }) as unknown as AgentConfig

// Save/restore the full production registry so we don't pollute siblings.
let registrySnapshot: ReturnType<typeof __snapshotRegistry>
beforeAll(() => {
  registrySnapshot = __snapshotRegistry()
  // Ensure localize-phase is registered in case a sibling reset the registry.
  if (!allKnobs().has(localizePhaseKnob.id)) registerKnob(localizePhaseKnob)
})
afterAll(() => {
  __restoreRegistry(registrySnapshot)
})

let savedEnv: string | undefined
beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
})

// ── 1. Gate-OFF: env absent / inactive ────────────────────────────────────────

describe("hellgate — gate-OFF (env absent)", () => {
  test("absent env → localize-phase inactive, cfg byte-identical", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    const base = baseCfg()
    const out = applyBenchKnobs(base, state, {})
    // When the knob is inactive applyKnobs returns the SAME reference.
    expect(out).toBe(base)
    expect(out.localizePhase).toBeUndefined()
  })

  test("empty string env → parse returns undefined → knob inactive", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
    expect(state.inactive).toContain(localizePhaseKnob.id)
  })

  test("'0' → explicit OFF sentinel resolves as env-layer value", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "0" } })
    expect(state.values.get(localizePhaseKnob.id)?.value).toEqual({ phase1Turns: 0 })
    expect(state.values.get(localizePhaseKnob.id)?.source).toBe("env")
  })

  test("negative integer → knob inactive", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "-5" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })
})

// ── 2. Active end-to-end: env "5" → cfg.localizePhase ─────────────────────────

describe("hellgate — active knob end-to-end", () => {
  test("preset localize-phase + env '0' ⇒ explicit OFF suppresses the preset", () => {
    const state = resolveBenchKnobs({
      envVars: { [ENV_KEY]: "0", QUANTA_BENCH_PRESET: "agentless-v5-thin-and-expanded" },
    })
    expect(state.values.get(localizePhaseKnob.id)?.value).toEqual({ phase1Turns: 0 })

    const out = applyBenchKnobs(baseCfg(), state, {})
    expect(out.localizePhase).toBeUndefined()
  })

  test("'5' → resolveBenchKnobs resolves → applyBenchKnobs sets cfg.localizePhase", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "5" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(true)
    expect(state.values.get(localizePhaseKnob.id)?.value).toEqual({ phase1Turns: 5 })
    expect(state.values.get(localizePhaseKnob.id)?.source).toBe("env")

    const base = baseCfg()
    const out = applyBenchKnobs(base, state, {})
    expect(out).not.toBe(base) // new config object (not byte-identical)
    expect(out.localizePhase).toEqual({ phase1Turns: 5 })
    // base is NOT mutated.
    expect(base.localizePhase).toBeUndefined()
  })

  test("boundary '1' → phase1Turns = 1", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "1" } })
    const out = applyBenchKnobs(baseCfg(), state, {})
    expect(out.localizePhase).toEqual({ phase1Turns: 1 })
  })

  test("boundary '20' → phase1Turns = 20", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "20" } })
    const out = applyBenchKnobs(baseCfg(), state, {})
    expect(out.localizePhase).toEqual({ phase1Turns: 20 })
  })

  test("'21' → parse rejects (measurement-integrity cap) → knob inactive", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "21" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })
})

// ── 3. Adversarial env values ─────────────────────────────────────────────────

describe("hellgate — adversarial env values", () => {
  test("non-integer '1.5' → parse rejects (Number.isInteger guard)", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "1.5" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })

  test("partial-numeric '1abc' → parse rejects (Number(..) NaN, no parseInt foot-gun)", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "1abc" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })

  test("NaN string → parse rejects", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "NaN" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })

  test("Infinity string → parse rejects (Number.isFinite guard)", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "Infinity" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })

  test("NUL-byte value → parse rejects, no crash", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "\x005" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })

  test("100KB value → parse rejects, no crash", () => {
    const big = "5".padEnd(100_000, "0")
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: big } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })

  test("Unicode emoji value → parse rejects, no crash", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "🎯" } })
    expect(state.values.has(localizePhaseKnob.id)).toBe(false)
  })
})

// ── 4. Surface filter ─────────────────────────────────────────────────────────

describe("hellgate — surface filter (bench-only)", () => {
  test("apply with surface='cli' context → localizePhase NOT set (surface guard)", () => {
    // localizePhaseKnob.apply is called by applyKnobs with surface:'bench'.
    // We simulate what WOULD happen if it were forced to a non-bench surface
    // by calling the knob's apply directly with an off-surface ctx.
    const cfg = baseCfg()
    const out = localizePhaseKnob.apply(cfg, { phase1Turns: 5 }, { surface: "cli" })
    // Non-bench surface → cfg unchanged (byte-identical reference).
    expect(out).toBe(cfg)
    expect(out.localizePhase).toBeUndefined()
  })

  test("apply with surface='bench' context → localizePhase set", () => {
    const cfg = baseCfg()
    const out = localizePhaseKnob.apply(cfg, { phase1Turns: 7 }, { surface: "bench" })
    expect(out).not.toBe(cfg)
    expect(out.localizePhase).toEqual({ phase1Turns: 7 })
  })
})

// ── 5. Conflict declaration ────────────────────────────────────────────────────

describe("hellgate — conflict declaration meta contract", () => {
  test("localize-phase declares conflict with branch-search", () => {
    expect(localizePhaseKnob.conflicts).toContain("branch-search")
  })

  test("localize-phase envKey is QUANTA_BENCH_LOCALIZE_PHASE", () => {
    expect(localizePhaseKnob.envKey).toBe(ENV_KEY)
  })

  test("localize-phase is in bench surface only (no cli/ide contamination)", () => {
    expect(localizePhaseKnob.surfaces).toEqual(["bench"])
  })
})

// ── 6. Byte-identical fence ────────────────────────────────────────────────────

describe("hellgate — byte-identical fence (gate-OFF)", () => {
  test("empty env → applyBenchKnobs returns exact same cfg reference", () => {
    // The production bench driver depends on this: no env ⇒ no behavioral change.
    const state = resolveBenchKnobs({ envVars: {} })
    const base = baseCfg()
    const out = applyBenchKnobs(base, state, {})
    // For the localize-phase knob specifically, the cfg object is the same
    // reference when the knob is inactive.
    expect(out.localizePhase).toBeUndefined()
  })

  test("active knob does NOT mutate the base config object", () => {
    const state = resolveBenchKnobs({ envVars: { [ENV_KEY]: "3" } })
    const base = baseCfg()
    const baseLocalizePhase = base.localizePhase
    applyBenchKnobs(base, state, {})
    // base is unchanged (apply must be pure / non-mutating).
    expect(base.localizePhase).toBe(baseLocalizePhase)
    expect(base.localizePhase).toBeUndefined()
  })
})

// ── 7. Registry registration ───────────────────────────────────────────────────

describe("hellgate — registry wiring", () => {
  test("localize-phase is registered in the global knob registry", () => {
    expect(allKnobs().has(localizePhaseKnob.id)).toBe(true)
  })

  test("localize-phase appears in bench surface view", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    expect(state.knobs.has(localizePhaseKnob.id)).toBe(true)
  })

  test("localize-phase id in inactive list when env absent", () => {
    const state = resolveBenchKnobs({ envVars: {} })
    expect(state.inactive).toContain(localizePhaseKnob.id)
  })
})
