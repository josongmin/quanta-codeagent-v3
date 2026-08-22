/**
 * Pillar C parity proof — the {@link PresetSpec} GENERATES the current frozen literal
 * byte-for-byte. `resolvePresetSpec(spec, {})` (params-only; the current literals are
 * fully explicit so no defaults are needed for parity) must deep-equal
 * `KNOB_PRESETS[spec.id]` for each re-expressed preset. When green, the literal in
 * `runner/knobs/presets.ts` is redundant and could be deleted, leaving the spec as the
 * single source of truth (killing the literal-vs-composite double-book + its
 * byte-identical golden oracle).
 */

import { describe, expect, test } from "bun:test"
import type { PresetSpec } from "@/config/knob-schema/contracts"
import { resolvePresetSpec } from "@/runner/batch/eval/kernel/preset-spec"
import {
  AGENTLESS_V1,
  AGENTLESS_V6_SINGLEPASS_EXECFULL,
} from "@/runner/batch/eval/kernel/preset-specs"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

const SPECS: readonly PresetSpec[] = [AGENTLESS_V1, AGENTLESS_V6_SINGLEPASS_EXECFULL]

describe("preset-spec parity — spec GENERATES the frozen literal", () => {
  for (const spec of SPECS) {
    test(`${spec.id}: resolvePresetSpec(spec, {}) deep-equals KNOB_PRESETS["${spec.id}"]`, () => {
      const literal = KNOB_PRESETS[spec.id]
      // Sanity: the literal must actually exist (guards against a renamed/deleted id
      // silently making this a vacuous pass).
      expect(literal).toBeDefined()
      if (literal === undefined) throw new Error(`no literal for ${spec.id}`)

      const generated = resolvePresetSpec(spec, {})

      // Byte-for-byte: same keys, same raw values. deep-equal on the flat map proves
      // the spec reproduces the literal exactly — the literal is now redundant.
      expect(generated).toEqual(literal as Record<string, string>)
      // Key sets identical (deep-equal already covers extra keys, but assert count
      // explicitly so an accidentally-dropped knob can't hide).
      expect(Object.keys(generated).sort()).toEqual(Object.keys(literal).sort())
    })
  }

  // Red-on-injection: a WRONG param must break parity. If this passed, the parity
  // assertion above would be tautological (always-true regardless of params).
  test("red-on-injection: a corrupted param fails parity (proves the test has teeth)", () => {
    const corrupted: PresetSpec = {
      ...AGENTLESS_V1,
      params: { ...AGENTLESS_V1.params, "localize-phase": "999" }, // was "5"
    }
    const generated = resolvePresetSpec(corrupted, {})
    expect(generated).not.toEqual(KNOB_PRESETS[AGENTLESS_V1.id] as Record<string, string>)
  })

  // Defaults-overlay semantics: spec.params win over defaults (last-wins). Belt-and-
  // suspenders that the generator overlays correctly, not just that {} happens to work.
  test("defaults overlay: spec.params override defaults (last-wins)", () => {
    const withDefaults = resolvePresetSpec(AGENTLESS_V1, {
      "localize-phase": "0", // a baseline default the preset must override
      "unrelated-default": "keep",
    })
    expect(withDefaults["localize-phase"]).toBe("5") // override won
    expect(withDefaults["unrelated-default"]).toBe("keep") // untouched default survives
  })
})
