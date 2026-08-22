/**
 * Pillar C parity proof — EVERY re-expressed {@link PresetSpec} GENERATES its frozen
 * `KNOB_PRESETS` literal byte-for-byte. Companion to `preset-spec-parity.test.ts`
 * (which covers the first two specs); this one iterates the full `PRESET_SPECS`
 * registry so a newly-added spec is automatically held to the same parity bar, and
 * asserts the registry COVERS every literal in `KNOB_PRESETS` (no preset left behind).
 *
 * When green, the literals in `runner/knobs/presets.ts` are redundant and could be
 * deleted, leaving the specs as the single source of truth (killing the
 * literal-vs-composite double-book + its byte-identical golden oracle).
 */

import { describe, expect, test } from "bun:test"
import type { PresetSpec } from "@/config/knob-schema/contracts"
import { resolvePresetSpec } from "@/runner/batch/eval/kernel/preset-spec"
import { PRESET_SPECS } from "@/runner/batch/eval/kernel/preset-specs"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

const SPECS: readonly PresetSpec[] = Object.values(PRESET_SPECS)

describe("preset-spec parity (ALL) — every spec GENERATES its frozen literal", () => {
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

  // Completeness: the registry must re-express EVERY frozen literal. A preset added
  // to KNOB_PRESETS without a matching spec is a coverage hole this catches.
  test("PRESET_SPECS covers every preset id in KNOB_PRESETS", () => {
    const literalIds = Object.keys(KNOB_PRESETS).sort()
    const specIds = Object.keys(PRESET_SPECS).sort()
    expect(specIds).toEqual(literalIds)
  })

  // baseline is the explicit no-op: it MUST generate the empty map (not just
  // "deep-equal something"). Pins the {} case so a stray param can't sneak in.
  test("baseline generates the empty override map", () => {
    const generated = resolvePresetSpec(PRESET_SPECS.baseline as PresetSpec, {})
    expect(generated).toEqual({})
    expect(Object.keys(generated)).toHaveLength(0)
  })

  // v5-adaptive is INERT (resolved-knob map identical to thin-strict; the adaptive
  // brain is an out-of-band runtime router). Assert the two specs resolve identically
  // so the "≡ thin-strict" claim is enforced, not just commented.
  test("agentless-v5-thin-and-expanded resolves identically to agentless-v3-thin-strict", () => {
    const v5 = resolvePresetSpec(PRESET_SPECS["agentless-v5-thin-and-expanded"] as PresetSpec, {})
    const v3 = resolvePresetSpec(PRESET_SPECS["agentless-v3-thin-strict"] as PresetSpec, {})
    expect(v5).toEqual(v3 as Record<string, string>)
  })

  // Red-on-injection: a WRONG param must break parity. If this passed, the parity
  // assertions above would be tautological (always-true regardless of params).
  test("red-on-injection: a corrupted param fails parity (proves the tests have teeth)", () => {
    const base = PRESET_SPECS["agentless-v6-closure-repair"] as PresetSpec
    const corrupted: PresetSpec = {
      ...base,
      params: { ...base.params, "closure-repair": "999" }, // was "5"
    }
    const generated = resolvePresetSpec(corrupted, {})
    expect(generated).not.toEqual(KNOB_PRESETS[base.id] as Record<string, string>)
  })

  // Red-on-injection #2: an EXTRA param (key the literal lacks) must also fail parity,
  // proving the key-set assertion catches over-generation, not just wrong values.
  test("red-on-injection: an extra param fails parity (over-generation caught)", () => {
    const base = PRESET_SPECS["hint-only"] as PresetSpec
    const corrupted: PresetSpec = {
      ...base,
      params: { ...base.params, "phantom-knob": "1" },
    }
    const generated = resolvePresetSpec(corrupted, {})
    const literal = KNOB_PRESETS[base.id]
    if (literal === undefined) throw new Error(`no literal for ${base.id}`)
    expect(generated).not.toEqual(literal)
    expect(Object.keys(generated).sort()).not.toEqual(Object.keys(literal).sort())
  })
})
