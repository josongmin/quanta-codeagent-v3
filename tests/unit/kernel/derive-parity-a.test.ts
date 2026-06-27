/**
 * Pillar A PARITY PROOF (slice A) — the SSOT derive reproduces today's
 * hand-maintained data EXACTLY for the FIRST-THIRD bench knob slice
 * (src/runner/batch/eval/kernel/schemas/bench-a.ts).
 *
 * For each authored `KnobSchema`:
 *   1. `deriveInventoryEntry(schema)` deep-equals the CURRENT entry in
 *      src/config/knob-inventory/bench.ts (the inventory hand-list).
 *   2. `deriveKnob(schema).parse(raw)` === the CURRENT registry knob's
 *      `parse(raw)` for a spread of raw values incl. active/off/garbage/boundary.
 *   3. `isDefaultOff(schema)` matches the inventory default's OFF-ness.
 *
 * If all hold, each schema can become the SINGLE declaration and its inventory
 * entry + registry knob can be DERIVED instead of hand-copied. The
 * red-on-injection block proves the parity assert actually has teeth.
 *
 * Modeled on tests/unit/kernel/derive-parity.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { BENCH } from "@/config/knob-inventory/bench"
import type { KnobInventoryEntry } from "@/config/knob-inventory/types"
import type { AnyKnobSchema } from "@/config/knob-schema/contracts"
import { deriveKnob } from "@/runner/batch/eval/kernel/derive"
import { deriveInventoryEntry, isDefaultOff } from "@/config/knob-schema/derive-inventory"
import {
  benchInLoopExecSchema,
  branchSearchSchema,
  faultEvidenceSchema,
  issueHintExpectedActualSchema,
  issueHintSchema,
  noPatchBreakerSchema,
  patchHygieneSchema,
  primaryRailSchema,
  repairEscalationSchema,
  specFidelitySteerSchema,
  subagentSchema,
  verificationPlanSchema,
} from "@/config/knob-schema/schemas/bench-a"
// Live registry knobs (their parse is the ground truth).
import { benchInLoopExecKnob } from "@/runner/knobs/knobs/bench-in-loop-exec"
import { branchSearchKnob } from "@/runner/knobs/knobs/branch-search"
import { faultEvidenceKnob } from "@/runner/knobs/knobs/fault-evidence"
import { issueHintExpectedActualKnob } from "@/runner/knobs/knobs/issue-hint-expected-actual"
import { issueHintKnob } from "@/runner/knobs/knobs/issue-hint"
import { noPatchBreakerKnob } from "@/runner/knobs/knobs/no-patch-breaker"
import { patchHygieneKnob } from "@/runner/knobs/knobs/patch-hygiene"
import { primaryRailKnob } from "@/runner/knobs/knobs/primary-rail"
import { repairEscalationKnob } from "@/runner/knobs/knobs/repair-escalation"
import { specFidelitySteerKnob } from "@/runner/knobs/knobs/spec-fidelity-steer"
import { subagentKnob } from "@/runner/knobs/knobs/subagent"
import { verificationPlanKnob } from "@/runner/knobs/knobs/verification-plan"
import { type AnyKnob, asAnyKnob } from "@/runner/knobs/types"

/** Index the live inventory by envKey for O(1) lookup. */
const inventoryByEnvKey = new Map<string, KnobInventoryEntry>(BENCH.map((e) => [e.envKey, e]))

/** A spread of raw values exercising active / off / garbage / boundary across
 *  every parser shape in this slice (int / bool / enum / string tri-state). */
const RAW_PROBES: readonly (string | undefined)[] = [
  undefined,
  "",
  "  ",
  "0",
  "1",
  "2",
  "3",
  "5",
  "8",
  "9",
  "-1",
  "1.5",
  "1abc",
  "abc",
  "on",
  "off",
  "true",
  "false",
  "True",
  "ON",
  "yes",
  "no",
  "agentless",
  "AGENTLESS",
  "regex",
  "full",
  "Full",
  "repro",
  "repro-only",
  " 1 ",
  " on ",
  "NaN",
  "Infinity",
]

interface Pair {
  readonly name: string
  readonly schema: AnyKnobSchema
  readonly knob: AnyKnob
}

const PAIRS: readonly Pair[] = [
  { name: "subagent", schema: subagentSchema, knob: asAnyKnob(subagentKnob) },
  { name: "branch-search", schema: branchSearchSchema, knob: asAnyKnob(branchSearchKnob) },
  { name: "issue-hint", schema: issueHintSchema, knob: asAnyKnob(issueHintKnob) },
  {
    name: "issue-hint-expected-actual",
    schema: issueHintExpectedActualSchema,
    knob: asAnyKnob(issueHintExpectedActualKnob),
  },
  { name: "bench-in-loop-exec", schema: benchInLoopExecSchema, knob: asAnyKnob(benchInLoopExecKnob) },
  { name: "fault-evidence", schema: faultEvidenceSchema, knob: asAnyKnob(faultEvidenceKnob) },
  { name: "verification-plan", schema: verificationPlanSchema, knob: asAnyKnob(verificationPlanKnob) },
  { name: "primary-rail", schema: primaryRailSchema, knob: asAnyKnob(primaryRailKnob) },
  { name: "patch-hygiene", schema: patchHygieneSchema, knob: asAnyKnob(patchHygieneKnob) },
  { name: "no-patch-breaker", schema: noPatchBreakerSchema, knob: asAnyKnob(noPatchBreakerKnob) },
  { name: "repair-escalation", schema: repairEscalationSchema, knob: asAnyKnob(repairEscalationKnob) },
  {
    name: "spec-fidelity-steer",
    schema: specFidelitySteerSchema,
    knob: asAnyKnob(specFidelitySteerKnob),
  },
]

describe("Pillar A derive parity (slice A) — inventory entry", () => {
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

describe("Pillar A derive parity (slice A) — knob parse semantics", () => {
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

describe("Pillar A derive parity (slice A) — FULL-Knob data parity (BURN-DOWN gate)", () => {
  // THE GATE the audit found missing: the per-knob parity above only compared
  // parse + inventory. The registry Knob ALSO carries category / describe / cost /
  // unit / source — fields deriveKnob can silently get wrong (it once hardcoded
  // category="validation" and emitted a spurious `default`). This burn-down proves
  // deriveKnob(schema, knob.apply) deep-equals the live knob across ALL data fields,
  // and forbids the divergent count from GROWING. A knob is reconciled (count
  // drops) by moving its category/describe(→knobDescribe)/cost/unit/source onto the
  // schema. When count hits 0, every slice-A knob can be DERIVED byte-identically.
  const FULL_KNOB_DIVERGENT_CEILING = 0 // slice A fully reconciled (12/12 derive byte-identical)
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

describe("Pillar A derive parity (slice A) — default-OFF proof", () => {
  for (const { name, schema } of PAIRS) {
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

  test("bench-in-loop-exec is NOT default-OFF (inventory default=true / full posture)", () => {
    // Guards the one non-OFF default in this slice — the derive must surface it.
    expect(isDefaultOff(benchInLoopExecSchema)).toBe(false)
  })
})

describe("Pillar A derive parity (slice A) — RED on injection (the assert has teeth)", () => {
  test("a wrong default makes deriveInventoryEntry parity FAIL", () => {
    // Corrupt ONLY the default (subagent is false in bench.ts → inject true).
    const corrupted: AnyKnobSchema = { ...subagentSchema, default: true }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(subagentSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
    expect(() => expect(derived).toEqual(current)).toThrow()
  })

  test("a wrong describe makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...branchSearchSchema, describe: "WRONG describe" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(branchSearchSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("a wrong readSite makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...primaryRailSchema, readSite: "runner/WRONG.ts" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(primaryRailSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("a wrong kind makes deriveInventoryEntry parity FAIL", () => {
    // issue-hint-expected-actual is kind="string" in bench.ts; force "bool".
    const corrupted: AnyKnobSchema = { ...issueHintExpectedActualSchema, kind: "bool" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(issueHintExpectedActualSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("flipping surfaces off bench-only flips the derived home", () => {
    // All slice-A schemas are bench-only ⇒ home="bench"; cross-surface ⇒ "runner-knobs".
    const crossSurface: AnyKnobSchema = {
      ...subagentSchema,
      surfaces: ["bench", "agent-batch"],
    }
    expect(deriveInventoryEntry(subagentSchema).home).toBe("bench")
    expect(deriveInventoryEntry(crossSurface).home).toBe("runner-knobs")
  })
})
