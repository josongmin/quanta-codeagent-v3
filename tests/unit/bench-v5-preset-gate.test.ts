import { describe, expect, test } from "bun:test"
import {
  presetRequiresLiveLspGrounding,
  V5_ADAPTIVE_PRESET,
  v5AdaptiveEnabled,
} from "@/apps/bench/preset"
import { KNOB_PRESETS } from "@/runner/knobs"

// v5 preset registration, GATED default-OFF. The preset's literal == the thin-
// strict opening (the controller injects phase modules at runtime); live routing
// requires an explicit opt-in.

describe("agentless-v5-thin-and-expanded preset + gate", () => {
  test("the v5 preset literal is the thin-strict opening (thin/noexec/minimal)", () => {
    expect(KNOB_PRESETS[V5_ADAPTIVE_PRESET]).toEqual(KNOB_PRESETS["agentless-v3-thin-strict"] ?? {})
  })

  test("requires live LSP grounding (localization-dependent)", () => {
    expect(presetRequiresLiveLspGrounding(V5_ADAPTIVE_PRESET)).toBe(true)
  })

  test("v5AdaptiveEnabled is STRICT opt-in (default-OFF)", () => {
    // ON only with the exact preset AND the exact gate.
    expect(v5AdaptiveEnabled({ preset: V5_ADAPTIVE_PRESET, envVars: { QUANTA_BENCH_V5_ADAPTIVE: "1" } })).toBe(true)
    // OFF: gate unset / falsy
    expect(v5AdaptiveEnabled({ preset: V5_ADAPTIVE_PRESET, envVars: {} })).toBe(false)
    expect(v5AdaptiveEnabled({ preset: V5_ADAPTIVE_PRESET, envVars: { QUANTA_BENCH_V5_ADAPTIVE: "0" } })).toBe(false)
    // OFF: gate on but a DIFFERENT preset (paired control — the gate alone can't enable it)
    expect(v5AdaptiveEnabled({ preset: "agentless-v3-thin-strict", envVars: { QUANTA_BENCH_V5_ADAPTIVE: "1" } })).toBe(
      false,
    )
  })
})
