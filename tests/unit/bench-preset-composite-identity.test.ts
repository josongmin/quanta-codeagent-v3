import { describe, expect, test } from "bun:test"
import { SELECT_N } from "@/runner/batch/eval/posture/capability-profiles"
import {
  composedKnobsForPreset,
  composePresetKnobs,
  PRESET_COMPOSITES,
} from "@/runner/batch/eval/posture/compose-preset"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

// D2+P2 SSOT contract: each frozen composable preset literal MUST equal the fold
// of its capability composite onto its declared base — RAW knob values, byte for
// byte (stronger than behavioral-equivalence). The frozen literal stays
// (reproducibility); the modules are the SINGLE value source it is pinned to.
// Covers the WHOLE composable family (19) over its three bases.

describe("preset ⇄ composite raw identity (D2 + P2)", () => {
  for (const { preset, base, modules } of PRESET_COMPOSITES) {
    test(`IDENTITY[${preset}]: frozen literal === base + composite fold`, () => {
      expect(composePresetKnobs(base, modules)).toEqual({ ...(KNOB_PRESETS[preset] ?? {}) })
      // and the convenience accessor agrees
      expect(composedKnobsForPreset(preset)).toEqual({ ...(KNOB_PRESETS[preset] ?? {}) })
    })
  }

  test("covers every composable preset (only frozen/legacy excluded)", () => {
    const EXCLUDED = new Set([
      "baseline",
      "agentless-v1",
      "agentless-v2",
      "agentless-v2-safe",
      "agentless-full",
      "hint-only",
      "everything",
    ])
    const declared = new Set(PRESET_COMPOSITES.map((c) => c.preset))
    const uncovered = Object.keys(KNOB_PRESETS).filter((n) => !EXCLUDED.has(n) && !declared.has(n))
    expect(uncovered).toEqual([])
  })

  // red-on-injection: the identity is NOT vacuous — a wrong module value breaks it.
  test("RED: a wrong N in the proof-clean composite breaks the identity", () => {
    const entry = PRESET_COMPOSITES.find((c) => c.preset === "agentless-v4-proof-clean")!
    const wrong = entry.modules.map((m) => (m.id.startsWith("select-n-") ? SELECT_N(2) : m))
    expect(composePresetKnobs(entry.base, wrong)).not.toEqual(
      KNOB_PRESETS["agentless-v4-proof-clean"] ?? {},
    )
  })
})
