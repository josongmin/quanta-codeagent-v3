/**
 * Hellgate: the unified bench PRESET system actually DRIVES the agent config —
 * not just the telemetry report. This is the anti-regression fence for the
 * split-brain "report-lie" that previously let `QUANTA_KNOBS_PRESET=everything`
 * appear in the report while the agent ran the baseline config.
 *
 * Every test imports from the PRODUCTION apps driver (`src/apps/bench/eval/
 * driver`) — NOT the runner driver — because production wires `runInstance`
 * from `./eval`. A test that proved the runner driver would prove a dead path.
 *
 * Red-on-injection: if `benchOptIns()` reverts to reading raw `process.env`
 * instead of projecting from `resolveBenchKnobs` (preset+env), the preset stops
 * flowing into the config and PRESET-1/2/6 fail (lsp/subagent/skills/localize
 * vanish). If the `liveOverrides` bridge in `buildConfig` is removed,
 * PRESET-1's setKnobOverride assertions fail.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { KNOB_PRESETS } from "@/runner/knobs"
import { __resetKnobOverrides, getKnobOverride } from "@/shared/knob-overrides"
import type { StreamPort } from "@/stream"
import {
  benchOptIns,
  buildConfig,
  knobsForReport,
  resolveBenchKnobs,
} from "../../src/apps/bench/eval/driver"
import type { Instance } from "../../src/apps/bench/types"

// Every env key a preset or its override could touch — scrubbed before each
// test so a stale dev shell cannot perturb the resolved posture.
const ENV_KEYS = [
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_SOTA",
  "QUANTA_KNOBS_PRESET",
  "QUANTA_BENCH_LSP",
  "QUANTA_BENCH_SUBAGENT",
  "QUANTA_BENCH_SKILLS",
  "QUANTA_BENCH_LOCALIZE_PHASE",
  "QUANTA_BENCH_BRANCH_SEARCH",
  "QUANTA_BENCH_ISSUE_HINT",
  "QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL",
  "QUANTA_BENCH_REPRO_TEST",
  "QUANTA_BENCH_RETRY_TRANSIENT",
  "QUANTA_BENCH_CLOSURE_REPAIR",
  "QUANTA_READ_OUTLINE",
  "QUANTA_TEST_RUNNER",
  "QUANTA_REPO_MAP",
  "QUANTA_LSP_TOOLS",
] as const

const snapshot = (): Map<string, string | undefined> => {
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
beforeEach(() => {
  saved = snapshot()
  for (const k of ENV_KEYS) delete process.env[k]
  __resetKnobOverrides()
})
afterEach(() => {
  restore(saved)
  __resetKnobOverrides()
})

// ── buildConfig harness (config-shape inspection only; LLM/stream never run) ──
class StubLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}
const stubStream: StreamPort = { emit() {} }
const swebenchInstance = (): Instance => ({
  id: "p-1",
  repoPath: "/tmp/x",
  problemStatement: "fix it",
  testCmd: "true",
  swebench: { instanceId: "x__1", repo: "x/x", baseCommit: "deadbeef" },
})
const baseDeps = { llm: new StubLLM(), maxTurns: 1, timeoutMs: 5_000 }
const buildOnce = (): ReturnType<typeof buildConfig> => {
  const ac = new AbortController()
  return buildConfig(swebenchInstance(), baseDeps, "/tmp/sb", ac.signal, stubStream)
}
const hasLspTool = (cfg: ReturnType<typeof buildConfig>): boolean =>
  cfg.registry.specs().some((s) => s.name.startsWith("lsp_"))

describe("bench preset DRIVES config (anti report-lie)", () => {
  // PRESET-1: agentless-v1 wires the full posture into BOTH posture + config.
  test("PRESET-1: QUANTA_BENCH_PRESET=agentless-v1 drives config", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(true)
    expect(opt.localizePhase).toEqual({ phase1Turns: 5, lspGroundingSteer: true })
    expect(opt.issueHintMode).toBe("agentless")
    expect(opt.issueHintExpectedActual).toBe(true)
    expect(opt.reproTestK).toBe(5)
    expect(opt.retryTransient).toBe(3)
    expect(opt.preset).toBe("agentless-v1")
    // Config-fold: LSP nav tools actually appear in the registry.
    const cfg = buildOnce()
    expect(hasLspTool(cfg)).toBe(true)
    // posture (opt) AND built config (cfg) both carry the default-on steer — the
    // anti-report-lie invariant: what's reported == what drives the agent.
    expect(cfg.localizePhase).toEqual({ phase1Turns: 5, lspGroundingSteer: true })
    // Live-override bridge: runtime-config knobs pushed into the store.
    expect(getKnobOverride("QUANTA_READ_OUTLINE")).toBe("1")
    expect(getKnobOverride("QUANTA_TEST_RUNNER")).toBe("1")
    expect(getKnobOverride("QUANTA_REPO_MAP")).toBe("1")
  })

  // PRESET-2: everything-v1 adds the multi-agent axis on top of agentless-v1.
  test("PRESET-2: everything-v1 additionally wires subagent + skills", () => {
    process.env.QUANTA_BENCH_PRESET = "everything-v1"
    const cfg = buildOnce()
    expect(cfg.subagent).toEqual({})
    expect(cfg.skills).toEqual({})
    expect(hasLspTool(cfg)).toBe(true) // still inherits agentless-v1 lsp
    expect(getKnobOverride("QUANTA_READ_OUTLINE")).toBe("1")
  })

  // PRESET-3: the SAME resolved state feeds the report AND the posture — so
  // "report == applied" by construction (the report-lie is impossible).
  test("PRESET-3: report's active knobs match what drives config", () => {
    process.env.QUANTA_BENCH_PRESET = "everything-v1"
    const state = resolveBenchKnobs({ envVars: process.env })
    const report = knobsForReport(state)
    // Report shows the preset's knobs active...
    for (const id of ["lsp", "subagent", "skills", "localize-phase", "issue-hint", "repro-test"]) {
      expect(report[id]).toBeDefined()
    }
    // ...and the posture projected from the SAME state agrees.
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(true)
    expect(opt.subagent).toEqual({})
    expect(opt.skills).toEqual({})
    expect(opt.localizePhase).toEqual({ phase1Turns: 5, lspGroundingSteer: true })
  })

  // PRESET-4: explicit env var OVERRIDES a preset value (layer precedence).
  test("PRESET-4: explicit QUANTA_BENCH_LOCALIZE_PHASE overrides the preset", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    process.env.QUANTA_BENCH_LOCALIZE_PHASE = "3"
    expect(benchOptIns().localizePhase).toEqual({ phase1Turns: 3, lspGroundingSteer: true })
  })

  // PRESET-5: no preset + no env ⇒ byte-identical all-OFF baseline. The
  // live-override store stays untouched (no setKnobOverride side-effect).
  test("PRESET-5: baseline (no preset/env) is all-OFF, no overrides", () => {
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(false)
    expect(opt.subagent).toBeUndefined()
    expect(opt.skills).toBeUndefined()
    expect(opt.localizePhase).toBeUndefined()
    expect(opt.issueHintMode).toBe("off")
    expect(opt.reproTestK).toBeUndefined()
    expect(opt.retryTransient).toBeUndefined()
    // EXECUTION half OFF by default: no preset ⇒ no repair budget ⇒ the closure
    // gate cannot enter verify-first (byte-identical single-pass).
    expect(opt.repairRounds).toBeUndefined()
    expect(opt.liveOverrides).toEqual([])
    expect(opt.preset).toBeUndefined()
    const cfg = buildOnce()
    expect(hasLspTool(cfg)).toBe(false)
    expect(cfg.subagent).toBeUndefined()
    expect(getKnobOverride("QUANTA_READ_OUTLINE")).toBeUndefined()
    expect(getKnobOverride("QUANTA_TEST_RUNNER")).toBeUndefined()
    expect(getKnobOverride("QUANTA_REPO_MAP")).toBeUndefined()
  })

  // PRESET-6: QUANTA_BENCH_SOTA=1 is a back-compat ALIAS for agentless-v1.
  test("PRESET-6: QUANTA_BENCH_SOTA=1 ≡ agentless-v1 posture", () => {
    process.env.QUANTA_BENCH_SOTA = "1"
    const sota = benchOptIns()
    delete process.env.QUANTA_BENCH_SOTA
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    const explicit = benchOptIns()
    expect(sota.lspNav).toBe(explicit.lspNav)
    expect(sota.localizePhase).toEqual(explicit.localizePhase)
    expect(sota.issueHintMode).toBe(explicit.issueHintMode)
    expect(sota.reproTestK).toBe(explicit.reproTestK)
    expect(sota.retryTransient).toBe(explicit.retryTransient)
    expect(sota.preset).toBe("agentless-v1")
  })

  // PRESET-7: the canonical selector OUTRANKS the SOTA alias and the legacy
  // QUANTA_KNOBS_PRESET spelling (documented precedence).
  test("PRESET-7: QUANTA_BENCH_PRESET wins over SOTA alias and QUANTA_KNOBS_PRESET", () => {
    process.env.QUANTA_BENCH_PRESET = "baseline"
    process.env.QUANTA_BENCH_SOTA = "1"
    process.env.QUANTA_KNOBS_PRESET = "everything-v1"
    const opt = benchOptIns()
    expect(opt.preset).toBe("baseline")
    expect(opt.lspNav).toBe(false) // baseline = no-op, despite SOTA/KNOBS set
  })

  // PRESET-8: frozen-preset snapshot — agentless-v1's contents are immutable.
  // Tripping this means someone edited a `-v1` preset in place instead of
  // adding `-v2`. Reproducibility of past `preset:agentless-v1` runs depends
  // on this never changing.
  test("PRESET-8: agentless-v1 contents are frozen (snapshot)", () => {
    expect(KNOB_PRESETS["agentless-v1"]).toEqual({
      lsp: "1",
      "localize-phase": "5",
      "issue-hint": "agentless",
      "issue-hint-expected-actual": "1",
      "repro-test": "5",
      "repo-map": "1",
      "read-outline": "1",
      "test-runner": "1",
      "retry-transient": "3",
    })
  })

  // PRESET-9: the repair EXECUTOR is NOT in the DEFAULT/v1/v2 presets — measured
  // net-negative (jun-19: resolution 9→7, repro is a false-NEGATIVE oracle so
  // repair just churns). The closure GROUNDING knobs stay (they win: 82/84
  // django). The executor is opt-in: the jun-19 repair-arms `agentless-v2-repair`
  // (legacy gate) and `agentless-v2-reprovote` (K-of-N vote gate) DO enable
  // `closure-repair:3` — exactly the "for when the repro oracle is fixed" arms
  // this comment foresaw (the vote IS that fix). This test pins that v1/v2
  // themselves stay executor-free. red-on-injection: add "closure-repair" to
  // agentless-v2 and this fails.
  test("PRESET-9: v1/v2 presets stay executor-free (repair is explicit opt-in via the repair-arms)", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v2"
    expect(benchOptIns().repairRounds).toBeUndefined()
    expect(KNOB_PRESETS["agentless-v2"]?.["closure-repair"]).toBeUndefined()
    // But the closure GROUNDING knobs ARE on (the winning config).
    expect(KNOB_PRESETS["agentless-v2"]?.["primary-rail"]).toBe("1")
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    expect(benchOptIns().repairRounds).toBeUndefined()
  })

  // PRESET-10: the executor is still reachable as an explicit opt-in (env/CLI),
  // so a future A/B can re-enable it on top of agentless-v2 without forking.
  test("PRESET-10: QUANTA_BENCH_CLOSURE_REPAIR opts the executor back in over a preset", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v2"
    expect(benchOptIns().repairRounds).toBeUndefined() // off by preset
    process.env.QUANTA_BENCH_CLOSURE_REPAIR = "5"
    expect(benchOptIns().repairRounds).toBe(5) // explicit opt-in wins
    // Garbage is rejected by the strict parse; with no preset value to fall back
    // to, the executor stays OFF (undefined) — fail-safe given it's net-negative.
    process.env.QUANTA_BENCH_CLOSURE_REPAIR = "abc"
    expect(benchOptIns().repairRounds).toBeUndefined()
  })

  test("PRESET-11: agentless-v3-select-regression wires no-oracle select posture", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v3-select-regression"
    const opt = benchOptIns()
    expect(opt.verifySelectN).toBe(5)
    expect(opt.verifySelectRegression).toBe("discovered")
    expect(opt.verifySelectRepro).toBe("positive")
    expect(KNOB_PRESETS["agentless-v3-select-regression"]).toMatchObject({
      "verify-select": "5",
      "verify-select-regression": "discovered",
      "verify-select-repro": "positive",
    })
  })

  test("PRESET-12: agentless-v3-thin stays mini-first without verify-select enabled", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v3-thin"
    const opt = benchOptIns()
    expect(opt.verifySelectN).toBeUndefined()
    expect(opt.verifySelectRegression).toBeUndefined()
    expect(opt.verifySelectRepro).toBeUndefined()
    expect(KNOB_PRESETS["agentless-v3-thin"]).toMatchObject({
      "round0-minimal": "1",
      "spec-fidelity-steer": "1",
      "patch-budget": "1",
    })
  })

  test("PRESET-14: agentless-v3-thin-strict is noexec + hard patch-budget, without late selector", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v3-thin-strict"
    const opt = benchOptIns()
    expect(opt.inLoopExec).toBe(false)
    expect(opt.patchBudget).toBe(true)
    expect(opt.patchBudgetStrict).toBe(true)
    expect(opt.verifySelectN).toBeUndefined()
    expect(KNOB_PRESETS["agentless-v3-thin-strict"]).toMatchObject({
      "bench-in-loop-exec": "off",
      "round0-minimal": "1",
      "spec-fidelity-steer": "1",
      "patch-budget": "1",
      "patch-budget-strict": "1",
    })
    expect(KNOB_PRESETS["agentless-v3-thin-strict"]?.["test-runner"]).toBeUndefined()
    expect(KNOB_PRESETS["agentless-v3-thin-strict"]?.["repro-test"]).toBeUndefined()
  })

  test("PRESET-15: agentless-v3-thin-strict-select keeps noexec candidate-gen and adds late selector", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v3-thin-strict-select"
    const opt = benchOptIns()
    expect(opt.inLoopExec).toBe(false)
    expect(opt.patchBudgetStrict).toBe(true)
    expect(opt.verifySelectN).toBe(5)
    expect(opt.verifySelectRegression).toBe("discovered")
    expect(opt.verifySelectRepro).toBe("positive")
    expect(KNOB_PRESETS["agentless-v3-thin-strict-select"]).toMatchObject({
      "bench-in-loop-exec": "off",
      "patch-budget-strict": "1",
      "verify-select": "5",
      "verify-select-regression": "discovered",
      "verify-select-repro": "positive",
    })
  })

  test("PRESET-16: agentless-v3-select-regression-doubt adds the targeted stall-breaker", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v3-select-regression-doubt"
    const opt = benchOptIns()
    expect(opt.verifySelectN).toBe(5)
    expect(opt.verifySelectRegression).toBe("discovered")
    expect(opt.verifySelectRepro).toBe("positive")
    const cfg = buildOnce()
    expect(cfg.reproDoubt).toEqual({ stuckRuns: 5 })
    expect(KNOB_PRESETS["agentless-v3-select-regression-doubt"]).toMatchObject({
      "verify-select": "5",
      "verify-select-regression": "discovered",
      "verify-select-repro": "positive",
      "repro-doubt": "5",
    })
  })
})
