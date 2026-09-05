/**
 * Pillar A PARITY PROOF — the SSOT derive reproduces today's hand-maintained
 * data EXACTLY.
 *
 * For each authored `KnobSchema`:
 *   1. `deriveInventoryEntry(schema)` deep-equals the CURRENT entry in
 *      src/config/knob-inventory/bench.ts (the inventory hand-list).
 *   2. `deriveKnob(schema).parse(raw)` === the CURRENT registry knob's
 *      `parse(raw)` for a spread of raw values incl. invalid/off/garbage.
 *   3. `isDefaultOff(schema)` matches the inventory default's OFF-ness.
 *
 * If both hold for all 8, the schema can become the SINGLE declaration and the
 * inventory entry + registry knob can be DERIVED instead of hand-copied — the
 * 4-place drift problem is closed. The red-on-injection block proves the parity
 * assert actually has teeth: a wrong default in a schema FAILS the deep-equal.
 */

import { describe, expect, test } from "bun:test"
import { BENCH } from "@/config/knob-inventory/bench"
import type { KnobDeclaration } from "@/config/knob-inventory/types"
import type { AnyKnobSchema } from "@/config/knob-schema/contracts"
import { deriveInventoryEntry, isDefaultOff } from "@/config/knob-schema/derive-inventory"
import {
  localizePhaseSchema,
  repoMapSchema,
  retryTransientSchema,
  selectorModeSchema,
} from "@/config/knob-schema/schemas/bench-loop"
import {
  reproDoubtSchema,
  reproExecTimeoutSchema,
  reproTestSchema,
  reproVoteSchema,
} from "@/config/knob-schema/schemas/bench-repro"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
// Live registry knobs (their parse is the ground truth).
import { localizePhaseKnob } from "@/runner/knobs/knobs/localize-phase"
import { repoMapKnob } from "@/runner/knobs/knobs/repo-map"
import { reproDoubtKnob } from "@/runner/knobs/knobs/repro-doubt"
import { reproExecTimeoutKnob } from "@/runner/knobs/knobs/repro-exec-timeout"
import { reproTestKnob } from "@/runner/knobs/knobs/repro-test"
import { reproVoteKnob } from "@/runner/knobs/knobs/repro-vote"
import { retryTransientKnob } from "@/runner/knobs/knobs/retry-transient"
import { selectorModeKnob } from "@/runner/knobs/knobs/selector-mode"
import { type AnyKnob, asAnyKnob } from "@/runner/knobs/types"

/** Index the live inventory by envKey for O(1) lookup. */
const inventoryByEnvKey = new Map<string, KnobDeclaration>(BENCH.map((e) => [e.envKey, e]))

/** A spread of raw values that exercises active / off / garbage / boundary for
 *  every parser shape (int / bool / enum / string / float-ish). */
const RAW_PROBES: readonly (string | undefined)[] = [
  undefined,
  "",
  "  ",
  "0",
  "1",
  "2",
  "5",
  "6",
  "8",
  "12",
  "13",
  "40",
  "41",
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
  "clean",
  "research",
  "CLEAN",
  "Research ",
  " 1 ",
  "60000",
  "5000",
  "4999",
  "600000",
  "600001",
  "NaN",
  "Infinity",
]

interface Pair {
  readonly name: string
  readonly schema: AnyKnobSchema
  readonly knob: AnyKnob
}

const PAIRS: readonly Pair[] = [
  { name: "repro-test", schema: reproTestSchema, knob: asAnyKnob(reproTestKnob) },
  { name: "repro-vote", schema: reproVoteSchema, knob: asAnyKnob(reproVoteKnob) },
  { name: "repro-doubt", schema: reproDoubtSchema, knob: asAnyKnob(reproDoubtKnob) },
  {
    name: "repro-exec-timeout",
    schema: reproExecTimeoutSchema,
    knob: asAnyKnob(reproExecTimeoutKnob),
  },
  { name: "localize-phase", schema: localizePhaseSchema, knob: asAnyKnob(localizePhaseKnob) },
  { name: "retry-transient", schema: retryTransientSchema, knob: asAnyKnob(retryTransientKnob) },
  { name: "selector-mode", schema: selectorModeSchema, knob: asAnyKnob(selectorModeKnob) },
  { name: "repo-map", schema: repoMapSchema, knob: asAnyKnob(repoMapKnob) },
]

describe("derive parity (base) — FULL-Knob data parity (BURN-DOWN gate)", () => {
  const FULL_KNOB_DIVERGENT_CEILING = 0
  const project = (k: AnyKnob): Record<string, unknown> => ({
    id: k.id,
    envKey: k.envKey,
    category: k.category,
    surfaces: [...k.surfaces],
    describe: k.describe,
    default: k.default,
    costMultiplier: k.costMultiplier,
    unit: k.unit,
    source: k.source,
  })
  const mismatches: string[] = []
  for (const { name, schema, knob } of PAIRS) {
    const derived = deriveKnob(schema, knob.apply) as unknown as AnyKnob
    if (JSON.stringify(project(derived)) !== JSON.stringify(project(knob))) mismatches.push(name)
  }
  test(`full-Knob divergent count stays <= ${FULL_KNOB_DIVERGENT_CEILING} (burn-down)`, () => {
    expect(mismatches.length).toBeLessThanOrEqual(FULL_KNOB_DIVERGENT_CEILING)
  })
})

describe("Pillar A derive parity — inventory entry", () => {
  for (const { name, schema } of PAIRS) {
    test(`deriveInventoryEntry(${name}) deep-equals current bench.ts entry`, () => {
      const current = inventoryByEnvKey.get(schema.envKey)
      // Defensive: the entry MUST exist, else the parity claim is vacuous.
      expect(current, `bench.ts has an entry for ${schema.envKey}`).toBeDefined()
      const derived = deriveInventoryEntry(schema)
      expect(derived).toEqual(current as KnobDeclaration)
    })
  }
})

describe("Pillar A derive parity — knob parse semantics", () => {
  for (const { name, schema, knob } of PAIRS) {
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
      expect(derived.apply(cfg, derived.parse("1") as never, { surface: "bench" })).toBe(cfg)
      expect(derived.surfaces).toContain("bench")
      expect(derived.id).toBe(knob.id)
      expect(derived.envKey).toBe(knob.envKey)
    })
  }
})

describe("Pillar A derive parity — default-OFF proof", () => {
  for (const { name, schema } of PAIRS) {
    test(`isDefaultOff(${name}) agrees with inventory default OFF-ness`, () => {
      const current = inventoryByEnvKey.get(schema.envKey) as KnobDeclaration
      const inventoryOff =
        current.default === undefined ||
        current.default === false ||
        current.default === 0 ||
        current.default === ""
      expect(isDefaultOff(schema)).toBe(inventoryOff)
      // All 8 chosen knobs are byte-identical-baseline default-OFF.
      expect(isDefaultOff(schema)).toBe(true)
    })
  }
})

describe("Pillar A derive parity — RED on injection (the assert has teeth)", () => {
  test("a wrong default in a schema makes deriveInventoryEntry parity FAIL", () => {
    // Corrupt ONLY the default (repro-vote is false in bench.ts → inject true).
    const corrupted: AnyKnobSchema = { ...reproVoteSchema, default: true }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(reproVoteSchema.envKey) as KnobDeclaration
    // The deep-equal that the parity test relies on MUST reject this.
    expect(derived).not.toEqual(current)
    expect(() => expect(derived).toEqual(current)).toThrow()
  })

  test("a wrong describe in a schema makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...reproTestSchema, describe: "WRONG describe" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(reproTestSchema.envKey) as KnobDeclaration
    expect(derived).not.toEqual(current)
  })

  test("a wrong readSite in a schema makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...repoMapSchema, readSite: "runner/WRONG.ts" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(repoMapSchema.envKey) as KnobDeclaration
    expect(derived).not.toEqual(current)
  })

  test("wrong surfaces flip the derived home (cross-surface ⇒ runner-knobs)", () => {
    // repo-map is cross-surface ⇒ "runner-knobs"; forcing bench-only ⇒ "bench"
    // would diverge from the current entry, proving the home-derivation is live.
    const benchOnly: AnyKnobSchema = { ...repoMapSchema, surfaces: ["bench"] }
    expect(deriveInventoryEntry(benchOnly).home).toBe("bench")
    expect(deriveInventoryEntry(repoMapSchema).home).toBe("runner-knobs")
  })
})
