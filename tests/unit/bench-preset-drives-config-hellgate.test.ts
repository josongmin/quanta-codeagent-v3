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
 *
 * jun-26 preset cleanup: the heavy verify-select arms (agentless-v2,
 * v3-select-regression*, v3-thin, v3-thin-strict-*select*, v4-proof-clean*,
 * v5-absorb*, everything-v1, model-lane-diversity) were removed — they laundered
 * correct patches to empty via hard-veto gates and were superseded by the
 * measured single-pass winner `agentless-v6-singlepass-execfull`. Their per-preset
 * pinning tests were deleted with them; the retained presets are baseline /
 * agentless-v1 / -v1-nosteer / -v6-singlepass-execfull / -v3-thin-strict /
 * -v5-thin-and-expanded / hint-only / everything.
 *
 * jun-27: `agentless-v5-absorb-execfull` was also removed when the verify-select /
 * best-of-N veto SELECTION plane was retired; its PRESET-ABSORB pin was deleted.
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
  "QUANTA_BENCH_LSP_CHEAP",
  "QUANTA_BENCH_SUBAGENT",
  "QUANTA_BENCH_SKILLS",
  "QUANTA_BENCH_LOCALIZE_PHASE",
  "QUANTA_BENCH_BRANCH_SEARCH",
  "QUANTA_BENCH_ISSUE_HINT",
  "QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL",
  "QUANTA_BENCH_REPRO_TEST",
  "QUANTA_BENCH_ADVERSARIAL_REPRO",
  "QUANTA_BENCH_RETRY_TRANSIENT",
  "QUANTA_BENCH_CLOSURE_REPAIR",
  "QUANTA_BENCH_REPAIR_BREADTH",
  "QUANTA_BENCH_IN_LOOP_EXEC",
  "QUANTA_BENCH_VERIFY_SELECT",
  "QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY",
  "QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT",
  "QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED",
  "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
  "QUANTA_BENCH_VERIFY_SELECT_REPRO",
  "QUANTA_BENCH_VERIFY_SELECT_RISK_GATE",
  "QUANTA_BENCH_VERIFY_SELECT_COUNTERFACTUAL",
  "QUANTA_BENCH_ACCEPTANCE",
  "QUANTA_BENCH_LOCATION_FANOUT",
  "QUANTA_BENCH_CHA_MULTISITE_STEER",
  "QUANTA_BENCH_CHA_MULTISITE_GENERAL",
  "QUANTA_BENCH_MODEL_LANE_DIVERSITY",
  "QUANTA_BENCH_SELECTOR_MODE",
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

  // PRESET-3: the SAME resolved state feeds the report AND the posture — so
  // "report == applied" by construction (the report-lie is impossible).
  test("PRESET-3: report's active knobs match what drives config", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    const state = resolveBenchKnobs({ envVars: process.env })
    const report = knobsForReport(state)
    // Report shows the preset's knobs active...
    for (const id of ["lsp", "localize-phase", "issue-hint", "repro-test"]) {
      expect(report[id]).toBeDefined()
    }
    // ...and the posture projected from the SAME state agrees.
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(true)
    expect(opt.localizePhase).toEqual({ phase1Turns: 5, lspGroundingSteer: true })
  })

  // PRESET-4: explicit env var OVERRIDES a preset value (layer precedence).
  test("PRESET-4: explicit QUANTA_BENCH_LOCALIZE_PHASE overrides the preset", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    process.env.QUANTA_BENCH_LOCALIZE_PHASE = "3"
    expect(benchOptIns().localizePhase).toEqual({ phase1Turns: 3, lspGroundingSteer: true })
  })

  test("PRESET-4b: explicit QUANTA_BENCH_LSP=off suppresses preset lsp tools", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    process.env.QUANTA_BENCH_LSP = "off"
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(false)
    const cfg = buildOnce()
    expect(hasLspTool(cfg)).toBe(false)
    expect(cfg.localizePhase).toEqual({ phase1Turns: 5 })
  })

  test("PRESET-4c: explicit QUANTA_BENCH_LSP=off beats legacy QUANTA_LSP_TOOLS=full alias", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    process.env.QUANTA_BENCH_LSP = "off"
    process.env.QUANTA_LSP_TOOLS = "full"
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(false)
    const cfg = buildOnce()
    expect(hasLspTool(cfg)).toBe(false)
  })

  test("PRESET-4d: v7 multifile preset projects the structural breadth posture, not just telemetry", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v7-oracle-multifile"
    const opt = benchOptIns()
    expect(opt.repairRounds).toBe(5)
    expect(opt.repairBreadth).toBe(3)
    expect(opt.locationFanout).toBe(true)
    expect(opt.chaMultisiteSteer).toBe(true)
    expect(opt.chaMultisiteGeneral).toBe(true)
    expect(opt.modelLaneDiversity).toBe(true)
    expect(opt.acceptance).toBe(true)
    expect(opt.pairedControl).toBe(true)
    expect(opt.adversarialRepro).toBe(true)
    const report = knobsForReport(resolveBenchKnobs({ envVars: process.env }))
    expect(report["repair-breadth"]).toBeDefined()
    expect(report["bench-location-fanout"]).toBeDefined()
    expect(report["paired-control"]).toBeDefined()
    expect(report["adversarial-repro"]).toBeDefined()
  })

  // PRESET-5: no preset + no env ⇒ all-OFF baseline EXCEPT the jun-26 cheap
  // LSP-nav tier, which is a DEFAULT-ON gated-flip (REPORT-jun26 §4.5). The
  // full opt-in (`opt.lspNav`) stays OFF and the live-override store stays
  // untouched (no setKnobOverride side-effect). The measurement-integrity OFF
  // arm is pinned just below via the `QUANTA_BENCH_LSP_CHEAP=0` kill-switch.
  test("PRESET-5: baseline (no preset/env) is all-OFF except the default-ON cheap LSP-nav tier", () => {
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(false) // the FULL opt-in (references/implementation) stays OFF
    expect(opt.lspNavCheap).toBe(true) // jun-26 default-ON cheap tier
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
    // Cheap tier present by default, but NEVER the two measured-intractable
    // members nor the mutating rename_apply (those need the full opt-in).
    const navNames = cfg.registry
      .specs()
      .map((s) => s.name)
      .filter((n) => n.startsWith("lsp_"))
    expect(navNames).toContain("lsp_workspace_symbol")
    expect(navNames).not.toContain("lsp_references")
    expect(navNames).not.toContain("lsp_implementation")
    expect(navNames).not.toContain("lsp_rename_apply")
    expect(cfg.subagent).toBeUndefined()
    expect(getKnobOverride("QUANTA_READ_OUTLINE")).toBeUndefined()
    expect(getKnobOverride("QUANTA_TEST_RUNNER")).toBeUndefined()
    expect(getKnobOverride("QUANTA_REPO_MAP")).toBeUndefined()
  })

  // PRESET-5b: the byte-identity OFF arm — `QUANTA_BENCH_LSP_CHEAP=0` reverts
  // the jun-26 flip so the bench nav surface is the legacy all-OFF baseline
  // (ZERO lsp_* tools). This is the measurement-integrity / A-arm control and
  // proves the default-flip is reversible to the prior bytes.
  test("PRESET-5b: QUANTA_BENCH_LSP_CHEAP=0 ⇒ legacy all-OFF nav baseline (byte-identity arm)", () => {
    process.env.QUANTA_BENCH_LSP_CHEAP = "0"
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(false)
    expect(opt.lspNavCheap).toBe(false)
    const cfg = buildOnce()
    expect(hasLspTool(cfg)).toBe(false)
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
    process.env.QUANTA_KNOBS_PRESET = "everything"
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

  // PRESET-14: agentless-v3-thin-strict is noexec + hard patch-budget, without
  // a late selector (the retained thin-strict base the v5 controller composes over).
  test("PRESET-14: agentless-v3-thin-strict is noexec + hard patch-budget, without late selector", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v3-thin-strict"
    const opt = benchOptIns()
    expect(opt.inLoopExec).toBe(false)
    expect(opt.patchBudget).toBe(true)
    expect(opt.patchBudgetStrict).toBe(true)
    expect(opt.verifySelectN).toBeUndefined()
    expect(KNOB_PRESETS["agentless-v3-thin-strict"]).toMatchObject({
      "bench-in-loop-exec": "off",
      "spec-fidelity-steer": "1",
      "patch-budget": "1",
      "patch-budget-strict": "1",
    })
    expect(KNOB_PRESETS["agentless-v3-thin-strict"]?.["test-runner"]).toBeUndefined()
    expect(KNOB_PRESETS["agentless-v3-thin-strict"]?.["repro-test"]).toBeUndefined()
  })

  // PRESET-V6: the MEASURED WINNER — agentless-v6-singlepass-execfull == the
  // agentless-v1 localization core PLUS full in-loop repo-test execution. This is
  // the posture that resolved django-11138 on the official harness.
  test("PRESET-V6: agentless-v6-singlepass-execfull == v1 core + full in-loop exec", () => {
    process.env.QUANTA_BENCH_PRESET = "agentless-v6-singlepass-execfull"
    const opt = benchOptIns()
    expect(opt.lspNav).toBe(true)
    expect(opt.localizePhase).toEqual({ phase1Turns: 5, lspGroundingSteer: true })
    expect(opt.reproTestK).toBe(5)
    expect(opt.inLoopExec).toBe(true)
    expect(opt.inLoopExecMode).toBe("full")
    expect(KNOB_PRESETS["agentless-v6-singlepass-execfull"]).toMatchObject({
      lsp: "1",
      "localize-phase": "5",
      "issue-hint": "agentless",
      "repro-test": "5",
      "bench-in-loop-exec": "full",
    })
  })

  // PRESET-ABSORB removed (jun-27): `agentless-v5-absorb-execfull` was deleted with
  // the verify-select / best-of-N veto SELECTION plane retirement. No verify-select
  // reference arm or clean-selector preset remains to assert against.

  test("PRESET-15c: no named preset may bake in targeted RCA gates", () => {
    const contaminated = Object.entries(KNOB_PRESETS).filter(
      ([, preset]) => preset["rca-target-gates"] !== undefined,
    )
    expect(contaminated).toEqual([])
  })

  // PRESET-SM: a preset with no selector-mode key (and no preset at all) projects
  // the default "research". red-on-injection: if benchPostureFromState defaulted
  // selectorMode to "clean", these flip. (The clean-authority arm was retired with
  // the verify-select veto plane — no clean preset remains to assert against.)
  test("PRESET-SM: no-selector-mode preset projects research", () => {
    // A preset that opts into NO selector-mode ⇒ default research projection.
    process.env.QUANTA_BENCH_PRESET = "agentless-v1"
    expect(benchOptIns().selectorMode).toBe("research")
    expect(KNOB_PRESETS["agentless-v1"]?.["selector-mode"]).toBeUndefined()
    // No preset / no env ⇒ default research (byte-identical baseline).
    delete process.env.QUANTA_BENCH_PRESET
    expect(benchOptIns().selectorMode).toBe("research")
  })
})

// ── Safety ratchet: NO preset may surface the HIDDEN-TEST verifier to the agent ──
// `QUANTA_BENCH_EXPOSE_DATASET_VERIFIER` surfaces the FAIL_TO_PASS-derived verifier
// command (hidden test node-ids) into the AGENT prompt
// (`agentVisibleBenchVerifierCommand`, src/runner/batch/eval/driver.ts). That is a
// leaderboard-gaming hazard: it leaks the answer-key test selection into the model's
// context. It is default-OFF (src/config/knob-inventory/bench.ts) and must NEVER be
// baked into a shippable preset. Symmetric to the verify-select-regression!="discovered"
// contamination guards above — this ratchet trips if any preset adds the key on-value.
describe("HIDDEN-TEST verifier exposure ratchet: no preset arms QUANTA_BENCH_EXPOSE_DATASET_VERIFIER", () => {
  const EXPOSE_ENV_KEY = "QUANTA_BENCH_EXPOSE_DATASET_VERIFIER"
  // Match the exact env key OR any normalized alias (a future short knob name) that
  // would still surface the dataset verifier. Case/separator-insensitive so a rename
  // to e.g. `expose-dataset-verifier` cannot smuggle past an exact-string match.
  const matchesExposeKey = (key: string): boolean => {
    if (key === EXPOSE_ENV_KEY) return true
    const norm = key.toLowerCase().replace(/[^a-z]/g, "")
    return norm.includes("expose") && norm.includes("verifier")
  }
  // A knob value is "on" unless it is an explicit off-token. Mirrors the env-gate
  // default-OFF semantics (any non-off string enables a bool knob).
  const OFF_TOKENS = new Set(["", "0", "off", "false", "no"])
  const isOnValue = (value: string): boolean => !OFF_TOKENS.has(value.trim().toLowerCase())

  const presetEntries = Object.entries(KNOB_PRESETS)

  test("anti-vacuous floor: there is a non-empty set of presets to scan", () => {
    expect(presetEntries.length).toBeGreaterThanOrEqual(4)
  })

  test("RATCHET: no PRESETS entry sets the dataset-verifier exposure key to an on-value", () => {
    const violations: string[] = []
    for (const [presetName, knobs] of presetEntries) {
      for (const [key, value] of Object.entries(knobs)) {
        if (matchesExposeKey(key) && isOnValue(value)) {
          violations.push(`${presetName}.${key}=${value}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("RED-ON-INJECTION (the teeth): the same scan REJECTS a preset that armed the key", () => {
    // Synthetic contaminated preset table — proves the scan is not vacuously green:
    // if a real preset added the key on-value, the RATCHET test above would fail
    // exactly like this.
    const injected: Record<string, Record<string, string>> = {
      ...Object.fromEntries(presetEntries),
      "evil-leak": { [EXPOSE_ENV_KEY]: "1" },
      "evil-alias-leak": { "expose-dataset-verifier": "true" },
    }
    const violations: string[] = []
    for (const [presetName, knobs] of Object.entries(injected)) {
      for (const [key, value] of Object.entries(knobs)) {
        if (matchesExposeKey(key) && isOnValue(value)) {
          violations.push(`${presetName}.${key}=${value}`)
        }
      }
    }
    expect(violations).toContain("evil-leak.QUANTA_BENCH_EXPOSE_DATASET_VERIFIER=1")
    expect(violations).toContain("evil-alias-leak.expose-dataset-verifier=true")

    // PAIRED CONTROL: the OFF-token form is NOT a violation (the ratchet only trips
    // on an on-value, so a deliberately-disabled key would be permitted).
    const offForm: Record<string, Record<string, string>> = {
      "explicitly-off": { [EXPOSE_ENV_KEY]: "0" },
    }
    const offViolations = Object.entries(offForm).flatMap(([p, knobs]) =>
      Object.entries(knobs)
        .filter(([k, v]) => matchesExposeKey(k) && isOnValue(v))
        .map(([k, v]) => `${p}.${k}=${v}`),
    )
    expect(offViolations).toEqual([])
  })
})
