/**
 * Drift guard for the leaderboard dashboard's knob catalog
 * (`tools/leaderboard-dashboard/gen-knob-catalog.ts`).
 *
 * Two regressions this pins (both shipped silently before this guard):
 *   1. The catalog used to iterate ONLY the union of preset-referenced knob ids,
 *      so env-only override knobs that no preset touches (regression-max-tests,
 *      repro-exec-timeout, no-patch-force-fraction, localize-budget, …) vanished
 *      from the dashboard entirely.
 *   2. A registered knob with `category:"validation"` fell through to a `group`
 *      that had no entry in `groupLabels`, so it rendered ungrouped.
 *
 * The guard reads the REAL registry (full knob barrel) so adding a new
 * bench-surface knob without a preset reference fails here instead of silently
 * disappearing from the catalog.
 */
import { describe, expect, test } from "bun:test"
// Barrel import: register every knob module so `allKnobs()` is complete.
import "@/runner/knobs/knobs"
import { buildCatalog, catalogKnobIds } from "@/../tools/leaderboard-dashboard/gen-knob-catalog"
import { allKnobs } from "@/runner/knobs"
import { KNOB_PRESETS } from "@/runner/knobs/presets"

const presetEntries = Object.entries(KNOB_PRESETS) as [string, Readonly<Record<string, unknown>>][]

const buildReal = () =>
  buildCatalog({
    registry: allKnobs(),
    presetEntries,
    presetDesc: {},
    generatedAt: "2026-06-22T00:00:00.000Z",
  })

describe("leaderboard knob-catalog drift guard", () => {
  test("every registered bench-surface knob appears in the catalog (FIX 2a)", () => {
    const reg = allKnobs()
    const benchIds = [...reg.values()].filter((k) => k.surfaces.includes("bench")).map((k) => k.id)
    expect(benchIds.length).toBeGreaterThan(0) // sanity: registry actually populated
    const catalog = buildReal()
    const missing = benchIds.filter((id) => catalog.knobs[id] === undefined)
    expect(missing).toEqual([])
  })

  test("env-only override knobs (no preset references them) are still documented", () => {
    // These four are deliberately env-only — they appear in NO preset, which is
    // exactly the case the old preset-union iteration dropped.
    const envOnly = [
      "regression-max-tests",
      "repro-exec-timeout",
      "no-patch-force-fraction",
      "localize-budget",
    ]
    const catalog = buildReal()
    for (const id of envOnly) {
      const entry = catalog.knobs[id]
      expect(entry).toBeDefined()
      expect(entry?.inRegistry).toBe(true)
      // and crucially they are NOT referenced by any preset (otherwise this test
      // would be vacuous — it must exercise the registry-iteration path).
      const inSomePreset = presetEntries.some(([, kv]) => id in kv)
      expect(inSomePreset).toBe(false)
    }
  })

  test("every catalog entry's group has a label (no ungrouped render) (FIX 2b)", () => {
    const catalog = buildReal()
    const labels = new Set(Object.keys(catalog.groupLabels))
    const ungrouped = Object.values(catalog.knobs)
      .map((k) => k.group)
      .filter((g) => !labels.has(g))
    expect([...new Set(ungrouped)]).toEqual([])
  })

  test("validation-category knobs map to the labelled `validation` group", () => {
    expect(Object.keys(buildReal().groupLabels)).toContain("validation")
    // regression-max-tests is category:"validation" with no curated group →
    // it must surface under the `validation` group, which must be labelled.
    const entry = buildReal().knobs["regression-max-tests"]
    expect(entry?.category).toBe("validation")
    expect(entry?.group).toBe("validation")
  })

  test("catalogKnobIds = bench-registry ids ∪ preset ids (no id dropped)", () => {
    const reg = allKnobs()
    const ids = new Set(catalogKnobIds(reg, presetEntries))
    // every bench-surface registered id present
    for (const k of reg.values()) {
      if (k.surfaces.includes("bench")) expect(ids.has(k.id)).toBe(true)
    }
    // every preset-referenced id present (even if not a registered knob)
    for (const [, kv] of presetEntries) {
      for (const id of Object.keys(kv)) expect(ids.has(id)).toBe(true)
    }
  })
})
