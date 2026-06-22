import { describe, expect, test } from "bun:test"
import { SELECT_N } from "@/runner/batch/eval/posture/capability-profiles"
import {
  composedKnobsForPreset,
  composePresetKnobs,
  PRESET_COMPOSITES,
  THIN_STRICT_PRESET,
} from "@/runner/batch/eval/posture/compose-preset"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

// D2 SSOT contract: each frozen composable preset literal MUST equal the fold of
// its capability composite onto the thin-strict base — RAW knob values, byte for
// byte (stronger than the prior behavioral-equivalence). The frozen literal stays
// (reproducibility); the modules are the value source it is pinned to.

describe("preset ⇄ composite raw identity (D2)", () => {
  for (const { preset, modules } of PRESET_COMPOSITES) {
    test(`IDENTITY[${preset}]: frozen literal === thin-base + composite fold`, () => {
      const folded = composePresetKnobs(KNOB_PRESETS[THIN_STRICT_PRESET] ?? {}, modules)
      expect(folded).toEqual(KNOB_PRESETS[preset] ?? {})
      // and the convenience accessor agrees
      expect(composedKnobsForPreset(preset)).toEqual(KNOB_PRESETS[preset] ?? {})
    })
  }

  // red-on-injection: the identity is NOT vacuous — a wrong module value breaks it.
  test("RED: a wrong N in the proof-clean composite breaks the identity", () => {
    const wrong = PRESET_COMPOSITES.find((c) => c.preset === "agentless-v4-proof-clean")!.modules.map(
      (m) => (m.id.startsWith("select-n-") ? SELECT_N(2) : m),
    )
    const folded = composePresetKnobs(KNOB_PRESETS[THIN_STRICT_PRESET] ?? {}, wrong)
    expect(folded).not.toEqual(KNOB_PRESETS["agentless-v4-proof-clean"] ?? {})
  })

  test("base is the thin-strict preset (the documented shared root)", () => {
    expect(KNOB_PRESETS[THIN_STRICT_PRESET]).toBeDefined()
  })
})
