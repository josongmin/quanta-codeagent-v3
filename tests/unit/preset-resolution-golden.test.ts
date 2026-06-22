/**
 * GOLDEN byte-identical oracle for the jun-22 v5 posture-SSOT migration (P0).
 *
 * The SSOT migration keeps the composable preset LITERALS frozen but binds them
 * to the KnobModule catalog via `composePresetKnobs` (the single fold + registry
 * in `compose-preset.ts`). The HARD invariant is that every preset NAME resolves
 * to the EXACT same knob values regardless (bench results store the preset name,
 * not a hash — so name→knobs must be reproducible). This test freezes the
 * resolved values of EVERY preset as a snapshot; any change that perturbs a
 * single resolved knob breaks it.
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
  // CHURN-ROBUST: the preset registry is reshaped by many concurrent agents
  // (presets added/removed). We do NOT snapshot the roster or assert a fixed
  // count — that brittle pin false-REDs on every concurrent registry change.
  // Instead each preset's RESOLVED VALUES are snapshotted: a NEW preset auto-adds
  // (green), a REMOVED preset simply stops running, and only a VALUE DRIFT on an
  // existing preset breaks the byte-identical reproducibility guarantee.
  const names = Object.keys(KNOB_PRESETS).sort()

  for (const name of names) {
    test(`golden resolved knobs: ${name}`, () => {
      expect(resolvedValues(name)).toMatchSnapshot(name)
    })
  }
})
