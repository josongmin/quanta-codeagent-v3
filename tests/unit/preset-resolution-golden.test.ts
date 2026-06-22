/**
 * GOLDEN byte-identical oracle for the jun-22 v5 posture-SSOT migration (P0).
 *
 * The SSOT refactor converts the composable presets in `presets.ts` from literal
 * knob-maps into `expandModules([...])` compositions. The HARD invariant is that
 * every preset NAME must resolve to the EXACT same knob values before and after
 * (bench results store the preset name, not a hash — so name→knobs must be
 * reproducible). This test freezes the resolved values of EVERY preset as a
 * snapshot; any migration step that perturbs a single resolved knob breaks it.
 *
 * Captured at HEAD before P1. Do NOT update the snapshot to make a refactor pass
 * — a diff here means the composition is wrong.
 */

import { describe, expect, test } from "bun:test"
import { resolveBenchKnobs } from "@/runner/batch/eval/knobs-bench"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

/** Stable, order-independent projection of a preset's resolved knob values — OR
 *  a frozen error marker if the preset throws on resolution (e.g. the legacy
 *  `everything` preset has a branch-search<->localize-phase conflict). The
 *  migration must reproduce BOTH outcomes byte-identically. */
const resolvedValues = (preset: string): unknown => {
  try {
    const state = resolveBenchKnobs({
      envVars: { QUANTA_BENCH_PRESET: preset } as NodeJS.ProcessEnv,
    })
    return [...state.values.entries()]
      .map(([id, kv]) => [id, kv.value] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  } catch (e) {
    return { __throws: e instanceof Error ? e.message : String(e) }
  }
}

describe("preset resolution — golden byte-identical oracle (P0)", () => {
  const names = Object.keys(KNOB_PRESETS).sort()

  test("preset roster is non-empty and stable", () => {
    expect(names.length).toBeGreaterThan(20)
    expect(names).toMatchSnapshot("roster")
  })

  for (const name of names) {
    test(`golden resolved knobs: ${name}`, () => {
      expect(resolvedValues(name)).toMatchSnapshot(name)
    })
  }
})
