/**
 * Pillar A PARITY PROOF (GAP-3) — the SSOT derive reproduces today's
 * hand-maintained inventory data EXACTLY for the remaining bench knobs.
 *
 * For each authored `KnobSchema`:
 *   1. `deriveInventoryEntry(schema)` deep-equals the CURRENT entry in
 *      src/config/knob-inventory/bench.ts (the inventory hand-list).
 *   2. PARSE-PARITY ONLY for knobs with a LIVE registry knob: `deriveKnob(schema)
 *      .parse(raw)` === the live knob's `parse(raw)` over a raw spread. Of these
 *      GAP-3 knobs, exactly ONE has a live registry knob
 *      (no-patch-force-fraction); the rest are ENV-DIRECT (read straight from
 *      process.env at their readSite, no `Knob`) so there is no parse ground
 *      truth to match — INVENTORY parity only.
 *   3. `isDefaultOff(schema)` matches the inventory default's OFF-ness (note:
 *      PROTECT_TESTS is the one DEFAULT-ON knob here ⇒ NOT default-off).
 *
 * The red-on-injection block proves the parity assert actually has teeth: a
 * wrong default in a schema FAILS the deep-equal.
 *
 * Modeled on tests/unit/kernel/derive-parity.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { BENCH } from "@/config/knob-inventory/bench"
import type { KnobInventoryEntry } from "@/config/knob-inventory/types"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import { deriveInventoryEntry, isDefaultOff } from "@/config/knob-schema/derive-inventory"
import type { AnyKnobSchema } from "@/config/knob-schema/contracts"
import {
  benchClosureDiagSchema,
  benchConcurrencySchema,
  benchExposeDatasetVerifierSchema,
  benchFindRefsSchema,
  benchPresetSchema,
  benchProtectTestsSchema,
  benchRecordTrajectorySchema,
  benchReplayOnMissSchema,
  benchReplayTrajectorySchema,
  benchSiblingSchema,
  benchSimplicitySchema,
  benchSotaSchema,
  noPatchForceFractionSchema,
} from "@/config/knob-schema/schemas/bench-gap-3"
// The ONE live registry knob among GAP-3 (its parse is the ground truth).
import { noPatchForceFractionKnob } from "@/runner/knobs/knobs/no-patch-force-fraction"
import { type AnyKnob, asAnyKnob } from "@/runner/knobs/types"

/** Index the live inventory by envKey for O(1) lookup. */
const inventoryByEnvKey = new Map<string, KnobInventoryEntry>(BENCH.map((e) => [e.envKey, e]))

/** A spread of raw values exercising active / off / garbage / boundary for every
 *  parser shape (bool / int / enum / string / float). */
const RAW_PROBES: readonly (string | undefined)[] = [
  undefined,
  "",
  "  ",
  "0",
  "1",
  "2",
  ".5",
  "0.5",
  "0.8",
  ".999",
  "1.0",
  "-0.5",
  "0",
  "-1",
  "1.5",
  "1abc",
  "abc",
  "on",
  "off",
  "true",
  "false",
  "yes",
  "no",
  "throw",
  "passthrough",
  "record-and-passthrough",
  " 1 ",
  "6",
  "agentless-v1",
  "/tmp/foo.jsonl",
  "NaN",
  "Infinity",
]

/* All GAP-3 schemas (inventory-derive parity applies to ALL). */
const ALL_SCHEMAS: readonly { readonly name: string; readonly schema: AnyKnobSchema }[] = [
  { name: "bench-sota", schema: benchSotaSchema },
  { name: "bench-preset", schema: benchPresetSchema },
  { name: "bench-concurrency", schema: benchConcurrencySchema },
  { name: "bench-closure-diag", schema: benchClosureDiagSchema },
  { name: "bench-record-trajectory", schema: benchRecordTrajectorySchema },
  { name: "bench-replay-trajectory", schema: benchReplayTrajectorySchema },
  { name: "bench-replay-on-miss", schema: benchReplayOnMissSchema },
  { name: "no-patch-force-fraction", schema: noPatchForceFractionSchema },
  { name: "bench-find-refs", schema: benchFindRefsSchema },
  { name: "bench-simplicity", schema: benchSimplicitySchema },
  { name: "bench-sibling", schema: benchSiblingSchema },
  { name: "bench-protect-tests", schema: benchProtectTestsSchema },
  { name: "bench-expose-dataset-verifier", schema: benchExposeDatasetVerifierSchema },
]

/* Only knobs that have a LIVE registry knob get parse-parity. */
interface LivePair {
  readonly name: string
  readonly schema: AnyKnobSchema
  readonly knob: AnyKnob
}
const LIVE_PAIRS: readonly LivePair[] = [
  {
    name: "no-patch-force-fraction",
    schema: noPatchForceFractionSchema,
    knob: asAnyKnob(noPatchForceFractionKnob),
  },
]

describe("derive parity (gap-3) — FULL-Knob data parity (BURN-DOWN gate)", () => {
  const FULL_KNOB_DIVERGENT_CEILING = 0
  const project = (k: AnyKnob): Record<string, unknown> => ({
    id: k.id, envKey: k.envKey, category: k.category, surfaces: [...k.surfaces],
    describe: k.describe, default: k.default, costMultiplier: k.costMultiplier, unit: k.unit, source: k.source,
  })
  const mismatches: string[] = []
  for (const { name, schema, knob } of LIVE_PAIRS) {
    const derived = deriveKnob(schema, knob.apply) as unknown as AnyKnob
    if (JSON.stringify(project(derived)) !== JSON.stringify(project(knob))) mismatches.push(name)
  }
  test(`full-Knob divergent count stays <= ${FULL_KNOB_DIVERGENT_CEILING} (burn-down)`, () => {
    expect(mismatches.length).toBeLessThanOrEqual(FULL_KNOB_DIVERGENT_CEILING)
  })
})

describe("Pillar A derive parity (GAP-3) — inventory entry", () => {
  for (const { name, schema } of ALL_SCHEMAS) {
    test(`deriveInventoryEntry(${name}) deep-equals current bench.ts entry`, () => {
      const current = inventoryByEnvKey.get(schema.envKey)
      // Defensive: the entry MUST exist, else the parity claim is vacuous.
      expect(current, `bench.ts has an entry for ${schema.envKey}`).toBeDefined()
      const derived = deriveInventoryEntry(schema)
      expect(derived).toEqual(current as KnobInventoryEntry)
    })
  }
})

describe("Pillar A derive parity (GAP-3) — knob parse semantics (live knobs only)", () => {
  for (const { name, schema, knob } of LIVE_PAIRS) {
    test(`deriveKnob(${name}).parse === live knob.parse over ${RAW_PROBES.length} raws`, () => {
      const derived = deriveKnob(schema)
      // The derived parse must be the schema's parse (same reference).
      expect(derived.parse).toBe(schema.parse)
      for (const raw of RAW_PROBES) {
        expect(derived.parse(raw)).toEqual(knob.parse(raw))
      }
    })

    test(`deriveKnob(${name}) is apply-NOOP + bench surface`, () => {
      const derived = deriveKnob(schema)
      const cfg = { sentinel: name } as unknown as Parameters<typeof derived.apply>[0]
      // NOOP apply returns the exact same config reference, untouched.
      expect(derived.apply(cfg, derived.parse(".5") as never, { surface: "bench" })).toBe(cfg)
      expect(derived.surfaces).toContain("bench")
      expect(derived.id).toBe(knob.id)
      expect(derived.envKey).toBe(knob.envKey)
    })
  }
})

describe("Pillar A derive parity (GAP-3) — default-OFF proof", () => {
  for (const { name, schema } of ALL_SCHEMAS) {
    test(`isDefaultOff(${name}) agrees with inventory default OFF-ness`, () => {
      const current = inventoryByEnvKey.get(schema.envKey) as KnobInventoryEntry
      const inventoryOff =
        current.default === undefined ||
        current.default === false ||
        current.default === 0 ||
        current.default === ""
      expect(isDefaultOff(schema)).toBe(inventoryOff)
    })
  }

  test("PROTECT_TESTS is the lone DEFAULT-ON knob ⇒ NOT default-off", () => {
    // Guards against a silent default flip: a kill-switch knob must NOT be
    // mistaken for a default-OFF opt-in.
    expect(isDefaultOff(benchProtectTestsSchema)).toBe(false)
    const current = inventoryByEnvKey.get(benchProtectTestsSchema.envKey) as KnobInventoryEntry
    expect(current.default).toBe(true)
  })
})

describe("Pillar A derive parity (GAP-3) — RED on injection (the assert has teeth)", () => {
  test("a wrong default in a schema makes deriveInventoryEntry parity FAIL", () => {
    // Corrupt ONLY the default (bench-sota is false in bench.ts → inject true).
    const corrupted: AnyKnobSchema = { ...benchSotaSchema, default: true }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(benchSotaSchema.envKey) as KnobInventoryEntry
    // The deep-equal that the parity test relies on MUST reject this.
    expect(derived).not.toEqual(current)
    expect(() => expect(derived).toEqual(current)).toThrow()
  })

  test("a wrong describe in a schema makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...benchConcurrencySchema, describe: "WRONG describe" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(benchConcurrencySchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("a wrong readSite in a schema makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...benchReplayOnMissSchema, readSite: "apps/WRONG.ts" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(benchReplayOnMissSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })
})
