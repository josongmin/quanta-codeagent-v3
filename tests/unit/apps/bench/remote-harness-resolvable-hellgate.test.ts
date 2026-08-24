/**
 * HELLGATE — a family the box path will ask for a swebench harness must be able
 * to answer BEFORE a box is provisioned.
 *
 * `promax.ts` records why this matters, in its own words: "`setupBox` and
 * `harnessSpec` also refuse, but those fire AFTER `RunInstances` — an operator
 * would have paid for a box before learning ProMax cannot run yet. This makes
 * the refusal free." Opening the ProMax lane deleted that step from the family's
 * port while `harnessSpec` kept refusing, and a full-remote launch went back to
 * paying for a box and then dying.
 *
 * `assertRemoteHarnessResolvable` is the generic replacement, and the condition
 * it skips on is not its own invention: `box-session.ts` and
 * `ec2-lifecycle.ts` both consult `harnessSpec` ONLY when `boxGrade` is absent.
 * The guard mirrors that and asks the same question earlier.
 *
 * Driven over SYNTHETIC families rather than the live ones, because today no
 * shipped family has the offending combination — every family that refuses a
 * harness spec also grades on-box. A guard with no live offender is exactly the
 * kind that rots into decoration, so the offender is constructed here.
 */

import { describe, expect, test } from "bun:test"

import type { DatasetFamily } from "@/apps/bench/dataset-family-token"
import {
  DATASET_FAMILY_PROFILES,
  registerDatasetFamilyProfile,
} from "@/apps/bench/profiles/registry"
import { assertRemoteHarnessResolvable } from "@/apps/bench/remote/box-session"

/** Register a throwaway family for the duration of `body`, always unregistered. */
const withFamily = (family: string, over: Record<string, unknown>, body: () => void): void => {
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

const REFUSING_HARNESS = (): never => {
  throw new Error("this family has no swebench harness")
}

const check = (family: string): void =>
  assertRemoteHarnessResolvable({ surface: "test", family: family as DatasetFamily })

describe("remote preflight: the harness the box path will ask for", () => {
  test("🔴 OFFENDER — no boxGrade and a refusing harnessSpec is refused at preflight", () => {
    withFamily("t-harness-refuses", { harnessSpec: REFUSING_HARNESS }, () => {
      expect(() => check("t-harness-refuses")).toThrow(/no swebench harness/)
    })
  })

  test("INNOCENT — a family whose harnessSpec answers passes", () => {
    // `verified`'s own port, unchanged: the guard must not invent a refusal for
    // the families that make up every normal run.
    withFamily("t-harness-answers", {}, () => {
      expect(() => check("t-harness-answers")).not.toThrow()
    })
  })

  test("INNOCENT — boxGrade present ⇒ skipped even when harnessSpec refuses", () => {
    // The load-bearing case. A family that grades in its own grader phase is
    // never asked for a harness by the box path, so preflight must not ask
    // either — otherwise this guard would refuse every on-box-grading family,
    // which is the opposite of the bug it exists for.
    withFamily(
      "t-box-grades",
      {
        harnessSpec: REFUSING_HARNESS,
        boxGrade: () => "echo grade",
        parseBoxGradeVerdicts: () => [],
      },
      () => {
        expect(() => check("t-box-grades")).not.toThrow()
      },
    )
  })

  test("every SHIPPED family passes its own preflight", () => {
    // Anti-vacuity: proves the guard is reachable with real inputs and that no
    // shipped family is currently refused by it.
    const shipped = Object.keys(DATASET_FAMILY_PROFILES)
    expect(shipped.length).toBeGreaterThan(2)
    for (const family of shipped) expect(() => check(family)).not.toThrow()
  })
})
