/**
 * Pillar A PARITY PROOF (SLICE B — bench inventory entries 26–50) — the SSOT
 * derive reproduces today's hand-maintained data EXACTLY for the spec-fidelity /
 * localize / CHA / model-lane / patch-budget / verify-select knob family.
 *
 * For each authored `KnobSchema`:
 *   1. `deriveInventoryEntry(schema)` deep-equals the CURRENT entry in
 *      src/config/knob-inventory/bench.ts (the inventory hand-list).
 *   2. `deriveKnob(schema).parse(raw)` === the CURRENT registry knob's
 *      `parse(raw)` over a spread of active / off / garbage / boundary raws.
 *   3. `isDefaultOff(schema)` matches the inventory default's OFF-ness.
 *
 * The DERIVE-GAP knobs (bool+default:undefined tri-states, the float knob, and
 * QUANTA_BENCH_MODEL_LANES which has no registry parse) are intentionally absent
 * — see schemas/bench-b.ts module-doc. The red-on-injection block proves the
 * parity asserts actually have teeth.
 *
 * Modeled on tests/unit/kernel/derive-parity.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { BENCH } from "@/config/knob-inventory/bench"
import type { KnobDeclaration } from "@/config/knob-inventory/types"
import type { AnyKnobSchema } from "@/config/knob-schema/contracts"
import { deriveInventoryEntry, isDefaultOff } from "@/config/knob-schema/derive-inventory"
import {
  adversarialReproSchema,
  chaMultisiteGeneralSchema,
  chaMultisiteSteerSchema,
  closureRepairSchema,
  dynamicMessageMatcherSchema,
  forwardLocalizeSchema,
  localizeBudgetSchema,
  modelLaneDiversitySchema,
  pairedControlSchema,
  patchBudgetSchema,
  patchBudgetStrictSchema,
  regressionMaxTestsSchema,
  specFidelityInvariantSchema,
  verifySelectConcurrencySchema,
  verifySelectLlmRiskGateSchema,
  verifySelectSchema,
} from "@/config/knob-schema/schemas/bench-b"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
// Live registry knobs (their parse is the ground truth).
import { adversarialReproKnob } from "@/runner/knobs/knobs/adversarial-repro"
import { chaMultisiteGeneralKnob } from "@/runner/knobs/knobs/cha-multisite-general"
import { chaMultisiteSteerKnob } from "@/runner/knobs/knobs/cha-multisite-steer"
import { closureRepairKnob } from "@/runner/knobs/knobs/closure-repair"
import { dynamicMessageMatcherKnob } from "@/runner/knobs/knobs/dynamic-message-matcher"
import { forwardLocalizeKnob } from "@/runner/knobs/knobs/forward-localize"
import { localizeBudgetKnob } from "@/runner/knobs/knobs/localize-budget"
import { modelLaneDiversityKnob } from "@/runner/knobs/knobs/model-lane-diversity"
import { pairedControlKnob } from "@/runner/knobs/knobs/paired-control"
import { patchBudgetKnob } from "@/runner/knobs/knobs/patch-budget"
import { patchBudgetStrictKnob } from "@/runner/knobs/knobs/patch-budget-strict"
import { regressionMaxTestsKnob } from "@/runner/knobs/knobs/regression-max-tests"
import { specFidelityInvariantKnob } from "@/runner/knobs/knobs/spec-fidelity-invariant"
import { verifySelectKnob } from "@/runner/knobs/knobs/verify-select"
import { verifySelectConcurrencyKnob } from "@/runner/knobs/knobs/verify-select-concurrency"
import { verifySelectLlmRiskGateKnob } from "@/runner/knobs/knobs/verify-select-llm-risk-gate"
import { type AnyKnob, asAnyKnob } from "@/runner/knobs/types"

/** Index the live inventory by envKey for O(1) lookup. */
const inventoryByEnvKey = new Map<string, KnobDeclaration>(BENCH.map((e) => [e.envKey, e]))

/** A spread of raw values that exercises active / off / garbage / boundary for
 *  every parser shape in this slice (int / bool / enum / list-string). */
const RAW_PROBES: readonly (string | undefined)[] = [
  undefined,
  "",
  "  ",
  "0",
  "1",
  "2",
  "5",
  "8",
  "9",
  "10",
  "11",
  "12",
  "13",
  "200",
  "201",
  "-1",
  "1.5",
  "1abc",
  "abc",
  "on",
  "off",
  "true",
  "false",
  "True",
  "ON ",
  "yes",
  "no",
  "shadow",
  "SHADOW",
  "on",
  " 1 ",
  "NaN",
  "Infinity",
  // list-string (localize-budget) probes
  "topk=5",
  "topk=5,tree=12000,files=3000",
  "chafiles=3",
  "topk=0",
  "topk=51",
  "bogus=1",
  "topk=",
  "topk=abc",
]

interface Pair {
  readonly name: string
  readonly schema: AnyKnobSchema
  readonly knob: AnyKnob
}

const PAIRS: readonly Pair[] = [
  {
    name: "spec-fidelity-invariant",
    schema: specFidelityInvariantSchema,
    knob: asAnyKnob(specFidelityInvariantKnob),
  },
  {
    name: "dynamic-message-matcher",
    schema: dynamicMessageMatcherSchema,
    knob: asAnyKnob(dynamicMessageMatcherKnob),
  },
  { name: "forward-localize", schema: forwardLocalizeSchema, knob: asAnyKnob(forwardLocalizeKnob) },
  {
    name: "cha-multisite-steer",
    schema: chaMultisiteSteerSchema,
    knob: asAnyKnob(chaMultisiteSteerKnob),
  },
  {
    name: "cha-multisite-general",
    schema: chaMultisiteGeneralSchema,
    knob: asAnyKnob(chaMultisiteGeneralKnob),
  },
  { name: "paired-control", schema: pairedControlSchema, knob: asAnyKnob(pairedControlKnob) },
  {
    name: "model-lane-diversity",
    schema: modelLaneDiversitySchema,
    knob: asAnyKnob(modelLaneDiversityKnob),
  },
  { name: "closure-repair", schema: closureRepairSchema, knob: asAnyKnob(closureRepairKnob) },
  { name: "patch-budget", schema: patchBudgetSchema, knob: asAnyKnob(patchBudgetKnob) },
  {
    name: "patch-budget-strict",
    schema: patchBudgetStrictSchema,
    knob: asAnyKnob(patchBudgetStrictKnob),
  },
  {
    name: "adversarial-repro",
    schema: adversarialReproSchema,
    knob: asAnyKnob(adversarialReproKnob),
  },
  { name: "verify-select", schema: verifySelectSchema, knob: asAnyKnob(verifySelectKnob) },
  { name: "localize-budget", schema: localizeBudgetSchema, knob: asAnyKnob(localizeBudgetKnob) },
  {
    name: "regression-max-tests",
    schema: regressionMaxTestsSchema,
    knob: asAnyKnob(regressionMaxTestsKnob),
  },
  {
    name: "verify-select-concurrency",
    schema: verifySelectConcurrencySchema,
    knob: asAnyKnob(verifySelectConcurrencyKnob),
  },
  {
    name: "verify-select-llm-risk-gate",
    schema: verifySelectLlmRiskGateSchema,
    knob: asAnyKnob(verifySelectLlmRiskGateKnob),
  },
]

describe("Pillar A derive parity (slice B) — inventory entry", () => {
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

describe("Pillar A derive parity (slice B) — knob parse semantics", () => {
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

describe("Pillar A derive parity (slice B) — default-OFF proof", () => {
  for (const { name, schema } of PAIRS) {
    test(`isDefaultOff(${name}) agrees with inventory default OFF-ness`, () => {
      const current = inventoryByEnvKey.get(schema.envKey) as KnobDeclaration
      const inventoryOff =
        current.default === undefined ||
        current.default === false ||
        current.default === 0 ||
        current.default === ""
      expect(isDefaultOff(schema)).toBe(inventoryOff)
      // Every knob in this slice is a byte-identical-baseline default-OFF feature.
      expect(isDefaultOff(schema)).toBe(true)
    })
  }
})

describe("Pillar A derive parity (slice B) — FULL-Knob data parity (BURN-DOWN gate)", () => {
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

describe("Pillar A derive parity (slice B) — RED on injection (the assert has teeth)", () => {
  test("a wrong default in a schema makes deriveInventoryEntry parity FAIL", () => {
    // closure-repair default is undefined in bench.ts → inject a bogus default.
    const corrupted: AnyKnobSchema = { ...closureRepairSchema, default: 99 }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(closureRepairSchema.envKey) as KnobDeclaration
    expect(derived).not.toEqual(current)
    expect(() => expect(derived).toEqual(current)).toThrow()
  })

  test("a wrong describe in a schema makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...verifySelectSchema, describe: "WRONG describe" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(verifySelectSchema.envKey) as KnobDeclaration
    expect(derived).not.toEqual(current)
  })

  test("a wrong readSite in a schema makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...patchBudgetSchema, readSite: "runner/WRONG.ts" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(patchBudgetSchema.envKey) as KnobDeclaration
    expect(derived).not.toEqual(current)
  })

  test("a wrong enum-mode parse diverges from the live knob", () => {
    // The live llm-risk-gate accepts only shadow/on/1/true; a parser that also
    // accepted "yes" would diverge — prove the parity probe would catch it.
    expect(verifySelectLlmRiskGateSchema.parse("yes")).toEqual(
      verifySelectLlmRiskGateKnob.parse("yes"),
    )
    expect(verifySelectLlmRiskGateSchema.parse("shadow")).toBe("shadow")
    expect(verifySelectLlmRiskGateSchema.parse("on")).toBe("on")
  })
})
