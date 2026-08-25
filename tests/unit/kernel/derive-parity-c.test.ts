/**
 * Pillar A PARITY PROOF (slice C — inventory entries 51–75) — the SSOT derive
 * reproduces today's hand-maintained data EXACTLY for the last third of the
 * bench knobs.
 *
 * For each authored `KnobSchema` in src/runner/batch/eval/kernel/schemas/bench-c.ts:
 *   1. `deriveInventoryEntry(schema)` deep-equals the CURRENT entry in
 *      src/config/knob-inventory/bench.ts (the inventory hand-list).
 *   2. `deriveKnob(schema).parse(raw)` === the CURRENT registry knob's
 *      `parse(raw)` across active / off / garbage / boundary raws.
 *   3. `isDefaultOff(schema)` matches the inventory default's OFF-ness.
 *
 * Modeled on tests/unit/kernel/derive-parity.test.ts.
 *
 * DERIVE GAPS for this slice (NOT covered — see bench-c.ts header for why):
 *   find-refs (56), simplicity (57), sibling (58), protect-tests (59),
 *   expose-dataset-verifier (70): no registry knob (read in driver.ts).
 *   full-remote-ami (66), full-remote-instance-type (67), full-remote-ondemand
 *   (68), full-remote-ready-polls (69), resume (71), resume-s3-bucket (72),
 *   campaign-id, resume-iam-profile, instance-id, and the resume KMS/principal/
 *   retention security inputs: no registry knob (read in apps/bench/...).
 *   must-pass (65): surfaces ⇒ deriveHome "runner-knobs" ≠ inventory "bench".
 * Already covered by sibling files (SKIPPED): selector-mode (52), repo-map (63).
 */

import { describe, expect, test } from "bun:test"
import { BENCH } from "@/config/knob-inventory/bench"
import type { KnobInventoryEntry } from "@/config/knob-inventory/types"
import type { AnyKnobSchema } from "@/config/knob-schema/contracts"
import { deriveInventoryEntry, isDefaultOff } from "@/config/knob-schema/derive-inventory"
import {
  closeoutGuardSchema,
  hooksSchema,
  multiVoterSchema,
  verifySelectRegressionSchema,
  verifySelectReproSchema,
  workingStateSchema,
} from "@/config/knob-schema/schemas/bench-c"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
// Live registry knobs (their parse is the ground truth).
import { closeoutGuardKnob } from "@/runner/knobs/knobs/closeout-guard"
import { hooksKnob } from "@/runner/knobs/knobs/hooks"
import { multiVoterKnob } from "@/runner/knobs/knobs/multi-voter"
import { verifySelectRegressionKnob } from "@/runner/knobs/knobs/verify-select-regression"
import { verifySelectReproKnob } from "@/runner/knobs/knobs/verify-select-repro"
import { workingStateKnob } from "@/runner/knobs/knobs/working-state"
import { type AnyKnob, asAnyKnob } from "@/runner/knobs/types"

/** Index the live inventory by envKey for O(1) lookup. */
const inventoryByEnvKey = new Map<string, KnobInventoryEntry>(BENCH.map((e) => [e.envKey, e]))

/** A spread of raws exercising active / off / garbage / boundary across every
 *  parser shape in this slice (bool strict / bool no-trim / enum / multi-voter
 *  string grammar). */
const RAW_PROBES: readonly (string | undefined)[] = [
  undefined,
  "",
  "  ",
  "0",
  "1",
  "2",
  "3",
  " 1 ",
  "on",
  "off",
  "true",
  "false",
  "yes",
  "no",
  "TRUE",
  "On",
  "4rule",
  "4Rule",
  // verify-select-regression / -repro enum tokens (incl. aliases + case).
  "discovered",
  "repo",
  "native",
  "gold",
  "pass-to-pass",
  "passtoppass",
  "GOLD",
  "Discovered ",
  "hard",
  "gate",
  "positive",
  "soft",
  "HARD",
  // multi-voter grammar.
  "3:0.6",
  "3:1",
  "3:0",
  "3:1.5",
  "0",
  "0:0.5",
  "abc",
  "3:abc",
  "3:0.5:9",
  " 5 ",
  "-1",
  "1.5",
  "NaN",
  "Infinity",
]

interface Pair {
  readonly name: string
  readonly schema: AnyKnobSchema
  readonly knob: AnyKnob
}

const PAIRS: readonly Pair[] = [
  {
    name: "verify-select-regression",
    schema: verifySelectRegressionSchema,
    knob: asAnyKnob(verifySelectRegressionKnob),
  },
  {
    name: "verify-select-repro",
    schema: verifySelectReproSchema,
    knob: asAnyKnob(verifySelectReproKnob),
  },
  { name: "hooks", schema: hooksSchema, knob: asAnyKnob(hooksKnob) },
  { name: "working-state", schema: workingStateSchema, knob: asAnyKnob(workingStateKnob) },
  { name: "closeout-guard", schema: closeoutGuardSchema, knob: asAnyKnob(closeoutGuardKnob) },
  { name: "multi-voter", schema: multiVoterSchema, knob: asAnyKnob(multiVoterKnob) },
]

describe("Pillar A derive parity (slice C) — inventory entry", () => {
  for (const { name, schema } of PAIRS) {
    test(`deriveInventoryEntry(${name}) deep-equals current bench.ts entry`, () => {
      const current = inventoryByEnvKey.get(schema.envKey)
      // Defensive: the entry MUST exist, else the parity claim is vacuous.
      expect(current, `bench.ts has an entry for ${schema.envKey}`).toBeDefined()
      const derived = deriveInventoryEntry(schema)
      expect(derived).toEqual(current as KnobInventoryEntry)
    })
  }
})

describe("Pillar A derive parity (slice C) — knob parse semantics", () => {
  for (const { name, schema, knob } of PAIRS) {
    test(`deriveKnob(${name}).parse === live knob.parse over ${RAW_PROBES.length} raws`, () => {
      const derived = deriveKnob(schema)
      // The derived parse must be the schema's parse (same reference).
      expect(derived.parse).toBe(schema.parse)
      for (const raw of RAW_PROBES) {
        expect(derived.parse(raw)).toEqual(knob.parse(raw))
      }
    })

    test(`deriveKnob(${name}) is apply-NOOP + correct id/envKey`, () => {
      const derived = deriveKnob(schema)
      const cfg = { sentinel: name } as unknown as Parameters<typeof derived.apply>[0]
      // NOOP apply returns the exact same config reference, untouched.
      expect(derived.apply(cfg, derived.parse("1") as never, { surface: "bench" })).toBe(cfg)
      expect(derived.id).toBe(knob.id)
      expect(derived.envKey).toBe(knob.envKey)
      // surfaces mirror the live knob's surface set (deriveHome reads these).
      expect([...derived.surfaces].sort()).toEqual([...knob.surfaces].sort())
    })
  }
})

describe("Pillar A derive parity (slice C) — default-OFF proof", () => {
  for (const { name, schema } of PAIRS) {
    test(`isDefaultOff(${name}) agrees with inventory default OFF-ness`, () => {
      const current = inventoryByEnvKey.get(schema.envKey) as KnobInventoryEntry
      const inventoryOff =
        current.default === undefined ||
        current.default === false ||
        current.default === 0 ||
        current.default === ""
      expect(isDefaultOff(schema)).toBe(inventoryOff)
      // All chosen knobs are byte-identical-baseline default-OFF.
      expect(isDefaultOff(schema)).toBe(true)
    })
  }
})

describe("Pillar A derive parity (slice C) — FULL-Knob data parity (BURN-DOWN gate)", () => {
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

describe("Pillar A derive parity (slice C) — RED on injection (the assert has teeth)", () => {
  test("a wrong default makes a bool deriveInventoryEntry parity FAIL", () => {
    // hooks derives default `false` in bench.ts → inject a richer default that
    // passes through unchanged for a bool kind only when undefined; force `true`.
    const corrupted: AnyKnobSchema = { ...hooksSchema, kind: "int", default: 7 }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(hooksSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
    expect(() => expect(derived).toEqual(current)).toThrow()
  })

  test("a wrong describe makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...multiVoterSchema, describe: "WRONG describe" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(multiVoterSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("a wrong readSite makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...verifySelectReproSchema, readSite: "runner/WRONG.ts" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(verifySelectReproSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("wrong surfaces flip the derived home (bench-only ⇒ bench; cross-surface ⇒ runner-knobs)", () => {
    // hooks is cross-surface ⇒ "runner-knobs"; forcing bench-only ⇒ "bench"
    // diverges from the current entry, proving the home-derivation is live.
    const benchOnly: AnyKnobSchema = { ...hooksSchema, surfaces: ["bench"] }
    expect(deriveInventoryEntry(benchOnly).home).toBe("bench")
    expect(deriveInventoryEntry(hooksSchema).home).toBe("runner-knobs")
    // verify-select-repro is bench-only ⇒ "bench"; widening flips it.
    const widened: AnyKnobSchema = {
      ...verifySelectReproSchema,
      surfaces: ["bench", "cli"],
    }
    expect(deriveInventoryEntry(verifySelectReproSchema).home).toBe("bench")
    expect(deriveInventoryEntry(widened).home).toBe("runner-knobs")
  })
})
