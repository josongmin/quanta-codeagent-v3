/**
 * Pillar A PARITY PROOF (GAP-1 family) — the SSOT derive reproduces today's
 * hand-maintained data EXACTLY for the nine knobs that need an ESCAPE HATCH
 * override (bool recorded as `undefined`; cross-surface knob filed under the
 * `bench` home).
 *
 * For each authored `KnobSchema`:
 *   1. `deriveInventoryEntry(schema)` deep-equals the CURRENT entry in
 *      src/config/knob-inventory/bench.ts.
 *   2. `deriveKnob(schema).parse(raw)` === the live registry knob's `parse(raw)`
 *      over active / off / garbage / boundary raws.
 *   3. `isDefaultOff(schema)` matches the inventory default's OFF-ness.
 *
 * The red-on-injection block proves the two override classes carry teeth:
 * dropping the `inventoryDefault: undefined` pin (bool ⇒ derives `false`) and
 * dropping the `inventoryHome: "bench"` pin (cross-surface ⇒ derives
 * `runner-knobs`) each break the deep-equal.
 *
 * Modelled on tests/unit/kernel/derive-parity.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { BENCH } from "@/config/knob-inventory/bench"
import type { KnobDeclaration } from "@/config/knob-inventory/types"
import type { AnyKnobSchema } from "@/config/knob-schema/contracts"
import { deriveInventoryEntry, isDefaultOff } from "@/config/knob-schema/derive-inventory"
import {
  lspCheapSchema,
  lspSchema,
  lspSteerSchema,
  mustPassSchema,
  skillsSchema,
  verifySelectCounterfactualSchema,
  verifySelectEarlyAcceptSchema,
  verifySelectProofRequiredSchema,
  verifySelectRiskGateSchema,
} from "@/config/knob-schema/schemas/bench-gap-1"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import { lspKnob } from "@/runner/knobs/knobs/lsp"
// Live registry knobs (their parse is the ground truth).
import { lspCheapKnob } from "@/runner/knobs/knobs/lsp-cheap"
import { lspSteerKnob } from "@/runner/knobs/knobs/lsp-steer"
import { mustPassKnob } from "@/runner/knobs/knobs/must-pass"
import { skillsKnob } from "@/runner/knobs/knobs/skills"
import { verifySelectCounterfactualKnob } from "@/runner/knobs/knobs/verify-select-counterfactual"
import { verifySelectEarlyAcceptKnob } from "@/runner/knobs/knobs/verify-select-early-accept"
import { verifySelectProofRequiredKnob } from "@/runner/knobs/knobs/verify-select-proof-required"
import { verifySelectRiskGateKnob } from "@/runner/knobs/knobs/verify-select-risk-gate"
import { type AnyKnob, asAnyKnob } from "@/runner/knobs/types"

/** Index the live inventory by envKey for O(1) lookup. */
const inventoryByEnvKey = new Map<string, KnobDeclaration>(BENCH.map((e) => [e.envKey, e]))

/** A spread of raw values exercising active / off / garbage / boundary across
 *  every parser shape (bool tri-state, strict-truthy, must-pass enum). */
const RAW_PROBES: readonly (string | undefined)[] = [
  undefined,
  "",
  "  ",
  "0",
  "1",
  "2",
  "3",
  "4",
  "on",
  "off",
  "true",
  "false",
  "yes",
  "no",
  "strict",
  "STRICT",
  "On ",
  " 1 ",
  "1abc",
  "abc",
  "TRUE",
  "Off",
]

interface Pair {
  readonly name: string
  readonly schema: AnyKnobSchema
  readonly knob: AnyKnob
}

const PAIRS: readonly Pair[] = [
  { name: "lsp", schema: lspSchema, knob: asAnyKnob(lspKnob) },
  { name: "lsp-cheap", schema: lspCheapSchema, knob: asAnyKnob(lspCheapKnob) },
  { name: "lsp-steer", schema: lspSteerSchema, knob: asAnyKnob(lspSteerKnob) },
  { name: "skills", schema: skillsSchema, knob: asAnyKnob(skillsKnob) },
  { name: "must-pass", schema: mustPassSchema, knob: asAnyKnob(mustPassKnob) },
  {
    name: "verify-select-counterfactual",
    schema: verifySelectCounterfactualSchema,
    knob: asAnyKnob(verifySelectCounterfactualKnob),
  },
  {
    name: "verify-select-early-accept",
    schema: verifySelectEarlyAcceptSchema,
    knob: asAnyKnob(verifySelectEarlyAcceptKnob),
  },
  {
    name: "verify-select-proof-required",
    schema: verifySelectProofRequiredSchema,
    knob: asAnyKnob(verifySelectProofRequiredKnob),
  },
  {
    name: "verify-select-risk-gate",
    schema: verifySelectRiskGateSchema,
    knob: asAnyKnob(verifySelectRiskGateKnob),
  },
]

describe("Pillar A GAP-1 derive parity — inventory entry", () => {
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

describe("Pillar A GAP-1 derive parity — knob parse semantics", () => {
  for (const { name, schema, knob } of PAIRS) {
    test(`deriveKnob(${name}).parse === live knob.parse over ${RAW_PROBES.length} raws`, () => {
      const derived = deriveKnob(schema)
      // The derived parse must be the schema's parse (same reference).
      expect(derived.parse).toBe(schema.parse)
      // The schema now REPLICATES the live knob's parse verbatim (the schema
      // lives in the config leaf and cannot import @/runner, so it is a copy,
      // not the same reference). Parity is EXTENSIONAL: the replica must agree
      // with the live knob's parse over the full probe battery — any replication
      // error is caught here.
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

describe("Pillar A GAP-1 derive parity — default-OFF proof", () => {
  for (const { name, schema } of PAIRS) {
    test(`isDefaultOff(${name}) agrees with inventory default OFF-ness`, () => {
      const current = inventoryByEnvKey.get(schema.envKey) as KnobDeclaration
      const inventoryOff =
        current.default === undefined ||
        current.default === false ||
        current.default === 0 ||
        current.default === ""
      expect(isDefaultOff(schema)).toBe(inventoryOff)
      // All nine GAP-1 knobs are byte-identical-baseline default-OFF.
      expect(isDefaultOff(schema)).toBe(true)
    })
  }
})

describe("Pillar A GAP-1 derive parity — RED on injection (overrides have teeth)", () => {
  test("dropping inventoryDefault: undefined (bool ⇒ derives false) breaks parity", () => {
    // lsp-cheap records `undefined` in bench.ts; without the pin the bool
    // convention derives `false`, which must NOT deep-equal the entry.
    const { inventoryDefault: _drop, ...rest } = lspCheapSchema
    const withoutPin = rest as AnyKnobSchema
    const derived = deriveInventoryEntry(withoutPin)
    const current = inventoryByEnvKey.get(lspCheapSchema.envKey) as KnobDeclaration
    expect(derived.default).toBe(false)
    expect(current.default).toBeUndefined()
    expect(derived).not.toEqual(current)
  })

  test("dropping inventoryHome: bench (cross-surface ⇒ derives runner-knobs) breaks parity", () => {
    // lsp is cross-surface in the live knob; without the home pin deriveHome
    // gives "runner-knobs", diverging from the bench.ts "bench" entry.
    const { inventoryHome: _drop, ...rest } = lspSchema
    const withoutPin = rest as AnyKnobSchema
    const derived = deriveInventoryEntry(withoutPin)
    const current = inventoryByEnvKey.get(lspSchema.envKey) as KnobDeclaration
    expect(derived.home).toBe("runner-knobs")
    expect(current.home).toBe("bench")
    expect(derived).not.toEqual(current)
  })

  test("a wrong describe in a schema makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...mustPassSchema, describe: "WRONG describe" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(mustPassSchema.envKey) as KnobDeclaration
    expect(derived).not.toEqual(current)
  })

  test("a wrong readSite in a schema makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...lspSteerSchema, readSite: "runner/WRONG.ts" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(lspSteerSchema.envKey) as KnobDeclaration
    expect(derived).not.toEqual(current)
  })
})

describe("Pillar A derive parity (gap-1) — FULL-Knob data parity (BURN-DOWN gate)", () => {
  const FULL_KNOB_DIVERGENT_CEILING = 0 // lower to 0 once every schema is reconciled
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
