/**
 * PMX-04 — A FAMILY THAT GRADES ON-BOX MUST SAY WHERE ITS VERDICTS COME FROM.
 *
 * `boxGrade` and `parseBoxGradeVerdicts` are one decision expressed as two
 * fields. Declaring the first without the second is not a partial feature, it is
 * a broken one: that family's bench report is written by a PATCH-GEN-ONLY pass,
 * in which every instance is an explicit "requires the official Python harness —
 * REFUSING to fake-grade" infra error by construction. There is no verdict source
 * left, so the run has nowhere honest to read from.
 *
 * The pairing was documented and then enforced nowhere. A profile missing the
 * second port registered fine, provisioned a box, ran patch-gen, MATERIALIZED THE
 * ANSWER KEY and ran the evaluator — and only then threw. That is the same
 * "refusal that fires after the spend" shape the aug-22 A-C round hoisted
 * `admitBox` out of `setupBox` to kill: a guard that runs once the box has
 * already been provisioned and rewritten is not a guard.
 *
 * So it is checked at REGISTRATION — the earliest reachable moment, before any
 * run, and free.
 */
import { describe, expect, test } from "bun:test"
import type { DatasetFamily } from "@/apps/bench/dataset-family-token"
import {
  DATASET_FAMILY_PROFILES,
  registerDatasetFamilyProfile,
  resolveDatasetFamilyProfile,
} from "@/apps/bench/profiles/registry"

const withProfile = (family: string, over: Record<string, unknown>, body: () => void): void => {
  const drop = registerDatasetFamilyProfile({
    ...DATASET_FAMILY_PROFILES.verified,
    family: family as DatasetFamily,
    reportPartitionKey: family,
    ...over,
  } as Parameters<typeof registerDatasetFamilyProfile>[0])
  try {
    body()
  } finally {
    drop()
  }
}

describe("the box-grade ports are registered as a PAIR", () => {
  test("🔴 boxGrade WITHOUT parseBoxGradeVerdicts is refused at registration", () => {
    expect(() =>
      registerDatasetFamilyProfile({
        ...DATASET_FAMILY_PROFILES.verified,
        family: "pmx-halfport-probe" as DatasetFamily,
        reportPartitionKey: "pmx-halfport-probe",
        boxGrade: () => "echo grade",
      } as Parameters<typeof registerDatasetFamilyProfile>[0]),
    ).toThrow(/parseBoxGradeVerdicts/)
  })

  test("the refusal explains WHY, so it is not a rule to be worked around", () => {
    let message = ""
    try {
      registerDatasetFamilyProfile({
        ...DATASET_FAMILY_PROFILES.verified,
        family: "pmx-halfport-why" as DatasetFamily,
        reportPartitionKey: "pmx-halfport-why",
        boxGrade: () => "echo grade",
      } as Parameters<typeof registerDatasetFamilyProfile>[0])
    } catch (e) {
      message = (e as Error).message
    }
    // names the family, the missing port, and the reason its report is unusable
    expect(message).toContain("pmx-halfport-why")
    expect(message).toContain("parseBoxGradeVerdicts")
    expect(message).toMatch(/patch-gen|infra error|no verdict/i)
  })

  test("PAIRED CONTROL: both ports together register fine", () => {
    withProfile(
      "pmx-bothports-probe",
      {
        boxGrade: () => "echo grade",
        parseBoxGradeVerdicts: () => [],
      },
      () => {
        expect(
          resolveDatasetFamilyProfile("pmx-bothports-probe" as DatasetFamily).boxGrade,
        ).toBeDefined()
      },
    )
  })

  test("PAIRED CONTROL: NEITHER port — every inline-grading family — registers fine", () => {
    withProfile("pmx-noports-probe", {}, () => {
      expect(
        resolveDatasetFamilyProfile("pmx-noports-probe" as DatasetFamily).boxGrade,
      ).toBeUndefined()
    })
  })

  test("KNOWN-ITEM FLOOR: the SHIPPED families satisfy the pairing", () => {
    for (const family of ["verified", "live", "pro", "promax"] as const) {
      const p = resolveDatasetFamilyProfile(family)
      expect(
        p.boxGrade === undefined || p.parseBoxGradeVerdicts !== undefined,
        `${family} declares boxGrade with no parseBoxGradeVerdicts`,
      ).toBe(true)
    }
    // …and promax really is the one that declares them, so this is not vacuous.
    expect(resolveDatasetFamilyProfile("promax").boxGrade).toBeDefined()
  })
})
