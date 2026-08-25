/**
 * Pillar A PARITY PROOF (slice GAP-2 — ENV-DIRECT bench knobs) — the SSOT derive
 * reproduces today's hand-maintained inventory data EXACTLY for the full-remote
 * EC2 dials, the spot-resume / campaign family, and the G1 model-lanes override.
 *
 * ⚠️ These knobs are ENV-DIRECT: an inventory entry exists in
 * src/config/knob-inventory/bench.ts but NO registry knob object exists in
 * src/runner/knobs/knobs/ (they are read straight from env in apps/bench/*).
 * There is therefore NO live `parse` to compare against — this slice proves
 * INVENTORY-DERIVE parity ONLY (not parse-parity, which the other slices add).
 *
 * For each authored `KnobSchema` in
 * src/runner/batch/eval/kernel/schemas/bench-gap-2.ts:
 *   1. `deriveInventoryEntry(schema)` deep-equals the CURRENT entry in
 *      src/config/knob-inventory/bench.ts (the inventory hand-list).
 *   2. `isDefaultOff(schema)` matches the inventory default's OFF-ness.
 *
 * Plus a RED-on-injection battery proving the deep-equal has teeth.
 *
 * Modeled on tests/unit/kernel/derive-parity-c.test.ts.
 */

import { describe, expect, test } from "bun:test"
import { BENCH } from "@/config/knob-inventory/bench"
import type { KnobInventoryEntry } from "@/config/knob-inventory/types"
import type { AnyKnobSchema } from "@/config/knob-schema/contracts"
import { deriveInventoryEntry, isDefaultOff } from "@/config/knob-schema/derive-inventory"
import {
  benchBestkPasskSchema,
  campaignIdSchema,
  fullRemoteAmiSchema,
  fullRemoteConcurrencySchema,
  fullRemoteInstanceTypeSchema,
  fullRemoteOndemandSchema,
  fullRemoteReadyPollsSchema,
  instanceIdSchema,
  modelLanesSchema,
  resumeIamProfileSchema,
  resumeKmsKeyArnSchema,
  resumeMaxRetentionDaysSchema,
  resumePrincipalArnSchema,
  resumeS3BucketSchema,
  resumeSchema,
} from "@/config/knob-schema/schemas/bench-gap-2"

/** Index the live inventory by envKey for O(1) lookup. */
const inventoryByEnvKey = new Map<string, KnobInventoryEntry>(BENCH.map((e) => [e.envKey, e]))

interface Entry {
  readonly name: string
  readonly schema: AnyKnobSchema
}

const SCHEMAS: readonly Entry[] = [
  { name: "full-remote-ami", schema: fullRemoteAmiSchema },
  { name: "full-remote-concurrency", schema: fullRemoteConcurrencySchema },
  { name: "full-remote-instance-type", schema: fullRemoteInstanceTypeSchema },
  { name: "full-remote-ondemand", schema: fullRemoteOndemandSchema },
  { name: "full-remote-ready-polls", schema: fullRemoteReadyPollsSchema },
  { name: "resume", schema: resumeSchema },
  { name: "resume-s3-bucket", schema: resumeS3BucketSchema },
  { name: "resume-kms-key-arn", schema: resumeKmsKeyArnSchema },
  { name: "resume-principal-arn", schema: resumePrincipalArnSchema },
  { name: "resume-max-retention-days", schema: resumeMaxRetentionDaysSchema },
  { name: "campaign-id", schema: campaignIdSchema },
  { name: "resume-iam-profile", schema: resumeIamProfileSchema },
  { name: "instance-id", schema: instanceIdSchema },
  { name: "model-lanes", schema: modelLanesSchema },
  { name: "bestk-passk", schema: benchBestkPasskSchema },
]

describe("Pillar A derive parity (slice GAP-2, env-direct) — inventory entry", () => {
  for (const { name, schema } of SCHEMAS) {
    test(`deriveInventoryEntry(${name}) deep-equals current bench.ts entry`, () => {
      const current = inventoryByEnvKey.get(schema.envKey)
      // Defensive: the entry MUST exist, else the parity claim is vacuous.
      expect(current, `bench.ts has an entry for ${schema.envKey}`).toBeDefined()
      const derived = deriveInventoryEntry(schema)
      expect(derived).toEqual(current as KnobInventoryEntry)
    })
  }
})

describe("Pillar A derive parity (slice GAP-2) — default-OFF proof", () => {
  for (const { name, schema } of SCHEMAS) {
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
})

describe("Pillar A derive parity (slice GAP-2) — RED on injection (the assert has teeth)", () => {
  test("a wrong default makes a string deriveInventoryEntry parity FAIL", () => {
    // full-remote-ami records `default: undefined` in bench.ts → inject a
    // non-undefined default that passes through verbatim for a string kind.
    const corrupted: AnyKnobSchema = { ...fullRemoteAmiSchema, default: "ami-WRONG" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(fullRemoteAmiSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
    expect(() => expect(derived).toEqual(current)).toThrow()
  })

  test("a wrong int default makes deriveInventoryEntry parity FAIL", () => {
    // full-remote-ready-polls records `default: 90`; inject 7.
    const corrupted: AnyKnobSchema = { ...fullRemoteReadyPollsSchema, default: 7 }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(fullRemoteReadyPollsSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("a wrong describe makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...resumeSchema, describe: "WRONG describe" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(resumeSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("a wrong readSite makes deriveInventoryEntry parity FAIL", () => {
    const corrupted: AnyKnobSchema = { ...instanceIdSchema, readSite: "apps/bench/WRONG.ts" }
    const derived = deriveInventoryEntry(corrupted)
    const current = inventoryByEnvKey.get(instanceIdSchema.envKey) as KnobInventoryEntry
    expect(derived).not.toEqual(current)
  })

  test("wrong surfaces flip the derived home (bench-only ⇒ bench; cross-surface ⇒ runner-knobs)", () => {
    // Every GAP-2 knob is bench-only ⇒ "bench"; widening flips it to runner-knobs.
    expect(deriveInventoryEntry(modelLanesSchema).home).toBe("bench")
    const widened: AnyKnobSchema = { ...modelLanesSchema, surfaces: ["bench", "cli"] }
    expect(deriveInventoryEntry(widened).home).toBe("runner-knobs")
    expect(deriveInventoryEntry(widened)).not.toEqual(
      inventoryByEnvKey.get(modelLanesSchema.envKey) as KnobInventoryEntry,
    )
  })
})
